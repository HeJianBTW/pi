import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  JsonObject,
  RuntimeRequestContext,
  ToolCallRequest,
  ToolSource,
} from '@amaster.ai/pi-shared';

export type SecurityDecision =
  | { kind: 'allow'; reason?: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string; prompt?: string }
  | { kind: 'sandbox_only'; reason: string; sandboxProfile: string }
  | { kind: 'allow_with_constraints'; reason?: string; constraints: RuntimeConstraints };

export type RuntimeConstraints = {
  filesystem?: {
    read?: 'workspace' | 'all' | 'deny';
    write?: 'workspace' | 'all' | 'deny';
    allowPaths?: string[];
    denyPaths?: string[];
  };
  network?: {
    mode: 'deny' | 'allowlist' | 'unrestricted';
    allowedDomains?: string[];
  };
  shell?: {
    timeoutMs?: number;
    requireSandbox?: boolean;
    denyPatterns?: string[];
  };
  output?: {
    redactFields?: string[];
    maxBytes?: number;
  };
};

export type CapabilityPolicy = {
  allow?: string[];
  deny?: string[];
};

export type ConfiguredCapabilityPolicy = CapabilityPolicy & {
  mode?: 'merge' | 'replace';
};

export type SecurityResourceKind = 'file' | 'shell' | 'network' | 'memory' | 'mcp' | 'subagent';
export type SecurityOperation =
  | 'read'
  | 'write'
  | 'execute'
  | 'delete'
  | 'connect'
  | 'spawn'
  | 'search';
export type SecurityScope = 'workspace' | 'home' | 'system' | 'external' | 'unknown';
export type SecuritySensitivity = 'normal' | 'source' | 'config' | 'secret' | 'credential';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type SecurityResource = {
  kind: SecurityResourceKind;
  operation: SecurityOperation;
  target?: string;
  scope: SecurityScope;
  sensitivity: SecuritySensitivity;
};

export type RiskAssessment = {
  level: RiskLevel;
  reasons: string[];
};

export type SecurityRule = {
  id: string;
  enabled?: boolean;
  priority?: number;
  tools?: string[];
  tool?: string;
  sources?: ToolSource[];
  source?: ToolSource;
  triggers?: Array<RuntimeRequestContext['trigger']>;
  trigger?: RuntimeRequestContext['trigger'];
  senderTrusts?: Array<RuntimeRequestContext['senderTrust']>;
  senderTrust?: RuntimeRequestContext['senderTrust'];
  args?: Record<string, string>;
  argsRegex?: Record<string, string>;
  resources?: SecurityResourceKind[];
  operations?: SecurityOperation[];
  scopes?: SecurityScope[];
  sensitivity?: SecuritySensitivity[];
  risk?: RiskLevel[];
  decision: SecurityDecision;
};

export type SecurityPolicyEngineOptions = {
  rules?: SecurityRule[];
  defaultDecision?: SecurityDecision;
};

export type SecurityProfileConfig = {
  extends?: string;
  capabilities?: ConfiguredCapabilityPolicy;
  rules?: SecurityRule[];
  defaultDecision?: SecurityDecision;
};

export type SecurityConfig = {
  defaultProfile?: string;
  profiles?: Record<string, SecurityProfileConfig>;
};

export type SecurityEvaluationContext = {
  request: RuntimeRequestContext;
  toolCall: ToolCallRequest;
  workspaceDir?: string;
  resources: SecurityResource[];
  risk: RiskAssessment;
};

export type SecurityEvaluationResult = {
  evaluationId: string;
  decision: SecurityDecision;
  resources: SecurityResource[];
  risk: RiskAssessment;
  matchedRuleIds: string[];
};

export type SecurityAuditEvent = SecurityEvaluationResult & {
  sessionId: string;
  conversationId: string;
  traceId?: string;
  toolCallId: string;
  toolName: string;
  createdAt: string;
  approvalId?: string;
};

export type SecurityApprovalRequest = {
  request: RuntimeRequestContext;
  toolCall: ToolCallRequest;
  decision: Extract<SecurityDecision, { kind: 'ask' }>;
  evaluation: SecurityEvaluationResult;
};

