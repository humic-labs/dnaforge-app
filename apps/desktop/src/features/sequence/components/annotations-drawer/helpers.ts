import { DEFAULT_MANUAL_ANNOTATION_COLOR, type Annotation } from '@waypoint/sequence-utils';
import type { AnnotationDraft } from '../../types';

export const ANNOTATION_TYPES = [
  { value: 'gene', label: 'Gene' },
  { value: 'CDS', label: 'CDS' },
  { value: 'promoter', label: 'Promoter' },
  { value: 'terminator', label: 'Terminator' },
  { value: 'primer_bind', label: 'Primer Binding Site' },
  { value: 'misc_feature', label: 'Misc Feature' },
  { value: 'rep_origin', label: 'Origin of Replication' },
  { value: 'regulatory', label: 'Regulatory' },
] as const;

export type AnnotationRange = { start: number; end: number };
export type AnnotationKind = 'regular' | 'cds';

export const CDS_QUALIFIER_KEYS = new Set([
  'translation',
  'transl_table',
  'codon_start',
  'protein_id',
]);

export const ANNOTATION_GRID =
  '18px minmax(56px, 200px) minmax(40px, 100px) minmax(48px, 1fr) 22px';

export const EMPTY_HIDDEN_KEYS: Set<string> = new Set();

export function annotationVisibilityKey(ann: {
  name: string;
  type: string;
  start: number;
  end: number;
}): string {
  return `${ann.name}|${ann.type}|${ann.start}|${ann.end}`;
}

export interface EditState {
  name: string;
  type: string;
  direction: 1 | -1 | 0;
  color: string;
  start: string;
  end: string;
}

export interface AnnotationSavePayload {
  name: string;
  type: string;
  direction: 1 | -1 | 0;
  color: string;
  start: number;
  end: number;
}

export interface AddState {
  name: string;
  type: string;
  direction: 1 | -1 | 0;
  color: string;
  start: string;
  end: string;
  qualifiers: Record<string, string[]>;
}

export function annotationKindForType(type: string): AnnotationKind {
  return type === 'CDS' ? 'cds' : 'regular';
}

export function stripCdsQualifiers(qualifiers: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(qualifiers).filter(([key]) => !CDS_QUALIFIER_KEYS.has(key))
  );
}

export function pickCdsQualifiers(qualifiers: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(qualifiers).filter(([key]) => CDS_QUALIFIER_KEYS.has(key))
  );
}

export function hasQualifiers(qualifiers: Record<string, string[]>): boolean {
  return Object.keys(qualifiers).length > 0;
}

export function initEditState(ann: Annotation): EditState {
  return {
    name: ann.name,
    type: ann.type || 'misc_feature',
    direction: ann.direction ?? 1,
    color: ann.color || DEFAULT_MANUAL_ANNOTATION_COLOR,
    start: String(ann.start),
    end: String(ann.end),
  };
}

export function initAddState(
  initialDraft: AnnotationDraft | null | undefined,
  initialRange: AnnotationRange | null | undefined
): AddState {
  if (initialDraft) {
    return {
      name: initialDraft.name,
      type: initialDraft.type,
      direction: initialDraft.direction,
      color: initialDraft.color ?? DEFAULT_MANUAL_ANNOTATION_COLOR,
      start: String(initialDraft.start),
      end: String(initialDraft.end),
      qualifiers: initialDraft.qualifiers ? { ...initialDraft.qualifiers } : {},
    };
  }
  return {
    name: '',
    type: 'misc_feature',
    direction: 1,
    color: DEFAULT_MANUAL_ANNOTATION_COLOR,
    start: initialRange ? String(initialRange.start) : '',
    end: initialRange ? String(initialRange.end) : '',
    qualifiers: {},
  };
}

export function isAnnotationRangeValid(
  name: string,
  startNum: number,
  endNum: number,
  circular?: boolean,
  sequenceLength?: number
): boolean {
  if (name.trim().length === 0) return false;
  if (Number.isNaN(startNum) || Number.isNaN(endNum)) return false;
  if (startNum < 1 || endNum < 1) return false;
  if (!circular && endNum < startNum) return false;
  if (sequenceLength != null && (startNum > sequenceLength || endNum > sequenceLength))
    return false;
  return true;
}
