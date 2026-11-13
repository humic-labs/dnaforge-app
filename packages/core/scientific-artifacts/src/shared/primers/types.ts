import type { ProjectableEntitySchemaRevisionSnapshot } from '../entity-schema';
import type { PrimerOligoCompositionV1 } from './oligo-modifications';

export type PrimerEntitySchemaSnapshot = ProjectableEntitySchemaRevisionSnapshot<'primer'>;

export type PrimerStatus = 'designed' | 'ordered' | 'received' | 'verified' | 'archived';

export type PrimerDirection = 'forward' | 'reverse';

export type PrimerOrigin = 'manual' | 'assembly' | 'import' | 'genbank';

export type PrimerApplication = 'pcr' | 'sequencing' | 'cloning' | 'mutagenesis' | 'other';

export interface ValidationError {
  position?: number;
  char?: string;
  reason?: 'empty' | 'too_short' | 'too_long' | 'invalid_char';
  min?: number;
  max?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];

  trimmed?: string;
}

export interface CreatePrimerInput {
  name: string;
  sequence: string;

  oligo?: PrimerOligoCompositionV1;
  workspaceId?: number;

  artifactPath?: string;

  workspaceRoot?: string;

  targetFilePath?: string;

  targetDocumentId?: string;
  targetLength?: number;
  targetTopology?: 'linear' | 'circular';

  requireRegistry?: true;

  bindingSequenceId?: number;
  bindingStart?: number;
  bindingEnd?: number;

  bindingStrand?: 1 | -1;
  origin?: PrimerOrigin;
  originDetails?: Record<string, unknown>;
  application?: PrimerApplication;
  notes?: string;

  entitySchema?: PrimerEntitySchemaSnapshot;

  entityFields?: Record<string, unknown>;
}

export interface UpdatePrimerInput {
  id: string;
  name?: string;
  sequence?: string;
  status?: string;
  notes?: string;
  vendor?: string;
  orderDate?: number;
  application?: PrimerApplication;
  scale?: string;
  purification?: string;
  modifications?: string;
  stockLocation?: string;
  concentration?: number;
}

export interface SearchPrimersInput {
  query?: string;
  status?: string;
  application?: string;
  limit?: number;
  offset?: number;
}

export interface ImportBatchResult {
  imported: number;
  errors: Array<{ index: number; reason: string }>;
  duplicates: number;
}

export interface Primer {
  id: string;
  catalogNumber: string;
  name: string;
  sequence: string;
  length: number;
  tm: number | null;
  gcPercent: number;
  origin: PrimerOrigin;
  originDetails: Record<string, unknown> | null;
  status: PrimerStatus;
  vendor: string | null;
  orderDate: number | null;
  application: PrimerApplication | null;
  scale: string | null;
  purification: string | null;
  modifications: string | null;
  stockLocation: string | null;
  concentration: number | null;
  notes: string | null;
  workspaceId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateBindingInput {
  primerId: string;
  sequenceId: number;
  bindingStart: number;
  bindingEnd: number;
  strand: 1 | -1;
  source?: 'manual' | 'promoted' | 'accepted';
}

export interface PrimerBinding {
  id: string;
  primerId: string;
  sequenceId: number;
  bindingStart: number;
  bindingEnd: number;
  strand: number;
  source: string;
  createdAt: number;
  updatedAt: number;

  locationLabel?: string;
}

export interface BoundPrimer extends Primer {
  binding: PrimerBinding;
}

export interface DbPrimerRow {
  id: string;
  catalog_number: string;
  name: string;
  sequence: string;
  length: number;
  tm: number | null;
  gc_percent: number;
  origin: string;
  origin_details: string | null;
  status: string;
  vendor: string | null;
  order_date: number | null;
  application: string | null;
  scale: string | null;
  purification: string | null;
  modifications: string | null;
  stock_location: string | null;
  concentration: number | null;
  notes: string | null;
  workspace_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface DbBoundPrimerRow extends DbPrimerRow {
  binding_id: string;
  binding_start: number;
  binding_end: number;

  strand: number;
  source: string;
  binding_created_at: number;
  binding_updated_at: number;
}

export interface AutoNameInput {
  position: number;
  direction: PrimerDirection;
  annotations: Array<{ name: string; type: string; start: number; end: number }>;
  existingNames: string[];
  sequenceLength?: number;
  circular?: boolean;
}

export interface DeleteResult {
  deleted: boolean;
  reason?: string;
}

export const LIBRARY_PRIMER_COLOR = '#D97706';
