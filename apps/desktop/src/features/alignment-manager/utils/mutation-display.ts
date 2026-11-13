import type { Mutation, StructuralRegion, StructuralType } from '../types';
import { MUTATION_COLORS } from '@waypoint/workspace-editor';

export function classifyPointMutation(mutation: Mutation): 'SNV' | 'MNV' | 'INS' | 'DEL' {
  if (mutation.type === 'substitution') {
    return mutation.length > 1 ? 'MNV' : 'SNV';
  }
  if (mutation.type === 'insertion') return 'INS';
  if (mutation.type === 'deletion') return 'DEL';
  return 'SNV';
}

export function classifyStructuralRegion(
  type: StructuralType
): 'DEL' | 'INS' | 'DUP' | 'INV' | 'MIX' {
  switch (type) {
    case 'deletion':
    case 'truncation':
      return 'DEL';
    case 'insertion':
      return 'INS';
    case 'tandem_duplication':
    case 'dispersed_duplication':
      return 'DUP';
    case 'inversion':
      return 'INV';
    default:
      return 'MIX';
  }
}

export function truncateSeq(seq: string, maxLen: number = 6): string {
  if (!seq) return '';
  if (seq.length <= maxLen) return seq;
  return seq.slice(0, maxLen - 1) + '\u2026';
}

export function formatPointMutationChange(mutation: Mutation): string {
  if (mutation.type === 'substitution') {
    const ref = mutation.referenceBase || '?';
    const alt = mutation.alternateBase || '?';
    if (ref.length > 1 || alt.length > 1) {
      return `${truncateSeq(ref)}\u2192${truncateSeq(alt)}`;
    }
    return `${ref}\u2192${alt}`;
  }
  if (mutation.type === 'insertion') {
    const inserted = mutation.alternateBase;
    if (inserted && inserted.length > 0) {
      return `+${truncateSeq(inserted, 8)}`;
    }
    return `+${mutation.length}bp`;
  }
  if (mutation.type === 'deletion') {
    const deleted = mutation.referenceBase;
    if (deleted && deleted.length > 0) {
      return `\u0394${truncateSeq(deleted, 8)}`;
    }
    return `\u0394${mutation.length}bp`;
  }
  return '\u2014';
}

export function formatStructuralChange(region: StructuralRegion, mutations?: Mutation[]): string {
  if (!mutations || region.mutationIndices.length === 0) {
    return `${region.lengthColumns}bp`;
  }

  let ins = 0;
  let del = 0;
  let sub = 0;
  for (const idx of region.mutationIndices) {
    const m = mutations[idx];
    if (!m) continue;
    if (m.type === 'insertion') ins += m.length || 1;
    else if (m.type === 'deletion') del += m.length || 1;
    else if (m.type === 'substitution') sub += m.length || 1;
  }

  const additions = ins + sub;
  const deletions = del + sub;

  if (additions > 0 && deletions > 0) return `+${additions} / \u2212${deletions}`;
  if (additions > 0) return `+${additions}`;
  if (deletions > 0) return `\u2212${deletions}`;
  return `${region.lengthColumns}bp`;
}

export function getTypeBadgeStyle(
  displayType: string,
  severity?: 'high' | 'medium' | 'low'
): { backgroundColor: string; color: string } {
  let baseColor: string;
  let textColor: string | undefined;

  if (severity === 'high' && displayType !== 'MIX') {
    baseColor = MUTATION_COLORS.deletion;
  } else {
    switch (displayType) {
      case 'SNV':
      case 'MNV':
        baseColor = MUTATION_COLORS.substitution;
        textColor = '#c9a000';
        break;
      case 'INS':
        baseColor = MUTATION_COLORS.insertion;
        break;
      case 'DEL':
        baseColor = MUTATION_COLORS.deletion;
        break;
      case 'DUP':
        baseColor = MUTATION_COLORS.insertion;
        break;
      case 'INV':
        baseColor = MUTATION_COLORS.substitution;
        textColor = '#c9a000';
        break;
      case 'MIX':
        baseColor = '#f59e0b';
        break;
      default:
        baseColor = '#888888';
    }
  }

  return {
    backgroundColor: `${baseColor}33`,
    color: textColor || baseColor,
  };
}
