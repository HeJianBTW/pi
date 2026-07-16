import { describe, expect, it } from 'vitest';
import { GoalState, isClearKeyword, MAX_CONDITION_LENGTH } from '../goal-state.js';

describe('GoalState', () => {
  it('sets an active goal and reports it', () => {
    const state = new GoalState();
    const goal = state.set('all tests pass', 'explicit');
    expect(goal.condition).toBe('all tests pass');
    expect(goal.origin).toBe('explicit');
    expect(goal.status).toBe('active');
    expect(goal.iterations).toBe(0);
    expect(state.isActive()).toBe(true);
    expect(state.get()).toBe(goal);
  });

  it('trims the condition and rejects empty', () => {
    const state = new GoalState();
    expect(state.set('  spaced  ', 'derived').condition).toBe('spaced');
    expect(() => state.set('   ', 'derived')).toThrow(/empty/i);
  });

  it('rejects conditions over the length cap', () => {
    const state = new GoalState();
    const tooLong = 'x'.repeat(MAX_CONDITION_LENGTH + 1);
    expect(() => state.set(tooLong, 'explicit')).toThrow(/4000 characters/);
  });

  it('carries a token budget when provided', () => {
    const state = new GoalState();
    expect(state.set('c', 'explicit', { tokenBudget: 1000 }).tokenBudget).toBe(1000);
    expect(state.set('c', 'explicit', { tokenBudget: 0 }).tokenBudget).toBeUndefined();
  });

  it('records iterations and last reason', () => {
    const state = new GoalState();
    state.set('c', 'derived');
    state.recordIteration('still failing', 42);
    const goal = state.get();
    expect(goal?.iterations).toBe(1);
    expect(goal?.lastReason).toBe('still failing');
    expect(goal?.tokensUsed).toBe(42);
  });

  it('transitions through terminal states', () => {
    const state = new GoalState();
    state.set('c', 'derived');
    state.markAchieved('done');
    expect(state.get()?.status).toBe('achieved');
    expect(state.get()?.lastReason).toBe('done');
    expect(state.isActive()).toBe(false);

    state.set('c2', 'derived');
    state.markImpossible('cannot');
    expect(state.get()?.status).toBe('impossible');

    state.set('c3', 'derived');
    state.markBudgetLimited();
    expect(state.get()?.status).toBe('budget_limited');

    state.set('c4', 'derived');
    state.markIterationLimited();
    expect(state.get()?.status).toBe('iteration_limited');
  });

  it('clears the goal', () => {
    const state = new GoalState();
    state.set('c', 'explicit');
    const cleared = state.clear();
    expect(cleared?.status).toBe('cleared');
    expect(state.get()).toBeUndefined();
    expect(state.isActive()).toBe(false);
  });

  it('mutation methods are no-ops without an active goal', () => {
    const state = new GoalState();
    expect(state.recordIteration('x', 1)).toBeUndefined();
    expect(state.markAchieved('x')).toBeUndefined();
    expect(state.clear()).toBeUndefined();
  });
});

describe('isClearKeyword', () => {
  it('matches the clear keyword set case-insensitively', () => {
    for (const kw of ['clear', 'STOP', 'Off', 'reset', 'none', 'cancel']) {
      expect(isClearKeyword(kw)).toBe(true);
    }
    expect(isClearKeyword('  clear  ')).toBe(true);
  });

  it('does not match a real condition', () => {
    expect(isClearKeyword('stop the server from crashing')).toBe(false);
    expect(isClearKeyword('all tests pass')).toBe(false);
  });
});
