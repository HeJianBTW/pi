import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmbiguousSubmitError, RemoteTaskNotFoundError } from '../errors.js';
import { newapiAdapter } from '../providers/newapi.js';
import type { ResolvedProvider } from '../types.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-newapi');
afterEach(() => rmSync(suiteDir, { recursive: true, force: true }));
beforeEach(() => {
  mkdirSync(suiteDir, { recursive: true });
  writeFileSync(join(suiteDir, 'frame.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

const provider: ResolvedProvider = {
  style: 'newapi',
  apiKey: 'test-key',
  baseUrl: 'https://newapi.example.com',
};

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('newapiAdapter.submit', () => {
  it('builds the body with image + metadata and prefers task_id', async () => {
    let seen:
      | { url: string; headers: Record<string, string>; body: Record<string, unknown> }
      | undefined;
    const fetchImpl = mockFetch((url, init) => {
      seen = {
        url,
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      };
      return jsonResponse(201, { id: 'video_123', task_id: 'abcd1234', status: 'processing' });
    });

    const handle = await newapiAdapter.submit(
      provider,
      'kling-v1',
      {
        prompt: 'waves',
        firstFramePath: join(suiteDir, 'frame.png'),
        lastFramePath: join(suiteDir, 'frame.png'),
        referenceImagePaths: [join(suiteDir, 'frame.png')],
        durationSec: 5,
        aspectRatio: '16:9',
        resolution: '1080p',
      },
      fetchImpl,
    );

    expect(handle.taskId).toBe('abcd1234');
    expect(seen?.url).toBe('https://newapi.example.com/v1/video/generations');
    expect(seen?.headers.authorization).toBe('Bearer test-key');
    expect(seen?.body.model).toBe('kling-v1');
    expect(seen?.body.prompt).toBe('waves');
    expect(seen?.body.duration).toBe(5);
    expect(String(seen?.body.image)).toMatch(/^data:image\/png;base64,/);
    const metadata = seen?.body.metadata as Record<string, unknown>;
    expect(metadata.aspect_ratio).toBe('16:9');
    expect(metadata.resolution).toBe('1080p');
    expect(String(metadata.image_tail)).toMatch(/^data:image\/png;base64,/);
    expect(metadata.image_urls).toHaveLength(1);
  });

  it('omits image and metadata for a bare text-to-video call and falls back to id', async () => {
    let seenBody: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(201, { id: 'video_123', status: 'processing' });
    });

    const handle = await newapiAdapter.submit(provider, 'm', { prompt: 'x' }, fetchImpl);

    expect(handle.taskId).toBe('video_123');
    expect(seenBody?.image).toBeUndefined();
    expect(seenBody?.metadata).toBeUndefined();
    expect(seenBody?.duration).toBeUndefined();
  });

  it.each([
    'https://newapi.example.com/',
    'https://newapi.example.com/v1',
  ])('normalizes the configured baseUrl %s to the server root', async (baseUrl) => {
    let seenUrl = '';
    const fetchImpl = mockFetch((url) => {
      seenUrl = url;
      return jsonResponse(201, { task_id: 't-1' });
    });
    await newapiAdapter.submit({ ...provider, baseUrl }, 'm', { prompt: 'x' }, fetchImpl);
    expect(seenUrl).toBe('https://newapi.example.com/v1/video/generations');
  });

  it('fails fast on 4xx, ambiguous on 5xx/network/parse, missing key', async () => {
    const f400 = mockFetch(() => jsonResponse(400, {}));
    await expect(newapiAdapter.submit(provider, 'm', { prompt: 'x' }, f400)).rejects.toThrow(
      /HTTP 400/,
    );
    const f500 = mockFetch(() => jsonResponse(500, {}));
    await expect(newapiAdapter.submit(provider, 'm', { prompt: 'x' }, f500)).rejects.toThrow(
      /ambiguous/i,
    );
    const fNet = mockFetch(() => {
      throw new Error('reset');
    });
    await expect(newapiAdapter.submit(provider, 'm', { prompt: 'x' }, fNet)).rejects.toThrow(
      /ambiguous/i,
    );
    const fHtml = mockFetch(() => new Response('<html>', { status: 200 }));
    await expect(newapiAdapter.submit(provider, 'm', { prompt: 'x' }, fHtml)).rejects.toThrow(
      /ambiguous/i,
    );
    await expect(
      newapiAdapter.submit(
        { style: 'newapi', baseUrl: provider.baseUrl },
        'm',
        { prompt: 'x' },
        f400,
      ),
    ).rejects.toThrow(/api key/i);
  });

  it('treats 2xx without any task id as ambiguous', async () => {
    await expect(
      newapiAdapter.submit(
        provider,
        'm',
        { prompt: 'x' },
        mockFetch(() => jsonResponse(201, { status: 'processing' })),
      ),
    ).rejects.toBeInstanceOf(AmbiguousSubmitError);
  });
});

describe('newapiAdapter.inspect', () => {
  const handle = { taskId: 'abcd1234', submittedAt: '', requestFingerprint: 'fp' };

  it('maps the full status enum and reads url', async () => {
    const cases: [string, unknown][] = [
      ['queued', { phase: 'pending' }],
      ['processing', { phase: 'running' }],
      ['in_progress', { phase: 'running' }],
      ['succeeded', { phase: 'succeeded', videoUrl: 'https://cdn.example/v.mp4' }],
      ['failed', { phase: 'failed', message: 'boom' }],
    ];
    for (const [status, expected] of cases) {
      let seenUrl = '';
      const fetchImpl = mockFetch((url) => {
        seenUrl = url;
        return jsonResponse(200, {
          task_id: 'abcd1234',
          status,
          url: 'https://cdn.example/v.mp4',
          error: { message: 'boom' },
        });
      });
      expect(await newapiAdapter.inspect(provider, handle, fetchImpl)).toEqual(expected);
      expect(seenUrl).toBe('https://newapi.example.com/v1/video/generations/abcd1234');
    }
  });

  it('accepts a string error on failed tasks', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(200, { status: 'failed', error: 'bad prompt' }));
    expect(await newapiAdapter.inspect(provider, handle, fetchImpl)).toEqual({
      phase: 'failed',
      message: 'bad prompt',
    });
  });

  it('throws on succeeded-without-url and unknown status', async () => {
    const noUrl = mockFetch(() => jsonResponse(200, { status: 'succeeded' }));
    await expect(newapiAdapter.inspect(provider, handle, noUrl)).rejects.toThrow(/no video URL/i);
    const weird = mockFetch(() => jsonResponse(200, { status: 'mystery' }));
    await expect(newapiAdapter.inspect(provider, handle, weird)).rejects.toThrow(
      /unknown task status/i,
    );
  });

  it('maps a 404 to RemoteTaskNotFoundError', async () => {
    const f404 = mockFetch(() => jsonResponse(404, { message: 'Task not found' }));
    await expect(newapiAdapter.inspect(provider, handle, f404)).rejects.toBeInstanceOf(
      RemoteTaskNotFoundError,
    );
  });
});

