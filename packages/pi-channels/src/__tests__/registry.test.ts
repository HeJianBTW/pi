import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelRegistry } from '../registry.js';

describe('ChannelRegistry', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not forward webhook credentials to a recipient outside configured routes', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const log = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const registry = new ChannelRegistry();
    registry.setLogger(log);
    await registry.loadConfig(
      {
        adapters: {
          webhook: { type: 'webhook', secret: 'configured-secret' },
        },
        routes: {
          ops: {
            adapter: 'webhook',
            recipient: 'https://allowed.example/hook?token=recipient-secret',
          },
        },
      },
      '/workspace',
    );

    const rejected = await registry.send({
      adapter: 'ops',
      recipient: 'https://attacker.example/collect',
      text: 'hello',
    });
    const allowed = await registry.send({ adapter: 'ops', recipient: '', text: 'hello' });

    expect(rejected).toEqual({
      ok: false,
      error: 'Credentialed webhook destinations must use a configured route.',
    });
    expect(allowed).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://allowed.example/hook?token=recipient-secret',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer configured-secret' }),
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('recipient-secret');
  });

  it('rejects a private webhook destination even when the adapter has no credentials', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new ChannelRegistry();
    await registry.loadConfig(
      {
        adapters: {
          webhook: { type: 'webhook' },
        },
      },
      '/workspace',
    );

    await expect(
      registry.send({
        adapter: 'webhook',
        recipient: 'http://127.0.0.1/private',
        text: 'hello',
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'Outbound URL must use a public HTTP(S) destination.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs bounded metadata without message text or raw adapter errors', async () => {
    const log = vi.fn();
    const registry = new ChannelRegistry();
    registry.setLogger(log);
    registry.register('failing', {
      direction: 'outgoing',
      send: async () => {
        throw new Error('remote body contains configured-secret');
      },
    });

    await registry.send({
      adapter: 'failing',
      recipient: 'target',
      text: 'private message',
      source: 'unit',
    });

    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).not.toContain('private message');
    expect(serialized).not.toContain('configured-secret');
    expect(log).toHaveBeenCalledWith(
      'message_send_failed',
      { adapter: 'failing', source: 'unit' },
      'ERROR',
    );
  });
});
