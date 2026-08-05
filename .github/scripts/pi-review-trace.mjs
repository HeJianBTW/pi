import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Renders a compact, human-readable timeline of a Pi `--mode json` event stream
// so a review run's execution is visible in the CI log. The full event stream is
// far too large for the log (streaming thinking deltas, large tool args), so this
// prints lifecycle and per-reviewer outcomes only; the raw stream is uploaded as
// an artifact for full-fidelity inspection.

const MAX_VALUE = 200;
const MAX_RENDERED = 2000;

function truncate(value, max = MAX_VALUE) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text == null) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Parses a JSONL event stream into events, skipping blank or malformed lines. */
export function parseTraceEvents(text) {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** One summary line per child reviewer inside a parallel subagent result. */
function describeSubagentChildren(event) {
  const results = event?.result?.details?.results;
  if (!Array.isArray(results)) return [];
  return results.map((child) => {
    const axis = child?.structuredOutput?.axis ?? 'reviewer';
    if (child?.exitCode !== 0) {
      const reason = child?.error ? ` — ${truncate(child.error, 160)}` : '';
      return `${axis}: FAILED (exit ${child?.exitCode ?? '?'})${reason}`;
    }
    const findings = Array.isArray(child?.structuredOutput?.findings) ? child.structuredOutput.findings.length : 0;
    return `${axis}: exit 0, ${findings} finding(s)`;
  });
}

/**
 * Renders events to log lines. Message content and streaming deltas are skipped
 * by design; agent/turn lifecycle and tool (subagent) outcomes are shown.
 */
export function renderPiReviewTrace(events) {
  const lines = [];
  let turn = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let assistantMessages = 0;

  const push = (line) => {
    if (lines.length < MAX_RENDERED) lines.push(line);
  };

  for (const event of events) {
    switch (event?.type) {
      case 'agent_start':
        push('▶ agent start');
        break;
      case 'turn_start':
        turn += 1;
        push(`├─ turn ${turn} start`);
        break;
      case 'turn_end': {
        const results = Array.isArray(event?.toolResults) ? event.toolResults.length : 0;
        push(`├─ turn ${turn} end (${results} tool result(s))`);
        break;
      }
      case 'message_end':
        assistantMessages += 1;
        break;
      case 'tool_execution_start':
        toolCalls += 1;
        push(`│  ▶ ${event?.toolName ?? 'tool'}`);
        break;
      case 'tool_execution_end': {
        if (event?.isError) toolErrors += 1;
        push(`│  ${event?.isError ? '✗' : '✓'} ${event?.toolName ?? 'tool'}${event?.isError ? ' (error)' : ''}`);
        if (event?.toolName === 'subagent') {
          for (const child of describeSubagentChildren(event)) push(`│     ${child}`);
        }
        break;
      }
      case 'agent_end': {
        const messages = Array.isArray(event?.messages) ? event.messages.length : 0;
        push(`■ agent end (${messages} message(s))`);
        break;
      }
      default:
        // message_start / message_update / tool_execution_update: streaming, skipped.
        break;
    }
  }

  const summary =
    `Pi review execution trace: ${events.length} event(s), ${turn} turn(s), ` +
    `${toolCalls} tool call(s), ${assistantMessages} assistant message(s), ${toolErrors} tool error(s)`;
  if (lines.length >= MAX_RENDERED) lines.push(`… trace truncated after ${MAX_RENDERED} lines …`);
  return [summary, ...lines];
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const file = process.argv[2];
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.log(`Pi review execution trace: no event stream captured at ${file ?? '(unset path)'}`);
    process.exit(0);
  }
  const events = parseTraceEvents(text);
  if (events.length === 0) {
    console.log('Pi review execution trace: event stream is empty');
    process.exit(0);
  }
  for (const line of renderPiReviewTrace(events)) console.log(line);
}
