export interface DevWindowIdentityParts {
  label: string;
  port: number | string | null | undefined;
  shortSha: string | null | undefined;
}

export function normalizeDevInstanceLabel(
  branch: string | null | undefined,
  worktreeBasename: string | null | undefined,
  maxLen = 32
): string {
  const b = (branch ?? '').trim();
  const wt = (worktreeBasename ?? '').trim();
  let raw =
    b && b !== 'HEAD' && b !== 'heads/HEAD'
      ? b.replace(/^(feature|fix|chore|plan)\//, '')
      : wt || 'detached';
  raw = raw.replace(/^waypoint-/, '').replace(/^TASK-(\d+)-/, '$1-');
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, Math.max(1, maxLen - 1))}…`;
}

export function formatDevAppBarChip(parts: DevWindowIdentityParts): string {
  const label = parts.label || 'dev';
  const port = parts.port != null && String(parts.port).trim() !== '' ? `:${parts.port}` : ':?';
  const sha = (parts.shortSha ?? '').trim() || '???????';
  return `${port} · ${label} · ${sha}`;
}

export function formatDevWindowTitle(parts: DevWindowIdentityParts): string {
  return `DNAForge · ${formatDevAppBarChip(parts)}`;
}
