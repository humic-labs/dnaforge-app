import { findCurrentFilesByFilename } from '../../../db/find-current-files-by-filename';
import { findNotebookFileByPageId } from '../../../db/find-notebook-file-by-page-id';
import {
  planPageReferenceRepair,
  planReferenceRepair,
  repairLookupKey,
  type PageRepairCandidate,
  type RepairableMention,
  type SkipReason,
} from './plan-reference-repair';

export interface PageReferenceRepairResult {
  content: unknown;
  repaired: number;
  skipped: Array<{ label: string; reason: SkipReason }>;
  changed: boolean;
}

interface MentionNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: unknown[];
}

function collectMentions(content: unknown): MentionNode[] {
  const out: MentionNode[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const n = node as MentionNode;
    if (n.type === 'mention' && n.attrs && typeof n.attrs.referenceUri !== 'string') out.push(n);
    if (n.content) walk(n.content);
  };
  walk((content as { content?: unknown } | null)?.content);
  return out;
}

export async function repairPageReferences(
  content: unknown,
  owningRoot: string | null
): Promise<PageReferenceRepairResult> {
  const unchanged: PageReferenceRepairResult = {
    content,
    repaired: 0,
    skipped: [],
    changed: false,
  };

  if (!owningRoot) return unchanged;

  const nodes = collectMentions(content);
  if (nodes.length === 0) return unchanged;

  const mentions: RepairableMention[] = nodes.map((n) => (n.attrs ?? {}) as RepairableMention);

  const keys = new Set<string>();
  for (const mention of mentions) {
    if (mention.objectUuid || mention.contentHash) continue;
    const key = repairLookupKey(mention);
    if (key) keys.add(key);
  }

  const pageIds = new Set<string>();
  for (const mention of mentions) {
    if (mention.entityType !== 'page') continue;
    if (typeof mention.path === 'string' && mention.path) continue;
    if (typeof mention.entityId === 'string' && mention.entityId) pageIds.add(mention.entityId);
  }

  if (keys.size === 0 && pageIds.size === 0) return unchanged;

  const matches = new Map<string, Awaited<ReturnType<typeof findCurrentFilesByFilename>>>();
  try {
    for (const key of keys) {
      matches.set(key, await findCurrentFilesByFilename(key, owningRoot));
    }
  } catch (error) {
    console.warn('[repairPageReferences] catalog lookup failed; leaving the notebook alone', error);
    return unchanged;
  }

  const pageMatches = new Map<string, PageRepairCandidate[]>();
  try {
    for (const id of pageIds) {
      pageMatches.set(id, await findNotebookFileByPageId(id, owningRoot));
    }
  } catch (error) {
    console.warn('[repairPageReferences] notebook lookup failed; leaving pages alone', error);
    pageMatches.clear();
  }
  const pagePlan = planPageReferenceRepair({ mentions, matches: pageMatches });

  const plan = planReferenceRepair({ mentions, matches });
  const skipped = plan.skipped

    .filter((s) => s.reason !== 'not-a-file-entity' && s.reason !== 'already-complete')
    .map((s) => ({ label: s.label, reason: s.reason }));

  if (plan.repairs.length === 0 && pagePlan.repairs.length === 0) {
    return { ...unchanged, skipped };
  }

  const next = JSON.parse(JSON.stringify(content)) as unknown;
  const nextNodes = collectMentions(next);

  for (const repair of plan.repairs) {
    const target = nextNodes[repair.index];
    if (!target?.attrs) continue;
    target.attrs.path = repair.attrs.path;
    target.attrs.contentHash = repair.attrs.contentHash;
    target.attrs.objectUuid = repair.attrs.objectUuid;

    target.attrs.entityId = repair.attrs.entityId;
  }

  for (const repair of pagePlan.repairs) {
    const target = nextNodes[repair.index];
    if (!target?.attrs) continue;

    target.attrs.path = repair.path;
  }

  return {
    content: next,
    repaired: plan.repairs.length + pagePlan.repairs.length,
    skipped,
    changed: true,
  };
}
