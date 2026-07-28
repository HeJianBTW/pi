import { COPYFILE_EXCL } from 'node:constants';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, readFile, rename } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { isProjectTrusted } from '@amaster.ai/pi-shared/settings';
import { StringEnum } from '@earendil-works/pi-ai';
import {
  type ExtensionAPI,
  type ExtensionContext,
  truncateHead,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  listModelRegistry,
  loadVideoGenSettings,
  resolveModel,
  resolveOutputDir,
} from './config.js';
import {
  AmbiguousSubmitError,
  errorMessageForUser,
  missingKeyError,
  providerLabel,
  RemoteTaskFailedError,
  RemoteTaskNotFoundError,
  redactUrl,
  toLogSummary,
} from './errors.js';
import { resolveFfmpeg } from './ffmpeg.js';
import {
  ActiveJobs,
  assertSafeId,
  ensureSingleJobDir,
  loadRenderJob,
  loadSingleJob,
  newJobId,
  readJsonFile,
  resolveJobDirInsideOutput,
  type SingleJobManifest,
  saveRenderJob,
  saveSingleJob,
  singleJobDir,
  writeJsonAtomic,
} from './jobs/store.js';
import { arkAdapter } from './providers/ark.js';
import { dashscopeAdapter } from './providers/dashscope.js';
import { klingAdapter } from './providers/kling.js';
import { newapiAdapter } from './providers/newapi.js';
import { openrouterAdapter } from './providers/openrouter.js';
import { requestFingerprint } from './providers/request.js';
import { CancelledError, pollTask, RateLimiter } from './providers/task.js';
import { runRender } from './render.js';
import type {
  GenerateVideoParams,
  RemoteTaskHandle,
  ResolvedProvider,
  VideoApiStyle,
  VideoGenSettings,
  VideoModelCapabilities,
  VideoProviderAdapter,
} from './types.js';

/** Registered provider wire adapters. */
const ADAPTERS: Partial<Record<VideoApiStyle, VideoProviderAdapter>> = {
  ark: arkAdapter,
  dashscope: dashscopeAdapter,
  kling: klingAdapter,
  newapi: newapiAdapter,
  openrouter: openrouterAdapter,
};

