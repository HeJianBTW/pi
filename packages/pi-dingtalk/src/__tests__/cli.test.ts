import { describe, expect, it, test, vi } from 'vitest';

const mockExecFile = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

const { initDws } = await import('../cli.js');

describe('initDws', () => {
  test('rejects when clientId is missing', async () => {
    await expect(initDws({ clientSecret: 'secret' })).rejects.toThrow(
      'clientId and clientSecret are required',
    );
  });

  test('rejects when clientSecret is missing', async () => {
    await expect(initDws({ clientId: 'dingabc' })).rejects.toThrow(
      'clientId and clientSecret are required',
    );
  });

  it('passes credentials as process arguments without shell interpolation', async () => {
    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, '', ''),
    );

    await initDws({ clientId: 'id; touch /tmp/pwned', clientSecret: 'secret$(id)' });

    expect(mockExecFile).toHaveBeenCalledWith(
      'dws',
      [
        'auth',
        'login',
        '--client-id',
        'id; touch /tmp/pwned',
        '--client-secret',
        'secret$(id)',
        '--yes',
      ],
      expect.any(Function),
    );
  });
});
