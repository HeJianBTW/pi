import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createJiti } from 'jiti/static';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');

const EXTENSION_PACKAGES = [
  'pi-security',
  'pi-telemetry',
  'pi-browser-use',
  'pi-computer-use',
] as const;

interface CollectedExtension {
  handlers: Map<string, unknown[]>;
  tools: Map<string, { name: string; parameters: unknown; [k: string]: unknown }>;
  commands: Map<string, unknown>;
}

function createCollector(): { api: Record<string, unknown>; ext: CollectedExtension } {
  const ext: CollectedExtension = {
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
  };
  const api = {
    on(event: string, handler: unknown) {
      ext.handlers.set(event, [...(ext.handlers.get(event) || []), handler]);
    },
    registerTool(tool: { name: string; parameters: unknown }) {
      ext.tools.set(tool.name, tool as CollectedExtension['tools'] extends Map<string, infer V> ? V : never);
    },
    registerCommand(name: string, opts: unknown) {
      ext.commands.set(name, opts);
    },
  };
  return { api, ext };
}

async function loadExtensionWithJiti(pkgName: string): Promise<{ factory: Function; ext: CollectedExtension }> {
  const entryPath = path.join(PACKAGES_DIR, pkgName, 'src', 'index.ts');
  const jiti = createJiti(entryPath, { moduleCache: false });
  const factory = (await jiti.import(entryPath, { default: true })) as Function;
  const { api, ext } = createCollector();
  await factory(api);
  return { factory, ext };
}

function findSchemaViolations(schema: unknown, path = ''): string[] {
  const violations: string[] = [];
  if (!schema || typeof schema !== 'object') return violations;
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.items)) {
    violations.push(`${path}.items is an array (tuple schema) — incompatible with Moonshot/Kimi`);
  }
  if (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) {
    violations.push(...findSchemaViolations(s.items, `${path}.items`));
  }
  if (s.properties && typeof s.properties === 'object') {
    for (const [key, val] of Object.entries(s.properties as Record<string, unknown>)) {
      violations.push(...findSchemaViolations(val, `${path}.${key}`));
    }
  }
  if (s.additionalProperties && typeof s.additionalProperties === 'object') {
    violations.push(...findSchemaViolations(s.additionalProperties, `${path}.additionalProperties`));
  }
  return violations;
}

describe('Extension E2E loading via jiti', () => {
  for (const pkgName of EXTENSION_PACKAGES) {
    it(`${pkgName}: package.json declares pi.extensions`, () => {
      const pkgJson = JSON.parse(
        readFileSync(path.join(PACKAGES_DIR, pkgName, 'package.json'), 'utf8'),
      );
      expect(pkgJson.pi?.extensions).toBeInstanceOf(Array);
      expect(pkgJson.pi.extensions.length).toBeGreaterThan(0);
    });
  }

  it('pi-computer-use: loads via jiti and registers computer_use tool', async () => {
    const { ext } = await loadExtensionWithJiti('pi-computer-use');
    expect(ext.tools.has('computer_use')).toBe(true);
    expect(ext.handlers.has('session_shutdown')).toBe(true);
  });

  it('pi-computer-use: tool schema has no tuple (items as array)', async () => {
    const { ext } = await loadExtensionWithJiti('pi-computer-use');
    const tool = ext.tools.get('computer_use')!;
    const violations = findSchemaViolations(tool.parameters);
    expect(violations).toEqual([]);
  });

  it('pi-computer-use: path field uses minItems/maxItems for coordinate pairs', async () => {
    const { ext } = await loadExtensionWithJiti('pi-computer-use');
    const tool = ext.tools.get('computer_use')!;
    const params = tool.parameters as Record<string, unknown>;
    const action = (params.properties as Record<string, unknown>).action as Record<string, unknown>;
    const pathProp = (action.properties as Record<string, unknown>).path as Record<string, unknown>;
    const innerItems = pathProp.items as Record<string, unknown>;
    expect(innerItems.type).toBe('array');
    expect(innerItems.items).toEqual({ type: 'number' });
    expect(innerItems.minItems).toBe(2);
    expect(innerItems.maxItems).toBe(2);
  });

  it('pi-browser-use: loads via jiti and registers session handlers', async () => {
    const { ext } = await loadExtensionWithJiti('pi-browser-use');
    expect(ext.handlers.has('session_start')).toBe(true);
    expect(ext.handlers.has('session_shutdown')).toBe(true);
  });
});

describe('findSchemaViolations regression', () => {
  it('detects tuple-style items (array of schemas)', () => {
    const tupleSchema = {
      type: 'object',
      properties: {
        action: {
          type: 'object',
          properties: {
            path: {
              type: 'array',
              items: {
                type: 'array',
                items: [{ type: 'number' }, { type: 'number' }],
              },
            },
          },
        },
      },
    };
    const violations = findSchemaViolations(tupleSchema);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain('tuple');
  });

  it('passes for valid array-style items (object schema)', () => {
    const arraySchema = {
      type: 'object',
      properties: {
        action: {
          type: 'object',
          properties: {
            path: {
              type: 'array',
              items: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
              },
            },
          },
        },
      },
    };
    const violations = findSchemaViolations(arraySchema);
    expect(violations).toEqual([]);
  });
});
