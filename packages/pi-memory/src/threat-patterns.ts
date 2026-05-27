/**
 * Threat-pattern library for memory content scanning.
 *
 * Covers prompt injection, role hijack, C2 framework names, exfiltration,
 * persistence (SSH backdoor, agent-config edits), and invisible unicode.
 *
 * Pattern philosophy: anchor on attack-specific vocabulary or unambiguous
 * attack behavior, NOT on bossy English.  Multi-word filler is allowed via
 * `(?:\w+\s+)*` between key tokens so attackers can't bypass with
 * synonyms ("ignore all prior instructions").
 */

type Scope = 'all' | 'context' | 'strict';

type RawPattern = readonly [pattern: string, id: string, scope: Scope];

const RAW_PATTERNS: readonly RawPattern[] = [
  // Classic prompt injection (applies everywhere)
  [
    String.raw`ignore\s+(?:\w+\s+)*(previous|all|above|prior)\s+(?:\w+\s+)*instructions`,
    'prompt_injection',
    'all',
  ],
  [String.raw`system\s+prompt\s+override`, 'sys_prompt_override', 'all'],
  [
    String.raw`disregard\s+(?:\w+\s+)*(your|all|any)\s+(?:\w+\s+)*(instructions|rules|guidelines)`,
    'disregard_rules',
    'all',
  ],
  [
    String.raw`act\s+as\s+(if|though)\s+(?:\w+\s+)*you\s+(?:\w+\s+)*(have\s+no|don't\s+have)\s+(?:\w+\s+)*(restrictions|limits|rules)`,
    'bypass_restrictions',
    'all',
  ],
  ['<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->', 'html_comment_injection', 'all'],
  [String.raw`<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none`, 'hidden_div', 'all'],
  [String.raw`translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)`, 'translate_execute', 'all'],
  [String.raw`do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user`, 'deception_hide', 'all'],

  // Role-play / identity hijack (context + strict)
  [String.raw`you\s+are\s+(?:\w+\s+)*now\s+(?:a|an|the)\s+`, 'role_hijack', 'context'],
  [String.raw`pretend\s+(?:\w+\s+)*(you\s+are|to\s+be)\s+`, 'role_pretend', 'context'],
  [String.raw`output\s+(?:\w+\s+)*(system|initial)\s+prompt`, 'leak_system_prompt', 'context'],
  [
    String.raw`(respond|answer|reply)\s+without\s+(?:\w+\s+)*(restrictions|limitations|filters|safety)`,
    'remove_filters',
    'context',
  ],
  [
    String.raw`you\s+have\s+been\s+(?:\w+\s+)*(updated|upgraded|patched)\s+to`,
    'fake_update',
    'context',
  ],
  [String.raw`\bname\s+yourself\s+\w+`, 'identity_override', 'context'],

  // C2 / Brainworm-style promptware
  [String.raw`register\s+(as\s+)?a?\s*node`, 'c2_node_registration', 'context'],
  [String.raw`(heartbeat|beacon|check[\s\-]?in)\s+(to|with)\s+`, 'c2_heartbeat', 'context'],
  [String.raw`pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b`, 'c2_task_pull', 'context'],
  [String.raw`connect\s+to\s+the\s+network\b`, 'c2_network_connect', 'context'],
  [
    String.raw`you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b`,
    'forced_action',
    'context',
  ],
  [String.raw`only\s+use\s+one[\s\-]?liners?\b`, 'anti_forensic_oneliner', 'context'],
  [
    String.raw`never\s+(?:\w+\s+)*(?:create|write)\s+(?:\w+\s+)*(?:script|file)\s+(?:\w+\s+)*disk`,
    'anti_forensic_disk',
    'context',
  ],
  [
    String.raw`unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC|PI)\w*`,
    'env_var_unset_agent',
    'context',
  ],

  // Known C2 framework names
  [
    String.raw`\b(?:praxis|cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b`,
    'known_c2_framework',
    'context',
  ],
  [String.raw`\bc2\s+(?:server|channel|infrastructure|beacon)\b`, 'c2_explicit', 'context'],
  [String.raw`\bcommand\s+and\s+control\b`, 'c2_explicit_long', 'context'],

  // Exfiltration via curl/wget/cat with secrets
  [
    String.raw`curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`,
    'exfil_curl',
    'all',
  ],
  [
    String.raw`wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`,
    'exfil_wget',
    'all',
  ],
  [
    String.raw`cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`,
    'read_secrets',
    'all',
  ],
  [String.raw`(send|post|upload|transmit)\s+.*\s+(to|at)\s+https?://`, 'send_to_url', 'strict'],
  [
    String.raw`(include|output|print|share)\s+(?:\w+\s+)*(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`,
    'context_exfil',
    'strict',
  ],

  // Persistence / SSH backdoor (strict scope)
  ['authorized_keys', 'ssh_backdoor', 'strict'],
  [String.raw`\$HOME/\.ssh|~/\.ssh`, 'ssh_access', 'strict'],
  [String.raw`\$HOME/\.pi/\.env|~/\.pi/\.env`, 'pi_env', 'strict'],
  [
    String.raw`(update|modify|edit|write|change|append|add\s+to)\s+.*(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)`,
    'agent_config_mod',
    'strict',
  ],

  // Hardcoded secrets
  [
    String.raw`(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}`,
    'hardcoded_secret',
    'strict',
  ],
];

