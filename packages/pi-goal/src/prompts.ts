/**
 * Prompt templates for the goal engine.
 *
 * - Derive: turn recent conversation into one measurable completion condition.
 * - Evaluate: judge whether a condition is met (JSON verdict), modeled on
 *   Claude Code's stop-condition evaluator.
 * - Activation / continue: messages injected into the main agent to drive it.
 */

export const DERIVE_SYSTEM_PROMPT = `You infer a single, concrete completion condition from a coding conversation.

Given the recent transcript, output ONE line describing the measurable outcome that would mean the user's current objective is fully handled. This condition will later be used to judge whether the agent may stop working.

Rules:
- Output ONLY the condition text — no preamble, no quotes, no markdown, no trailing explanation.
- Make it measurable and verifiable (e.g. "All tests pass and \`pnpm lint\` reports no errors", "The /login endpoint returns 200 for valid credentials and 401 otherwise").
- Base it on the user's most recent intent, not incidental side-quests.
- Keep it under 300 characters.
- If the conversation has no actionable objective, output exactly: NONE`;

export function buildDeriveUserPrompt(transcript: string): string {
  return `## Recent conversation\n\n${transcript}\n\n---\nInfer the single measurable completion condition, or output NONE.`;
}

export const EVALUATE_SYSTEM_PROMPT = `You are evaluating a stop condition for a coding agent. Based on the conversation transcript, judge whether the user-provided condition is now satisfied.

Respond with a JSON object and NOTHING else. Shapes:
- Met:        {"ok": true, "reason": "<why it is satisfied>"}
- Not yet:    {"ok": false, "reason": "<what still remains>"}
- Impossible: {"ok": false, "impossible": true, "reason": "<why it cannot be achieved>"}

Guidance:
- Only report ok:true when the condition is genuinely and verifiably met by the work shown.
- Use impossible sparingly — only when the condition can never be satisfied (contradictory, blocked by an external hard limit), not merely because it is unfinished.
- Keep "reason" to one sentence.`;

export function buildEvaluateUserPrompt(condition: string, transcript: string): string {
  return `## Conversation transcript\n\n${transcript}\n\n## Condition\n\n${condition}\n\n---\nHas the condition been satisfied? Reply with the JSON verdict only.`;
}

/** Injected once when a goal is set, so the main agent starts working toward it. */
export function buildActivationMessage(condition: string): string {
  return [
    `A goal is now active with condition: "${condition}".`,
    'Briefly acknowledge it, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask what to do.',
    'You will be checked against this condition when you finish; work will resume automatically until it holds.',
    'It clears automatically once the condition is met — do not tell the user to clear it after success.',
  ].join(' ');
}

/** Injected after a not-yet-met evaluation to drive the next round of work. */
export function buildContinueMessage(condition: string, reason: string): string {
  return [
    `The goal is not yet met. Goal condition: "${condition}".`,
    `What still remains: ${reason}`,
    'Continue working toward the condition now.',
  ].join(' ');
}
