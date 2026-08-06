import { describe, expect, it, vi } from 'vitest';
import {
  resolveBundledTarget,
  resolveDriverLayout,
  resolveUnixSocketPath,
  SanitizingJsonSchemaValidator,
  sanitizeSchemaFormats,
} from '../mcp-client.js';

describe('CuaDriverClient', () => {
  it.each([
    ['darwin', 'arm64', 'darwin-universal'],
    ['darwin', 'x64', 'darwin-universal'],
    ['linux', 'arm64', 'linux-arm64'],
    ['linux', 'x64', 'linux-x64'],
    ['win32', 'arm64', 'win32-arm64'],
    ['win32', 'x64', 'win32-x64'],
  ])('resolves %s/%s to %s', (platform, arch, expected) => {
    expect(resolveBundledTarget(platform, arch)).toBe(expected);
  });

  it('uses the bundled Rust app identity on macOS', () => {
    expect(resolveDriverLayout({ mode: 'bundled' }, '/package', 'darwin', 'arm64')).toEqual({
      appPath: '/package/bin/darwin-universal/CuaDriver.app',
      binaryPath: '/package/bin/darwin-universal/CuaDriver.app/Contents/MacOS/cua-driver',
      embedded: false,
    });
  });

  it('uses embedded mode for a custom macOS binary', () => {
    expect(
      resolveDriverLayout(
        { mode: 'path', binaryPath: '/opt/cua-driver' },
        '/package',
        'darwin',
        'arm64',
      ),
    ).toEqual({ binaryPath: '/opt/cua-driver', embedded: true });
  });

  it('falls back to /tmp when the configured temp path exceeds Unix socket limits', () => {
    const longTempDir = `/var/folders/${'nested/'.repeat(14)}T`;

    expect(resolveUnixSocketPath(longTempDir, '123-deadbeef')).toBe(
      '/tmp/pi-cua-123-deadbeef.sock',
    );
    expect(Buffer.byteLength(resolveUnixSocketPath('/tmp', '123-deadbeef'))).toBeLessThan(91);
  });
});

describe('sanitizeSchemaFormats', () => {
  it('rewrites uint64 format to standard integer constraints', () => {
    expect(sanitizeSchemaFormats({ type: 'integer', format: 'uint64' })).toEqual({
      type: 'integer',
      minimum: 0,
    });
  });

  it('rewrites uint32 with an explicit maximum', () => {
    expect(sanitizeSchemaFormats({ format: 'uint32' })).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 4_294_967_295,
    });
  });

  it('rewrites nested schemas in the verify_state shape', () => {
    const schema = {
      type: 'object',
      properties: {
        elapsed_ms: { type: 'integer', format: 'uint64' },
        predicates: {
          type: 'array',
          items: { type: 'object', properties: { index: { format: 'uint64' } } },
        },
        delivery: { type: 'object', properties: { delivered_count: { format: 'uint32' } } },
      },
    };

    const sanitized = sanitizeSchemaFormats(schema);
    expect(sanitized.properties.elapsed_ms).toEqual({ type: 'integer', minimum: 0 });
    expect(sanitized.properties.predicates.items.properties.index).toEqual({
      type: 'integer',
      minimum: 0,
    });
    expect(sanitized.properties.delivery.properties.delivered_count).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 4_294_967_295,
    });
  });

  it('leaves standard formats untouched', () => {
    const schema = { type: 'string', format: 'date-time' };
    expect(sanitizeSchemaFormats(schema)).toEqual(schema);
  });

  it('does not override existing bounds', () => {
    expect(sanitizeSchemaFormats({ format: 'uint32', minimum: 1, maximum: 10 })).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 10,
    });
  });

  it('does not mutate the input schema', () => {
    const schema = { properties: { samples: { format: 'uint64' } } };
    sanitizeSchemaFormats(schema);
    expect(schema).toEqual({ properties: { samples: { format: 'uint64' } } });
  });

  it('sanitizes properties named like schema keywords', () => {
    const schema = {
      type: 'object',
      properties: {
        default: { type: 'integer', format: 'uint64' },
        enum: { type: 'integer', format: 'uint32' },
      },
      $defs: { const: { format: 'uint64' } },
    };

    const sanitized = sanitizeSchemaFormats(schema);
    expect(sanitized.properties.default).toEqual({ type: 'integer', minimum: 0 });
    expect(sanitized.properties.enum).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 4_294_967_295,
    });
    expect(sanitized.$defs.const).toEqual({ type: 'integer', minimum: 0 });
  });

  it('still leaves keyword-position instance data untouched', () => {
    const schema = {
      type: 'object',
      properties: {
        count: { type: 'integer', format: 'uint64', default: { format: 'uint64' } },
      },
    };

    const sanitized = sanitizeSchemaFormats(schema);
    expect(sanitized.properties.count).toEqual({
      type: 'integer',
      minimum: 0,
      default: { format: 'uint64' },
    });
  });

  it('leaves integer formats on non-integer types untouched', () => {
    const schema = { type: 'string', format: 'uint32' };
    expect(sanitizeSchemaFormats(schema)).toEqual(schema);
  });

  it('ignores format values matching Object.prototype keys', () => {
    const schema = { type: 'integer', format: 'constructor' };
    expect(sanitizeSchemaFormats(schema)).toEqual(schema);
  });
});

describe('SanitizingJsonSchemaValidator', () => {
  it('compiles non-standard formats without ajv warnings and keeps validating', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const validate = new SanitizingJsonSchemaValidator().getValidator({
        type: 'object',
        properties: { elapsed_ms: { type: 'integer', format: 'uint64' } },
      });

      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(validate({ elapsed_ms: 5 }).valid).toBe(true);
      expect(validate({ elapsed_ms: -1 }).valid).toBe(false);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });
});