/**
 * Channels routed through NewAPI's task framework answer with the envelope
 * {code, data: {status: UPPERCASE, result_url, fail_reason, data: upstream}} —
 * shape captured from a live relay (token.helige.cn, 2026-07).
 */
describe('newapiAdapter task-framework envelope', () => {
  const handle = { taskId: 'task_abc', submittedAt: '', requestFingerprint: 'fp' };

  it('submit unwraps the envelope to find task_id', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(200, { code: 'success', message: '', data: { task_id: 'task_abc' } }),
    );
    const h = await newapiAdapter.submit(provider, 'm', { prompt: 'x' }, fetchImpl);
    expect(h.taskId).toBe('task_abc');
  });

  it('maps uppercase framework statuses', async () => {
    const cases: [string, unknown][] = [
      ['SUBMITTED', { phase: 'pending' }],
      ['QUEUED', { phase: 'pending' }],
      ['IN_PROGRESS', { phase: 'running' }],
      ['PROCESSING', { phase: 'running' }],
    ];
    for (const [status, expected] of cases) {
      const fetchImpl = mockFetch(() =>
        jsonResponse(200, { code: 'success', message: '', data: { task_id: 'task_abc', status } }),
      );
      expect(await newapiAdapter.inspect(provider, handle, fetchImpl)).toEqual(expected);
    }
  });

  it('reads the video url from result_url, falling back to the nested upstream payload', async () => {
    const withResultUrl = mockFetch(() =>
      jsonResponse(200, {
        code: 'success',
        message: '',
        data: {
          task_id: 'task_abc',
          status: 'SUCCESS',
          progress: '100%',
          result_url: 'https://cdn.example/from-result-url.mp4',
          data: { status: 'succeeded', content: { video_url: 'https://cdn.example/nested.mp4' } },
        },
      }),
    );
    expect(await newapiAdapter.inspect(provider, handle, withResultUrl)).toEqual({
      phase: 'succeeded',
      videoUrl: 'https://cdn.example/from-result-url.mp4',
    });

    const nestedOnly = mockFetch(() =>
      jsonResponse(200, {
        code: 'success',
        message: '',
        data: {
          task_id: 'task_abc',
          status: 'SUCCESS',
          data: { status: 'succeeded', content: { video_url: 'https://cdn.example/nested.mp4' } },
        },
      }),
    );
    expect(await newapiAdapter.inspect(provider, handle, nestedOnly)).toEqual({
      phase: 'succeeded',
      videoUrl: 'https://cdn.example/nested.mp4',
    });
  });

  it('reads failure text from fail_reason', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(200, {
        code: 'success',
        message: '',
        data: { task_id: 'task_abc', status: 'FAILURE', fail_reason: 'content rejected' },
      }),
    );
    expect(await newapiAdapter.inspect(provider, handle, fetchImpl)).toEqual({
      phase: 'failed',
      message: 'content rejected',
    });
  });
});
