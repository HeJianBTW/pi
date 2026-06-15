import { describe, expect, test } from 'vitest';
import { initDws } from '../cli.js';

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
});
