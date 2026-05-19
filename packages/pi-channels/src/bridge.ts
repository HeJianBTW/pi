import { type ChildProcess, spawn } from 'node:child_process';
import type { ChannelRegistry } from './registry.js';
import type { BridgeConfig, IncomingMessage } from './types.js';

type BridgeRunResult = {
  ok: boolean;
  response: string;
  error?: string;
};

type QueuedMessage = {
  id: string;
  message: IncomingMessage;
};

type SessionState = {
  queue: QueuedMessage[];
  processing: boolean;
  abortController: AbortController | undefined;
};

const DEFAULTS: Required<BridgeConfig> = {
  enabled: false,
  timeoutMs: 300_000,
  maxQueuePerSender: 5,
  maxConcurrent: 2,
  model: null as string | null,
  commands: true,
};

let idCounter = 0;

export class ChatBridge {
  private config: Required<BridgeConfig>;
  private cwd: string;
  private registry: ChannelRegistry;
  private running = false;
  private activeCount = 0;
  private sessions = new Map<string, SessionState>();

  constructor(config: BridgeConfig | undefined, cwd: string, registry: ChannelRegistry) {
    this.config = { ...DEFAULTS, ...(config ?? {}) };
    this.cwd = cwd;
    this.registry = registry;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    for (const session of this.sessions.values()) session.abortController?.abort();
    this.sessions.clear();
    this.activeCount = 0;
  }

  isActive(): boolean {
    return this.running;
  }

  stats(): { active: boolean; sessions: number; activePrompts: number; queued: number } {
    let queued = 0;
    for (const session of this.sessions.values()) queued += session.queue.length;
    return {
      active: this.running,
      sessions: this.sessions.size,
      activePrompts: this.activeCount,
      queued,
    };
  }

  async handleMessage(message: IncomingMessage): Promise<void> {
    if (!this.running) return;
    const text = message.text.trim();
    if (!text) return;

    const senderKey = `${message.adapter}:${message.sender}`;
    const builtInReply = this.handleBuiltInCommand(senderKey, text);
    if (builtInReply !== null) {
      await this.registry.send({
        adapter: message.adapter,
        recipient: message.sender,
        text: builtInReply,
      });
      return;
    }

    const session = this.getSession(senderKey);
    if (session.queue.length >= this.config.maxQueuePerSender) {
      await this.registry.send({
        adapter: message.adapter,
        recipient: message.sender,
        text: `Queue full (${this.config.maxQueuePerSender} pending). Wait or send /abort.`,
      });
      return;
    }

    session.queue.push({ id: `msg-${Date.now()}-${++idCounter}`, message });
    void this.processNext(senderKey);
  }

  private getSession(senderKey: string): SessionState {
    let session = this.sessions.get(senderKey);
    if (!session) {
      session = { queue: [], processing: false, abortController: undefined };
      this.sessions.set(senderKey, session);
    }
    return session;
  }

  private handleBuiltInCommand(senderKey: string, text: string): string | null {
    if (!this.config.commands || !text.startsWith('/')) return null;
    const [command] = text.slice(1).trim().split(/\s+/);
    if (!command) return null;

    if (command === 'status') {
      const stats = this.stats();
      return [
        'Channel bridge status',
        `- Active: ${stats.active}`,
        `- Sessions: ${stats.sessions}`,
        `- Active prompts: ${stats.activePrompts}`,
        `- Queued: ${stats.queued}`,
      ].join('\n');
    }

    if (command === 'abort') {
      const session = this.sessions.get(senderKey);
      if (!session?.abortController) return 'Nothing is running right now.';
      session.abortController.abort();
      return 'Aborting current prompt...';
    }

    if (command === 'new') {
      const session = this.sessions.get(senderKey);
      session?.abortController?.abort();
      this.sessions.delete(senderKey);
      return 'Session reset.';
    }

    if (command === 'help' || command === 'start') {
      return 'Send a message to talk with pi. Commands: /status, /abort, /new.';
    }

    return null;
  }

  private async processNext(senderKey: string): Promise<void> {
    const session = this.sessions.get(senderKey);
    if (!session || session.processing || session.queue.length === 0) return;
    if (this.activeCount >= this.config.maxConcurrent) return;

    const queued = session.queue.shift();
    if (!queued) return;

    session.processing = true;
    this.activeCount++;
    const ac = new AbortController();
    session.abortController = ac;
    const adapter = this.registry.getAdapter(queued.message.adapter);
    adapter?.sendTyping?.(queued.message.sender).catch(() => undefined);

    const result = await runPrompt({
      cwd: this.cwd,
      prompt: queued.message.text,
      timeoutMs: this.config.timeoutMs,
      model: this.config.model,
      signal: ac.signal,
    });

    const reply = result.ok
      ? result.response
      : result.response || `Error: ${result.error ?? 'unknown'}`;
    await this.registry.send({
      adapter: queued.message.adapter,
      recipient: queued.message.sender,
      text: reply,
      ...(queued.message.metadata ? { metadata: queued.message.metadata } : {}),
    });

    session.abortController = undefined;
    session.processing = false;
    this.activeCount--;
    if (session.queue.length > 0) void this.processNext(senderKey);
    this.drainWaiting();
  }

  private drainWaiting(): void {
    if (this.activeCount >= this.config.maxConcurrent) return;
    for (const [senderKey, session] of this.sessions) {
      if (!session.processing && session.queue.length > 0) {
        void this.processNext(senderKey);
        if (this.activeCount >= this.config.maxConcurrent) return;
      }
    }
  }
}

function runPrompt(options: {
  cwd: string;
  prompt: string;
  timeoutMs: number;
  model: string | null;
  signal?: AbortSignal;
}): Promise<BridgeRunResult> {
  return new Promise((resolve) => {
    const args = ['-p', '--no-session', '--no-extensions'];
    if (options.model) args.push('--model', options.model);
    args.push(options.prompt);

    let child: ChildProcess;
    try {
      child = spawn('pi', args, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        timeout: options.timeoutMs,
      });
    } catch (error) {
      resolve({
        ok: false,
        response: '',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const abort = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', abort, { once: true });

    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', abort);
      const response = stdout.trim();
      if (options.signal?.aborted) {
        resolve({ ok: false, response: response || '(aborted)', error: 'Aborted' });
      } else if (code === 0) {
        resolve({ ok: true, response: response || '(no output)' });
      } else {
        resolve({ ok: false, response, error: stderr.trim() || `Exit code ${code ?? 1}` });
      }
    });

    child.on('error', (error) => {
      options.signal?.removeEventListener('abort', abort);
      resolve({ ok: false, response: '', error: error.message });
    });
  });
}
