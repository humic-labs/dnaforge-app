import type { PendingImport } from '../../stores/workspaceStore';

export function formatImportProgress(pending: PendingImport): string {
  if (pending.status === 'scanning') return 'scanning…';
  if (pending.status === 'finalizing') return 'finalizing…';
  const { filesCopied, totalFiles } = pending;
  if (typeof filesCopied === 'number' && typeof totalFiles === 'number' && totalFiles > 0) {
    const pct = Math.min(100, Math.floor((filesCopied / totalFiles) * 100));
    return `copying… ${pct}% (${filesCopied}/${totalFiles})`;
  }
  return 'copying…';
}
