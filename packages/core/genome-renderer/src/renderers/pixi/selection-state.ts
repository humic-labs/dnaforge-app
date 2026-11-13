import type { RenderState } from '../../types';
import type { GenomeOrfIdentity } from '../../types';

export type SelectionFeature = {
  id: number;
  start: number;
  end: number;
  canonicalIdentity?: string;
};
export type SelectionFeatureIdentity = { id: number; canonicalIdentity?: string };

export type SelectionAction =
  | { type: 'clear-selection' }
  | { type: 'set-highlight-range'; range: [number, number] | null; clearSelectedIds?: boolean }
  | { type: 'select-feature'; feature: SelectionFeatureIdentity }
  | { type: 'select-feature-range'; feature: SelectionFeature; genomeLength: number }
  | { type: 'select-orf'; orf: GenomeOrfIdentity }
  | { type: 'select-orf-range'; orf: GenomeOrfIdentity }
  | { type: 'place-cursor'; bp: number }
  | { type: 'set-external-cursor'; bp: number | null }
  | { type: 'set-external-highlight'; range: [number, number] | null }
  | { type: 'set-external-hover'; featureId: number | null }
  | { type: 'set-residue-link-range'; range: [number, number] | null };

export function applySelectionAction(state: RenderState, action: SelectionAction): RenderState {
  switch (action.type) {
    case 'clear-selection':
      state.selectedIds.clear();
      state.selectedCanonicalIdentities?.clear();
      state.selectedOrf = null;
      state.highlightRange = null;
      state.cursorPosition = null;
      state.hoverPosition = null;
      return state;

    case 'set-highlight-range':
      if (action.clearSelectedIds) {
        state.selectedIds.clear();
        state.selectedCanonicalIdentities?.clear();
      }
      if (action.range) state.selectedOrf = null;
      state.highlightRange = action.range;
      if (action.range) state.cursorPosition = null;
      return state;

    case 'select-feature':
      state.selectedIds.clear();
      state.selectedIds.add(action.feature.id);
      replaceSelectedCanonicalIdentity(state, action.feature.canonicalIdentity);
      state.selectedOrf = null;
      state.highlightRange = null;
      state.cursorPosition = null;
      return state;

    case 'select-feature-range':
      state.selectedIds.clear();
      state.selectedIds.add(action.feature.id);
      replaceSelectedCanonicalIdentity(state, action.feature.canonicalIdentity);
      state.selectedOrf = null;
      state.highlightRange = featureHighlightRange(action.feature, action.genomeLength);
      state.cursorPosition = null;
      return state;

    case 'select-orf':
      state.selectedIds.clear();
      state.selectedCanonicalIdentities?.clear();
      state.selectedOrf = {
        start: action.orf.start,
        end: action.orf.end,
        strand: action.orf.strand,
      };
      state.highlightRange = null;
      state.cursorPosition = null;
      return state;

    case 'select-orf-range':
      state.selectedIds.clear();
      state.selectedCanonicalIdentities?.clear();
      state.selectedOrf = {
        start: action.orf.start,
        end: action.orf.end,
        strand: action.orf.strand,
      };
      state.highlightRange = [action.orf.start, action.orf.end];
      state.cursorPosition = null;
      return state;

    case 'place-cursor':
      state.selectedIds.clear();
      state.selectedCanonicalIdentities?.clear();
      state.selectedOrf = null;
      state.highlightRange = null;
      state.cursorPosition = action.bp;
      return state;

    case 'set-external-cursor':
      if (action.bp != null) state.selectedOrf = null;
      state.cursorPosition = state.highlightRange ? null : action.bp;
      return state;

    case 'set-external-highlight':
      state.highlightRange = action.range;
      if (action.range) state.selectedOrf = null;
      if (action.range) state.cursorPosition = null;
      return state;

    case 'set-external-hover':
      state.hoveredId = action.featureId;
      return state;

    case 'set-residue-link-range':
      state.residueLinkRange = action.range;
      return state;
  }
}

function replaceSelectedCanonicalIdentity(
  state: RenderState,
  canonicalIdentity: string | undefined
): void {
  const identities =
    state.selectedCanonicalIdentities ?? (state.selectedCanonicalIdentities = new Set<string>());
  identities.clear();
  if (canonicalIdentity) identities.add(canonicalIdentity);
}

export function buildSelectionRange(
  anchor: number,
  current: number,
  genomeLength: number,
  circular: boolean
): [number, number] {
  if (!circular) {
    return [Math.min(anchor, current), Math.max(anchor, current)];
  }

  const nonWrapStart = Math.min(anchor, current);
  const nonWrapEnd = Math.max(anchor, current);
  const nonWrapLen = nonWrapEnd - nonWrapStart;
  const circularWrapLen = genomeLength - nonWrapLen;
  return circularWrapLen < nonWrapLen ? [nonWrapEnd, nonWrapStart] : [nonWrapStart, nonWrapEnd];
}

export function buildBoundarySelectionRange(
  anchor: number,
  current: number,
  genomeLength: number,
  circular: boolean
): [number, number] | null {
  if (anchor === current) return null;
  const [start, end] = buildSelectionRange(anchor, current, genomeLength, circular);
  return [start, circular ? (end - 1 + genomeLength) % genomeLength : end - 1];
}

export function shiftSelectionRange(inputs: {
  currentRange: [number, number] | null;
  bp: number;
  genomeLength: number;
  circular: boolean;
  forceStartHandle?: boolean;
}): [number, number] {
  if (!inputs.currentRange) return [inputs.bp, inputs.bp];
  const [start, end] = inputs.currentRange;

  if (inputs.circular) {
    return inputs.forceStartHandle ? [inputs.bp, end] : [start, inputs.bp];
  }

  return circularDistance(inputs.bp, start, inputs.genomeLength) <=
    circularDistance(inputs.bp, end, inputs.genomeLength)
    ? buildSelectionRange(end, inputs.bp, inputs.genomeLength, false)
    : buildSelectionRange(start, inputs.bp, inputs.genomeLength, false);
}

export function featureHighlightRange(
  feat: { start: number; end: number },
  genomeLength: number
): [number, number] {
  const endInclusive =
    genomeLength > 0 ? (((feat.end - 1) % genomeLength) + genomeLength) % genomeLength : feat.end;
  return [feat.start, endInclusive];
}

export function selectionContainsBp(
  range: [number, number] | null,
  bp: number | null,
  genomeLength: number
): boolean {
  if (!range || bp == null || genomeLength <= 0) return false;
  const pos = ((bp % genomeLength) + genomeLength) % genomeLength;
  const start = ((range[0] % genomeLength) + genomeLength) % genomeLength;
  const end = ((range[1] % genomeLength) + genomeLength) % genomeLength;
  if (end < start) return pos >= start || pos <= end;
  return pos >= start && pos <= end;
}

function circularDistance(a: number, b: number, length: number): number {
  const direct = Math.abs(a - b);
  return Math.min(direct, length - direct);
}
