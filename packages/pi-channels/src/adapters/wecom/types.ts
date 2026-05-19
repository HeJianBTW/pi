import type { ChannelMessage, WeComAdapterConfig } from '../../types.js';

export type WeComNetworkOptions = {
  timeoutMs: number;
};

export type WeComAgentAccount = {
  corpId: string;
  agentId: number;
  secret: string;
  baseUrl: string;
  tokenRefreshBufferSeconds: number;
  network: WeComNetworkOptions;
};

export type WeComRecipient =
  | { kind: 'user'; id: string }
  | { kind: 'party'; id: string }
  | { kind: 'tag'; id: string }
  | { kind: 'appchat'; id: string };

export type WeComTextTarget = {
  touser?: string;
  toparty?: string;
  totag?: string;
  chatid?: string;
};

export type WeComIncomingContext = {
  token: string;
  encodingAesKey: string;
  receiveId?: string;
  corpId: string;
};

export type NormalizedWeComConfig = WeComAdapterConfig & {
  corpId: string;
  agentId: number;
  secret: string;
  baseUrl: string;
  timeoutMs: number;
  tokenRefreshBufferSeconds: number;
  incoming?: WeComAdapterConfig['incoming'];
};

export type ResolvedOutboundMessage = {
  target: WeComTextTarget;
  text: string;
  raw: ChannelMessage;
};
