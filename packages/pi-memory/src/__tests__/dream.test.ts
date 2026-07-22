import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDream } from '../dream.js';
import { writeDreamingState } from '../dreaming-state.js';

const { runConsolidationMock } = vi.hoisted(() => ({
  runConsolidationMock: vi.fn(),
}));

vi.mock('../consolidation.js', () => ({
  runConsolidation: runConsolidationMock,
}));

describe('runDream', () => {
  let home: string;
  let sessionDir: string;
  let session: SessionManager;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    home = path.join(tmpdir(), `pi-memory-dream-test-${Date.now()}-${Math.random()}`);
    process.env.PI_CODING_AGENT_DIR = path.join(home, 'pi-agent');
    sessionDir = path.join(home, 'sessions');
    session = SessionManager.create(home, sessionDir, { id: 'dream-test' });
    appendTurn(session, 1);
    runConsolidationMock.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(home, { recursive: true, force: true });
  });

  it('reads default Pi sessions across project directories', async () => {
    const projectA = SessionManager.create(path.join(home, 'project-a'), undefined, {
      id: 'project-a',
    });
    const projectB = SessionManager.create(path.join(home, 'project-b'), undefined, {
      id: 'project-b',
    });
    appendTurn(projectA, 1);
    appendTurn(projectB, 2);

    await expect(
      runDream({
        dreaming: { minHoursSinceLastRun: 0, minTurnsSinceLastRun: 2 },
        includeGlobalSessions: true,
        memoryDir: path.join(home, 'global-memories'),
        modelRegistry: modelRegistry(),
        sessionDir: projectA.getSessionDir(),
      }),
    ).resolves.toBe(true);

    expect(runConsolidationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: expect.arrayContaining([
          expect.objectContaining({ sessionId: 'project-a' }),
          expect.objectContaining({ sessionId: 'project-b' }),
        ]),
      }),
    );
  });

  it('keeps a custom memory store scoped to its current session directory', async () => {
    const otherProject = SessionManager.create(path.join(home, 'other-project'), undefined, {
      id: 'other-project',
    });
    appendTurn(otherProject, 2);

    await expect(
      runDream({
        dreaming: { minHoursSinceLastRun: 0, minTurnsSinceLastRun: 1 },
        memoryDir: path.join(home, 'isolated-memories'),
        modelRegistry: modelRegistry(),
        sessionDir,
      }),
    ).resolves.toBe(true);

    expect(runConsolidationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [expect.objectContaining({ sessionId: 'dream-test' })],
      }),
    );
  });

  it('reads Pi sessions, runs once, and skips while the time gate is closed', async () => {
    const options = {
      dreaming: { minHoursSinceLastRun: 24, minTurnsSinceLastRun: 1 },
      memoryDir: path.join(home, 'memories'),
      modelRegistry: modelRegistry(),
      sessionDir,
    };

    await expect(runDream(options)).resolves.toBe(true);
    await expect(runDream(options)).resolves.toBe(false);

    expect(runConsolidationMock).toHaveBeenCalledTimes(1);
    expect(runConsolidationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          expect.objectContaining({
            assistantMessage: 'Understood',
            sessionId: 'dream-test',
            userMessage: 'Remember preference 1',
          }),
        ],
      }),
    );
  });

  it('skips while the turns gate is closed', async () => {
    const result = await runDream({
      dreaming: { minHoursSinceLastRun: 0, minTurnsSinceLastRun: 2 },
      memoryDir: path.join(home, 'memories'),
      modelRegistry: modelRegistry(),
      sessionDir,
    });

    expect(result).toBe(false);
    expect(runConsolidationMock).not.toHaveBeenCalled();
  });

  it('defaults to a five-turn gate', async () => {
    const options = {
      memoryDir: path.join(home, 'memories'),
      modelRegistry: modelRegistry(),
      sessionDir,
    };

    for (let index = 2; index <= 4; index++) appendTurn(session, index);
    await expect(runDream(options)).resolves.toBe(false);

    appendTurn(session, 5);
    await expect(runDream(options)).resolves.toBe(true);
  });

  it('defaults to a 24-hour time gate', async () => {
    const memoryDir = path.join(home, 'memories');
    for (let index = 2; index <= 6; index++) appendTurn(session, index, Date.now());

    await writeDreamingState(
      {
        lastConsolidatedAt: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
        lastSessionCount: 0,
      },
      memoryDir,
    );
    await expect(runDream({ memoryDir, modelRegistry: modelRegistry(), sessionDir })).resolves.toBe(
      false,
    );

    await writeDreamingState(
      {
        lastConsolidatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        lastSessionCount: 0,
      },
      memoryDir,
    );
    await expect(runDream({ memoryDir, modelRegistry: modelRegistry(), sessionDir })).resolves.toBe(
      true,
    );
  });

  it('skips a concurrent session while another dream holds the lock', async () => {
    let finish: ((value: boolean) => void) | undefined;
    runConsolidationMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const options = {
      dreaming: { minHoursSinceLastRun: 0, minTurnsSinceLastRun: 1 },
      memoryDir: path.join(home, 'memories'),
      modelRegistry: modelRegistry(),
      sessionDir,
    };

    const first = runDream(options);
    await vi.waitFor(() => expect(runConsolidationMock).toHaveBeenCalledTimes(1));
    await expect(runDream(options)).resolves.toBe(false);
    finish?.(true);
    await expect(first).resolves.toBe(true);

    expect(runConsolidationMock).toHaveBeenCalledTimes(1);
  });
});

function modelRegistry() {
  return {
    find: vi.fn(),
    getApiKeyAndHeaders: vi.fn(),
  };
}

function appendTurn(session: SessionManager, index: number, timestamp = Date.parse('2020-01-01')) {
  session.appendMessage({
    role: 'user',
    content: `Remember preference ${index}`,
    timestamp,
  });
  session.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'Understood' }],
    provider: 'test',
    model: 'test-model',
    timestamp,
  } as never);
}