export type SecurityApprovalHandler = (input: SecurityApprovalRequest) => Promise<SecurityDecision>;
export type SecurityAuditSink = (event: SecurityAuditEvent) => void | Promise<void>;

export type SecurityGateAuthorizeInput = {
  request: RuntimeRequestContext;
  toolCall: ToolCallRequest;
  workspaceDir?: string;
};

export type SecurityGateOptions = {
  profile: string;
  config?: SecurityConfig;
  filePolicies?: Record<string, SecurityProfileConfig>;
  engine?: SecurityPolicyEngine;
  approvalHandler?: SecurityApprovalHandler;
  auditSink?: SecurityAuditSink;
};

const DEFAULT_DECISION: SecurityDecision = {
  kind: 'ask',
  reason: 'No security rule matched this tool call.',
};

const OPEN_SANDBOX_CAPABILITIES = [
  'read_file',
  'list_files',
  'search_files',
  'write_file',
  'edit_file',
  'run_shell',
  'run_code',
  'memory_search',
  'memory_write',
  'sessions_spawn',
  'mcp:*',
  'mcp_*',
  'mcp__*',
];

const DEFAULT_CAPABILITY_POLICY: CapabilityPolicy = {
  allow: ['memory_search'],
  deny: ['run_shell', 'run_code', 'write_file'],
};

const BUILTIN_CAPABILITY_POLICIES: Record<string, CapabilityPolicy> = {
  chat: DEFAULT_CAPABILITY_POLICY,
  assistant: {
    allow: ['memory_search', 'memory_write', 'mcp:*', 'mcp_*', 'mcp__*', 'scheduler:create'],
    deny: ['run_shell', 'run_code'],
  },
  'workspace-read': {
    allow: ['read_file', 'list_files', 'search_files', 'memory_search'],
    deny: ['write_file', 'edit_file'],
  },
  'workspace-write': {
    allow: ['read_file', 'list_files', 'search_files', 'write_file', 'edit_file', 'memory_search'],
    deny: ['run_shell', 'run_code'],
  },
  'sandbox-exec': { allow: OPEN_SANDBOX_CAPABILITIES },
  copilot: { allow: OPEN_SANDBOX_CAPABILITIES },
  'auto-review': { allow: OPEN_SANDBOX_CAPABILITIES },
  default: {
    allow: ['read_file', 'list_files', 'search_files', 'write_file', 'edit_file', 'memory_search'],
    deny: ['run_shell', 'run_code'],
  },
  subagent: {
    allow: OPEN_SANDBOX_CAPABILITIES.filter(
      (capability) => capability !== 'memory_write' && capability !== 'sessions_spawn',
    ),
    deny: ['memory_write', 'sessions_spawn'],
  },
  scheduled: {
    allow: ['memory_search', 'read_file', 'list_files', 'search_files', 'mcp:*', 'mcp_*', 'mcp__*'],
    deny: ['scheduler:create', 'run_shell', 'run_code', 'write_file', 'edit_file'],
  },
  admin: { allow: ['*'] },
  'full-access': { allow: ['*'] },
};

const BASELINE_SECURITY_RULES: SecurityRule[] = [denySecretsRule()];

const BUILTIN_SECURITY_RULES: Record<string, SecurityRule[]> = {
  default: [
    ...BASELINE_SECURITY_RULES,
    {
      id: 'ask-workspace-write',
      priority: 260,
      resources: ['file'],
      operations: ['write', 'delete'],
      scopes: ['workspace'],
      decision: {
        kind: 'ask',
        reason: 'Workspace file modifications require approval.',
        prompt: 'Approve this file modification?',
      },
    },
  ],
  'auto-review': [
    ...BASELINE_SECURITY_RULES,
    {
      id: 'ask-critical-risk',
      priority: 500,
      risk: ['critical'],
      decision: { kind: 'ask', reason: 'Critical risk operation requires approval.' },
    },
    {
      id: 'ask-high-risk',
      priority: 420,
      risk: ['high'],
      decision: { kind: 'ask', reason: 'High risk operation requires approval.' },
    },
    {
      id: 'ask-workspace-write',
      priority: 260,
      resources: ['file'],
      operations: ['write', 'delete'],
      scopes: ['workspace'],
      decision: {
        kind: 'ask',
        reason: 'Workspace file modifications require approval.',
        prompt: 'Approve this file modification?',
      },
    },
  ],
  scheduled: [
    ...BASELINE_SECURITY_RULES,
    {
      id: 'deny-non-read-scheduled',
      priority: 420,
      operations: ['write', 'execute', 'delete', 'spawn'],
      decision: {
        kind: 'deny',
        reason: 'Scheduled runs cannot perform mutating or executable actions by default.',
      },
    },
  ],
  subagent: [
    ...BASELINE_SECURITY_RULES,
    {
      id: 'deny-recursive-subagent-spawn',
      priority: 500,
      tools: ['sessions_spawn'],
      decision: { kind: 'deny', reason: 'Subagents cannot spawn child sessions by default.' },
    },
    {
      id: 'deny-subagent-memory-write',
      priority: 420,
      tools: ['memory_write'],
      decision: { kind: 'deny', reason: 'Subagents cannot write durable memory by default.' },
    },
  ],
  admin: [],
  'full-access': [],
};

