import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('node:https', () => ({ request: requestMock }));

import { safeFetch } from '../network.js';

describe('network transport', () => {
  it('uses the single-address lookup contract when connecting to a pinned address', async () => {
    requestMock.mockImplementation(
      (
        _url: URL,
        options: {
          family?: number;
          lookup: (
            hostname: string,
            options: { all: boolean; family: number },
            callback: (error: Error | null, address: unknown, family?: number) => void,
          ) => void;
        },
        onResponse: (response: {
          headers: Record<string, string>;
          statusCode: number;
          statusMessage: string;
        }) => void,
      ) => {
        const request = new EventEmitter() as EventEmitter & { end(): void };
        request.end = () => {
          const all = options.family === undefined;
          options.lookup(
            'cdn.example',
            { all, family: options.family ?? 0 },
            (error, address, family) => {
              if (error) {
                request.emit('error', error);
                return;
              }
              if (all ? !Array.isArray(address) : typeof address !== 'string' || !family) {
                request.emit('error', new TypeError('lookup callback returned the wrong shape'));
                return;
              }
              onResponse({ headers: {}, statusCode: 200, statusMessage: 'OK' });
            },
          );
        };
        return request;
      },
    );

    await expect(
      safeFetch(
        'https://cdn.example/image.png',
        { method: 'HEAD' },
        { lookup: async () => [{ address: '93.184.216.34', family: 4 }] },
      ),
    ).resolves.toMatchObject({ status: 200 });
  });
});
