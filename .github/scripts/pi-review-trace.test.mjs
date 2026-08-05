import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { parseTraceEvents, renderPiReviewTrace } from './pi-review-trace.mjs';

const subagentEnd = (results, isError = false) => ({
  type: 'tool_execution_end',
  toolCallId: 'call-1',
  toolName: 'subagent',
  isError,
  result: { details: { mode: 'parallel', results } },
});

test('renders lifecycle and per-reviewer outcomes, skipping message content', () => {
  const events = [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { delta: 'thinking…' } },
    { type: 'message_end', message: { role: 'assistant' } },
    { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'subagent', args: { tasks: [{}, {}] } },
    subagentEnd([
      { exitCode: 0, structuredOutput: { axis: 'Standards', findings: [] } },
      { exitCode: 1, error: 'spec reviewer blew up' },
    ]),
    { type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'subagent_wait', args: {} },
    { type: 'tool_execution_end', toolCallId: 'call-2', toolName: 'subagent_wait', isError: false, result: {} },
    { type: 'turn_end', message: { role: 'assistant' }, toolResults: [{}, {}] },
    { type: 'agent_end', messages: [{}, {}, {}] },
  ];

  const output = renderPiReviewTrace(events).join('\n');

  // Headline summary.
  assert.match(output, /Pi review execution trace: 11 event\(s\), 1 turn\(s\), 2 tool call\(s\), 1 assistant message\(s\), 0 tool error\(s\)/);
  // Lifecycle and tool events.
  assert.match(output, /▶ agent start/);
  assert.match(output, /├─ turn 1 start/);
  assert.match(output, /├─ turn 1 end \(2 tool result\(s\)\)/);
  assert.match(output, /│  ▶ subagent/);
  assert.match(output, /│  ✓ subagent/);
  assert.match(output, /│  ✓ subagent_wait/);
  assert.match(output, /■ agent end \(3 message\(s\)\)/);
  // Per-reviewer outcomes from the parallel subagent result.
  assert.match(output, /Standards: exit 0, 0 finding\(s\)/);
  assert.match(output, /reviewer: FAILED \(exit 1\) — spec reviewer blew up/);
  // Streaming message content is not rendered.
  assert.doesNotMatch(output, /thinking…/);
  assert.doesNotMatch(output, /message_start/);
});

test('flags a failed subagent tool call as an error', () => {
  const output = renderPiReviewTrace([
    { type: 'tool_execution_start', toolCallId: 'c', toolName: 'subagent', args: {} },
    subagentEnd([], true),
  ]).join('\n');
  assert.match(output, /1 tool error\(s\)/);
  assert.match(output, /✗ subagent \(error\)/);
});

test('parseTraceEvents skips blank and malformed lines', () => {
  const events = parseTraceEvents([
    '{"type":"agent_start"}',
    '',
    '   ',
    'not json',
    '{"type":"agent_end","messages":[]}',
  ].join('\n'));
  assert.deepEqual(events.map((event) => event.type), ['agent_start', 'agent_end']);
});

test('renders an empty stream as just the zero summary', () => {
  assert.deepEqual(renderPiReviewTrace([]), [
    'Pi review execution trace: 0 event(s), 0 turn(s), 0 tool call(s), 0 assistant message(s), 0 tool error(s)',
  ]);
});

test('workflow captures the full event stream and renders the trace', async () => {
  const workflow = await readFile(new URL('../workflows/pi-review.yml', import.meta.url), 'utf8');
  // The run step tees the full event stream before filtering it into the transcript.
  assert.match(workflow, /tee "\$PI_REVIEW_FULL"/);
  assert.match(workflow, /Print Pi execution trace/);
  assert.match(workflow, /node \.github\/scripts\/pi-review-trace\.mjs "\$PI_REVIEW_FULL"/);
  // Full-fidelity evidence is uploaded even when the run fails.
  assert.match(workflow, /Upload Pi review execution artifacts/);
  assert.match(workflow, /pi-review-full\.jsonl/);
  assert.match(workflow, /pi-review-stderr\.log/);
});
