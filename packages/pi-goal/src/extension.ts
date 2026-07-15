import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  loadSettings,
  type PiGoalConfig,
  type ResolvedGoalConfig,
  resolveConfig,
} from './config.js';
import { deriveCondition } from './derive.js';
import { evaluateCondition } from './evaluate.js';
import { type ActiveGoal, GoalState, isClearKeyword, MAX_CONDITION_LENGTH } from './goal-state.js';
import type { GoalModelRegistry } from './llm.js';
import { buildActivationMessage, buildContinueMessage } from './prompts.js';
import { buildTranscript, buildTranscriptWithMeta } from './transcript.js';

const STATUS_KEY = 'pi-goal';

export type PiGoalExtensionConfig = PiGoalConfig;

/**
 * Dependencies for the goal engine — extracted so the engine is unit-testable
 * without a live ExtensionAPI.
 */
export interface GoalEngineDeps {
  state: GoalState;
  config: ResolvedGoalConfig;
  registry: GoalModelRegistry;
  sendUserMessage: (content: string) => void;
  notify: (message: string, level: 'info' | 'warning' | 'error') => void;
  setStatus: (text: string) => void;
  signal?: AbortSignal;
  /** Rough token accounting; defaults to a char-based estimate of the transcript. */
  estimateTokens?: (transcript: string) => number;
}

/**
 * Evaluate the active goal against the transcript and either stop (achieved /
 * impossible / limited) or inject a continuation message. Idempotent guard: the
 * caller must ensure only one invocation runs at a time (see extension wiring).
 */
export async function runGoalEngine(
  deps: GoalEngineDeps,
  messages: unknown[],
): Promise<
  'achieved' | 'impossible' | 'continued' | 'budget_limited' | 'iteration_limited' | 'skipped'
