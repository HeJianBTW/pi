/**
 * Fetches the latest lark-cli skills from GitHub and writes them to the skills/ directory.
 * Run via: node scripts/fetch-skills.mjs
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', 'skills');
const REPO = 'larksuite/cli';
const BRANCH = 'main';
const REMOTE_PATH = 'skills';
const REQUIRED_SKILLS = [
  'lark-im',
  'lark-shared',
];

async function fetchSkills() {
  log('[pi-lark] Fetching skills from github.com/%s ...', REPO);

  const tmpDir = join(__dirname, '..', '.tmp-skills-fetch');
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  try {
    execFileSync('git', [
      'clone',
      '--depth',
      '1',
      '--filter=blob:none',
      '--sparse',
      '--branch',
      BRANCH,
      `https://github.com/${REPO}.git`,
      '.',
    ], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['sparse-checkout', 'set', REMOTE_PATH], { cwd: tmpDir, stdio: 'pipe' });

    const srcSkills = join(tmpDir, REMOTE_PATH);
    validateSkillsDir(srcSkills);

    rmSync(SKILLS_DIR, { recursive: true, force: true });
    cpSync(srcSkills, SKILLS_DIR, { recursive: true });
    log('[pi-lark] Skills fetched successfully (%d skills).', countSkills(SKILLS_DIR));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function validateSkillsDir(skillsDir) {
  if (!existsSync(skillsDir)) {
    throw new Error(`Skills directory not found at ${skillsDir}`);
  }

  const skillCount = countSkills(skillsDir);
  if (skillCount === 0) {
    throw new Error(`No SKILL.md files found in ${skillsDir}`);
  }

  for (const skillName of REQUIRED_SKILLS) {
    const skillFile = join(skillsDir, skillName, 'SKILL.md');
    if (!existsSync(skillFile)) {
      throw new Error(`Required skill missing: ${skillName}/SKILL.md`);
    }
  }
}

function countSkills(skillsDir) {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
    .length;
}

function log(message, ...args) {
  console.error(message, ...args);
}

fetchSkills().catch((err) => {
  console.error('[pi-lark] Failed to fetch skills:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
