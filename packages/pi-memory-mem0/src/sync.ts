/**
 * Passive turn sync — sends conversation pairs to Mem0 for server-side extraction.
 * Buffers user and assistant messages, syncs as pairs.
 */

import type { Mem0Provider } from './provider.js';

export class TurnSync {
  private readonly provider: Mem0Provider;
  private readonly userId: string;
  private inflight = false;
  private lastUserText = '';

  constructor(provider: Mem0Provider, userId: string) {
    this.provider = provider;
    this.userId = userId;
  }

  /** Buffer a message. When we have a user+assistant pair, sync it. */
  onMessage(role: string, text: string): void {
    if (role === 'user') {
      this.lastUserText = text;
      return;
    }

    if (role === 'assistant' && text && this.lastUserText) {
      this.sync(this.lastUserText, text);
      this.lastUserText = '';
    }
  }

  private sync(userContent: string, assistantContent: string): void {
    if (this.inflight) return;

    this.inflight = true;
    this.provider
      .add(
        [
          { role: 'user', content: userContent },
          { role: 'assistant', content: assistantContent },
        ],
        { userId: this.userId },
      )
      .catch(() => {})
      .finally(() => {
        this.inflight = false;
      });
  }
}