> {
  const { state, config, registry } = deps;
  const goal = state.get();
  if (!goal || goal.status !== 'active') return 'skipped';
  if (!config.model) return 'skipped'; // engine disabled without a model

  const { text: transcript, omitted } = buildTranscriptWithMeta(
    messages,
    config.transcriptMaxChars,
  );
  if (!transcript) return 'skipped';

  const verdict = await evaluateCondition({
    registry,
    modelConfig: config.model,
    condition: goal.condition,
    transcript,
    omittedCount: omitted,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  // Model unavailable / call failed: do nothing this round (degrade quietly).
  if (verdict === null) return 'skipped';

  if (verdict.impossible) {
    state.markImpossible(verdict.reason);
    deps.notify(`Goal deemed unreachable: ${verdict.reason}`, 'warning');
    deps.setStatus(formatStatus(state.get()));
    return 'impossible';
  }

  if (verdict.ok) {
    state.markAchieved(verdict.reason);
    deps.notify(`Goal achieved: ${verdict.reason}`, 'info');
    deps.setStatus(formatStatus(state.get()));
    return 'achieved';
  }

  // Not yet met — apply guards before continuing.
  const estimate = deps.estimateTokens ?? ((t: string) => Math.ceil(t.length / 4));
  const tokensUsed = goal.tokensUsed + estimate(transcript);
  state.recordIteration(verdict.reason, tokensUsed);
  const current = state.get();
  if (!current) return 'skipped';

  if (current.iterations >= config.maxIterations) {
    state.markIterationLimited(verdict.reason);
    deps.notify(
      `Goal paused after ${current.iterations} rounds (max reached). Last check: ${verdict.reason}`,
      'warning',
    );
    deps.setStatus(formatStatus(state.get()));
    return 'iteration_limited';
  }

  if (config.tokenBudget && tokensUsed >= config.tokenBudget) {
    state.markBudgetLimited(verdict.reason);
    deps.notify(`Goal paused: token budget reached. Last check: ${verdict.reason}`, 'warning');
    deps.setStatus(formatStatus(state.get()));
    return 'budget_limited';
  }

  deps.setStatus(formatStatus(current));
  deps.sendUserMessage(buildContinueMessage(current.condition, verdict.reason));
  return 'continued';
}

export default function goalExtension(
  pi: ExtensionAPI,
  injectedConfig?: PiGoalExtensionConfig,
): void {
  const state = new GoalState();
  let config: ResolvedGoalConfig = resolveConfig(injectedConfig);
  let registry: GoalModelRegistry | undefined;
  let latestMessages: unknown[] = [];
  let engineRunning = false;
  // Set when `--goal` was passed with an empty value: derivation is deferred to
  // the first before_agent_start, where the user's prompt is available. At
  // session_start there is no transcript yet, so deriving there yields nothing.
  let pendingDerive = false;

  pi.on('session_start', async (_event, ctx) => {
    const fileConfig = loadSettings(ctx.cwd);
    config = resolveConfig({ ...fileConfig, ...injectedConfig });
    registry = ctx.modelRegistry as unknown as GoalModelRegistry;
    ctx.ui.setStatus(STATUS_KEY, config.model ? 'goal: none' : 'goal: disabled (no model)');

    // --goal <condition> flag: set the goal at startup (print mode can't dispatch
    // the /goal slash command, so the flag is the CLI entry point). An empty
    // string (bare --goal) defers derivation to before_agent_start, where the
    // user's prompt for the turn is available to derive from.
    const flagValue = pi.getFlag('goal');
    if (typeof flagValue === 'string') {
      const condition = flagValue.trim();
      if (condition && !isClearKeyword(condition)) {
        setExplicitGoal(condition, ctx);
      } else if (!condition) {
        pendingDerive = true;
      }
    }
  });

  // First user prompt: if a --goal derivation is pending, derive the condition
  // now — event.prompt carries what the user wants this turn, which is the
  // signal to derive from. Fires once per prompt; we clear the flag after.
  pi.on('before_agent_start', async (event, ctx) => {
    if (!pendingDerive) return;
    pendingDerive = false;
    const evt = event as unknown as { prompt?: unknown };
    const prompt = typeof evt.prompt === 'string' ? evt.prompt : '';
    // activate=false: the agent is about to run this prompt, so don't inject an
    // activation message (it would throw "already processing"). The run reaches
    // agent_end on its own, where the engine evaluates the goal.
    await deriveAndSet(ctx, prompt, false);
  });

  // Keep the freshest full message list for the engine; agent_end also carries it.
  pi.on('turn_end', async (event) => {
    const evt = event as unknown as { message?: unknown };
    if (evt.message) latestMessages.push(evt.message);
  });

  pi.on('agent_end', async (event, ctx) => {
    if (!state.isActive() || !config.model || !registry) return;
    if (engineRunning) return; // re-entrancy guard: our own sendUserMessage re-triggers agent_end
    const evt = event as unknown as { messages?: unknown[] };
    const messages =
      Array.isArray(evt.messages) && evt.messages.length > 0 ? evt.messages : latestMessages;

    engineRunning = true;
    try {
      await runGoalEngine(
        {
          state,
          config,
          registry,
          sendUserMessage: (content) => pi.sendUserMessage(content),
          notify: (message, level) => ctx.ui.notify(message, level),
          setStatus: (text) => ctx.ui.setStatus(STATUS_KEY, text),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
        messages,
      );
    } catch (err) {
      console.error(`[pi-goal] engine error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      engineRunning = false;
    }
  });

  pi.on('session_shutdown', async () => {
    state.clear();
    latestMessages = [];
    registry = undefined;
    pendingDerive = false;
  });

  pi.registerFlag('goal', {
    description:
      'Set a goal at startup — Pi keeps working until the condition is met. Pass a condition, or an empty string to derive one from context.',
    type: 'string',
  });

  pi.registerCommand('goal', {
    description:
      'Set a goal — Pi keeps working until the condition is met. Usage: /goal [<condition> | clear]. With no argument, derives a goal from the conversation.',
    getArgumentCompletions: (prefix: string) => {
      const options = ['clear'];
      const matches = options.filter((o) => o.startsWith(prefix.trim().toLowerCase()));
      return matches.map((o) => ({ label: o, value: o }));
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const arg = args.trim();

      // Clear
      if (isClearKeyword(arg)) {
        const cleared = state.clear();
        ctx.ui.setStatus(STATUS_KEY, config.model ? 'goal: none' : 'goal: disabled (no model)');
        ctx.ui.notify(cleared ? `Goal cleared: ${cleared.condition}` : 'No goal was set.', 'info');
        return;
      }

      // Explicit condition
      if (arg) {
        setExplicitGoal(arg, ctx);
        return;
      }

      // No argument: show status if a goal exists, else derive
      const existing = state.get();
      if (existing && existing.status === 'active') {
        ctx.ui.notify(formatDetail(existing), 'info');
        return;
      }

      await deriveAndSet(ctx);
    },
  });

  function setExplicitGoal(condition: string, ctx: ExtensionContext): void {
    if (condition.length > MAX_CONDITION_LENGTH) {
      ctx.ui.notify(`Goal condition is limited to ${MAX_CONDITION_LENGTH} characters.`, 'error');
      return;
    }
    try {
      const goal = state.set(condition, 'explicit', tokenBudgetOpts());
      ctx.ui.setStatus(STATUS_KEY, formatStatus(goal));
      if (config.model) {
        pi.sendUserMessage(buildActivationMessage(goal.condition));
      } else {
        ctx.ui.notify(
          'Goal set, but no evaluator model is configured — auto-continuation is disabled.',
          'warning',
        );
      }
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : 'Failed to set goal.', 'error');
    }
  }

  async function deriveAndSet(
    ctx: ExtensionContext,
    extraContext = '',
    activate = true,
  ): Promise<void> {
    if (!config.model || !registry) {
      ctx.ui.notify(
        'No evaluator model configured. Set `pi-goal.model` in settings, or use `/goal <condition>`.',
        'warning',
      );
      return;
    }
    ctx.ui.notify('Deriving a goal from the conversation…', 'info');
    // Fold the current turn's prompt (when derivation was triggered by --goal
    // before any turn has run) into the buffered transcript, so there is always
    // something to derive from even on a fresh session.
    const buffered = buildTranscript(latestMessages, config.transcriptMaxChars);
    const extra = extraContext.trim() ? `[user] ${extraContext.trim()}` : '';
    const transcript = [buffered, extra].filter(Boolean).join('\n\n');
    const condition = await deriveCondition({
      registry,
      modelConfig: config.model,
      transcript,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!condition) {
      ctx.ui.notify(
        'Could not derive a clear goal from the conversation. Try `/goal <condition>`.',
        'warning',
      );
      return;
    }

    if (config.requireConfirmForDerived && ctx.hasUI) {
      const approved = await ctx.ui.confirm(
        'Set this goal?',
        `Pi will keep working until:\n\n${condition}`,
      );
      if (!approved) {
        ctx.ui.notify('Goal not set.', 'info');
        return;
      }
    }

    try {
      const goal = state.set(condition, 'derived', tokenBudgetOpts());
      ctx.ui.setStatus(STATUS_KEY, formatStatus(goal));
      // Only inject the activation nudge when the agent is idle (interactive
      // /goal). When deriving at before_agent_start, the agent is already about
      // to run the user's prompt — injecting here throws "Agent is already
      // processing a prompt". That run naturally reaches agent_end, where the
      // engine evaluates the goal.
      if (activate) {
        pi.sendUserMessage(buildActivationMessage(goal.condition));
      }
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : 'Failed to set goal.', 'error');
    }
  }

  function tokenBudgetOpts(): { tokenBudget?: number } {
    return config.tokenBudget ? { tokenBudget: config.tokenBudget } : {};
  }
}

function formatStatus(goal: ActiveGoal | undefined): string {
  if (!goal) return 'goal: none';
  if (goal.status === 'active') return `goal: active (${goal.iterations})`;
  return `goal: ${goal.status}`;
}

function formatDetail(goal: ActiveGoal): string {
  const lines = [
    `Goal (${goal.origin}): ${goal.condition}`,
    `Status: ${goal.status}`,
    `Rounds: ${goal.iterations}`,
  ];
  if (goal.tokenBudget) lines.push(`Tokens: ~${goal.tokensUsed} / ${goal.tokenBudget}`);
  if (goal.lastReason) lines.push(`Last check: ${goal.lastReason}`);
  lines.push('/goal clear to stop early');
  return lines.join('\n');
}