/**
 * Invisible / bidirectional unicode characters used in injection attacks.
 */
export const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
  '​', // zero-width space
  '‌', // zero-width non-joiner
  '‍', // zero-width joiner
  '⁠', // word joiner
  '⁢', // invisible times
  '⁣', // invisible separator
  '⁤', // invisible plus
  '﻿', // zero-width no-break space (BOM)
  '‪', // left-to-right embedding
  '‫', // right-to-left embedding
  '‬', // pop directional formatting
  '‭', // left-to-right override
  '‮', // right-to-left override
  '⁦', // left-to-right isolate
  '⁧', // right-to-left isolate
  '⁨', // first strong isolate
  '⁩', // pop directional isolate
]);

type CompiledPattern = readonly [regex: RegExp, id: string];

function buildScopeSets(): Record<Scope, CompiledPattern[]> {
  const all: CompiledPattern[] = [];
  const context: CompiledPattern[] = [];
  const strict: CompiledPattern[] = [];
  for (const [pattern, id, scope] of RAW_PATTERNS) {
    const compiled: CompiledPattern = [new RegExp(pattern, 'i'), id];
    if (scope === 'all') {
      all.push(compiled);
      context.push(compiled);
      strict.push(compiled);
    } else if (scope === 'context') {
      context.push(compiled);
      strict.push(compiled);
    } else {
      strict.push(compiled);
    }
  }
  return { all, context, strict };
}

const COMPILED = buildScopeSets();

/**
 * Return matched pattern IDs in `content` at the given scope.
 *
 * - `all`: classic injection + exfil only (lowest false-positive set).
 * - `context`: adds promptware / C2 / role-play patterns.
 * - `strict`: adds persistence / SSH backdoor / exfil-URL patterns.
 *
 * Invisible-unicode hits are reported as `invisible_unicode_U+XXXX`.
 */
export function scanForThreats(content: string, scope: Scope = 'context'): string[] {
  if (!content) {
    return [];
  }
  const findings: string[] = [];

  for (const ch of content) {
    if (INVISIBLE_CHARS.has(ch)) {
      const code = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
      const finding = `invisible_unicode_U+${code}`;
      if (!findings.includes(finding)) {
        findings.push(finding);
      }
    }
  }

  const patterns = COMPILED[scope];
  if (!patterns) {
    throw new Error(`scanForThreats: unknown scope '${scope}'`);
  }
  for (const [regex, id] of patterns) {
    if (regex.test(content)) {
      findings.push(id);
    }
  }
  return findings;
}

/**
 * Return a human-readable error string for the first threat in `content`,
 * or `null` when clean.  Convenience wrapper for paths that block on first
 * hit (memory writes).
 */
export function firstThreatMessage(content: string, scope: Scope = 'strict'): string | null {
  const findings = scanForThreats(content, scope);
  if (findings.length === 0) {
    return null;
  }
  const id = findings[0]!;
  if (id.startsWith('invisible_unicode_')) {
    const codepoint = id.replace('invisible_unicode_', '');
    return `Blocked: content contains invisible unicode character ${codepoint} (possible injection).`;
  }
  return `Blocked: content matches threat pattern '${id}'. Content is injected into the system prompt and must not contain injection or exfiltration payloads.`;
}
