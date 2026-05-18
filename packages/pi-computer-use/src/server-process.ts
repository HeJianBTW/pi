import { type ChildProcess, spawn } from 'node:child_process';
import WebSocket from 'ws';
import type { ComputerUseConfig } from './config.js';

const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const KILL_GRACE_MS = 2_000;

export class ComputerServerProcess {
  private proc: ChildProcess | null = null;

  async start(config: ComputerUseConfig): Promise<void> {
    const cmd = config.command ?? 'uvx';
    const pkg = config.package ?? 'cua-computer-server';
    const host = config.host ?? '127.0.0.1';
    const port = config.port ?? 8000;
    const args = [pkg, '--host', host, '--port', String(port), ...(config.extraArgs ?? [])];

    this.proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.error(`[pi-computer-use] ${line}`);
    });

    this.proc.on('error', (err) => {
      console.error(`[pi-computer-use] Failed to start ${cmd}: ${err.message}`);
    });

    await this.waitForReady(host, port);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;

    const proc = this.proc;
    this.proc = null;

    proc.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, KILL_GRACE_MS);

      proc.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async waitForReady(host: string, port: number): Promise<void> {
    const wsUrl = `ws://${host}:${port}/ws`;
    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (this.proc?.exitCode !== null && this.proc?.exitCode !== undefined) {
        throw new Error(
          `cua-computer-server exited with code ${this.proc.exitCode} before becoming ready`,
        );
      }

      const ready = await this.probeWs(wsUrl);
      if (ready) return;

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    throw new Error(`cua-computer-server not ready after ${READY_TIMEOUT_MS}ms`);
  }

  private probeWs(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.terminate();
        resolve(false);
      }, 1_000);

      ws.on('open', () => {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      });

      ws.on('error', () => {
        clearTimeout(timer);
        ws.terminate();
        resolve(false);
      });
    });
  }
}
