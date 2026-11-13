import { reverseComplement } from '@waypoint/sequence-utils';
import type { PrimerOligoCompositionV1 } from '../primers/public/oligo-modifications';
import type {
  AssemblyMethod,
  DesignPrimer,
  SavedPrimerLink,
  SavedPrimerLinkOrigin,
} from './assembly-contract';
import type { DesignRegion, SequenceDesign } from './types';

export type { SavedPrimerLink, SavedPrimerLinkOrigin };

export interface AssemblyPrimerSourceSite {
  documentId: string;
  name: string;
  coordinateSystem: 'zero_based_half_open';
  start: number;
  end: number;
  strand: 1 | -1;
  wraps: boolean;
  sourceLength: number | null;
  circular: boolean;
}

export interface AssemblyPrimerUse {
  designId: string;
  designName: string;
  designVersion: number;
  assemblyMethod: AssemblyMethod;
  primerId: string;
  primerName: string;
  partNumber: number;
  direction: 'forward' | 'reverse';
  sequence: string;
  bindingSequence: string;
  tailSequence: string;
  tmC: number | null;
  chemistry: PrimerOligoCompositionV1 | null;
  sourceSite: AssemblyPrimerSourceSite | null;
}

export interface SavedOligoBindingSnapshot {
  id: string;
  documentId: string;
  start: number;
  end: number;
  strand: 1 | -1;
  placement: string;
  confirmed: boolean;
  sourceDigest: string | null;
}

export interface SavedOligoSnapshot {
  oligoId: string;
  catalogNumber: string;
  name: string;
  bases: string;
  sequenceContentHash: string;
  artifactRevision: number;
  chemistry: PrimerOligoCompositionV1 | null;
  bindingSequence: string | null;
  tmC: number | null;
  tmConcentrationNm: number | null;
  tmModelLabel: string | null;
  bindings: SavedOligoBindingSnapshot[];
}

export type SavedPrimerLinkState =
  | 'current'
  | 'draft-primer-changed'
  | 'oligo-bases-changed'
  | 'oligo-unavailable';

export type SavedOligoMatch =
  | { kind: 'none' }
  | { kind: 'unique'; oligo: SavedOligoSnapshot }
  | { kind: 'ambiguous'; oligos: SavedOligoSnapshot[] };

export type SourceAttachmentAgreement =
  | { kind: 'agrees'; binding: SavedOligoBindingSnapshot }
  | { kind: 'differs'; bindings: SavedOligoBindingSnapshot[] }
  | { kind: 'none' };

export function designPrimerList(design: SequenceDesign): DesignPrimer[] {
  return design.designPrimers
    .flatMap((pair) => [pair.forward, pair.reverse])
    .filter((primer) => primer.sequence.trim().length > 0);
}

export function oligoChemistryKey(oligo: PrimerOligoCompositionV1 | null | undefined): string {
  if (!oligo) return '';
  const orderType = oligo.orderType ?? 'dna';
  if (orderType === 'dna' && oligo.modifications.length === 0) return '';
  const modifications = oligo.modifications
    .map((modification) =>
      JSON.stringify([
        modification.vendor,
        modification.vendorCode,
        modification.chemistryId,
        modification.anchor.kind,
        modification.anchor.kind === 'terminus'
          ? modification.anchor.end
          : modification.anchor.kind === 'base'
            ? modification.anchor.index
            : modification.anchor.offset,
        modification.naturalBase ?? null,
      ])
    )
    .sort();
  return JSON.stringify([orderType, modifications]);
}

function sameBases(left: string, right: string): boolean {
  return left.trim().toUpperCase() === right.trim().toUpperCase();
}

export function oligoMatchesPrimer(
  primer: Pick<AssemblyPrimerUse, 'sequence' | 'chemistry'>,
  oligo: Pick<SavedOligoSnapshot, 'bases' | 'chemistry'>
): boolean {
  return (
    sameBases(primer.sequence, oligo.bases) &&
    oligoChemistryKey(primer.chemistry) === oligoChemistryKey(oligo.chemistry)
  );
}

