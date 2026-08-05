import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  commentableLines,
  combinePiReviewTranscript,
  parseReviewOutput,
  preparePiReview,
  publishPiReview,
  reviewLocationIndex,
  summaryBody,
} from './publish-pi-review.mjs';

const finding = {
  severity: 'P1',
  axis: 'Standards',
  path: 'src/example.ts',
  line: 11,
  side: 'RIGHT',
  title: 'Unchecked failure path',
  body: 'The added call can throw before cleanup runs.',
  fix: 'Move cleanup into a finally block.',
};

test('combines schema-validated axis outputs from the Pi JSON transcript', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-transcript-'));
  const transcriptPath = path.join(directory, 'pi.jsonl');
  const reviewPath = path.join(directory, 'review.json');
  const specFinding = { ...finding, severity: 'P2', axis: 'Spec', title: 'Documented fallback is missing' };
  try {
    await writeFile(transcriptPath, [
      JSON.stringify({ type: 'tool_execution_start', toolName: 'subagent' }),
      JSON.stringify({
        type: 'tool_execution_end',
        toolName: 'subagent',
        result: {
          details: {
            mode: 'parallel',
            results: [
              { exitCode: 0, structuredOutput: { axis: 'Standards', findings: [finding] } },
              { exitCode: 0, structuredOutput: { axis: 'Spec', findings: [specFinding] } },
            ],
          },
        },
      }),
    ].join('\n'));
    await combinePiReviewTranscript({ transcriptPath, reviewPath });
    assert.deepEqual(JSON.parse(await readFile(reviewPath, 'utf8')), { findings: [finding, specFinding] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('accepts a Standards-only run when the skill finds no specification', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-no-spec-'));
  const transcriptPath = path.join(directory, 'pi.jsonl');
  const reviewPath = path.join(directory, 'review.json');
  try {
    await writeFile(transcriptPath, JSON.stringify({
      type: 'tool_execution_end',
      toolName: 'subagent',
      result: {
        details: {
          mode: 'parallel',
          results: [{ exitCode: 0, structuredOutput: { axis: 'Standards', findings: [finding] } }],
        },
      },
    }));
    await combinePiReviewTranscript({ transcriptPath, reviewPath });
    assert.deepEqual(JSON.parse(await readFile(reviewPath, 'utf8')), { findings: [finding] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('combines successful structured outputs across coordinator recovery calls', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-recovery-'));
  const transcriptPath = path.join(directory, 'pi.jsonl');
  const reviewPath = path.join(directory, 'review.json');
  const specFinding = { ...finding, severity: 'P2', axis: 'Spec', title: 'Documented fallback is missing' };
  const event = (results) => JSON.stringify({
    type: 'tool_execution_end',
    toolName: 'subagent',
    result: { details: { mode: 'parallel', results } },
  });
  try {
    await writeFile(transcriptPath, [
      event([{ exitCode: 1, error: 'first attempt failed' }]),
      event([{ exitCode: 0, structuredOutput: { axis: 'Standards', findings: [finding] } }]),
      event([{ exitCode: 0, structuredOutput: { axis: 'Spec', findings: [specFinding] } }]),
    ].join('\n'));
    await combinePiReviewTranscript({ transcriptPath, reviewPath });
    assert.deepEqual(JSON.parse(await readFile(reviewPath, 'utf8')), { findings: [finding, specFinding] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('parses findings JSON wrapped in model prose', () => {
  assert.deepEqual(parseReviewOutput(`\`\`\`json\n${JSON.stringify({ findings: [finding] })}\n\`\`\``), [finding]);
  assert.deepEqual(parseReviewOutput(`Both reviews completed.\n${JSON.stringify({ findings: [] })}\nReview complete.`), []);
  assert.throws(() => parseReviewOutput('Both reviews completed without structured output.'), /valid JSON object/);
  assert.throws(
    () => parseReviewOutput(JSON.stringify({ findings: [finding, { ...finding, title: 'Another defect' }] })),
    /multiple findings for the same axis and changed line/,
  );
});

test('collects only added and removed diff lines', () => {
  const locations = commentableLines([{ filename: 'src/example.ts', patch: '@@ -10,2 +10,3 @@\n same\n-old\n+new\n+more' }]);
  assert.deepEqual([...locations], [
    'src/example.ts\u0000LEFT\u000011',
    'src/example.ts\u0000RIGHT\u000011',
    'src/example.ts\u0000RIGHT\u000012',
  ]);
});

test('gives the reviewer exact changed-line coordinates', () => {
  const patch = [
    '@@ -36,6 +36,8 @@',
    ' ',
    ' Traces are scoped to user input boundaries.',
    ' ',
    '+Langfuse traces include correlation metadata.',
    '+',
    ' ## Configuration',
  ].join('\n');
  assert.equal(
    reviewLocationIndex([{ filename: 'packages/pi-telemetry/README.md', patch }]),
    'packages/pi-telemetry/README.md\tRIGHT\t39\npackages/pi-telemetry/README.md\tRIGHT\t40',
  );
});

test('prepares the review prompt outside the workflow', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-context-'));
  const contextPath = path.join(directory, 'context.md');
  await writeFile(path.join(directory, 'AGENTS.md'), '# Review rules');
  const listFiles = () => {};
  const listCommits = () => {};
  const github = {
    request: async () => ({ data: 'diff --git a/src/example.ts b/src/example.ts' }),
    paginate: async (method) => {
      if (method === listFiles) {
        return [{ filename: 'src/example.ts', patch: '@@ -10 +10,2 @@\n old\n+new' }];
      }
      if (method === listCommits) return [];
      throw new Error('Unexpected pagination method');
    },
    rest: {
      pulls: { listFiles, listCommits },
      issues: { get: async () => { throw new Error('Unexpected issue lookup'); } },
    },
  };
  try {
    await preparePiReview({
      github,
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        payload: {
          pull_request: {
            number: 123,
            title: 'Test review preparation',
            body: '',
            base: { sha: 'base123' },
            head: { sha: 'head123' },
          },
        },
      },
      core: { warning: () => {} },
      contextPath,
      workspace: directory,
    });
    const prompt = await readFile(contextPath, 'utf8');
    assert.match(prompt, /# Allowed changed-line locations/);
    assert.match(prompt, /src\/example\.ts\tRIGHT\t11/);
    assert.match(prompt, /Copy path, side, and line exactly from this list/);
    assert.match(prompt, /outputSchema/);
    assert.match(prompt, /structured_output/);
    assert.match(prompt, /"const":"Standards"/);
    assert.match(prompt, /"const":"Spec"/);
    assert.doesNotMatch(prompt, /file-only/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const workflow = await readFile(new URL('../workflows/pi-review.yml', import.meta.url), 'utf8');
  assert.match(workflow, /preparePiReview\(\{ github, context, core/);
  assert.match(workflow, /PI_REVIEW_TRANSCRIPT/);
  assert.match(workflow, /combinePiReviewTranscript/);
  assert.match(workflow, /--mode json/);
  assert.match(workflow, /> "\$PI_REVIEW_TRANSCRIPT"/);
  assert.match(workflow, /acceptanceRole: read-only/);
  assert.match(workflow, /completionGuard: false/);
  assert.doesNotMatch(workflow, /const diffResponse =/);
});

test('publishes inline findings, keeps the summary concise, and fails only for P0/P1', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-'));
  const reviewPath = path.join(directory, 'review.json');
  await writeFile(reviewPath, JSON.stringify({ findings: [finding] }));
  const calls = [];
  const reviewComments = [];
  const issueComments = [];
  const listFiles = () => {};
  const listReviewComments = () => {};
  const listComments = () => {};
  const github = {
    paginate: async (method) => {
      if (method === listFiles) return [{ filename: 'src/example.ts', patch: '@@ -10 +10,2 @@\n old\n+new' }];
      if (method === listReviewComments) return [...reviewComments];
      if (method === listComments) return [...issueComments];
      throw new Error('Unexpected pagination method');
    },
    rest: {
      pulls: {
        listFiles,
        listReviewComments,
        updateReviewComment: async (args) => {
          calls.push(['updateReviewComment', args]);
          reviewComments.find((comment) => comment.id === args.comment_id).body = args.body;
        },
        deleteReviewComment: async (args) => {
          calls.push(['deleteReviewComment', args]);
          reviewComments.splice(reviewComments.findIndex((comment) => comment.id === args.comment_id), 1);
        },
        createReview: async (args) => {
          calls.push(['createReview', args]);
          for (const comment of args.comments) {
            reviewComments.push({ id: reviewComments.length + 1, user: { type: 'Bot' }, body: comment.body });
          }
        },
      },
      issues: {
        listComments,
        updateComment: async (args) => {
          calls.push(['updateComment', args]);
          issueComments.find((comment) => comment.id === args.comment_id).body = args.body;
        },
        createComment: async (args) => {
          calls.push(['createComment', args]);
          issueComments.push({ id: issueComments.length + 1, user: { type: 'Bot' }, body: args.body });
        },
      },
    },
  };
  const failures = [];
  const warnings = [];
  const core = {
    setFailed: (message) => failures.push(message),
    warning: (message) => warnings.push(message),
  };
  try {
    await publishPiReview({
      github,
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        payload: { pull_request: { number: 123, head: { sha: 'abc123' } } },
      },
      core,
      reviewPath,
    });
    await writeFile(reviewPath, JSON.stringify({
      findings: [
        { ...finding, severity: 'P2', title: 'Cleanup can be skipped' },
        { ...finding, severity: 'P0', line: 12, title: 'Invalid model location' },
      ],
    }));
    await publishPiReview({
      github,
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        payload: { pull_request: { number: 123, head: { sha: 'def456' } } },
      },
      core,
      reviewPath,
    });
    await writeFile(reviewPath, JSON.stringify({ findings: [] }));
    await publishPiReview({
      github,
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        payload: { pull_request: { number: 123, head: { sha: 'def456' } } },
      },
      core,
      reviewPath,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const reviews = calls.filter(([name]) => name === 'createReview');
  assert.equal(reviews.length, 1);
  assert.ok(reviews[0][1].body);
  assert.equal(calls.filter(([name]) => name === 'updateReviewComment').length, 1);
  assert.equal(calls.filter(([name]) => name === 'deleteReviewComment').length, 1);
  assert.equal(calls.filter(([name]) => name === 'createComment').length, 1);
  assert.equal(calls.filter(([name]) => name === 'updateComment').length, 2);
  assert.equal(reviewComments.length, 0);
  assert.deepEqual(failures, [
    'Pi review found 1 blocking P0/P1 finding(s)',
    'Pi review found 1 blocking P0/P1 finding(s)',
  ]);
  assert.deepEqual(warnings, ['Summary-only Pi review finding outside changed lines: src/example.ts:12 (RIGHT)']);
  assert.match(calls.find(([name]) => name === 'updateComment')[1].body, /Invalid model location/);
  const summary = summaryBody(
    [
      finding,
      {
        ...finding,
        severity: 'P2',
        axis: 'Spec',
        path: 'src/other.ts',
        line: 20,
        title: 'Documented fallback is missing',
        body: 'The PR promises a fallback, but this branch still throws.',
        fix: 'Return the documented fallback value.',
      },
    ],
    {
      owner: 'owner',
      repo: 'repo',
      headSha: 'abc123',
      baseSha: 'base123',
      serverUrl: 'https://github.example',
    },
  );
  assert.match(summary, /^<!-- pi-code-review -->\n## Standards/m);
  assert.match(summary, /\*\*P1 — \[src\/example\.ts \(line 11\)\]\(https:\/\/github\.example\/owner\/repo\/blob\/abc123\/src\/example\.ts#L11\): Unchecked failure path\.\*\*/);
  assert.match(summary, /The added call can throw before cleanup runs\. \*\*Suggested fix:\*\* Move cleanup into a finally block\./);
  assert.match(summary, /## Spec/);
  assert.match(summary, /\*\*P2 — \[src\/other\.ts \(line 20\)\]/);
  assert.match(summary, /\*\*Summary:\*\* Standards: 1 finding, highest P1; Spec: 1 finding, highest P2\./);
  assert.doesNotMatch(summary, /\| Priority \|/);
  assert.doesNotMatch(summary, /Model:/);

  const emptySummary = summaryBody([]);
  assert.equal(
    emptySummary,
    '<!-- pi-code-review -->\n## Standards\n\nNo actionable findings.\n\n## Spec\n\nNo actionable findings.\n\n**Summary:** Standards: no findings; Spec: no findings.',
  );
});
