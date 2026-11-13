import { createHash } from 'node:crypto';

export function migrationEvidenceId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}
