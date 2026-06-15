import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ensureLarkCli, getLarkCliSkillsDir, initLarkCli } from './cli.js';
import { loadLarkConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = join(__dirname, '..', 'skills');

async function resolveSkillsDir(): Promise<string | undefined> {
  const cliSkills = await getLarkCliSkillsDir();
  if (cliSkills) return cliSkills;
  if (existsSync(BUNDLED_SKILLS_DIR)) return BUNDLED_SKILLS_DIR;
  return undefined;
}

export default function piLarkExtension(pi: ExtensionAPI): void {
  let skillsDir: string | undefined;

  pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    const config = loadLarkConfig(ctx.cwd);
    if (!config?.appId || !config?.appSecret) return;

    if (existsSync(BUNDLED_SKILLS_DIR)) {
      skillsDir = BUNDLED_SKILLS_DIR;
    }

    try {
      const installed = await ensureLarkCli();
      if (installed) {
        await initLarkCli(config);
        skillsDir = await resolveSkillsDir();
        ctx.ui.setStatus?.('pi-lark', 'lark-cli: ready');
      }
    } catch (err) {
      ctx.ui.notify(
        `pi-lark: 初始化失败 — ${err instanceof Error ? err.message : String(err)}`,
        'warning',
      );
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
