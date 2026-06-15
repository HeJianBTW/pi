import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ensureDws, getDwsSkillsDir, initDws, isDwsInstalled } from './cli.js';
import { loadDingTalkConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = join(__dirname, '..', 'skills');

function resolveSkillsDir(): string | undefined {
  const cliSkills = getDwsSkillsDir();
  if (cliSkills) return cliSkills;
  if (existsSync(BUNDLED_SKILLS_DIR)) return BUNDLED_SKILLS_DIR;
  return undefined;
}

export default function piDingTalkExtension(pi: ExtensionAPI): void {
  let skillsDir: string | undefined;

  pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    const config = loadDingTalkConfig(ctx.cwd);
    if (!config?.clientId || !config?.clientSecret) return;

    if (existsSync(BUNDLED_SKILLS_DIR)) {
      skillsDir = BUNDLED_SKILLS_DIR;
    }

    if (isDwsInstalled()) {
      try {
        initDws(config);
        skillsDir = resolveSkillsDir();
        ctx.ui.setStatus?.('pi-dingtalk', 'dws: ready');
      } catch (err) {
        ctx.ui.notify(
          `pi-dingtalk: 初始化失败 — ${err instanceof Error ? err.message : String(err)}`,
          'warning',
        );
      }
    } else {
      ctx.ui.setStatus?.('pi-dingtalk', 'installing dws...');
      ensureDws()
        .then((installed) => {
          if (installed) {
            initDws(config);
            skillsDir = resolveSkillsDir();
            ctx.ui.setStatus?.('pi-dingtalk', 'dws: ready');
          }
        })
        .catch((err) => {
          ctx.ui.notify(
            `pi-dingtalk: 安装失败 — ${err instanceof Error ? err.message : String(err)}`,
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
