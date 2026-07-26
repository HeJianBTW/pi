import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';

describe('config', () => {
  it('excludes payloads by default', () => {
    expect(resolveConfig()).toMatchObject({
      includePayloads: false,
    });
  });
});
