import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  evaluateGate,
  formatComment,
  gradeExpectations,
  selectRegressionEvalSet,
  selectSkillChanges,
  validateEvalSet,
} from './skill-eval.mjs';

test('classifies changed skill directories against the base and head revisions', () => {
  const filesByRevision = {
    base: new Set(['packages/pi-demo/skills/existing/SKILL.md']),
    head: new Set([
      'packages/pi-demo/skills/existing/SKILL.md',
      'packages/pi-demo/skills/new-skill/SKILL.md',
    ]),
  };

  assert.deepEqual(
    selectSkillChanges(
      [
        'packages/pi-demo/skills/existing/references/guide.md',
        'packages/pi-demo/skills/new-skill/SKILL.md',
        'packages/pi-demo/src/index.ts',
      ],
      (revision, path) => filesByRevision[revision].has(path),
    ),
    [
      { type: 'modified', path: 'packages/pi-demo/skills/existing' },
      { type: 'added', path: 'packages/pi-demo/skills/new-skill' },
    ],
  );
});

const evalCase = (id, prompt = `prompt ${id}`) => ({
  id,
  prompt,
  expected_output: `expected ${id}`,
  expectations: [{ text: `checks ${id}`, includes: [`needle-${id}`] }],
});

test('bounds each eval set to three through five cases', () => {
  assert.throws(
    () => validateEvalSet({ skill_name: 'demo', evals: [evalCase('a'), evalCase('b')] }),
    /between 3 and 5 cases/,
  );
  assert.doesNotThrow(() =>
    validateEvalSet({
      skill_name: 'demo',
      evals: ['a', 'b', 'c', 'd', 'e'].map((id) => evalCase(id)),
    }),
  );
  assert.throws(
    () => validateEvalSet({
      skill_name: 'demo',
      evals: [evalCase('<img>'), evalCase('b'), evalCase('c')],
    }),
    /eval id must use/,
  );
});

test('uses the trusted base eval set when an existing skill changes', () => {
  const base = {
    skill_name: 'demo',
    evals: [evalCase('existing'), evalCase('safety'), evalCase('routing')],
  };
  const head = {
    skill_name: 'demo',
    evals: [
      evalCase('existing', 'updated for the next PR'),
      evalCase('safety'),
      evalCase('routing'),
      evalCase('new'),
    ],
  };

  assert.deepEqual(
    selectRegressionEvalSet(validateEvalSet(base), validateEvalSet(head)),
    base,
  );

  assert.throws(
    () => selectRegressionEvalSet(
      validateEvalSet(base),
      validateEvalSet({
        skill_name: 'renamed',
        evals: [evalCase('existing'), evalCase('safety'), evalCase('routing')],
      }),
    ),
    /skill_name must match/,
  );
});

test('grades declarative expectations without executing eval-controlled code', () => {
  assert.deepEqual(
    gradeExpectations('Use VIDEO_COMPOSE locally. Do not call a paid model.', [
      { text: 'routes locally', includes: ['video_compose', 'locally'] },
      { text: 'avoids paid generation', excludes: ['video_generate', 'video_render'] },
      { text: 'names a local signal', includes_any: ['ffmpeg', 'local'] },
    ]),
    {
      passed: 3,
      total: 3,
      score: 1,
      expectations: [
        { text: 'routes locally', passed: true, evidence: 'included: video_compose, locally' },
        { text: 'avoids paid generation', passed: true, evidence: 'excluded: video_generate, video_render' },
        { text: 'names a local signal', passed: true, evidence: 'included one of: ffmpeg, local' },
      ],
    },
  );
});

test('requires new skills to clear both the absolute score and improvement delta', () => {
  const runs = [
    { configuration: 'candidate', eval_id: 'a', score: 1, failure_mode: 'ok' },
    { configuration: 'candidate', eval_id: 'b', score: 0.8, failure_mode: 'ok' },
    { configuration: 'candidate', eval_id: 'c', score: 0.9, failure_mode: 'ok' },
    { configuration: 'baseline', eval_id: 'a', score: 0.7, failure_mode: 'ok' },
    { configuration: 'baseline', eval_id: 'b', score: 0.7, failure_mode: 'ok' },
    { configuration: 'baseline', eval_id: 'c', score: 0.6, failure_mode: 'ok' },
  ];
  assert.equal(evaluateGate({ type: 'added', runs }).passed, true);
  assert.match(
    evaluateGate({
      type: 'added',
      runs: runs.map((run) =>
        run.configuration === 'baseline' ? { ...run, score: run.score + 0.2 } : run,
      ),
    }).reasons.join('\n'),
    /delta/,
  );
});

