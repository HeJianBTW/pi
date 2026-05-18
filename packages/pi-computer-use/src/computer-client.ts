import WebSocket from 'ws';
import type { ComputerUseConfig } from './config.js';

const COMMAND_TIMEOUT_MS = 30_000;

export class ComputerClient {
  private ws: WebSocket | null = null;
  private commandLock: Promise<unknown> = Promise.resolve();
  private config: ComputerUseConfig;

  constructor(config: ComputerUseConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const host = this.config.host ?? '127.0.0.1';
    const port = this.config.port ?? 8000;
    const protocol = this.config.apiKey ? 'wss' : 'ws';
    const url = `${protocol}://${host}:${port}/ws`;

    const headers: Record<string, string> = {};
    if (this.config.apiKey) headers['X-API-Key'] = this.config.apiKey;
    if (this.config.vmName) headers['X-VM-Name'] = this.config.vmName;

    this.ws = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      ws.on('open', async () => {
        if (this.config.apiKey && this.config.vmName) {
          try {
            await this.authenticate(ws);
          } catch (err) {
            ws.close();
            reject(err);
            return;
          }
        }
        resolve(ws);
      });
      ws.on('error', (err) => reject(new Error(`WebSocket connection failed: ${err.message}`)));
    });
  }

  async sendCommand(
    command: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const execute = (): Promise<Record<string, unknown>> =>
        new Promise((innerResolve, innerReject) => {
          const timer = setTimeout(() => {
            innerReject(new Error(`Command "${command}" timed out after ${COMMAND_TIMEOUT_MS}ms`));
          }, COMMAND_TIMEOUT_MS);

          const handler = (data: WebSocket.RawData) => {
            clearTimeout(timer);
            this.ws?.off('message', handler);
            try {
              const response = JSON.parse(data.toString()) as Record<string, unknown>;
              if (response.error) {
                innerReject(new Error(response.error as string));
              } else {
                innerResolve(response);
              }
            } catch (err) {
              innerReject(err);
            }
          };

          this.ws!.on('message', handler);
          this.ws!.send(JSON.stringify({ command, params }));
        });

      this.commandLock = this.commandLock.then(() => execute().then(resolve, reject));
    });

    return result;
  }

  async screenshot(): Promise<string> {
    const response = await this.sendCommand('screenshot', {});
    const imageData = response.image_data as string | undefined;
    if (!imageData) {
      throw new Error('No image_data in screenshot response');
    }
    return imageData;
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private authenticate(ws: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const handler = (data: WebSocket.RawData) => {
        ws.off('message', handler);
        try {
          const response = JSON.parse(data.toString()) as Record<string, unknown>;
          if (response.success) {
            resolve();
          } else {
            reject(new Error(`Authentication failed: ${response.error ?? 'unknown error'}`));
          }
        } catch (err) {
          reject(err);
        }
      };

      ws.on('message', handler);
      ws.send(
        JSON.stringify({
          command: 'authenticate',
          params: { api_key: this.config.apiKey, container_name: this.config.vmName },
        }),
      );
    });
  }
}
