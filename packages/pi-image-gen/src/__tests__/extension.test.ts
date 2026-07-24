import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import piImageGenExtension, {
  buildImageGuidelines,
  buildImageToolParameters,
  type ImageToolCapabilities,
  QUALITY_VALUES,
  resolveImageToolCapabilities,
  sizeDescription,
} from '../index.js';
import type { ImageGenSettings } from '../types.js';

type ToolDef = {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: { properties?: Record<string, unknown> };
  execute: (...args: unknown[]) => Promise<unknown>;
};
type CommandDef = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> };
type Handler = (event: unknown, ctx: unknown) => unknown;

function setup() {
  const tools = new Map<string, ToolDef>();
  const commands = new Map<string, CommandDef>();
  const handlers = new Map<string, Handler>();
  const mockPi = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
    registerTool: vi.fn((t: ToolDef) => tools.set(t.name, t)),
    registerCommand: vi.fn((name: string, opts: CommandDef) => commands.set(name, opts)),
    appendEntry: vi.fn(),
  };
  piImageGenExtension(mockPi as any);
  return { tools, commands, handlers };
}

// The tool is registered inside session_start (after settings load), matching
// pi-web-access / pi-memory. Fire it so `tools` is populated. With no settings
// on disk the resolved api is null, which yields the fully-featured schema.
async function startSession(handlers: Map<string, Handler>, cwd = '/tmp') {
  await handlers.get('session_start')?.({}, { cwd, hasUI: true, ui: { notify: vi.fn() } });
}

function caps(
  api: ImageToolCapabilities['api'],
  quality: readonly string[] | null,
): ImageToolCapabilities {
  return { api, quality };
}