const ENV_VAR_BY_STYLE: Record<VideoApiStyle, string> = {
  ark: 'ARK_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  kling: 'KLING_API_KEY',
  newapi: 'NEWAPI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

type TextResult = {
  isError?: true;
  content: { type: 'text'; text: string }[];
  details: Record<string, unknown>;
};

function okResult(text: string, details: Record<string, unknown> = {}): TextResult {
  return { content: [{ type: 'text', text: boundToolText(text) }], details: boundDetails(details) };
}

function errResult(text: string, details: Record<string, unknown> = {}): TextResult {
  return {
    isError: true,
    content: [{ type: 'text', text: boundToolText(text) }],
    details: boundDetails(details),
  };
}

function boundToolText(text: string): string {
  const result = truncateHead(text, { maxBytes: 47 * 1024, maxLines: 1_900 });
  return result.truncated ? `${result.content}\n\n[pi-video-gen output truncated]` : result.content;
}

function boundDetails(details: Record<string, unknown>): Record<string, unknown> {
  try {
    return Buffer.byteLength(JSON.stringify(details), 'utf-8') <= 2 * 1024
      ? details
      : { truncated: true };
  } catch {
    return { truncated: true };
  }
}

/** Capability-driven schema for video_generate (mirrors pi-image-gen's approach). */
function buildGenerateParams(caps: VideoModelCapabilities | null) {
  return Type.Object({
    prompt: Type.String({
      description:
        'Text prompt for the clip. Describe subject, motion, and camera. When the active model has nativeAudio, append audio cues (e.g. "[Sound Effect] rain; [Speaker] Alice (soft): line").',
    }),
    firstFrame: Type.Optional(
      Type.String({
        description:
          'Path to a first-frame reference image (png/jpg/webp), absolute or relative to the session cwd.',
      }),
    ),
    ...(caps?.supportsFirstLastFrame
      ? {
          lastFrame: Type.Optional(
            Type.String({
              description:
                'Path to a last-frame reference image for first+last-frame interpolation.',
            }),
          ),
        }
      : {}),
    durationSec: Type.Optional(
      Type.Integer({
        ...(caps ? { minimum: caps.durations[0], maximum: caps.durations[1] } : {}),
        description: caps
          ? `Clip duration in seconds, integer ${caps.durations[0]}-${caps.durations[1]} for the active model.`
          : 'Clip duration in seconds (model-dependent).',
      }),
    ),
    aspectRatio: caps
      ? Type.Optional(
          StringEnum(caps.aspectRatios, { description: 'Aspect ratio for the active model.' }),
        )
      : Type.Optional(Type.String({ description: 'Aspect ratio (model-dependent).' })),
    jobId: Type.Optional(
      Type.String({
        description:
          'Resume a previous single-clip job by id (from an interrupted call) instead of submitting a new paid task.',
      }),
    ),
  });
}

export default function piVideoGenExtension(pi: ExtensionAPI): void {
  let settings: VideoGenSettings = {};
  let rateLimiter = new RateLimiter();
  const activeJobs = new ActiveJobs();

  const reloadSettings = (ctx: ExtensionContext) => {
    settings = loadVideoGenSettings(ctx.cwd, isProjectTrusted(ctx));
    rateLimiter = new RateLimiter(
      settings.rateLimit?.maxRequestsPerMinute,
      settings.rateLimit?.maxRequestsPerDay,
    );
  };

  const sha256hex = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

  /**
   * Freeze a frame into the job directory with an exclusive-create copy and
   * record its content hash — a paid task must be provably tied to the exact
   * image BYTES submitted, not just a path (decision 19②⑤⑧).
   */
  const snapshotFrame = async (
    jobDir: string,
    sourcePath: string,
    label: string,
  ): Promise<{ rel: string; hash: string }> => {
    const ext = extname(sourcePath) || '.png';
    const rel = join('assets', `${label}${ext}`);
    const dest = join(jobDir, rel);
    mkdirSync(join(jobDir, 'assets'), { recursive: true });
    let tmp = '';
    for (let i = 0; ; i++) {
      const candidate = `${dest}.tmp-${process.pid}-${i}`;
      try {
        await copyFile(sourcePath, candidate, COPYFILE_EXCL);
        tmp = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
    }
    await rename(tmp, dest);
    return { rel, hash: sha256hex(await readFile(dest)) };
  };

  /** Tool-facing params (LLM names) — mapped explicitly to the internal shape. */
  type GenerateToolParams = {
    prompt: string;
    firstFrame?: string | undefined;
    lastFrame?: string | undefined;
    referenceImages?: string[] | undefined;
    durationSec?: number | undefined;
    aspectRatio?: string | undefined;
    jobId?: string | undefined;
  };

  /** Shared single-clip flow for the tool's execute() and `/video-gen generate`. */
  const runGenerate = async (
    toolParams: GenerateToolParams,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (partial: TextResult) => void,
  ): Promise<TextResult> => {
    const resolved = resolveModel(settings);
    if (!resolved) {
      return errResult(
        `Cannot resolve model "${settings.defaultModel ?? 'seedance'}" against the built-in registry. Run /video-gen models to see available ids and aliases, or fix "pi-video-gen.defaultModel" in settings.`,
      );
    }
    const caps = resolved.entry.capabilities;
    const adapter = ADAPTERS[resolved.provider.style];
    if (!adapter) {
      return errResult(
        `Provider adapter "${resolved.provider.style}" is unavailable in this build. Run /video-gen models or reinstall pi-video-gen.`,
      );
    }
    if (!resolved.provider.apiKey) {
      return errResult(
        missingKeyError(
          resolved.provider.style,
          ENV_VAR_BY_STYLE[resolved.provider.style],
          resolved.provider.apiKeyPath,
        ).message,
      );
    }
    // Map tool params → internal params, applying model defaults. (A raw cast
    // here silently DROPPED firstFrame/lastFrame and defaulted resolution,
    // duration, ratio and audio — turning paid requests into silent t2v.)
    const params: GenerateVideoParams = {
      prompt: toolParams.prompt,
      firstFramePath: toolParams.firstFrame ? resolve(ctx.cwd, toolParams.firstFrame) : undefined,
      lastFramePath: toolParams.lastFrame ? resolve(ctx.cwd, toolParams.lastFrame) : undefined,
      referenceImagePaths: toolParams.referenceImages?.map((p) => resolve(ctx.cwd, p)),
      durationSec: toolParams.durationSec ?? resolved.entry.defaultDurationSec,
      aspectRatio: toolParams.aspectRatio ?? resolved.entry.defaultAspectRatio,
      resolution: resolved.entry.defaultResolution,
      generateAudio: caps.nativeAudio,
    };

    if (toolParams.lastFrame && !caps.supportsFirstLastFrame) {
      return errResult(
        `The active model (${resolved.entry.id}) does not support last-frame interpolation. Remove lastFrame, or switch models (/video-gen models).`,
      );
    }
    if (
      toolParams.durationSec != null &&
      (!Number.isInteger(toolParams.durationSec) ||
        toolParams.durationSec < caps.durations[0] ||
        toolParams.durationSec > caps.durations[1])
    ) {
      if (!Number.isInteger(toolParams.durationSec)) {
        return errResult(
          `durationSec must be a whole number of seconds (${caps.durations[0]}-${caps.durations[1]} for ${resolved.entry.id}) — got ${toolParams.durationSec}.`,
        );
      }
      return errResult(
        `durationSec must be ${caps.durations[0]}-${caps.durations[1]}s for ${resolved.entry.id} (got ${toolParams.durationSec}).`,
      );
    }
    if (toolParams.aspectRatio && !caps.aspectRatios.includes(toolParams.aspectRatio)) {
      return errResult(
        `aspectRatio must be one of ${caps.aspectRatios.join(', ')} for ${resolved.entry.id} (got ${toolParams.aspectRatio}).`,
      );
    }
    const totalRefs =
      (toolParams.firstFrame ? 1 : 0) +
      (toolParams.lastFrame ? 1 : 0) +
      (toolParams.referenceImages?.length ?? 0);
    if (totalRefs > caps.maxReferenceImages) {
      return errResult(
        `Too many reference images (${totalRefs}) — ${resolved.entry.id} accepts at most ${caps.maxReferenceImages} total (frames + references).`,
      );
    }

    const outputDir = resolveOutputDir(settings, ctx.cwd);

    // Resume path: a job id means "keep polling the persisted handle", never re-submit.
    if (toolParams.jobId) {
      assertSafeId(toolParams.jobId, 'job');
      const manifest = loadSingleJob(outputDir, toolParams.jobId);
      if (manifest?.state === 'ambiguous') {
        return errResult(
          `Job "${toolParams.jobId}" has an ambiguous submit — a paid task MAY exist. Check the provider console before starting another generation; this job will not submit again automatically.`,
          { jobId: toolParams.jobId },
        );
      }
      // Terminal states have no business re-polling: a finished job returns
      // its clip; a failed one refuses (permanent failures don't heal).
      if (manifest?.state === 'done' && manifest.videoPath && existsSync(manifest.videoPath)) {
        return okResult(
          `Video clip already rendered: ${manifest.videoPath}. Job id: ${manifest.jobId}.`,
          {
            jobId: manifest.jobId,
            videoPath: manifest.videoPath,
          },
        );
      }
      if (manifest?.state === 'failed') {
        return errResult(
          `Job ${toolParams.jobId} already failed permanently (its manifest records the reason). Start a fresh generation instead of resuming.`,
        );
      }
      if (!manifest?.handle) {
        return errResult(
          `No resumable job found with id "${toolParams.jobId}". The manifest is missing or has no task handle; start a fresh generation instead.`,
        );
      }
      if (
        !manifest.requestFingerprint ||
        manifest.handle.requestFingerprint !== manifest.requestFingerprint
      ) {
        return errResult(
          `Job ${toolParams.jobId} has a task handle that does not match its frozen request fingerprint. Refusing to poll it; inspect or discard the manifest.`,
          { jobId: toolParams.jobId },
        );
      }
      // Frozen task identity, fail-CLOSED: a manifest without identity
      // fields predates the freeze and cannot be resumed safely (settings may
      // have changed since) — no silent fallback to the current endpoint.
      if (!manifest.modelId || !manifest.providerStyle || !manifest.providerBaseUrl) {
        return errResult(
          `Job ${toolParams.jobId} was created before task-identity freezing and cannot be resumed safely. Start a new job (or delete .video-gen/single/${toolParams.jobId} under your video-gen output directory to clear it).`,
        );
      }
      // Settings must still point at the same endpoint — polling the old task
      // id against a reconfigured provider hits the wrong URL.
      if (
        manifest.modelId !== resolved.remoteId ||
        manifest.providerStyle !== resolved.provider.style ||
        manifest.providerBaseUrl !== resolved.provider.baseUrl
      ) {
        return errResult(
          `Job ${toolParams.jobId} was created with model "${manifest.modelId ?? resolved.remoteId}" on ${manifest.providerStyle ?? resolved.provider.style} (${manifest.providerBaseUrl ? redactUrl(manifest.providerBaseUrl) : 'default endpoint'}), but current settings resolve to "${resolved.remoteId}" on ${resolved.provider.style} (${redactUrl(resolved.provider.baseUrl)}). Restore the previous settings to resume it, or start a new job.`,
        );
      }
      const jobDir = resolveJobDirInsideOutput(outputDir, singleJobDir(outputDir, manifest.jobId));
      const frozenInput = readJsonFile<
        Partial<GenerateVideoParams> & { model?: string | undefined }
      >(join(jobDir, 'input.json'));
      if (
        !frozenInput ||
        frozenInput.model !== manifest.modelId ||
        frozenInput.requestId !== manifest.jobId ||
        typeof frozenInput.prompt !== 'string' ||
        requestFingerprint(frozenInput.model, frozenInput as GenerateVideoParams) !==
          manifest.requestFingerprint
      ) {
        return errResult(
          `Job ${toolParams.jobId} no longer matches its frozen input snapshot. Refusing to poll a task whose request identity cannot be verified.`,
          { jobId: toolParams.jobId },
        );
      }
      // Frozen frame verification: resume only if the snapshots are intact.
      if (manifest.frameHashes) {
        for (const [rel, expected] of Object.entries(manifest.frameHashes)) {
          const snapPath = join(singleJobDir(outputDir, manifest.jobId), rel);
          let actual: string | undefined;
          try {
            actual = sha256hex(await readFile(snapPath));
          } catch {
            actual = undefined;
          }
          if (actual !== expected) {
            return errResult(
              `Frame snapshot ${rel} changed or is missing — the frozen input is no longer trustworthy. Start a new job.`,
            );
          }
        }
      }

      const release = activeJobs.acquire(jobDir);
      try {
        return await finishJob(manifest, resolved.provider, adapter, outputDir, signal, onUpdate);
      } finally {
        release();
      }
    }

    const jobId = newJobId('gen');
    const jobDir = ensureSingleJobDir(outputDir, jobId);
    params.requestId = jobId;
    const release = activeJobs.acquire(jobDir);
    try {
      // Freeze every frame input into the job BEFORE the paid submit — the
      // task must be tied to exact image BYTES, not a mutable path.
      const frameHashes: Record<string, string> = {};
      try {
        if (params.firstFramePath) {
          const snap = await snapshotFrame(jobDir, params.firstFramePath, 'first_frame');
          frameHashes[snap.rel] = snap.hash;
          params.firstFramePath = join(jobDir, snap.rel);
        }
        if (params.lastFramePath) {
          const snap = await snapshotFrame(jobDir, params.lastFramePath, 'last_frame');
          frameHashes[snap.rel] = snap.hash;
          params.lastFramePath = join(jobDir, snap.rel);
        }
        if (params.referenceImagePaths?.length) {
          const frozenRefs: string[] = [];
          for (let i = 0; i < params.referenceImagePaths.length; i++) {
            const snap = await snapshotFrame(jobDir, params.referenceImagePaths[i]!, `ref_${i}`);
            frameHashes[snap.rel] = snap.hash;
            frozenRefs.push(join(jobDir, snap.rel));
          }
          params.referenceImagePaths = frozenRefs;
        }
      } catch {
        return errResult(
          'A reference frame is not readable. Use the absolute path returned by image_generate, or an existing png/jpg/webp file.',
        );
      }

      writeJsonAtomic(`${jobDir}/input.json`, { model: resolved.remoteId, ...params });
      await rateLimiter.acquire(signal);
      const expectedFingerprint = requestFingerprint(resolved.remoteId, params);
      // Persist a fail-closed state BEFORE the paid request. A crash or an
      // AmbiguousSubmitError leaves a job that refuses automatic resubmission.
      saveSingleJob(outputDir, {
        jobId,
        kind: 'single',
        state: 'ambiguous',
        modelId: resolved.remoteId,
        providerStyle: resolved.provider.style,
        providerBaseUrl: resolved.provider.baseUrl,
        requestFingerprint: expectedFingerprint,
        frameHashes, // frozen bytes are provable even if the response is lost
        updatedAt: new Date().toISOString(),
      });
      onUpdate?.(okResult('Submitting video task…'));
      const handle = await adapter.submit(
        resolved.provider,
        resolved.remoteId,
        params,
        fetch,
        signal,
      );
      saveSingleJob(outputDir, {
        jobId,
        kind: 'single',
        state: 'submitted',
        handle,
        requestFingerprint: expectedFingerprint,
        modelId: resolved.remoteId,
        providerStyle: resolved.provider.style,
        providerBaseUrl: resolved.provider.baseUrl,
        frameHashes,
        updatedAt: new Date().toISOString(),
      });
      return await finishJob(
        loadSingleJob(outputDir, jobId)!,
        resolved.provider,
        adapter,
        outputDir,
        signal,
        onUpdate,
      );
    } catch (error) {
      return handleGenerateError(error, outputDir, jobId);
    } finally {
      release();
    }
  };

  /** Poll an existing handle to completion and download the clip. */
  const finishJob = async (
    manifest: SingleJobManifest,
    provider: ResolvedProvider,
    adapter: VideoProviderAdapter,
    outputDir: string,
    signal?: AbortSignal,
    onUpdate?: (partial: TextResult) => void,
  ): Promise<TextResult> => {
    const handle = manifest.handle as RemoteTaskHandle;
    const jobDir = resolveJobDirInsideOutput(outputDir, singleJobDir(outputDir, manifest.jobId));
    try {
      onUpdate?.(okResult(`Task ${handle.taskId} submitted; polling…`));
      saveSingleJob(outputDir, { ...manifest, state: 'polling' });
      const succeeded = await pollTask({
        check: () => adapter.inspect(provider, handle, fetch, signal),
        signal,
        onTick: (attempt, phase) => {
          if (attempt % 15 === 0) {
            onUpdate?.(okResult(`Still ${phase}… (${attempt * 2}s elapsed)`));
          }
        },
      });

      const videoPath = `${jobDir}/video.mp4`;
      saveSingleJob(outputDir, { ...manifest, state: 'downloading' });
      onUpdate?.(okResult('Task finished; downloading clip…'));
      const meta = await adapter.downloadTo(
        provider,
        handle,
        succeeded.videoUrl,
        videoPath,
        fetch,
        signal,
      );

      saveSingleJob(outputDir, { ...manifest, state: 'done', videoPath: meta.path });
      pi.appendEntry('video-gen:last-job', {
        jobId: manifest.jobId,
        kind: 'single',
        videoPath: meta.path,
      });
      return okResult(
        `Video clip ready: ${meta.path} (${(meta.bytes / 1_000_000).toFixed(1)} MB). Job id: ${manifest.jobId}.`,
        { jobId: manifest.jobId, videoPath: meta.path, bytes: meta.bytes, taskId: handle.taskId },
      );
    } catch (error) {
      if (error instanceof CancelledError || signal?.aborted) {
        if (adapter.cancel) {
          try {
            const cancelled = await adapter.cancel(
              provider,
              handle,
              fetch,
              AbortSignal.timeout(10_000),
            );
            if (cancelled.cancelled) {
              const next = {
                ...manifest,
                state: 'failed' as const,
                error: 'cancelled remotely',
              };
              delete next.handle;
              saveSingleJob(outputDir, next);
              return errResult(`Remote task ${handle.taskId} was cancelled.`, {
                jobId: manifest.jobId,
                taskId: handle.taskId,
              });
            }
          } catch {
            console.error('[pi-video-gen] remote cancel failed');
          }
        }
        saveSingleJob(outputDir, { ...manifest, state: 'polling_stopped' });
        return errResult(
          `Stopped locally. NOTE: the remote task ${handle.taskId} may still be running and billable — local stop does not cancel it (Ark task-cancellation support is unverified). Resume polling with video_generate jobId "${manifest.jobId}" once it should have finished.`,
          { jobId: manifest.jobId, taskId: handle.taskId },
        );
      }
      return handleGenerateError(error, outputDir, manifest.jobId);
    }
  };

  const handleGenerateError = (error: unknown, outputDir: string, jobId: string): TextResult => {
    console.error(`[pi-video-gen] generate failed: ${toLogSummary(error)}`);
    const existing = loadSingleJob(outputDir, jobId);
    if (existing && existing.state !== 'done') {
      const terminal = error instanceof RemoteTaskFailedError;
      const ambiguous =
        error instanceof AmbiguousSubmitError || error instanceof RemoteTaskNotFoundError;
      const next: SingleJobManifest = {
        ...existing,
        state: ambiguous
          ? 'ambiguous'
          : existing.handle && !terminal
            ? 'polling_stopped'
            : 'failed',
        error: error instanceof RemoteTaskFailedError ? error.providerMessage : toLogSummary(error),
      };
      if (terminal) delete next.handle;
      saveSingleJob(outputDir, next);
    }
    return errResult(
      error instanceof RemoteTaskNotFoundError
        ? `Job ${jobId} is no longer visible to the provider, but the paid task may still exist. Its handle was preserved and this job will not resubmit automatically; check the provider console before starting another generation.`
        : errorMessageForUser(error),
      { jobId },
    );
  };

  /** Shared multi-shot render flow for the tool's execute() and `/video-gen render`. */
  const runRenderTool = async (
    p: { renderSpecPath: string; allowDegradations?: string[] | undefined },
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (partial: TextResult) => void,
  ): Promise<TextResult> => {
    try {
      const resolved = resolveModel(settings);
      if (!resolved) {
        return errResult(
          `Cannot resolve model "${settings.defaultModel ?? 'seedance'}". Run /video-gen models, or fix pi-video-gen.defaultModel.`,
        );
      }
      const adapter = ADAPTERS[resolved.provider.style];
      if (!adapter) {
        return errResult(
          `Provider adapter "${resolved.provider.style}" is unavailable in this build. Run /video-gen models or reinstall pi-video-gen.`,
        );
      }
      if (!resolved.provider.apiKey) {
        return errResult(
          missingKeyError(
            resolved.provider.style,
            ENV_VAR_BY_STYLE[resolved.provider.style],
            resolved.provider.apiKeyPath,
          ).message,
        );
      }
      const ffmpeg = resolveFfmpeg(settings.ffmpegPath);
      if (!ffmpeg.runnable) {
        return errResult(
          `ffmpeg is not runnable (tried source: ${ffmpeg.source}, path: ${ffmpeg.path}). Set pi-video-gen.ffmpegPath in GLOBAL settings or FFMPEG_PATH, then /video-gen doctor.`,
        );
      }
      const result = await runRender({
        renderSpecPath: p.renderSpecPath,
        allowDegradations: p.allowDegradations,
        settings,
        cwd: ctx.cwd,
        resolved,
        adapter,
        activeJobs,
        rateLimiter,
        ffmpegPath: ffmpeg.path,
        signal,
        onUpdate: (msg) => onUpdate?.(okResult(msg)),
      });
      const degradedNote =
        result.degraded.length > 0 ? ` Degradations applied: ${result.degraded.join('; ')}.` : '';
      pi.appendEntry('video-gen:last-job', {
        jobId: result.jobId,
        kind: 'render',
        finalVideoPath: result.finalVideoPath,
      });
      return okResult(
        `Final video ready: ${result.finalVideoPath} (${result.shotsDone} shots). Job: ${result.jobId}.${degradedNote}`,
        result as unknown as Record<string, unknown>,
      );
    } catch (error) {
      console.error(`[pi-video-gen] video_render failed: ${toLogSummary(error)}`);
      return errResult(errorMessageForUser(error));
    }
  };

  const capabilitiesText = (): string => {
    const info = listModelRegistry(settings);
    const resolved = resolveModel(settings);
    const lines = [
      `Active model: ${info.activeId}${info.activeResolved ? '' : ' (NOT resolvable — check pi-video-gen.defaultModel)'}`,
    ];
    if (resolved) {
      const c = resolved.entry.capabilities;
      lines.push(
        `Provider: ${resolved.provider.style} (key ${resolved.provider.apiKey ? 'ready' : 'MISSING'})`,
        `Durations: ${c.durations[0]}-${c.durations[1]}s; Resolutions: ${c.resolutions.join('/')}; Aspect ratios: ${c.aspectRatios.join(', ')}`,
        `Native audio: ${c.nativeAudio ? 'yes' : 'no'}; First+last frame: ${c.supportsFirstLastFrame ? 'yes' : 'no'}; Max reference images: ${c.maxReferenceImages}`,
      );
    }
    lines.push('Registered models:');
    for (const m of info.models) {
      lines.push(
        `- ${m.id} [${m.provider}] aliases: ${m.aliases.join(', ')} (key ${m.keyReady ? 'ready' : 'missing'})`,
      );
    }
    return lines.join('\n');
  };

  const registerTools = () => {
    const caps = resolveModel(settings)?.entry.capabilities ?? null;

    pi.registerTool({
      name: 'video_generate',
      label: 'Generate Video Clip',
      description:
        'Generate a single short video clip (one shot) from a text prompt, optionally anchored by first/last frame images. Paid, slow (minutes per clip). For multi-shot videos, use the video-gen skill workflow instead of calling this repeatedly.',
      parameters: buildGenerateParams(caps),
      promptSnippet: 'Generate one short video clip (paid, minutes) via the active video model',
      promptGuidelines: [
        "Before composing prompts for a video task, call video_capabilities to learn the active model's duration range, aspect ratios, audio support, and first/last-frame support — do not assume.",
        'Video generation is paid and slow. State the expected clip count and duration to the user and get explicit confirmation before the first call.',
        'Only pass lastFrame when the user needs first+last-frame interpolation and the active model supports it.',
        'If a call is interrupted, resume with the returned jobId instead of submitting a new task (avoids double billing).',
        'If submit is reported as ambiguous, do not start another generation until the provider console confirms that no paid task exists.',
      ],
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        try {
          return await runGenerate(
            params as GenerateVideoParams & { jobId?: string },
            ctx,
            signal,
            onUpdate,
          );
        } catch (error) {
          console.error(`[pi-video-gen] video_generate failed: ${toLogSummary(error)}`);
          return errResult(errorMessageForUser(error));
        }
      },
    });

    pi.registerTool({
      name: 'video_render',
      label: 'Render Multi-Shot Video',
      description:
        'Render a multi-shot video from <jobDir>/render-input.json: submits one paid video task per shot (resuming persisted handles on rerun — finished shots never re-bill), downloads clips, and concatenates them into final_video.mp4. Foreground, reports progress; cancelling stops locally (remote tasks may keep billing). Frames must already exist (generate them with image_generate first).',
      parameters: Type.Object({
        renderSpecPath: Type.String({
          description:
            'Path to <jobDir>/render-input.json. The parent directory must live under the video-gen output dir and acts as the (immutable) job. Rerunning the same path resumes; revisions require a NEW job directory.',
        }),
        allowDegradations: Type.Optional(
          Type.Array(StringEnum(['first-frame-only'] as const), {
            description: 'Explicit user-approved downgrades for capability mismatches.',
          }),
        ),
      }),
      promptSnippet:
        'Render a prepared multi-shot video spec (paid, long-running) into a final mp4',
      promptGuidelines: [
        'Call ONLY after the user explicitly confirmed rendering: frames ready, shot count and cost magnitude stated.',
        'Generate all frames first via image_generate (pi-image-gen) and record their returned absolute paths in the render spec.',
        'The spec is immutable per job directory: rerunning the same path resumes identical input; revisions go in a NEW job directory.',
        'Interrupting stops locally only — remote tasks may keep billing; rerun the same spec path to resume after they finish.',
      ],
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        return runRenderTool(
          params as { renderSpecPath: string; allowDegradations?: string[] },
          ctx,
          signal,
          onUpdate,
        );
      },
    });

    pi.registerTool({
      name: 'video_capabilities',
      label: 'Video Model Capabilities',
      description:
        "Read-only: list the active video model's capabilities (duration range, resolutions, aspect ratios, native audio, first/last-frame support) and the registered models. Call before composing video prompts or shot books.",
      parameters: Type.Object({}),
      promptSnippet: 'Show active video model capabilities and registered models',
      async execute() {
        return okResult(capabilitiesText());
      },
    });
  };

  pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    reloadSettings(ctx);
    registerTools();
  });

  pi.registerCommand('video-gen', {
    description:
      'pi-video-gen: /video-gen [generate <prompt>|render <spec>|recover <jobId>|models|reload|doctor]',
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0];

      if (sub === 'generate') {
        const prompt = tokens.slice(1).join(' ').trim();
        if (!prompt) {
          ctx.ui.notify('Usage: /video-gen generate <prompt>', 'error');
          return;
        }
        const result = await runGenerate({ prompt }, ctx, ctx.signal);
        ctx.ui.notify(result.content[0]!.text, result.isError ? 'error' : 'info');
        return;
      }

      if (sub === 'reload') {
        reloadSettings(ctx);
        registerTools();
        ctx.ui.notify('pi-video-gen settings reloaded.', 'info');
        return;
      }

      if (sub === 'render') {
        const specPath = tokens[1];
        if (!specPath) {
          ctx.ui.notify('Usage: /video-gen render <jobDir/render-input.json>', 'error');
          return;
        }
        const result = await runRenderTool({ renderSpecPath: specPath }, ctx, ctx.signal);
        ctx.ui.notify(result.content[0]!.text, result.isError ? 'error' : 'info');
        return;
      }

      if (sub === 'recover') {
        // Manual resolution of ambiguous shots. Paths:
        //   reset → nothing was created, re-render the shot from scratch
        //   adopt → the task exists remotely, track it and resume polling
        const jobId = tokens[1];
        if (!jobId) {
          ctx.ui.notify(
            'Usage: /video-gen recover <jobId> [shotId reset|adopt <taskId>]\nWithout arguments, lists ambiguous shots of the job.',
            'error',
          );
          return;
        }
        try {
          assertSafeId(jobId, 'job');
        } catch {
          ctx.ui.notify(`Invalid job id "${jobId}".`, 'error');
          return;
        }
        const outputDir = resolveOutputDir(settings, ctx.cwd);
        const requestedJobDir = join(outputDir, jobId);
        let manifest: ReturnType<typeof loadRenderJob>;
        try {
          manifest = loadRenderJob(requestedJobDir);
        } catch (error) {
          ctx.ui.notify(errorMessageForUser(error), 'error');
          return;
        }
        if (!manifest) {
          ctx.ui.notify(
            `No render job found with id "${jobId}" under the video-gen output directory.`,
            'error',
          );
          return;
        }
        let jobDir: string;
        try {
          jobDir = resolveJobDirInsideOutput(outputDir, requestedJobDir);
          manifest = loadRenderJob(jobDir);
        } catch (error) {
          ctx.ui.notify(errorMessageForUser(error), 'error');
          return;
        }
        if (!manifest) {
          ctx.ui.notify(`No render job found with id "${jobId}".`, 'error');
          return;
        }

        // tokens: recover <jobId> [shotId] [reset|adopt <taskId>]
        const shotId = tokens[2];
        if (!shotId) {
          const blocked = Object.entries(manifest.shots).filter(
            ([, st]) => st.state === 'ambiguous',
          );
          if (blocked.length === 0) {
            ctx.ui.notify(`Job ${jobId} has no ambiguous shots.`, 'info');
            return;
          }
          const lines = [
            `Job ${jobId}: ${blocked.length} ambiguous shot(s) — a paid task MAY exist per shot.`,
          ];
          for (const [shotId] of blocked) {
            lines.push(
              `  ${shotId}: check the provider console, then either`,
              `    /video-gen recover ${jobId} ${shotId} reset            (nothing was created → re-render)`,
              `    /video-gen recover ${jobId} ${shotId} adopt <taskId>  (task exists → resume polling)`,
            );
          }
          ctx.ui.notify(lines.join('\n'), 'info');
          return;
        }

        // Form: /video-gen recover <jobId> <shotId> reset|adopt <taskId>
        const action = tokens[3];
        if (!action) {
          ctx.ui.notify(
            `Usage: /video-gen recover ${jobId} <shotId> reset|adopt <taskId>`,
            'error',
          );
          return;
        }
        try {
          assertSafeId(shotId, 'shot');
        } catch {
          ctx.ui.notify(`Invalid shot id "${shotId}".`, 'error');
          return;
        }
        let release: (() => void) | undefined;
        try {
          release = activeJobs.acquire(jobDir);
          // Re-read under the lock: the job may have advanced since the list/read above.
          manifest = loadRenderJob(jobDir);
          if (!manifest) {
            ctx.ui.notify(`No render job found with id "${jobId}".`, 'error');
            return;
          }
          const shot = manifest.shots[shotId];
          if (!shot) {
            ctx.ui.notify(`No shot "${shotId}" in job ${jobId}.`, 'error');
            return;
          }
          if (shot.state !== 'ambiguous') {
            ctx.ui.notify(
              `Shot "${shotId}" is not ambiguous (state: ${shot.state}). Nothing to resolve.`,
              'info',
            );
            return;
          }

          if (action === 'reset') {
            manifest.shots[shotId] = { state: 'pending', attempt: shot.attempt };
            saveRenderJob(jobDir, manifest);
            ctx.ui.notify(
              `Shot "${shotId}" reset to pending. Rerun video_render with the same render-input.json to re-render it.`,
              'info',
            );
            return;
          }
          if (action === 'adopt') {
            const taskId = tokens[4];
            if (!taskId) {
              ctx.ui.notify(`Usage: /video-gen recover ${jobId} ${shotId} adopt <taskId>`, 'error');
              return;
            }
            manifest.shots[shotId] = {
              state: 'submitted',
              attempt: shot.attempt,
              handle: {
                taskId,
                submittedAt: new Date().toISOString(),
                requestFingerprint: 'manual-adopt',
              },
              requestFingerprint: 'manual-adopt',
            };
            saveRenderJob(jobDir, manifest);
            ctx.ui.notify(
              `Shot "${shotId}" now tracks remote task ${taskId}. Rerun video_render with the same render-input.json to resume polling and download.`,
              'info',
            );
            return;
          }
          ctx.ui.notify(`Unknown recover action "${action}" — use reset or adopt.`, 'error');
        } catch (error) {
          ctx.ui.notify(errorMessageForUser(error), 'error');
        } finally {
          release?.();
        }
        return;
      }

      if (sub === 'models') {
        ctx.ui.notify(boundToolText(capabilitiesText()), 'info');
        return;
      }

      if (sub === 'doctor') {
        const result = runDoctor(ctx);
        ctx.ui.notify(result.content[0]!.text, 'info');
        return;
      }

      ctx.ui.notify(
        'pi-video-gen commands:\n  /video-gen generate <prompt>  Generate a single clip\n  /video-gen render <spec>      Render a multi-shot video\n  /video-gen recover <jobId>    Resolve ambiguous shots (reset/adopt)\n  /video-gen models             List registered models\n  /video-gen reload             Reload settings\n  /video-gen doctor             Check environment (ffmpeg, keys, image_generate, output dir)',
        'info',
      );
    },
  });

  function runDoctor(ctx: ExtensionContext): TextResult {
    const checks: string[] = [];

    // 1. video provider key + model resolution
    const resolved = resolveModel(settings);
    if (!resolved) {
      checks.push(
        `❌ defaultModel "${settings.defaultModel ?? 'seedance'}" not in registry — fix pi-video-gen.defaultModel`,
      );
    } else {
      const label = providerLabel(resolved.provider.style);
      checks.push(`✅ model: ${resolved.entry.id} [${resolved.provider.style}]`);
      checks.push(
        resolved.provider.apiKey
          ? `✅ ${label} API key configured`
          : `❌ ${label} API key missing — set apiKey for the active provider in global or agent-dir Pi settings`,
      );
    }

    // 2. ffmpeg (multi-shot concat; resolution chain: settings → env → bundled → PATH)
    const ffmpeg = resolveFfmpeg(settings.ffmpegPath);
    checks.push(
      ffmpeg.runnable
        ? `✅ ffmpeg found (source: ${ffmpeg.source})`
        : `❌ ffmpeg not runnable (source tried: ${ffmpeg.source}) — reinstall pi-video-gen to restore its platform package, or set pi-video-gen.ffmpegPath in global/agent-dir settings`,
    );

    // 3. image_generate presence (image stages live in pi-image-gen)
    try {
      const all = pi.getAllTools?.() ?? [];
      const active = pi.getActiveTools?.() ?? [];
      const registered = all.some((t) => t.name === 'image_generate');
      const enabled = active.includes('image_generate');
      checks.push(
        registered && enabled
          ? `✅ image_generate registered and active (pi-image-gen)`
          : `⚠️ image_generate ${registered ? 'registered but inactive' : 'not found'} — multi-shot workflows need pi-image-gen installed; check its config with /image-gen list`,
      );
    } catch {
      checks.push('⚠️ could not query registered tools on this runtime');
    }

    // 4. output dir writable
    const outputDir = resolveOutputDir(settings, ctx.cwd);
    try {
      mkdirSync(outputDir, { recursive: true });
      const probeDir = mkdtempSync(join(outputDir, '.doctor-probe-'));
      try {
        writeFileSync(join(probeDir, 'probe'), 'ok', { encoding: 'utf-8', flag: 'wx' });
      } finally {
        rmSync(probeDir, { recursive: true, force: true });
      }
      checks.push(`✅ output dir writable: ${outputDir}`);
    } catch {
      checks.push(`❌ output dir not writable: ${outputDir}`);
    }

    // 5. trust status
    checks.push(
      isProjectTrusted(ctx)
        ? '✅ project trusted (project-level pi-video-gen settings: whitelisted keys only)'
        : 'ℹ️ project not trusted — project-level .pi/settings.json is ignored',
    );

    return okResult(checks.join('\n'));
  }
}