export function matchSavedOligos(
  primer: Pick<AssemblyPrimerUse, 'sequence' | 'chemistry'>,
  candidates: readonly SavedOligoSnapshot[]
): SavedOligoMatch {
  const byId = new Map<string, SavedOligoSnapshot>();
  for (const candidate of candidates) {
    if (oligoMatchesPrimer(primer, candidate)) byId.set(candidate.oligoId, candidate);
  }
  const oligos = [...byId.values()];
  if (oligos.length === 0) return { kind: 'none' };
  if (oligos.length === 1) return { kind: 'unique', oligo: oligos[0]! };
  return { kind: 'ambiguous', oligos };
}

export function savedPrimerLinkState(
  primer: Pick<AssemblyPrimerUse, 'sequence' | 'chemistry'>,
  link: SavedPrimerLink,
  oligo: SavedOligoSnapshot | null
): SavedPrimerLinkState {
  if (!oligo) return 'oligo-unavailable';
  if (oligoMatchesPrimer(primer, oligo)) return 'current';
  return oligo.sequenceContentHash === link.sequenceContentHash
    ? 'draft-primer-changed'
    : 'oligo-bases-changed';
}

function sourceCoordinate(region: DesignRegion, offset: number): number {
  const length = region.sourceLength ?? 0;
  const position = region.sourceStart + offset;
  if (!region.sourceIsCircular || length <= 0) return position;
  return ((position % length) + length) % length;
}

function bindingOffsetInRegion(region: DesignRegion, primer: DesignPrimer): number | null {
  const binding = primer.pbs.sequence.trim().toUpperCase();
  if (!binding) return null;
  const template = region.sequence.toUpperCase();
  const footprint = primer.direction === 'forward' ? binding : reverseComplement(binding);
  if (footprint.length > template.length) return null;
  const edge = primer.direction === 'forward' ? 0 : template.length - footprint.length;
  if (template.startsWith(footprint, edge)) return edge;
  const first = template.indexOf(footprint);
  if (first < 0 || template.indexOf(footprint, first + 1) >= 0) return null;
  return first;
}

export function assemblyPrimerSourceSite(
  region: DesignRegion | undefined,
  primer: DesignPrimer
): AssemblyPrimerSourceSite | null {
  if (!region || region.isPlaceholder || !region.sourceSequenceId) return null;
  if (primer.oligo?.orderType === 'rna') return null;
  const offset = bindingOffsetInRegion(region, primer);
  if (offset === null) return null;
  const length = primer.pbs.sequence.trim().length;
  const circular = Boolean(region.sourceIsCircular);
  const sourceLength = region.sourceLength ?? null;
  const start = sourceCoordinate(region, offset);
  const unwrappedEnd = start + length;
  const wraps =
    circular && sourceLength !== null && sourceLength > 0 && unwrappedEnd > sourceLength;
  return {
    documentId: region.sourceSequenceId,
    name: region.sourceSequenceName,
    coordinateSystem: 'zero_based_half_open',
    start,
    end: wraps ? unwrappedEnd - sourceLength! : unwrappedEnd,
    strand: primer.direction === 'forward' ? 1 : -1,
    wraps,
    sourceLength,
    circular,
  };
}

export function assemblyPrimerUse(design: SequenceDesign, primer: DesignPrimer): AssemblyPrimerUse {
  const sequence = primer.sequence.trim();
  const bindingSequence = primer.pbs.sequence.trim();
  return {
    designId: design.id,
    designName: design.name,
    designVersion: design.version,
    assemblyMethod: design.assemblyMethod,
    primerId: primer.id,
    primerName: primer.name,
    partNumber: primer.fragmentIndex + 1,
    direction: primer.direction,
    sequence,
    bindingSequence,
    tailSequence: sequence.slice(0, Math.max(0, sequence.length - bindingSequence.length)),
    tmC: typeof primer.tm === 'number' && Number.isFinite(primer.tm) ? primer.tm : null,
    chemistry: primer.oligo ?? null,
    sourceSite: assemblyPrimerSourceSite(design.regions[primer.fragmentIndex], primer),
  };
}

export function assemblyPrimerUses(design: SequenceDesign): AssemblyPrimerUse[] {
  return designPrimerList(design).map((primer) => assemblyPrimerUse(design, primer));
}

