import { describe, expect, test } from 'vitest';
import { initDws } from '../cli.js';

describe('initDws', () => {
  test('throws when clientId is missing', () => {
    expect(() => initDws({ clientSecret: 'secret' })).toThrow(
      'clientId and clientSecret are required',
    );
  });

  test('throws when clientSecret is missing', () => {
    expect(() => initDws({ clientId: 'dingabc' })).toThrow(
      'clientId and clientSecret are required',
    );
  });
});