test('rejects a modified skill when any base eval regresses', () => {
  const result = evaluateGate({
    type: 'modified',
    baseEvalIds: ['routing', 'safety'],
    runs: [
      { configuration: 'candidate', eval_id: 'routing', score: 0.5, failure_mode: 'ok' },
      { configuration: 'baseline', eval_id: 'routing', score: 1, failure_mode: 'ok' },
      { configuration: 'candidate', eval_id: 'safety', score: 1, failure_mode: 'ok' },
      { configuration: 'baseline', eval_id: 'safety', score: 0.5, failure_mode: 'ok' },
    ],
  });
  assert.equal(result.passed, false);
  assert.match(result.reasons.join('\n'), /routing regressed/);
});

test('formats one PR comment with gate results and artifact links', () => {
  const comment = formatComment(
    [
      {
        skill: 'video-gen',
        type: 'modified',
        gate: { passed: false, candidateScore: 0.75, baselineScore: 1, delta: -0.25, reasons: ['routing regressed'] },
      },
    ],
    { runUrl: 'https://github.example/actions/runs/42', artifactName: 'skill-eval-42' },
  );
  assert.match(comment, /❌ Skill Eval — failed/);
  assert.match(comment, /\| `video-gen` \| modified \| 0\.750 \| 1\.000 \| -0\.250 \| ❌ \|/);
  assert.match(comment, /routing regressed/);
  assert.match(comment, /skill-eval-42/);
  assert.match(comment, /actions\/runs\/42/);
});

test('runs a changed skill through Pi and writes the PR comment artifact', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pi-skill-eval-test-'));
  try {
    const skillDir = path.join(root, 'packages/pi-demo/skills/demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\nbase\n');
    writeFileSync(
      path.join(skillDir, 'evals.json'),
      JSON.stringify({ skill_name: 'demo', evals: [evalCase('a'), evalCase('b'), evalCase('c')] }),
    );
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\nhead\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'head'], { cwd: root });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const fakePi = path.join(bin, 'pi');
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node\nconst prompt = process.argv[process.argv.indexOf('-p') + 1];\nconst hasInjectedSkill = process.argv.includes('--append-system-prompt');\nconst ids = ['a','b','c'].filter((id) => prompt.includes('prompt ' + id));\nconsole.log(hasInjectedSkill ? ids.map((id) => 'needle-' + id).join(' ') : '');\n`,
    );
    chmodSync(fakePi, 0o755);

    const outputDir = path.join(root, 'results');
    const script = fileURLToPath(new URL('./skill-eval.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SKILL_EVAL_BASE_SHA: base,
        SKILL_EVAL_HEAD_SHA: head,
        SKILL_EVAL_OUTPUT_DIR: outputDir,
        SKILL_EVAL_RUNS: '1',
        SKILL_EVAL_RUN_URL: 'https://github.example/actions/runs/42',
        SKILL_EVAL_ARTIFACT: 'skill-eval-42',
      },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(readFileSync(path.join(outputDir, 'comment.md'), 'utf8'), /✅ Skill Eval — passed/);
    assert.equal(JSON.parse(readFileSync(path.join(outputDir, 'summary.json'), 'utf8')).skills[0].skill, 'demo');
    assert.equal(
      JSON.parse(
        readFileSync(
          path.join(outputDir, 'demo/eval-a/new_skill/run-1/eval_metadata.json'),
          'utf8',
        ),
      ).eval_id,
      'a',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validates every bundled skill eval set', () => {
  for (const relative of [
    '../../packages/pi-image-gen/skills/image-gen/evals.json',
    '../../packages/pi-video-gen/skills/video-gen/evals.json',
  ]) {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    assert.doesNotThrow(() => validateEvalSet(JSON.parse(readFileSync(file, 'utf8'))), relative);
  }
});

test('uses trusted base code, comments before enforcing, and never executes PR code', () => {
  const workflow = readFileSync(
    fileURLToPath(new URL('../workflows/skill-eval.yml', import.meta.url)),
    'utf8',
  );
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /peter-evans\/create-or-update-comment@v4/);
  assert.ok(workflow.indexOf('Post PR comment') < workflow.indexOf('Enforce gate outcome'));
  assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
});