export class SecurityPolicyEngine {
  private readonly entries: SecurityRule[];
  private readonly defaultDecision: SecurityDecision;

  constructor(options: SecurityPolicyEngineOptions = {}) {
    this.entries = [...(options.rules ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    this.defaultDecision = options.defaultDecision ?? DEFAULT_DECISION;
  }

  decide(input: {
    request: RuntimeRequestContext;
    toolCall: ToolCallRequest;
    workspaceDir?: string;
  }): SecurityDecision {
    return this.evaluate(input).decision;
  }

  evaluate(input: {
    request: RuntimeRequestContext;
    toolCall: ToolCallRequest;
    workspaceDir?: string;
  }): SecurityEvaluationResult {
    const resources = classifySecurityResources(input);
    const risk = assessRisk({ ...input, resources });
    const context: SecurityEvaluationContext = { ...input, resources, risk };
    const matchedRuleIds: string[] = [];
    for (const entry of this.entries) {
      if (matchesSecurityRule(entry, context)) {
        matchedRuleIds.push(entry.id);
        return {
          evaluationId: randomUUID(),
          decision: normalizeForInteraction(entry.decision, input.request.interactive),
          resources,
          risk,
          matchedRuleIds,
        };
      }
    }
    return {
      evaluationId: randomUUID(),
      decision: normalizeForInteraction(this.defaultDecision, input.request.interactive),
      resources,
      risk,
      matchedRuleIds,
    };
  }
}

export class SecurityGate {
  private readonly engine: SecurityPolicyEngine;
  private readonly approvalHandler: SecurityApprovalHandler | undefined;
  private readonly auditSink: SecurityAuditSink | undefined;

  constructor(options: SecurityGateOptions) {
    this.engine =
      options.engine ??
      createSecurityPolicyEngineForProfile(options.profile, options.config, options.filePolicies);
    this.approvalHandler = options.approvalHandler;
    this.auditSink = options.auditSink;
  }

  async authorize(input: SecurityGateAuthorizeInput): Promise<SecurityEvaluationResult> {
    const initial = this.engine.evaluate(input);
    const decision = await this.resolveDecision(input, initial);
    const evaluation = { ...initial, decision };
    await this.audit(input, evaluation);
    return evaluation;
  }

  private async resolveDecision(
    input: SecurityGateAuthorizeInput,
    evaluation: SecurityEvaluationResult,
  ): Promise<SecurityDecision> {
    if (evaluation.decision.kind !== 'ask') {
      return evaluation.decision;
    }
    if (!this.approvalHandler) {
      return evaluation.decision;
    }
    const resolved = await this.approvalHandler({
      request: input.request,
      toolCall: input.toolCall,
      decision: evaluation.decision,
      evaluation,
    });
    if (resolved.kind === 'ask') {
      return resolved;
    }
    return resolved;
  }

  private async audit(
    input: SecurityGateAuthorizeInput,
    evaluation: SecurityEvaluationResult,
  ): Promise<void> {
    if (!this.auditSink) {
      return;
    }
    await this.auditSink({
      ...evaluation,
      sessionId: input.request.sessionId,
      conversationId: input.request.conversationId,
      ...(input.request.traceId ? { traceId: input.request.traceId } : {}),
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
      createdAt: new Date().toISOString(),
    });
  }
}

export function createSecurityGate(options: SecurityGateOptions): SecurityGate {
  return new SecurityGate(options);
}

export async function assertSecurityAllowed(input: {
  request: RuntimeRequestContext;
  securityGate: SecurityGate;
  toolCall: ToolCallRequest;
  workspaceDir?: string;
}): Promise<SecurityEvaluationResult> {
  const evaluation = await input.securityGate.authorize({
    request: input.request,
    toolCall: input.toolCall,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  assertSecurityDecisionAllowed(evaluation.decision);
  return evaluation;
}

export function assertSecurityDecisionAllowed(decision: SecurityDecision): void {
  switch (decision.kind) {
    case 'allow':
    case 'allow_with_constraints':
    case 'sandbox_only':
      return;
    case 'ask':
      throw new Error(`Tool call requires approval: ${decision.reason}`);
    case 'deny':
      throw new Error(`Tool call denied by security policy: ${decision.reason}`);
  }
}

export function resolveCapabilityPolicy(
  profile: string,
  config: SecurityConfig = {},
  filePolicies: Record<string, SecurityProfileConfig> = {},
): CapabilityPolicy {
  return resolveSecurityProfile(profile, config, [], filePolicies).capabilities;
}

export function isCapabilityExposed(toolName: string, policy: CapabilityPolicy): boolean {
  const normalized = normalizePatternValue(toolName);
  if (policy.deny?.some((entry) => matchesPattern(normalized, entry))) {
    return false;
  }
  if (!policy.allow?.length) {
    return false;
  }
  return policy.allow.some((entry) => matchesPattern(normalized, entry));
}

export function createSecurityPolicyEngineForProfile(
  profile: string,
  config: SecurityConfig = {},
  filePolicies: Record<string, SecurityProfileConfig> = {},
): SecurityPolicyEngine {
  const resolvedProfile = resolveSecurityProfile(profile, config, [], filePolicies);
  const capabilityRules: SecurityRule[] =
    resolvedProfile.capabilities.allow?.map((toolName) => ({
      id: `allow-capability-${profile}-${toolName}`,
      priority: 100,
      tool: toolName,
      decision: { kind: 'allow' },
    })) ?? [];
  return new SecurityPolicyEngine({
    rules: resolvedProfile.rules.concat(capabilityRules),
    defaultDecision: resolvedProfile.defaultDecision ?? {
      kind: 'deny',
      reason: `Tool is not exposed by security profile: ${profile}`,
    },
  });
}

export function classifySecurityResources(input: {
  request: RuntimeRequestContext;
  toolCall: ToolCallRequest;
  workspaceDir?: string;
}): SecurityResource[] {
  const { toolCall } = input;
  if (toolCall.name === 'read_file') {
    return [fileResource('read', stringArg(toolCall.args, 'path'), input.workspaceDir)];
  }
  if (toolCall.name === 'list_files') {
    return [fileResource('read', stringArg(toolCall.args, 'path'), input.workspaceDir)];
  }
  if (toolCall.name === 'search_files') {
    return [
      fileResource(
        'search',
        stringArg(toolCall.args, 'path') ?? stringArg(toolCall.args, 'cwd'),
        input.workspaceDir,
      ),
    ];
  }
  if (toolCall.name === 'write_file' || toolCall.name === 'edit_file') {
    return [fileResource('write', stringArg(toolCall.args, 'path'), input.workspaceDir)];
  }
  if (toolCall.name === 'run_shell' || toolCall.name === 'run_code') {
    const command =
      stringArg(toolCall.args, 'command') ?? stringArg(toolCall.args, 'code') ?? toolCall.name;
    const resources: SecurityResource[] = [
      {
        kind: 'shell',
        operation: 'execute',
        target: command,
        scope: fileScope(stringArg(toolCall.args, 'cwd'), input.workspaceDir),
        sensitivity: 'normal',
      },
    ];
    if (/https?:\/\/|(^|\s)(curl|wget|ssh|scp|rsync)\b/i.test(command)) {
      resources.push({
        kind: 'network',
        operation: 'connect',
        target: command,
        scope: 'external',
        sensitivity: 'normal',
      });
    }
    return resources;
  }
  if (toolCall.name === 'memory_search') {
    return [{ kind: 'memory', operation: 'search', scope: 'unknown', sensitivity: 'normal' }];
  }
  if (toolCall.name === 'memory_write') {
    return [{ kind: 'memory', operation: 'write', scope: 'unknown', sensitivity: 'normal' }];
  }
  if (toolCall.name === 'sessions_spawn') {
    return [{ kind: 'subagent', operation: 'spawn', scope: 'unknown', sensitivity: 'normal' }];
  }
  if (
    toolCall.source === 'mcp' ||
    toolCall.name.startsWith('mcp_') ||
    toolCall.name.startsWith('mcp__')
  ) {
    return [
      {
        kind: 'mcp',
        operation: 'connect',
        target: toolCall.name,
        scope: 'external',
        sensitivity: 'normal',
      },
    ];
  }
  return [
    {
      kind: 'shell',
      operation: 'execute',
      target: toolCall.name,
      scope: 'unknown',
      sensitivity: 'normal',
    },
  ];
}

export function assessRisk(input: {
  toolCall: ToolCallRequest;
  resources: SecurityResource[];
}): RiskAssessment {
  const reasons: string[] = [];
  let level: RiskLevel = 'low';
  const raise = (next: RiskLevel, reason: string) => {
    if (riskRank(next) > riskRank(level)) {
      level = next;
    }
    reasons.push(reason);
  };
  for (const resource of input.resources) {
    if (resource.sensitivity === 'secret' || resource.sensitivity === 'credential') {
      raise('critical', `Sensitive ${resource.sensitivity} resource`);
    }
    if (resource.kind === 'file' && resource.operation === 'write') {
      raise(
        resource.scope === 'workspace' ? 'medium' : 'high',
        `File write in ${resource.scope} scope`,
      );
    }
    if (resource.kind === 'shell') {
      raise('medium', 'Shell/code execution');
      const command = resource.target ?? '';
      if (/\brm\s+-rf\b|:\(\)\s*\{|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b/i.test(command)) {
        raise('critical', 'Destructive shell command');
      }
      if (/\bsudo\b|\bchmod\b|\bchown\b|\bkill(all)?\b|\blaunchctl\b/i.test(command)) {
        raise('high', 'Privileged or permission-changing shell command');
      }
      if (
        /\b(npm|pnpm|yarn|pip|brew|apt|apt-get)\s+(install|add|upgrade|update)\b/i.test(command)
      ) {
        raise('high', 'Dependency or package manager mutation');
      }
      if (/curl\b.*\|\s*(sh|bash)|wget\b.*\|\s*(sh|bash)/i.test(command)) {
        raise('critical', 'Remote script execution');
      }
    }
    if (resource.kind === 'network') {
      raise('high', 'External network access');
    }
    if (resource.kind === 'memory' && resource.operation === 'write') {
      raise('medium', 'Durable memory write');
    }
    if (resource.kind === 'subagent') {
      raise('medium', 'Subagent spawn');
    }
    if (resource.kind === 'mcp') {
      raise('medium', 'External MCP tool call');
    }
  }
  return {
    level,
    reasons: reasons.length ? [...new Set(reasons)] : ['Low risk read-only operation'],
  };
}

export function securityEvaluationDetails(evaluation: SecurityEvaluationResult): JsonObject {
  return {
    decision: evaluation.decision.kind,
    risk: evaluation.risk.level,
    riskReasons: evaluation.risk.reasons,
    matchedRules: evaluation.matchedRuleIds,
    resources: evaluation.resources.map((resource) => ({
      kind: resource.kind,
      operation: resource.operation,
      scope: resource.scope,
      sensitivity: resource.sensitivity,
      ...(resource.target ? { target: summarizeTarget(resource.target) } : {}),
    })),
  };
}

function resolveSecurityProfile(
  profile: string,
  config: SecurityConfig,
  seen: string[] = [],
  filePolicies: Record<string, SecurityProfileConfig> = {},
): { capabilities: CapabilityPolicy; rules: SecurityRule[]; defaultDecision?: SecurityDecision } {
  const normalizedProfile = profile.trim();
  if (seen.includes(normalizedProfile)) {
    return { capabilities: DEFAULT_CAPABILITY_POLICY, rules: [] };
  }
  const configured = filePolicies[normalizedProfile] ?? config.profiles?.[normalizedProfile];
  const parent = configured?.extends
    ? resolveSecurityProfile(
        configured.extends,
        config,
        seen.concat(normalizedProfile),
        filePolicies,
      )
    : {
        capabilities: BUILTIN_CAPABILITY_POLICIES[normalizedProfile] ?? DEFAULT_CAPABILITY_POLICY,
        rules: BUILTIN_SECURITY_RULES[normalizedProfile] ?? BASELINE_SECURITY_RULES,
      };
  if (!configured) {
    return parent;
  }
  return {
    capabilities: mergeCapabilityPolicy(parent.capabilities, configured.capabilities),
    rules: parent.rules.concat(normalizeConfiguredRules(configured.rules)),
    ...((configured.defaultDecision ?? parent.defaultDecision)
      ? { defaultDecision: configured.defaultDecision ?? parent.defaultDecision }
      : {}),
  };
}

function denySecretsRule(): SecurityRule {
  return {
    id: 'deny-secrets',
    priority: 600,
    sensitivity: ['secret', 'credential'],
    decision: { kind: 'deny', reason: 'Secret or credential resources are protected.' },
  };
}

function mergeCapabilityPolicy(
  base: CapabilityPolicy,
  override: ConfiguredCapabilityPolicy | undefined,
): CapabilityPolicy {
  if (!override) {
    return copyCapabilityPolicy(base);
  }
  if (override.mode === 'replace') {
    return {
      ...(override.allow ? { allow: uniqueStrings(override.allow) } : {}),
      ...(override.deny ? { deny: uniqueStrings(override.deny) } : {}),
    };
  }
  return {
    allow: uniqueStrings([...(base.allow ?? []), ...(override.allow ?? [])]),
    deny: uniqueStrings([...(base.deny ?? []), ...(override.deny ?? [])]),
  };
}

function copyCapabilityPolicy(policy: CapabilityPolicy): CapabilityPolicy {
  return {
    ...(policy.allow ? { allow: [...policy.allow] } : {}),
    ...(policy.deny ? { deny: [...policy.deny] } : {}),
  };
}

function normalizeConfiguredRules(rules: SecurityRule[] | undefined): SecurityRule[] {
  return (rules ?? [])
    .filter((rule) => rule.enabled !== false)
    .map((rule) => ({
      ...rule,
      priority: rule.priority ?? 300,
    }));
}

function matchesSecurityRule(rule: SecurityRule, context: SecurityEvaluationContext): boolean {
  if (rule.enabled === false) {
    return false;
  }
  if (
    rule.tools?.length &&
    !rule.tools.some((tool) => matchesPattern(context.toolCall.name, tool))
  ) {
    return false;
  }
  if (rule.tool && !matchesPattern(context.toolCall.name, rule.tool)) {
    return false;
  }
  if (rule.sources?.length && !rule.sources.includes(context.toolCall.source)) {
    return false;
  }
  if (rule.source && rule.source !== context.toolCall.source) {
    return false;
  }
  if (rule.triggers?.length && !rule.triggers.includes(context.request.trigger)) {
    return false;
  }
  if (rule.trigger && rule.trigger !== context.request.trigger) {
    return false;
  }
  if (rule.senderTrusts?.length && !rule.senderTrusts.includes(context.request.senderTrust)) {
    return false;
  }
  if (rule.senderTrust && rule.senderTrust !== context.request.senderTrust) {
    return false;
  }
  if (rule.args && !matchesArgs(rule.args, context.toolCall.args)) {
    return false;
  }
  if (rule.argsRegex && !matchesArgsRegex(rule.argsRegex, context.toolCall.args)) {
    return false;
  }
  if (rule.risk?.length && !rule.risk.includes(context.risk.level)) {
    return false;
  }
  if (
    hasResourceCriteria(rule) &&
    !context.resources.some((resource) => matchesResourceCriteria(rule, resource))
  ) {
    return false;
  }
  return true;
}

function hasResourceCriteria(rule: SecurityRule): boolean {
  return Boolean(
    rule.resources?.length ||
      rule.operations?.length ||
      rule.scopes?.length ||
      rule.sensitivity?.length,
  );
}

function matchesResourceCriteria(rule: SecurityRule, resource: SecurityResource): boolean {
  if (rule.resources?.length && !rule.resources.includes(resource.kind)) {
    return false;
  }
  if (rule.operations?.length && !rule.operations.includes(resource.operation)) {
    return false;
  }
  if (rule.scopes?.length && !rule.scopes.includes(resource.scope)) {
    return false;
  }
  if (rule.sensitivity?.length && !rule.sensitivity.includes(resource.sensitivity)) {
    return false;
  }
  return true;
}

function normalizeForInteraction(
  decision: SecurityDecision,
  interactive: boolean,
): SecurityDecision {
  if (decision.kind === 'ask' && !interactive) {
    return {
      kind: 'deny',
      reason: `Security policy requires approval but the context is non-interactive: ${decision.reason}`,
    };
  }
  return decision;
}

function fileResource(
  operation: SecurityOperation,
  value: string | undefined,
  workspaceDir: string | undefined,
): SecurityResource {
  return {
    kind: 'file',
    operation,
    ...(value ? { target: value } : {}),
    scope: fileScope(value, workspaceDir),
    sensitivity: classifyPathSensitivity(value),
  };
}

function fileScope(value: string | undefined, workspaceDir: string | undefined): SecurityScope {
  if (!value) {
    return 'unknown';
  }
  if (!path.isAbsolute(value)) {
    return 'workspace';
  }
  const normalized = path.resolve(value);
  if (workspaceDir && pathInside(normalized, path.resolve(workspaceDir))) {
    return 'workspace';
  }
  const home = process.env.HOME;
  if (home && pathInside(normalized, path.resolve(home))) {
    return 'home';
  }
  return 'system';
}

function pathInside(value: string, parent: string): boolean {
  const relative = path.relative(parent, value);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function classifyPathSensitivity(value: string | undefined): SecuritySensitivity {
  const lower = value?.toLowerCase() ?? '';
  if (!lower) {
    return 'normal';
  }
  if (
    /(^|\/)\.ssh(\/|$)|id_rsa|id_ed25519|private[_-]?key|credential|password|token|secret|\.pem$|\.key$/i.test(
      lower,
    )
  ) {
    return 'credential';
  }
  if (/(^|\/)\.env(\.|$)|(^|\/)\.npmrc$|(^|\/)\.pypirc$|(^|\/)secrets?(\/|$)/i.test(lower)) {
    return 'secret';
  }
  if (
    /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig\.json|dockerfile|docker-compose\.ya?ml)$/i.test(
      lower,
    )
  ) {
    return 'config';
  }
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|css|html|md)$/i.test(lower)) {
    return 'source';
  }
  return 'normal';
}

function matchesArgs(patterns: Record<string, string>, args: JsonObject): boolean {
  for (const [key, expected] of Object.entries(patterns)) {
    const actual = args[key];
    if (typeof actual !== 'string' || !matchesPattern(actual, expected)) {
      return false;
    }
  }
  return true;
}

function matchesArgsRegex(patterns: Record<string, string>, args: JsonObject): boolean {
  for (const [key, pattern] of Object.entries(patterns)) {
    const actual = args[key];
    if (typeof actual !== 'string' || !new RegExp(pattern).test(actual)) {
      return false;
    }
  }
  return true;
}

function matchesPattern(value: string, pattern: string): boolean {
  const normalizedValue = normalizePatternValue(value);
  const normalizedPattern = normalizePatternValue(pattern);
  if (normalizedPattern === '*') {
    return true;
  }
  if (normalizedPattern.endsWith(':*')) {
    return normalizedValue.startsWith(normalizedPattern.slice(0, -1));
  }
  if (normalizedPattern.endsWith('*')) {
    return normalizedValue.startsWith(normalizedPattern.slice(0, -1));
  }
  return normalizedValue === normalizedPattern;
}

function normalizePatternValue(value: string): string {
  return value.trim().toLowerCase();
}

function stringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function riskRank(level: RiskLevel): number {
  return { low: 1, medium: 2, high: 3, critical: 4 }[level];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function summarizeTarget(value: string): string {
  return value.length > 200
    ? `${value.slice(0, 200)}...[${value.length - 200} chars truncated]`
    : value;
}

export { default } from './extension.js';
