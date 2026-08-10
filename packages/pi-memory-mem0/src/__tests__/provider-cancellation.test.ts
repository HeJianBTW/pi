import { describe, expect, it, vi } from 'vitest';
import { createMem0Provider } from '../provider.js';

const search = vi.fn(() => new Promise(() => {}));

vi.mock('mem0ai', () => ({
  MemoryClient: class {
    _fetchWithErrorHandling = vi.fn();
    search = search;
  },
}));

describe('SDK-backed Mem0 provider cancellation', () => {
  it('stops waiting for a platform SDK request when the caller aborts', async () => {
    const provider = await createMem0Provider({
      config: { mode: 'platform', apiKey: 'm0-test' },
    });
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const pending = provider.search('pets', {
      userId: 'company-1',
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});
