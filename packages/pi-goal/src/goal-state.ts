/**
 * Session-scoped goal state. A single active goal per session, held in memory
 * (mirrors Claude Code's session-level activeGoal — no cross-session persistence).
 */

export type GoalStatus =
  | 'active'
  | 'achieved'
  | 'impossible'
  | 'budget_limited'
  | 'iteration_limited'
  | 'cleared';

export type GoalOrigin = 'derived' | 'explicit';

export interface ActiveGoal {
  condition: string;
  origin: GoalOrigin;
  status: GoalStatus;
  iterations: number;
  setAt: number;
  lastReason?: string;
  tokenBudget?: number;
  tokensUsed: number;
}

/** Max length of a goal condition, matching Claude Code's 4000-char cap. */
export const MAX_CONDITION_LENGTH = 4000;

/** Keywords that clear an active goal (matches Claude Code's clear-keyword set). */
export const CLEAR_KEYWORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

export function isClearKeyword(arg: string): boolean {
  return CLEAR_KEYWORDS.has(arg.trim().toLowerCase());
}

/**
 * Holds the single active goal for a session. Instantiated per-session in the
 * extension; not shared across sessions.
 */
export class GoalState {
  private goal: ActiveGoal | undefined;

  get(): ActiveGoal | undefined {
    return this.goal;
  }

  isActive(): boolean {
    return this.goal?.status === 'active';
  }

  /**
   * Set (or replace) the active goal. Throws on an empty or over-long condition
   * so callers can surface a sanitized error to the user.
   */
  set(condition: string, origin: GoalOrigin, options: { tokenBudget?: number } = {}): ActiveGoal {
    const trimmed = condition.trim();
    if (!trimmed) {
      throw new Error('Goal condition cannot be empty');
    }
    if (trimmed.length > MAX_CONDITION_LENGTH) {
      throw new Error(`Goal condition is limited to ${MAX_CONDITION_LENGTH} characters`);
    }
    const goal: ActiveGoal = {
      condition: trimmed,
      origin,
      status: 'active',
      iterations: 0,
      setAt: Date.now(),
      tokensUsed: 0,
    };
    if (typeof options.tokenBudget === 'number' && options.tokenBudget > 0) {
      goal.tokenBudget = options.tokenBudget;
    }
    this.goal = goal;
    return goal;
  }

  clear(): ActiveGoal | undefined {
    const previous = this.goal;
    if (previous) {
      previous.status = 'cleared';
    }
    this.goal = undefined;
    return previous;
  }

  /** Record a not-yet-met round: bump iterations, store the evaluator's reason. */
  recordIteration(reason: string, tokensUsed: number): ActiveGoal | undefined {
    if (!this.goal) return undefined;
    this.goal.iterations += 1;
    this.goal.lastReason = reason;
    this.goal.tokensUsed = tokensUsed;
    return this.goal;
  }

  markAchieved(reason: string): ActiveGoal | undefined {
    return this.transition('achieved', reason);
  }

  markImpossible(reason: string): ActiveGoal | undefined {
    return this.transition('impossible', reason);
  }

  markBudgetLimited(reason?: string): ActiveGoal | undefined {
    return this.transition('budget_limited', reason);
  }

  markIterationLimited(reason?: string): ActiveGoal | undefined {
    return this.transition('iteration_limited', reason);
  }

  private transition(status: GoalStatus, reason?: string): ActiveGoal | undefined {
    if (!this.goal) return undefined;
    this.goal.status = status;
    if (reason !== undefined) {
      this.goal.lastReason = reason;
    }
    return this.goal;
  }
}
