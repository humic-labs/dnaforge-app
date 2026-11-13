import { isSafeWorkspaceRelativePath } from '../../../shared/path-boundary';
import { looksLikeWorkspacePath } from './resolve-item-record';

export interface RepairCandidate {
  path: string;
  contentHash: string | null;
  objectUuid: string | null;
  entityId: string;
}

export interface RepairableMention {
  entityType?: string;
  entityId?: string | null;
  label?: string;
  path?: string | null;
  contentHash?: string | null;
  objectUuid?: string | null;
}

export type SkipReason =
  | 'already-complete'
  | 'ambiguous'
  | 'not-found'
  | 'not-a-file-entity'
  | 'unsafe-path';

export interface ReferenceRepairPlan {
  repairs: Array<{
    index: number;
    label: string;
    attrs: {
      path: string;
      contentHash: string | null;
      objectUuid: string | null;
      entityId: string;
    };
  }>;
  skipped: Array<{ index: number; label: string; reason: SkipReason }>;
}

const FILE_BACKED = new Set(['sequence', 'design', 'structure']);

export function repairLookupKey(mention: RepairableMention): string {
  const id = mention.entityId ?? '';
  if (id && looksLikeWorkspacePath(id)) return id;
  return mention.label ?? '';
}

function fingerprintOrNull(catalogHash: string | null): string | null {
  if (!catalogHash) return null;
  return /^sha256:[0-9a-f]{64}$/i.test(catalogHash) ? catalogHash : null;
}

export function planReferenceRepair(input: {
  mentions: RepairableMention[];
  matches: Map<string, RepairCandidate[]>;
}): ReferenceRepairPlan {
  const plan: ReferenceRepairPlan = { repairs: [], skipped: [] };

  input.mentions.forEach((mention, index) => {
    const label = mention.label ?? '';

    if (!FILE_BACKED.has(mention.entityType ?? '')) {
      plan.skipped.push({ index, label, reason: 'not-a-file-entity' });
      return;
    }

    if (mention.objectUuid || mention.contentHash) {
      plan.skipped.push({ index, label, reason: 'already-complete' });
      return;
    }

    const key = repairLookupKey(mention);
    const candidates = key ? (input.matches.get(key) ?? []) : [];
    if (candidates.length === 0) {
      plan.skipped.push({ index, label, reason: 'not-found' });
      return;
    }
    if (candidates.length > 1) {
      plan.skipped.push({ index, label, reason: 'ambiguous' });
      return;
    }

    const only = candidates[0];
    if (!isSafeWorkspaceRelativePath(only.path)) {
      plan.skipped.push({ index, label, reason: 'unsafe-path' });
      return;
    }

    plan.repairs.push({
      index,
      label,
      attrs: {
        path: only.path,
        contentHash: fingerprintOrNull(only.contentHash),
        objectUuid: only.objectUuid,
        entityId: only.entityId,
      },
    });
  });

  return plan;
}

export interface PageRepairCandidate {
  path: string;
}

export interface PageReferenceRepairPlan {
  repairs: Array<{ index: number; label: string; path: string }>;
  skipped: Array<{ index: number; label: string; reason: SkipReason }>;
}

export function planPageReferenceRepair(input: {
  mentions: RepairableMention[];
  matches: Map<string, PageRepairCandidate[]>;
}): PageReferenceRepairPlan {
  const plan: PageReferenceRepairPlan = { repairs: [], skipped: [] };

  input.mentions.forEach((mention, index) => {
    const label = mention.label ?? '';
    if (mention.entityType !== 'page') {
      plan.skipped.push({ index, label, reason: 'not-a-file-entity' });
      return;
    }
    if (typeof mention.path === 'string' && mention.path) {
      plan.skipped.push({ index, label, reason: 'already-complete' });
      return;
    }

    const key = typeof mention.entityId === 'string' ? mention.entityId : '';
    const candidates = key ? (input.matches.get(key) ?? []) : [];
    if (candidates.length === 0) {
      plan.skipped.push({ index, label, reason: 'not-found' });
      return;
    }
    if (candidates.length > 1) {
      plan.skipped.push({ index, label, reason: 'ambiguous' });
      return;
    }

    const only = candidates[0];
    if (!isSafeWorkspaceRelativePath(only.path)) {
      plan.skipped.push({ index, label, reason: 'unsafe-path' });
      return;
    }

    plan.repairs.push({ index, label, path: only.path });
  });

  return plan;
}
