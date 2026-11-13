export interface NotebookReference {
  path: string | null;
  entityId: string | null;
  contentHash: string | null;
}

export type MentionIdShape =
  | { kind: 'record'; ref: NotebookReference }
  | { kind: 'legacy-path'; path: string }
  | { kind: 'legacy-sequence-row'; dbId: number }
  | { kind: 'legacy-primer-row'; primerId: string }
  | { kind: 'unresolvable'; reason: string };

const SEQUENCE_ROW_ID = /^seq_(\d+)$/;
const PRIMER_ROW_ID = /^primer_(.+)$/;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readMentionReference(attrs: Record<string, unknown>): MentionIdShape {
  const path = str(attrs.path);
  const entityId = str(attrs.entityId);
  const contentHash = str(attrs.contentHash);

  if (path) {
    return { kind: 'record', ref: { path, entityId, contentHash } };
  }

  if (!entityId) {
    return { kind: 'unresolvable', reason: 'no path and no entityId' };
  }

  const seqMatch = SEQUENCE_ROW_ID.exec(entityId);
  if (seqMatch) {
    return { kind: 'legacy-sequence-row', dbId: Number(seqMatch[1]) };
  }

  const primerMatch = PRIMER_ROW_ID.exec(entityId);
  if (primerMatch) {
    return { kind: 'legacy-primer-row', primerId: primerMatch[1] };
  }

  const entityType = str(attrs.entityType);
  if (entityType === 'sequence' || entityType === 'design') {
    return { kind: 'legacy-path', path: entityId };
  }

  return { kind: 'unresolvable', reason: `unrecognized id for entityType ${entityType}` };
}

function canonical(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

export function markdownLinkDestination(
  refPath: string,
  workspaceRoot: string,
  packageRoot: string
): string {
  const ws = canonical(workspaceRoot);
  const pkg = canonical(packageRoot);

  const packageRelative = pkg.startsWith(`${ws}/`) ? pkg.slice(ws.length + 1) : '';
  const depth = packageRelative === '' ? 0 : packageRelative.split('/').length;

  const segments = canonical(refPath)
    .split('/')
    .filter((s) => s.length > 0);

  const encoded = segments.map((s) => encodeURIComponent(s)).join('/');
  const prefix = depth === 0 ? './' : '../'.repeat(depth);

  return `<${prefix}${encoded}>`;
}

export function markdownLabel(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}