describe('piImageGenExtension', () => {
  it('registers the /image-gen command at factory time', () => {
    const { commands } = setup();
    expect(commands.has('image-gen')).toBe(true);
  });

  it('registers the image_generate tool on session_start with snippet and guidelines', async () => {
    const { tools, handlers } = setup();
    // Not registered until a session starts and settings are loaded.
    expect(tools.has('image_generate')).toBe(false);
    await startSession(handlers);
    const tool = tools.get('image_generate');
    expect(tool).toBeDefined();
    expect(tool?.promptSnippet).toBeTruthy();
    expect(Array.isArray(tool?.promptGuidelines)).toBe(true);
    expect(tool?.promptGuidelines?.length).toBeGreaterThan(0);
    // The guidance must steer away from icons/logos and clarify `n` semantics.
    const guidelines = (tool?.promptGuidelines ?? []).join('\n');
    expect(guidelines).toMatch(/icon|logo|svg/i);
    expect(guidelines).toMatch(/\bn\b/);
    // Invariant params are always present regardless of provider.
    const props = tool?.parameters.properties ?? {};
    expect(props).toHaveProperty('prompt');
    expect(props).toHaveProperty('image');
    expect(props).toHaveProperty('n');
    expect(props).toHaveProperty('size');
    expect(props).toHaveProperty('filename');
    expect(props).toHaveProperty('outputDir');
  });

  it('/image-gen generate with no prompt notifies an error and does not generate', async () => {
    const { commands, handlers } = setup();
    const notify = vi.fn();
    const ctx = { cwd: '/tmp', hasUI: true, ui: { notify } };
    await handlers.get('session_start')?.({}, ctx);
    await commands.get('image-gen')?.handler('generate', ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Usage:/), 'error');
  });

  it('/image-gen reload reloads settings and re-registers the tool', async () => {
    const { commands, tools } = setup();
    const notify = vi.fn();
    await commands.get('image-gen')?.handler('reload', { cwd: '/tmp', ui: { notify } });
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/reloaded/i), 'info');
    // Reload re-registers so the schema tracks the freshly loaded model.
    expect(tools.has('image_generate')).toBe(true);
  });

  it('/image-gen list includes ARK_API_KEY when no provider is configured', async () => {
    for (const name of [
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'DASHSCOPE_API_KEY',
      'OPENROUTER_API_KEY',
      'ARK_API_KEY',
    ]) {
      vi.stubEnv(name, undefined);
    }
    try {
      const { commands } = setup();
      const notify = vi.fn();
      await commands.get('image-gen')?.handler('', { cwd: '/tmp', ui: { notify } });
      expect(String(notify.mock.calls[0]?.[0])).toContain('ARK_API_KEY');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('resolveImageToolCapabilities', () => {
  // These cases set provider API-key env vars so the model resolves. Use
  // vi.stubEnv so the mutations are auto-reverted after each test rather than
  // leaking into other tests sharing this worker (which lost the original value).
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exposes the quality enum for the built-in openai provider', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const c = resolveImageToolCapabilities({ defaultModel: 'gpt-image-2' });
    expect(c.api).toBe('openai');
    expect(c.quality).toEqual(QUALITY_VALUES);
  });

  it('exposes the quality enum for the built-in openrouter provider', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or-test');
    const settings: ImageGenSettings = {
      defaultModel: 'openrouter/openai/gpt-image-2',
    };
    const c = resolveImageToolCapabilities(settings);
    expect(c.api).toBe('openrouter');
    expect(c.quality).toEqual(QUALITY_VALUES);
  });

  it('omits quality for openai/dall-e-3 on the built-in provider (non-gpt-image vocab)', () => {
    // Routing DALL·E 3 through the built-in openai provider (slash form) still
    // must NOT advertise low|medium|high|auto — DALL·E 3 uses standard/hd and
    // would 400. The gate keys on the gpt-image model id, not the openai wire.
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const c = resolveImageToolCapabilities({ defaultModel: 'openai/dall-e-3' });
    expect(c.api).toBe('openai');
    expect(c.quality).toBeNull();
  });

  it('omits quality for an OpenRouter route to a non-gpt-image model', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or-test');
    const c = resolveImageToolCapabilities({
      defaultModel: 'openrouter/bytedance-seed/seedream-4.5',
    });
    expect(c.api).toBe('openrouter');
    expect(c.quality).toBeNull();
  });

  it('omits quality for gemini, dashscope, and ark built-ins', () => {
    vi.stubEnv('GEMINI_API_KEY', 'gem-test');
    vi.stubEnv('DASHSCOPE_API_KEY', 'ds-test');
    vi.stubEnv('ARK_API_KEY', 'ark-test');
    expect(resolveImageToolCapabilities({ defaultModel: 'nano-banana' }).quality).toBeNull();
    expect(resolveImageToolCapabilities({ defaultModel: 'qwen-image-2.0' }).quality).toBeNull();
    expect(resolveImageToolCapabilities({ defaultModel: 'seedream' }).quality).toBeNull();
  });

  it('omits quality for a CUSTOM openai-compatible provider (vocab unknown, e.g. DALL·E 3)', () => {
    // A self-hosted / third-party OpenAI-wire model may use a different quality
    // vocabulary (DALL·E 3: standard/hd) or none — wire format != capability.
    const settings: ImageGenSettings = {
      defaultModel: 'dall-e-3',
      customProviders: {
        myopenai: {
          api: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'k',
          models: [{ id: 'dall-e-3', alias: 'dall-e-3' }],
        },
      },
    };
    const c = resolveImageToolCapabilities(settings);
    expect(c.api).toBe('openai');
    expect(c.quality).toBeNull();
  });

  it('falls back to the full schema (quality present) when the model is unset', () => {
    expect(resolveImageToolCapabilities({}).quality).toEqual(QUALITY_VALUES);
    expect(resolveImageToolCapabilities({}).api).toBeNull();
  });

  it('falls back to the full schema when the model cannot be resolved', () => {
    const c = resolveImageToolCapabilities({ defaultModel: 'no-such-model-xyz' });
    expect(c.quality).toEqual(QUALITY_VALUES);
    expect(c.api).toBeNull();
  });
});

