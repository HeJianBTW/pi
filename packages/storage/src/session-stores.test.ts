import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConversationTurn, RuntimeSession } from '@amaster.ai/pi-shared';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonFileConversationStore, JsonFileTranscriptStore } from './session-stores.js';

const tmpDirs: string[] = [];

describe('JsonFileTranscriptStore', () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes versioned history state with turns, messages, and session summaries', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-history-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'transcripts.json');

    const store = new JsonFileTranscriptStore(filePath);
    await store.appendTurn(turn('turn-1', 'session-1', 'hello', 'hi'));
    await store.appendTurn(turn('turn-2', 'session-1', 'next', 'done'));

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    expect(persisted).toMatchObject({
      version: 1,
      sessionSummaries: {
        'session-1': {
          title: 'hello',
          turnCount: 2,
          firstUserMessage: 'hello',
          lastUserMessage: 'next',
          lastAssistantMessage: 'done',
          lastMessageAt: '2026-05-13T00:00:00.000Z',
        },
      },
    });
    expect(persisted.turns).toHaveLength(2);
    expect(persisted.messages).toMatchObject([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi' },
      { role: 'user', text: 'next' },
      { role: 'assistant', text: 'done' },
    ]);
  });

  it('returns session summaries from persisted summary state', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-history-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'transcripts.json');
    const store = new JsonFileTranscriptStore(filePath);

    await store.appendTurn(turn('turn-1', 'session-1', 'first question', 'first answer'));

    expect(
      await store.listSessionSummaries({ tenantId: 'tenant-1' }, [
        {
          sessionId: 'session-1',
          conversationId: 'session-1',
          tenantId: 'tenant-1',
          model: model(),
          sandboxStatus: 'running',
          toolPolicyProfile: 'default',
        },
      ]),
    ).toMatchObject([
      {
        sessionId: 'session-1',
        title: 'first question',
        turnCount: 1,
        lastUserMessage: 'first question',
        lastAssistantMessage: 'first answer',
      },
    ]);
  });

  it('treats legacy JSON sessions without tenantId as default tenant sessions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-history-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'sessions.json');
    const store = new JsonFileConversationStore(filePath);
    const legacySession = {
      sessionId: 'legacy-session',
      conversationId: 'legacy-session',
      model: model(),
      sandboxStatus: 'running',
      toolPolicyProfile: 'default',
    } satisfies RuntimeSession;

    await store.saveRuntimeSession(legacySession);

    await expect(store.listRuntimeSessions({ tenantId: 'default' })).resolves.toMatchObject([
      { sessionId: 'legacy-session' },
    ]);
    await expect(
      store.getRuntimeSession({ tenantId: 'default' }, 'legacy-session'),
    ).resolves.toMatchObject({
      sessionId: 'legacy-session',
    });
    await expect(store.listRuntimeSessions({ tenantId: 'tenant-1' })).resolves.toEqual([]);
  });
});

function turn(
  id: string,
  sessionId: string,
  userMessage: string,
  assistantMessage: string,
): ConversationTurn {
  return {
    id,
    sessionId,
    conversationId: sessionId,
    userMessage,
    assistantMessage,
    model: model(),
    createdAt: '2026-05-13T00:00:00.000Z',
  };
}

function model(): ConversationTurn['model'] {
  return {
    provider: 'openai',
    model: 'gpt-test',
  };
}
