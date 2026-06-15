/**
 * Fetches the latest lark-cli skills from GitHub and writes them to the skills/ directory.
 * Run via: node scripts/fetch-skills.mjs
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', 'skills');
const REPO = 'larksuite/cli';
const BRANCH = 'main';
const REMOTE_PATH = 'skills';

async function fetchSkills() {
  console.log('[pi-lark] Fetching skills from github.com/%s ...', REPO);

  if (existsSync(SKILLS_DIR)) {
    rmSync(SKILLS_DIR, { recursive: true, force: true });
  }
  mkdirSync(SKILLS_DIR, { recursive: true });

  const tmpDir = join(__dirname, '..', '.tmp-skills-fetch');
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  try {
    execSync(
      `git clone --depth 1 --filter=blob:none --sparse https://github.com/${REPO}.git .`,
      { cwd: tmpDir, stdio: 'pipe' },
    );
    execSync(`git sparse-checkout set ${REMOTE_PATH}`, { cwd: tmpDir, stdio: 'pipe' });

    const srcSkills = join(tmpDir, REMOTE_PATH);
    if (!existsSync(srcSkills)) {
      throw new Error(`Skills directory not found at ${srcSkills}`);
    }

    execSync(`cp -r "${srcSkills}/"* "${SKILLS_DIR}/"`, { stdio: 'pipe' });
    console.log('[pi-lark] Skills fetched successfully.');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

fetchSkills().catch((err) => {
  console.warn('[pi-lark] Failed to fetch skills (using existing if available):', err.message);
  process.exit(0);
});
