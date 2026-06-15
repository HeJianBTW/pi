import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  ensureWeComCli,
  getWeComCliSkillsDir,
  isWeComCliAuthenticated,
  isWeComCliInstalled,
} from './cli.js';
import { loadWeComConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = join(__dirname, '..', 'skills');

function resolveSkillsDir(): string | undefined {
  const cliSkills = getWeComCliSkillsDir();
  if (cliSkills) return cliSkills;
  if (existsSync(BUNDLED_SKILLS_DIR)) return BUNDLED_SKILLS_DIR;
  return undefined;
}

export default function piWeComExtension(pi: ExtensionAPI): void {
  let skillsDir: string | undefined;

  pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    const config = loadWeComConfig(ctx.cwd);
    if (!config?.botId || !config?.botSecret) return;

    if (existsSync(BUNDLED_SKILLS_DIR)) {
      skillsDir = BUNDLED_SKILLS_DIR;
    }

    if (isWeComCliInstalled()) {
      if (!isWeComCliAuthenticated()) {
        ctx.ui.notify('pi-wecom: wecom-cli 未认证，请运行 wecom-cli init 完成扫码认证', 'warning');
      }
      skillsDir = resolveSkillsDir();
      ctx.ui.setStatus?.('pi-wecom', 'wecom-cli: ready');
    } else {
      ctx.ui.setStatus?.('pi-wecom', 'installing wecom-cli...');
      ensureWeComCli()
        .then((installed) => {
          if (installed) {
            skillsDir = resolveSkillsDir();
            ctx.ui.setStatus?.('pi-wecom', 'wecom-cli: ready');
            if (!isWeComCliAuthenticated()) {
              ctx.ui.notify(
                'pi-wecom: wecom-cli 未认证，请运行 wecom-cli init 完成扫码认证',
                'warning',
              );
            }
          }
        })
        .catch((err) => {
          ctx.ui.notify(
            `pi-wecom: 安装失败 — ${err instanceof Error ? err.message : String(err)}`,
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
