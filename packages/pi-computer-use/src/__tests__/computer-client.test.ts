import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockSend = vi.fn();
const mockClose = vi.fn();
const mockOff = vi.fn();
let openHandler: (() => void) | null = null;
let errorHandler: ((err: Error) => void) | null = null;
let messageHandler: ((data: string) => void) | null = null;
let shouldAutoOpen = true;

vi.mock('ws', () => ({
  default: class MockWebSocket {
    static OPEN = 1;
    readyState = 1;
    send = mockSend;
    close = mockClose;
    off = mockOff;
    on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'open') {
        openHandler = handler as () => void;
        if (shouldAutoOpen) setTimeout(() => handler(), 0);
      }
      if (event === 'error') errorHandler = handler as (err: Error) => void;
      if (event === 'message') messageHandler = handler as (data: string) => void;
    });
  },
}));

const { ComputerClient } = await import('../computer-client.js');

describe('ComputerClient', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockClose.mockClear();
    mockOff.mockClear();
    openHandler = null;
    errorHandler = null;
    messageHandler = null;
    shouldAutoOpen = true;
  });

  describe('connect()', () => {
    test('resolves when WebSocket opens (no auth)', async () => {
      const client = new ComputerClient({ host: '127.0.0.1', port: 8000 });
      await client.connect();
    });

    test('authenticates when apiKey + vmName are set', async () => {
      const client = new ComputerClient({
        host: 'remote.example.com',
        port: 443,
        apiKey: 'secret',
        vmName: 'test-vm',
      });

      mockSend.mockImplementation(() => {
        setTimeout(() => {
          messageHandler?.(JSON.stringify({ success: true }));
        }, 0);
      });

      await client.connect();

      expect(mockSend).toHaveBeenCalledWith(
        JSON.stringify({
          command: 'authenticate',
          params: { api_key: 'secret', container_name: 'test-vm' },
        }),
      );
    });

    test('rejects when authentication fails', async () => {
      const client = new ComputerClient({
        host: 'remote.example.com',
        port: 443,
        apiKey: 'bad-key',
        vmName: 'test-vm',
      });

      mockSend.mockImplementation(() => {
        setTimeout(() => {
          messageHandler?.(JSON.stringify({ success: false, error: 'invalid key' }));
        }, 0);
      });

      await expect(client.connect()).rejects.toThrow('Authentication failed');
    });

    test('rejects when WebSocket emits error', async () => {
      shouldAutoOpen = false;
      const client = new ComputerClient({ host: '127.0.0.1', port: 9999 });

      const connectPromise = client.connect();

      await vi.waitFor(() => expect(errorHandler).not.toBeNull());
      errorHandler!(new Error('ECONNREFUSED'));

      await expect(connectPromise).rejects.toThrow('WebSocket connection failed');
    });
  });

  describe('sendCommand()', () => {
    test('sends JSON and resolves with parsed response', async () => {
      const client = new ComputerClient({ host: '127.0.0.1', port: 8000 });
      await client.connect();

      mockSend.mockImplementation(() => {
        setTimeout(() => {
          messageHandler?.(JSON.stringify({ status: 'ok', x: 100 }));
        }, 0);
      });

      const result = await client.sendCommand('left_click', { x: 100, y: 200 });

      expect(result).toEqual({ status: 'ok', x: 100 });
      expect(mockSend).toHaveBeenCalledWith(
        JSON.stringify({ command: 'left_click', params: { x: 100, y: 200 } }),
      );
    });

    test('rejects when response contains error field', async () => {
      const client = new ComputerClient({ host: '127.0.0.1', port: 8000 });
      await client.connect();

      mockSend.mockImplementation(() => {
        setTimeout(() => {
          messageHandler?.(JSON.stringify({ error: 'element not found' }));
        }, 0);
      });

      await expect(client.sendCommand('left_click', { x: 0, y: 0 })).rejects.toThrow(
        'element not found',
      );
    });

    test('throws when WebSocket is not connected', async () => {
      const client = new ComputerClient({ host: '127.0.0.1', port: 8000 });

      await expect(client.sendCommand('screenshot', {})).rejects.toThrow('WebSocket not connected');
    });

    test('serializes commands sequentially via command lock', async () => {
      const client = new ComputerClient({ host: '127.0.0.1', port: 8000 });
      await client.connect();

      const callOrder: string[] = [];
      let callCount = 0;

      mockSend.mockImplementation((data: string) => {
        const parsed = JSON.parse(data);
        callCount++;
        const currentCall = callCount;
        callOrder.push(`send:${parsed.command}`);

        setTimeout(
          () => {
            callOrder.push(`response:${parsed.command}`);
            messageHandler?.(JSON.stringify({ seq: currentCall }));
          },
          currentCall === 1 ? 30 : 5,
        );
      });

      const [r1, r2] = await Promise.all([
        client.sendCommand('left_click', { x: 1, y: 1 }),
        client.sendCommand('type_text', { text: 'hi' }),
      ]);

      expect(r1).toEqual({ seq: 1 });
      expect(r2).toEqual({ seq: 2 });
      expect(callOrder.indexOf('response:left_click')).toBeLessThan(
        callOrder.indexOf('send:type_text'),
      );
    });
  });

  describe('screenshot()', () => {
    test('returns image_data from response', async () => {
      const client = new ComputerClient({ host: '127.0.0.1', port: 8000 });
      await client.connect();

      mockSend.mockImplementation(() => {
        setTimeout(() => {
          messageHandler?.(JSON.stringify({ image_data: 'iVBORw0KGgoAAAA==' }));
        }, 0);
      });

      const base64 = await client.screenshot();
      expect(base64).toBe('iVBORw0KGgoAAAA==');
    });

    test('throws when no image_data in response', async () => {
      const client = new ComputerClient({ host: '127.0.0.1', port: 8000 });
      await client.connect();

      mockSend.mockImplementation(() => {
        setTimeout(() => {
          messageHandler?.(JSON.stringify({ status: 'ok' }));
        }, 0);
      });

      await expect(client.screenshot()).rejects.toThrow('No image_data in screenshot response');
    });
  });

  describe('close()', () => {
    test('closes the WebSocket connection', async () => {
      const client = new ComputerClient({ host: '127.0.0.1', port: 8000 });
      await client.connect();

      await client.close();
      expect(mockClose).toHaveBeenCalled();
    });

    test('no-ops when not connected', async () => {
      const client = new ComputerClient({ host: '127.0.0.1', port: 8000 });
      await client.close();
      expect(mockClose).not.toHaveBeenCalled();
    });
  });
});
