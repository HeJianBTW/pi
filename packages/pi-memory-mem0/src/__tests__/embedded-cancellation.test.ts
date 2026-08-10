import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMem0Provider } from '../provider.js';

const state = vi.hoisted(() => ({
  addCalls: 0,
  resolvers: [] as Array<(value: { results: [] }) => void>,
}));

vi.mock('mem0ai/oss', () => ({
  Memory: class {
    async getAll() {
      return [];
    }

    add() {
      state.addCalls++;
      return new Promise<{ results: [] }>((resolve) => state.resolvers.push(resolve));
    }
  },
}));

describe('embedded Mem0 provider cancellation', () => {
  beforeEach(() => {
    state.addCalls = 0;
    state.resolvers.length = 0;
  });

  it('keeps add calls serialized until a cancelled underlying write settles', async () => {
    const provider = await createMem0Provider({
      config: { mode: 'embedded', oss: { disableHistory: true } },
    });
    const controller = new AbortController();
    const first = provider.add([{ role: 'user', content: 'first' }], {
      userId: 'company-1',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(state.addCalls).toBe(1));

    controller.abort(new Error('caller cancelled'));
    await expect(first).rejects.toThrow('caller cancelled');
    const second = provider.add([{ role: 'user', content: 'second' }], {
      userId: 'company-1',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.addCalls).toBe(1);

    state.resolvers[0]!({ results: [] });
    await vi.waitFor(() => expect(state.addCalls).toBe(2));
    state.resolvers[1]!({ results: [] });
    await second;
  });

  it('does not start an add cancelled while waiting for the previous write', async () => {
    const provider = await createMem0Provider({
      config: { mode: 'embedded', oss: { disableHistory: true } },
    });
    const first = provider.add([{ role: 'user', content: 'first' }], {
      userId: 'company-1',
    });
    await vi.waitFor(() => expect(state.addCalls).toBe(1));

    const controller = new AbortController();
    const queued = provider.add([{ role: 'user', content: 'cancelled' }], {
      userId: 'company-1',
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('caller cancelled'));
    await expect(queued).rejects.toThrow('caller cancelled');

    const third = provider.add([{ role: 'user', content: 'third' }], {
      userId: 'company-1',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.addCalls).toBe(1);

    state.resolvers[0]!({ results: [] });
    await first;
    await vi.waitFor(() => expect(state.addCalls).toBe(2));
    state.resolvers[1]!({ results: [] });
    await third;
  });
});
