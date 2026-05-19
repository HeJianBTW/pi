import type { Server } from 'node:http';
import { startHttpEndpoint } from '../../http.js';
import type {
  AdapterConfig,
  ChannelAdapter,
  ChannelMessage,
  OnIncomingMessage,
  WeComAdapterConfig,
} from '../../types.js';
import { WeComAgentClient } from './client.js';
import { decryptWeComEnvelope, verifyWeComSignature } from './crypto.js';
import type {
  NormalizedWeComConfig,
  ResolvedOutboundMessage,
  WeComAgentAccount,
  WeComTextTarget,
} from './types.js';
import { xmlTag, xmlText } from './xml.js';

const DEFAULT_WECOM_BASE_URL = 'https://qyapi.weixin.qq.com/cgi-bin';

function asConfig(config: AdapterConfig): WeComAdapterConfig {
  return config as WeComAdapterConfig;
}

function requireString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(`WeCom adapter requires ${name}`);
}

function requireNumber(value: unknown, name: string): number {
  const raw = requireString(value, name);
  const parsed = Number(raw);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`WeCom adapter requires numeric ${name}`);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function normalizeConfig(config: AdapterConfig): NormalizedWeComConfig {
  const cfg = asConfig(config);
  return {
    ...cfg,
    corpId: requireString(cfg.corpId, 'corpId'),
    agentId: requireNumber(cfg.agentId, 'agentId'),
    secret: requireString(cfg.secret, 'secret'),
    baseUrl: optionalString(cfg.baseUrl) ?? DEFAULT_WECOM_BASE_URL,
    timeoutMs: Number(cfg.timeoutMs ?? 15_000),
    tokenRefreshBufferSeconds: Number(cfg.tokenRefreshBufferSeconds ?? 120),
  };
}

function resolveTarget(message: ChannelMessage): WeComTextTarget {
  const match = message.recipient.match(/^(user|party|tag|chat|appchat):(.+)$/);
  if (!match) return { touser: message.recipient };
  const id = match[2]!;
  if (match[1] === 'party') return { toparty: id };
  if (match[1] === 'tag') return { totag: id };
  if (match[1] === 'chat' || match[1] === 'appchat') return { chatid: id };
  return { touser: id };
}

function resolveOutboundMessage(message: ChannelMessage): ResolvedOutboundMessage {
  if (!message.text) throw new Error('WeCom adapter requires text');
  return {
    raw: message,
    target: resolveTarget(message),
    text: message.source ? `[${message.source}]\n${message.text}` : message.text,
  };
}

function createAgentAccount(cfg: NormalizedWeComConfig): WeComAgentAccount {
  return {
    corpId: cfg.corpId,
    agentId: cfg.agentId,
    secret: cfg.secret,
    baseUrl: cfg.baseUrl,
    tokenRefreshBufferSeconds: cfg.tokenRefreshBufferSeconds,
    network: { timeoutMs: cfg.timeoutMs },
  };
}

function readSignature(url: URL): string | null {
  return (
    url.searchParams.get('msg_signature') ??
    url.searchParams.get('msgsignature') ??
    url.searchParams.get('signature')
  );
}

function decryptAndValidate(params: {
  encrypted: string;
  cfg: NormalizedWeComConfig;
  token: string;
  encodingAesKey: string;
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
}): { message: string; receiveId: string } | null {
  if (
    !verifyWeComSignature({
      token: params.token,
      timestamp: params.timestamp,
      nonce: params.nonce,
      encrypted: params.encrypted,
      provided: params.signature,
    })
  ) {
    return null;
  }

  const decrypted = decryptWeComEnvelope(params.encrypted, params.encodingAesKey);
  const expectedReceiveId = optionalString(params.cfg.receiveId) ?? params.cfg.corpId;
  if (expectedReceiveId && decrypted.receiveId && decrypted.receiveId !== expectedReceiveId) {
    throw new Error(`Unexpected WeCom receiveId: ${decrypted.receiveId}`);
  }
  return decrypted;
}

export function createWeComAdapter(config: AdapterConfig): ChannelAdapter {
  const cfg = normalizeConfig(config);
  const client = new WeComAgentClient(createAgentAccount(cfg));
  let server: Server | null = null;

  async function sendText(message: ChannelMessage): Promise<void> {
    const resolved = resolveOutboundMessage(message);
    await client.sendText({ target: resolved.target, text: resolved.text });
  }

  async function start(onMessage: OnIncomingMessage): Promise<void> {
    if (!cfg.incoming?.enabled || server) return;
    const token = requireString(cfg.token, 'token when incoming.enabled is true');
    const encodingAesKey = requireString(
      cfg.encodingAesKey,
      'encodingAesKey when incoming.enabled is true',
    );
    const host = cfg.incoming.host ?? '0.0.0.0';
    const port = cfg.incoming.port ?? 8788;
    const path = cfg.incoming.path ?? '/wecom/events';

    server = await startHttpEndpoint({
      host,
      port,
      path,
      handler: (request, response, body) => {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
        const signature = readSignature(url);
        const timestamp = url.searchParams.get('timestamp');
        const nonce = url.searchParams.get('nonce');

        if (request.method === 'GET') {
          const echostr = url.searchParams.get('echostr');
          if (!echostr) {
            response.writeHead(400).end('missing echostr');
            return;
          }
          const decrypted = decryptAndValidate({
            encrypted: echostr,
            cfg,
            token,
            encodingAesKey,
            timestamp,
            nonce,
            signature,
          });
          if (!decrypted) {
            response.writeHead(401).end('invalid signature');
            return;
          }
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end(decrypted.message);
          return;
        }

        if (request.method !== 'POST') {
          response.writeHead(405).end('method not allowed');
          return;
        }

        const encrypted = xmlTag(body, 'Encrypt');
        if (!encrypted) {
          response.writeHead(400).end('missing Encrypt');
          return;
        }
        const decrypted = decryptAndValidate({
          encrypted,
          cfg,
          token,
          encodingAesKey,
          timestamp,
          nonce,
          signature,
        });
        if (!decrypted) {
          response.writeHead(401).end('invalid signature');
          return;
        }

        const msgType = xmlText(decrypted.message, 'MsgType');
        if (msgType === 'text') {
          const sender = xmlText(decrypted.message, 'FromUserName');
          const text = xmlText(decrypted.message, 'Content').trim();
          if (sender && text) {
            void onMessage({
              adapter: 'wecom',
              sender,
              text,
              metadata: {
                msgType,
                toUserName: xmlText(decrypted.message, 'ToUserName'),
                agentId: xmlText(decrypted.message, 'AgentID'),
                msgId: xmlTag(decrypted.message, 'MsgId'),
                receiveId: decrypted.receiveId,
              },
            });
          }
        }

        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('success');
      },
    });
  }

  return {
    direction: cfg.incoming?.enabled ? 'bidirectional' : 'outgoing',
    send: sendText,
    start,
    async stop(): Promise<void> {
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    },
  };
}