export function savedPrimerLinkFor(
  design: Pick<SequenceDesign, 'savedPrimerLinks'>,
  primerId: string
): SavedPrimerLink | null {
  return design.savedPrimerLinks?.find((link) => link.primerId === primerId) ?? null;
}

export function sourceAttachmentAgreement(
  site: AssemblyPrimerSourceSite | null,
  oligo: Pick<SavedOligoSnapshot, 'bindings'> | null
): SourceAttachmentAgreement {
  if (!site || !oligo) return { kind: 'none' };
  const onSource = oligo.bindings.filter((binding) => binding.documentId === site.documentId);
  if (onSource.length === 0) return { kind: 'none' };
  const agreeing = onSource.find(
    (binding) =>
      binding.start === site.start && binding.end === site.end && binding.strand === site.strand
  );
  return agreeing ? { kind: 'agrees', binding: agreeing } : { kind: 'differs', bindings: onSource };
}

export function mergeSavedPrimerLinks(
  design: Pick<SequenceDesign, 'savedPrimerLinks' | 'designPrimers'>,
  additions: readonly SavedPrimerLink[]
): SavedPrimerLink[] {
  const primerIds = new Set(
    design.designPrimers.flatMap((pair) => [pair.forward.id, pair.reverse.id])
  );
  if (primerIds.size === 0) return [...(design.savedPrimerLinks ?? [])];
  const merged = new Map<string, SavedPrimerLink>();
  for (const link of design.savedPrimerLinks ?? []) {
    if (primerIds.has(link.primerId)) merged.set(link.primerId, link);
  }
  for (const link of additions) {
    if (!primerIds.has(link.primerId)) continue;
    const existing = merged.get(link.primerId);
    merged.set(link.primerId, existing && sameLinkTarget(existing, link) ? existing : link);
  }
  return [...merged.values()].sort((left, right) => left.primerId.localeCompare(right.primerId));
}

function sameLinkTarget(left: SavedPrimerLink, right: SavedPrimerLink): boolean {
  return (
    left.oligoId === right.oligoId &&
    left.artifactRevision === right.artifactRevision &&
    left.sequenceContentHash === right.sequenceContentHash &&
    left.linkedAtDesignVersion === right.linkedAtDesignVersion &&
    left.via === right.via
  );
}

export function sameSavedPrimerLinks(
  left: readonly SavedPrimerLink[] | undefined,
  right: readonly SavedPrimerLink[]
): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right);
}

export interface OligoAssemblyUse {
  use: AssemblyPrimerUse;
  link: SavedPrimerLink;
  state: Exclude<SavedPrimerLinkState, 'oligo-unavailable'>;
  oligoRevisedSinceLink: boolean;
  polymerase: string | null;
  sourceAttachment: SourceAttachmentAgreement;
}

export function assemblyUsesOfOligo(
  oligo: SavedOligoSnapshot,
  designs: readonly SequenceDesign[]
): OligoAssemblyUse[] {
  const uses: OligoAssemblyUse[] = [];
  for (const design of designs) {
    for (const link of design.savedPrimerLinks ?? []) {
      if (link.oligoId !== oligo.oligoId) continue;
      const primer = designPrimerList(design).find((item) => item.id === link.primerId);
      if (!primer) continue;
      const use = assemblyPrimerUse(design, primer);
      const state = savedPrimerLinkState(use, link, oligo);
      if (state === 'oligo-unavailable') continue;
      uses.push({
        use,
        link,
        state,
        oligoRevisedSinceLink: oligo.artifactRevision > link.artifactRevision,
        polymerase: design.pcrPolymerase ?? null,
        sourceAttachment: sourceAttachmentAgreement(use.sourceSite, oligo),
      });
    }
  }
  return uses.sort(
    (left, right) =>
      left.use.designName.localeCompare(right.use.designName) ||
      left.use.partNumber - right.use.partNumber ||
      left.use.direction.localeCompare(right.use.direction)
  );
}

export function formatSourceSite(site: AssemblyPrimerSourceSite): string {
  const strand = site.strand === 1 ? '+' : '−';
  return `${(site.start + 1).toLocaleString('en-US')}–${site.end.toLocaleString('en-US')} (${strand})`;
}
