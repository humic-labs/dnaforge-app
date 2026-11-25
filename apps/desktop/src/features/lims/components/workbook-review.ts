import { computeImportPlanView } from './import-plan-view';
import type {
  ImportableSheet,
  LimsEntityKind,
  LimsImportPlan,
  LimsSchemaDefinitionView,
  LimsIdScheme,
} from '../../../shared/lims';
import type { WorkbookSheetPreview } from '../ingress';

export type SheetOutcomeStatus = 'imported' | 'not-selected' | 'failed';

export interface SheetImportOutcome {
  sheetName: string;
  status: SheetOutcomeStatus;
  kind?: string;
  added: number;
  skipped: number;
  flagged: number;
  error?: string;
}

export interface WorkbookReviewTab {
  sheetName: string;
  verdict: ImportableSheet['verdict'];
  rowCount: number;
  selected: boolean;
  plan: LimsImportPlan | null;
  planError?: string;
  outcome?: SheetImportOutcome;
}

export interface WorkbookReviewState {
  fileName: string;
  arrayBuffer: ArrayBuffer;
  sourcePath?: string;
  kind: LimsEntityKind;
  schemas: LimsSchemaDefinitionView[];
  tabs: WorkbookReviewTab[];
  activeSheet: string;
  gridPreviews: Record<string, WorkbookSheetPreview>;
  phase: 'review' | 'importing' | 'done';
}

export function activeReviewTab(state: WorkbookReviewState): WorkbookReviewTab | undefined {
  return state.tabs.find((tab) => tab.sheetName === state.activeSheet);
}

export function selectedReviewTabs(state: WorkbookReviewState): WorkbookReviewTab[] {
  return state.tabs.filter((tab) => tab.selected);
}

export function buildReviewSummaryRows(state: WorkbookReviewState): SheetImportOutcome[] {
  return state.tabs.map(
    (tab) =>
      tab.outcome ?? {
        sheetName: tab.sheetName,
        status: 'not-selected' as const,
        added: 0,
        skipped: 0,
        flagged: 0,
      }
  );
}

export function fieldOptionsForSchema(
  schema: LimsSchemaDefinitionView | undefined
): { value: string; label: string }[] {
  if (!schema) return [];
  return [
    { value: 'entity.name', label: 'Name' },
    ...schema.fields.map((field) => ({ value: `fields.${field.key}`, label: field.label })),
  ];
}

export interface WorkbookAcceptedCountInput {
  workbookReview: WorkbookReviewState | null;
  preview: LimsImportPlan | null;
  idSchemes: LimsIdScheme[];
  limsSchemas: LimsSchemaDefinitionView[];
}

export function workbookAcceptedCount({
  workbookReview,
  preview,
  idSchemes,
  limsSchemas,
}: WorkbookAcceptedCountInput): number {
  const review = workbookReview;
  if (!review) return 0;
  const schema = limsSchemas.find((s) => s.entityKind === review.kind);
  return review.tabs
    .filter((tab) => tab.selected)
    .reduce((sum, tab) => {
      const plan = tab.sheetName === review.activeSheet ? (preview ?? tab.plan) : tab.plan;
      if (!plan) return sum;
      return sum + computeImportPlanView(plan, idSchemes, undefined, schema).acceptedCount;
    }, 0);
}
