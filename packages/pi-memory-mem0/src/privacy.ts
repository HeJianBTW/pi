import { createHash } from 'node:crypto';
import path from 'node:path';
import { scanForThreats } from '@amaster.ai/pi-memory/threat-patterns';

export function scopeMemoryUserId(baseUserId: string, cwd: string): string {
  const project = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 12);
  return `${baseUserId}:project:${project}`;
}

export function redactMemoryText(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi,
      '[REDACTED]',
    )
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]')
    .replace(
      /\b(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
      '$1=[REDACTED]',
    );
}

export function formatRecalledMemory(text: string): string {
  const findings = scanForThreats(text, 'strict');
  if (findings.length > 0) {
    return `[BLOCKED UNTRUSTED MEMORY: ${findings.join(', ')}]`;
  }
  return `[UNTRUSTED MEMORY DATA] ${JSON.stringify(text)}`;
}
