export type WeComErrorCategory =
  | 'ip_whitelist'
  | 'invalid_credential'
  | 'invalid_recipient'
  | 'rate_limited'
  | 'network'
  | 'api';

export type WeComApiErrorDetails = {
  operation: string;
  errcode?: number | undefined;
  errmsg?: string | undefined;
  status?: number | undefined;
  category?: WeComErrorCategory | undefined;
  invalidUser?: string | undefined;
  invalidParty?: string | undefined;
  invalidTag?: string | undefined;
};

export function categorizeWeComError(errcode?: number, errmsg = ''): WeComErrorCategory {
  if (errcode === 60020 || errmsg.includes('not allow to access from your ip')) {
    return 'ip_whitelist';
  }
  if ([40001, 40013, 40014, 41001, 41002, 42001].includes(errcode ?? Number.NaN)) {
    return 'invalid_credential';
  }
  if ([81013, 84061].includes(errcode ?? Number.NaN)) return 'invalid_recipient';
  if ([45009, 45011].includes(errcode ?? Number.NaN)) return 'rate_limited';
  return 'api';
}

function hintFor(category: WeComErrorCategory): string {
  if (category === 'ip_whitelist') {
    return '企业微信拒绝了当前出口 IP，请在企业微信后台把运行机器或代理出口加入可信 IP，或配置固定出口代理。';
  }
  if (category === 'invalid_credential') {
    return '请检查 CorpID、应用 Secret、AgentId 以及 token 是否来自同一个企业微信自建应用。';
  }
  if (category === 'invalid_recipient') {
    return '请检查接收人、部门、标签或 appchat id 是否存在且该应用有可见范围权限。';
  }
  if (category === 'rate_limited') {
    return '企业微信接口触发限频，请稍后重试或降低发送频率。';
  }
  return '请参考企业微信接口错误码进一步排查。';
}

export class WeComApiError extends Error {
  readonly operation: string;
  readonly errcode: number | undefined;
  readonly errmsg: string | undefined;
  readonly status: number | undefined;
  readonly category: WeComErrorCategory;
  readonly invalidUser: string | undefined;
  readonly invalidParty: string | undefined;
  readonly invalidTag: string | undefined;
  readonly hint: string;

  constructor(details: WeComApiErrorDetails) {
    const category = details.category ?? categorizeWeComError(details.errcode, details.errmsg);
    const code = details.errcode === undefined ? '' : ` ${details.errcode}`;
    const reason = details.errmsg || (details.status ? `HTTP ${details.status}` : 'unknown error');
    super(`WeCom ${details.operation} error:${code} ${reason}. ${hintFor(category)}`);
    this.name = 'WeComApiError';
    this.operation = details.operation;
    this.errcode = details.errcode;
    this.errmsg = details.errmsg;
    this.status = details.status;
    this.category = category;
    this.invalidUser = details.invalidUser;
    this.invalidParty = details.invalidParty;
    this.invalidTag = details.invalidTag;
    this.hint = hintFor(category);
  }
}
