import type { UserMessagePayload } from '@waypoint/user-messages';
import type {
  LimsEntityKind,
  LimsFieldDefinition,
  LimsImportColumnMappingOverride,
  LimsImportPlan,
  LimsImportPlanRecord,
} from './lims';
import type { TmConditions, TmModel } from './primer-thermodynamics/tm-model';

export interface ImportReviewSource {
  fileName: string;
  sourcePath?: string;
  text?: string;
  arrayBuffer?: ArrayBuffer;
  sheetName?: string;
  headerRowOverride?: number;
  hasHeader?: boolean;
  externalRowKeyColumn?: string;
  defaultKind?: LimsEntityKind;
  forcedKind?: string;
  columnMappings?: readonly LimsImportColumnMappingOverride[];
  schemaFields?: readonly LimsFieldDefinition[];
  schemaRevisionId?: string;
  primerTmSettings?: {
    userSetting: TmModel;
    userSettingIsExplicit: boolean;
    conditions: TmConditions;
    concNm: number;
  };
}

export type ImportReviewCommand =
  | { kind: 'inspect'; offset?: number; limit?: number }
  | { kind: 'set-records-accepted'; recordIds: string[]; accepted: boolean }
  | { kind: 'set-mappings'; mappings: LimsImportColumnMappingOverride[] }
  | { kind: 'set-destination'; workspaceRoot: string; destinationDir: string }
  | {
      kind: 'set-source-options';
      sheetName?: string;
      headerRowOverride?: number;
      hasHeader?: boolean;
      forcedKind?: string;
    }
  | { kind: 'resolve-duplicate'; recordId: string; entityId: string | null }
  | {
      kind: 'resolve-link';
      recordId: string;
      linkIndex: number;
      endpoint: 'source' | 'target';
      entityId: string;
    }
  | { kind: 'apply'; requestId: string }
  | { kind: 'cancel' };

export interface ImportReviewReceipt {
  sourcePath?: string;
  members?: Array<{
    sourceRecordId: string;
    sourceRowId: string;
    sourceRow?: number;
    externalRowId?: string;
    entityId: string;
    entityKind: string;
    artifactRelativePath: string;
  }>;
  changed: boolean | 'unknown';
  artifactPaths: string[];
  imported: number;
  skipped: number;
  failed: number;
  batchId?: string;
  insertedLinks?: number;
  gitCommitted?: boolean;
  importSet?: { id: string; manifestRelativePath: string } | null;
  partialEffects?: string[];
  userMessagePayload?: UserMessagePayload;
}

export interface ImportReviewDocument {
  id: string;
  revision: string;
  workspaceRoot: string;
  destinationDir: string;
  sourceFingerprint: string;
  source: ImportReviewSource;
  plan: LimsImportPlan;
  phase: 'review' | 'applying' | 'applied' | 'partial' | 'cancelled' | 'failed';
  requestId?: string;
  receipt?: ImportReviewReceipt;
  error?: string;
}

export interface ImportReviewInspection {
  id: string;
  revision: string;
  workspaceRoot: string;
  destinationDir: string;
  phase: ImportReviewDocument['phase'];
  sourceName: string;
  sourceFingerprint: string;
  schemaRevisionId?: string;
  selectedSheet?: string;
  sheetDispositions?: LimsImportPlan['sheetDispositions'];
  sourceKind: LimsImportPlan['sourceKind'];
  columns: LimsImportPlan['columns'];
  totalRecords: number;
  records: LimsImportPlanRecord[];
  nextOffset: number | null;
  canApply: boolean;
  receipt?: ImportReviewReceipt;
  error?: string;
}

export type ImportReviewRequest =
  | { kind: 'prepare'; workspaceRoot: string; destinationDir: string; source: ImportReviewSource }
  | { kind: 'execute'; id: string; expectedRevision?: string; command: ImportReviewCommand };

export interface ImportReviewChanged {
  id: string;
  revision: string;
  workspaceRoot: string;
  phase: ImportReviewDocument['phase'];
}
