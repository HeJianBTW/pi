import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ensureLarkCli, getLarkCliSkillsDir, initLarkCli, isLarkCliInstalled } from './cli.js';
import { loadLarkConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = join(__dirname, '..', 'skills');

function resolveSkillsDir(): string | undefined {
  const cliSkills = getLarkCliSkillsDir();
  if (cliSkills) return cliSkills;
  if (existsSync(BUNDLED_SKILLS_DIR)) return BUNDLED_SKILLS_DIR;
  return undefined;
}

export default function piLarkExtension(pi: ExtensionAPI): void {
  let skillsDir: string | undefined;

  pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    const config = loadLarkConfig(ctx.cwd);
    if (!config?.appId || !config?.appSecret) return;

    // Use bundled skills immediately so they're available while CLI installs
    if (existsSync(BUNDLED_SKILLS_DIR)) {
      skillsDir = BUNDLED_SKILLS_DIR;
    }

    if (isLarkCliInstalled()) {
      try {
        await initLarkCli(config);
        skillsDir = resolveSkillsDir();
        ctx.ui.setStatus?.('pi-lark', 'lark-cli: ready');
      } catch (err) {
        ctx.ui.notify(
          `pi-lark: 初始化失败 — ${err instanceof Error ? err.message : String(err)}`,
          'warning',
        );
      }
    } else {
      ctx.ui.setStatus?.('pi-lark', 'installing lark-cli...');
      ensureLarkCli()
        .then(async (installed) => {
          if (installed) {
            await initLarkCli(config);
            skillsDir = resolveSkillsDir();
            ctx.ui.setStatus?.('pi-lark', 'lark-cli: ready');
          }
        })
        .catch((err) => {
          ctx.ui.notify(
            `pi-lark: 安装失败 — ${err instanceof Error ? err.message : String(err)}`,
            'warning',
          );
        });
    }
  });

  pi.on('resources_discover', () => {
    if (skillsDir) {
      return { skillPaths: [skillsDir] };
    }
    return {};
  });

  pi.on('session_shutdown', async () => {
    skillsDir = undefined;
  });
}