describe('buildImageToolParameters', () => {
  it('includes a constrained quality enum when capabilities allow it', () => {
    const props = buildImageToolParameters(caps('openai', QUALITY_VALUES)).properties as Record<
      string,
      { enum?: unknown[] }
    >;
    expect(props).toHaveProperty('quality');
    expect(props.quality?.enum).toEqual([...QUALITY_VALUES]);
  });

  it('omits quality when capabilities disallow it', () => {
    for (const api of ['gemini', 'dashscope', 'ark'] as const) {
      const props = buildImageToolParameters(caps(api, null)).properties as Record<string, unknown>;
      expect(props).not.toHaveProperty('quality');
    }
  });

  it('always exposes the invariant params', () => {
    const cases: ImageToolCapabilities[] = [
      caps('openai', QUALITY_VALUES),
      caps('gemini', null),
      caps('ark', null),
      caps(null, QUALITY_VALUES),
    ];
    for (const c of cases) {
      const props = buildImageToolParameters(c).properties as Record<string, unknown>;
      for (const key of ['prompt', 'image', 'n', 'size', 'filename', 'outputDir']) {
        expect(props).toHaveProperty(key);
      }
    }
  });
});

describe('sizeDescription', () => {
  it('warns about the 2K minimum for ark/Seedream', () => {
    expect(sizeDescription('ark')).toMatch(/2K|2048/);
  });

  it('uses the generic 1024x1024 hint for other providers', () => {
    expect(sizeDescription('openai')).toMatch(/1024x1024/);
    expect(sizeDescription(null)).toMatch(/1024x1024/);
  });
});

