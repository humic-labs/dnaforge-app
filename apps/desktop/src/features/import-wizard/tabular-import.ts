import type { LimsImportPlan, LimsImportPlanRecord } from '../../shared/lims';
import { createLimsImportPlan } from '../lims/public/ingress';

export interface TabularImportEntry {
  fileName: string;
  plan: LimsImportPlan | null;
  parseError?: string;
}

export type ResolveItemStatus = 'ready' | 'needs-you';

export interface ResolveItem {
  fileName: string;
  status: ResolveItemStatus;
  detectedKind: string;
  recordCount: number;
  reasons: string[];
}

export interface ResolveWorklist {
  total: number;
  ready: number;
  needYou: number;
  items: ResolveItem[];
}

export interface ReviewReconciliation {
  totalRows: number;
  register: number;
  duplicate: number;
  flagged: number;
  cannotParse: number;
}

function recordNeedsYouReasons(r: LimsImportPlanRecord): string[] {
  const reasons: string[] = [];
  if (r.errors.length > 0) reasons.push(...r.errors);
  if (r.unresolvedLinks.length > 0)
    reasons.push(`${r.unresolvedLinks.length} unresolved link endpoint(s)`);
  if (r.requiresRegistrationKind) reasons.push('needs a registration kind');
  if (r.duplicateCandidates.length > 0)
    reasons.push(`${r.duplicateCandidates.length} possible duplicate(s)`);
  return reasons;
}

export function summarizeResolveWorklist(entries: readonly TabularImportEntry[]): ResolveWorklist {
  const items: ResolveItem[] = entries.map((e) => {
    if (!e.plan) {
      return {
        fileName: e.fileName,
        status: 'needs-you',
        detectedKind: 'unparseable',
        recordCount: 0,
        reasons: [e.parseError ?? 'Could not parse this file into a table.'],
      };
    }
    const reasons = e.plan.records.flatMap(recordNeedsYouReasons);
    const blocked = !e.plan.canApply || reasons.length > 0;
    return {
      fileName: e.fileName,
      status: blocked ? 'needs-you' : 'ready',
      detectedKind: e.plan.detectedKind,
      recordCount: e.plan.records.length,
      reasons: blocked ? Array.from(new Set(reasons)).slice(0, 8) : [],
    };
  });
  const ready = items.filter((i) => i.status === 'ready').length;
  return { total: items.length, ready, needYou: items.length - ready, items };
}

export function summarizeReviewReconciliation(
  entries: readonly TabularImportEntry[]
): ReviewReconciliation {
  let register = 0;
  let duplicate = 0;
  let flagged = 0;
  let cannotParse = 0;
  let totalRows = 0;

  for (const e of entries) {
    if (!e.plan) {
      cannotParse += 1;
      totalRows += 1;
      continue;
    }
    for (const r of e.plan.records) {
      totalRows += 1;
      if (r.duplicateCandidates.length > 0 && r.action === 'skip') {
        duplicate += 1;
      } else if (
        r.errors.length > 0 ||
        r.requiresRegistrationKind ||
        r.unresolvedLinks.length > 0
      ) {
        flagged += 1;
      } else if (r.accepted && r.action === 'create') {
        register += 1;
      } else {
        flagged += 1;
      }
    }
  }
  return { totalRows, register, duplicate, flagged, cannotParse };
}

export function formatResolveHeadline(w: ResolveWorklist): string {
  return `${w.ready} ready · ${w.needYou} need you`;
}

export function formatReviewHeadline(r: ReviewReconciliation): string {
  return `${r.register} register · ${r.duplicate} duplicate`;
}

export interface TabularImportFile {
  name: string;
  text?: string;
  arrayBuffer?: ArrayBuffer;
}

export async function buildTabularImportPlans(
  files: readonly TabularImportFile[]
): Promise<TabularImportEntry[]> {
  const out: TabularImportEntry[] = [];
  for (const f of files) {
    try {
      const plan = await createLimsImportPlan({
        fileName: f.name,
        text: f.text,
        arrayBuffer: f.arrayBuffer,
      });
      out.push({ fileName: f.name, plan });
    } catch (err) {
      out.push({
        fileName: f.name,
        plan: null,
        parseError: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