describe('image_generate execute error surfaces are sanitized', () => {
  // A provider CDN URL whose credential lives in the query — the thing a raw
  // fetch rejection would reproduce into stderr / the tool result if we trusted
  // plain Error messages. It must reach NEITHER surface.
  const SIGNED_URL = 'https://cdn.example.com/gen/out.png?X-Amz-Signature=SECRET&token=USERTOKEN';
  // A 1x1 PNG (magic bytes + minimal IDAT) so materialize() accepts the result
  // and the run reaches the write step, where the output-dir failure fires.
  const PNG_B64 = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000115c46f250000000049454e44ae426082',
    'hex',
  ).toString('base64');
  const tmpDirs: string[] = [];
  let realFetch: typeof fetch;

  const makeProject = (settings: ImageGenSettings): string => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-image-gen-execute-'));
    tmpDirs.push(dir);
    mkdirSync(join(dir, '.pi'), { recursive: true });
    writeFileSync(join(dir, '.pi', 'settings.json'), JSON.stringify({ 'pi-image-gen': settings }));
    return dir;
  };

  const runExecute = async (cwd: string, params: Record<string, unknown> = { prompt: 'a cat' }) => {
    const { tools, handlers } = setup();
    await handlers.get('session_start')?.({}, { cwd, hasUI: true, ui: { notify: vi.fn() } });
    const tool = tools.get('image_generate');
    if (!tool) throw new Error('tool not registered');
    return (await tool.execute('call-1', params, undefined, undefined, {
      cwd,
    })) as { content: Array<{ text: string }>; isError?: boolean };
  };

  beforeEach(() => {
    tmpDirs.length = 0;
    realFetch = globalThis.fetch;
    // Stub (don't assign) so it's auto-reverted after each test — a bare
    // process.env write would leak into other tests sharing this worker.
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = realFetch;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('leaks neither the signed download URL nor a raw error to stderr or the tool result', async () => {
    // Generation returns a url-style result; the follow-up download rejects with
    // the full signed URL in its message — the exact plain-Error leak path.
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: SIGNED_URL }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`request to ${SIGNED_URL} failed, reason: ECONNREFUSED`);
    }) as typeof fetch;
    globalThis.fetch = fetchImpl;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runExecute(makeProject({ defaultModel: 'gpt-image-2' }));
      expect(result.isError).toBe(true);
      const toolText = result.content.map((c) => c.text).join('\n');
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      for (const surface of [toolText, logged]) {
        expect(surface).not.toContain('X-Amz-Signature');
        expect(surface).not.toContain('SECRET');
        expect(surface).not.toContain('USERTOKEN');
        expect(surface).not.toContain('token=');
        expect(surface).not.toContain('ECONNREFUSED');
      }
      // The stderr line is the terse, body-free category summary.
      expect(logged).toContain('generated image download failed');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('classifies a download body that breaks after headers — not a generic failure', async () => {
    // Generation returns a url-style result; the download response's headers
    // arrive OK (200) but the body read (arrayBuffer) rejects mid-stream. Before
    // the fix this escaped as `unexpected AbortError` with a generic user message;
    // now it is a body-free download category, and the signed URL never leaks.
    const brokenBodyResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      async arrayBuffer() {
        throw new DOMException('aborted', 'AbortError');
      },
    } as unknown as Response;
    const fetchImpl: typeof fetch = (async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: SIGNED_URL }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return brokenBodyResponse;
    }) as typeof fetch;
    globalThis.fetch = fetchImpl;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runExecute(makeProject({ defaultModel: 'gpt-image-2' }));
      expect(result.isError).toBe(true);
      const toolText = result.content.map((c) => c.text).join('\n');
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // Real, greppable download category — not the empty "unexpected" fallback.
      expect(logged).toContain('generated image download failed');
      expect(logged).not.toContain('unexpected');
      // User gets an actionable download error, not the generic internal-fault line.
      expect(toolText).not.toMatch(/failed unexpectedly/i);
      // The signed URL still leaks to neither surface.
      for (const surface of [toolText, logged]) {
        expect(surface).not.toContain('X-Amz-Signature');
        expect(surface).not.toContain('SECRET');
        expect(surface).not.toContain('USERTOKEN');
        expect(surface).not.toContain('token=');
      }
    } finally {
      errSpy.mockRestore();
    }
  });

  it('logs only a body-free config summary when the model is unresolvable', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runExecute(makeProject({ defaultModel: 'no-such-model-xyz' }));
      expect(result.isError).toBe(true);
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('[pi-image-gen] image_generate failed:');
      expect(logged).toContain('model did not resolve');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('gives an actionable, path-free error when the output dir cannot be created', async () => {
    // Generation succeeds, but writing fails: outputDir is nested UNDER a regular
    // file, so mkdir throws ENOTDIR — the same class as the reviewer's
    // /dev/null/child repro. The user must get an actionable hint (not a generic
    // "check the logs" with nothing in them), and no absolute path may leak.
    const cwd = makeProject({ defaultModel: 'gpt-image-2' });
    const filePath = join(cwd, 'not-a-dir');
    writeFileSync(filePath, 'x');
    const badOutputDir = join(filePath, 'child'); // parent is a file → ENOTDIR

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runExecute(cwd, { prompt: 'a cat', outputDir: badOutputDir });
      expect(result.isError).toBe(true);
      const toolText = result.content.map((c) => c.text).join('\n');
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // Actionable for the user — points at the output directory knob, and is NOT
      // the generic internal-fault fallback.
      expect(toolText).toMatch(/output directory/i);
      expect(toolText).not.toMatch(/failed unexpectedly/i);
      // stderr carries a real, greppable category — not an empty "unexpected".
      expect(logged).toContain('create the output directory failed');
      // No absolute path leaks to either surface.
      for (const surface of [toolText, logged]) {
        expect(surface).not.toContain(badOutputDir);
        expect(surface).not.toContain(cwd);
      }
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('buildImageGuidelines', () => {
  it('mentions the quality knob only when the schema exposes it', () => {
    expect(buildImageGuidelines(caps('openai', QUALITY_VALUES)).join('\n')).toMatch(/quality/i);
    expect(buildImageGuidelines(caps('gemini', null)).join('\n')).not.toMatch(/quality/i);
    expect(buildImageGuidelines(caps('ark', null)).join('\n')).not.toMatch(/quality/i);
  });

  it('always steers away from icons/logos and clarifies n semantics', () => {
    const cases: ImageToolCapabilities[] = [
      caps('openai', QUALITY_VALUES),
      caps('gemini', null),
      caps('ark', null),
      caps(null, QUALITY_VALUES),
    ];
    for (const c of cases) {
      const text = buildImageGuidelines(c).join('\n');
      expect(text).toMatch(/icon|logo|svg/i);
      expect(text).toMatch(/\bn\b/);
    }
  });
});
