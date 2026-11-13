import { userMessage, toUserMessage, type UserMessage } from '@waypoint/user-messages';
import {
  codonReaderFor,
  resolveSequenceGeneticCode,
  type AnnotatedSequence,
} from '@waypoint/sequence-utils';
import {
  buildResidueSelectionForCdsCodon,
  getCodonsForSingleCDS,
  type ResidueSelection,
} from '@waypoint/workspace-editor';
import { buildStructureDrawerRequestFromAnnotation } from '../../structure-drawer/public/api/build-structure-request';
import type { StructureDrawerRequest } from '../../structure-drawer/public/types/structure-drawer';
import type { Mutation } from '../types';
import { deriveMutationProteinProduct } from './mutation-protein-product';

export type MutationProteinContextResult =
  | { ok: true; request: StructureDrawerRequest; selections: ResidueSelection[] }
  | { ok: false; reason: UserMessage };

export function buildMutationProteinContext({
  sequence,
  mutation,
  documentId,
  trackId,
  trackLabel,
}: {
  sequence: AnnotatedSequence;
  mutation: Mutation;
  documentId: string;
  trackId: string;
  trackLabel: string;
}): MutationProteinContextResult {
  const referenceBase = mutation.referenceBase ?? '';
  const alternateBase = mutation.alternateBase ?? '';
  const insertion = mutation.type === 'insertion';
  const deletion = mutation.type === 'deletion';
  const start = mutation.position - 1;
  const length = referenceBase.length;
  const intervalLength = insertion ? 2 : length;
  if (
    !Number.isInteger(start) ||
    start < 0 ||
    (insertion ? length !== 0 || !alternateBase.length : !length) ||
    (deletion ? !!alternateBase.length : !insertion && alternateBase.length !== length) ||
    start + intervalLength > sequence.sequence.length
  ) {
    return { ok: false, reason: userMessage('alignment.invalidInterval') };
  }
  if (
    sequence.sequence.slice(start, start + length).toUpperCase() !== referenceBase.toUpperCase()
  ) {
    return {
      ok: false,
      reason: userMessage('alignment.referenceChanged'),
    };
  }
  const geneticCode = resolveSequenceGeneticCode(sequence);
  const matches = (sequence.annotations ?? [])
    .filter((cds) => cds.type === 'CDS')
    .map((cds) => {
      const codons = getCodonsForSingleCDS(
        cds,
        start,
        start + intervalLength,
        sequence.sequence,
        geneticCode.code,
        geneticCode.basis
      );
      return { cds, codons };
    })
    .filter(({ codons }) => codons.length > 0);
  if (matches.length === 0) return { ok: false, reason: userMessage('alignment.noCompleteCodon') };
  if (matches.length > 1)
    return {
      ok: false,
      reason: userMessage('alignment.multipleCodingFeatures'),
    };
  const { cds, codons } = matches[0];
  if (cds.direction !== 1 && cds.direction !== -1)
    return { ok: false, reason: userMessage('alignment.undefinedStrand') };
  if (/\border\s*\(/i.test(cds.qualifiers?._locationString?.[0] ?? ''))
    return {
      ok: false,
      reason: userMessage('alignment.unjoinedProtein'),
    };
  const request = buildStructureDrawerRequestFromAnnotation({
    annotation: cds,
    sequence,
    entityId: documentId,
  });
  if (!request || request.refusal)
    return {
      ok: false,
      reason: toUserMessage(request?.refusal?.message, 'alignment.translationUnavailable'),
    };
  const completeCodons = getCodonsForSingleCDS(
    cds,
    0,
    sequence.sequence.length,
    sequence.sequence,
    geneticCode.code,
    geneticCode.basis
  );
  if (insertion || deletion) {
    const codingBases = new Set<number>();
    for (const codon of completeCodons) {
      const end =
        codon.endPos < codon.startPos ? codon.endPos + sequence.sequence.length : codon.endPos;
      for (let position = codon.startPos; position <= end; position++)
        codingBases.add(position % sequence.sequence.length);
    }
    for (let position = start; position < start + intervalLength; position++)
      if (!codingBases.has(position))
        return {
          ok: false,
          reason: userMessage('alignment.indelBoundary'),
        };
  }
  const aminoAcids = new Map(completeCodons.map((codon) => [codon.residueIndex, codon.aa]));
  let observedTranslation = [...aminoAcids.entries()]
    .sort(([left], [right]) => (left ?? 0) - (right ?? 0))
    .map(([, aminoAcid]) => aminoAcid)
    .join('')
    .replace(/\*$/, '');
  if (request.proteinIdentity?.sequence.initiatorNormalized && observedTranslation.length) {
    observedTranslation = `M${observedTranslation.slice(1)}`;
  }
  if (observedTranslation !== request.translation) {
    return {
      ok: false,
      reason: userMessage('alignment.translationMismatch'),
    };
  }
  const seen = new Set<number>();
  const selections: ResidueSelection[] = [];
  for (const codon of codons) {
    const residueIndex = codon.residueIndex;
    if (!residueIndex || residueIndex > request.translation.length || codon.aa === '*') continue;
    if (seen.has(residueIndex)) continue;
    const selection = buildResidueSelectionForCdsCodon({
      referenceId: documentId,
      cds,
      codon: { start: codon.startPos, end: codon.endPos, strand: cds.direction, residueIndex },
      fullSequence: sequence.sequence,
      source: {
        kind: 'alignment-variant',
        id: `${trackId}:${mutation.id}`,
        surface: 'alignment-mutations',
        label: trackLabel,
      },
    });
    if (selection) {
      const intervals = new Map<string, { start: number; end: number }>();
      for (const piece of completeCodons) {
        if (piece.residueIndex === residueIndex) {
          intervals.set(`${piece.startPos}:${piece.endPos}`, {
            start: piece.startPos,
            end: piece.endPos,
          });
        }
      }
      for (const mapping of selection.mappings ?? []) {
        if (mapping.kind === 'coding-dna') mapping.intervals = [...intervals.values()];
      }
      seen.add(residueIndex);
      selections.push(selection);
    }
  }
  if (selections.length === 0)
    return {
      ok: false,
      reason: userMessage('alignment.noProteinResidue'),
    };
  type Context = NonNullable<StructureDrawerRequest['variantContext']>;
  const product = deriveMutationProteinProduct({
    sequence,
    cds,
    mutation,
    referenceProtein: request.translation,
  });
  const changes: NonNullable<Context['changes']> = [];
  let proteinEffect: Context['proteinEffect'];
  let affectedTail: Context['affectedTail'];
  if (insertion || deletion) {
    const frameShift = (insertion ? alternateBase.length : length) % 3 !== 0;
    proteinEffect = frameShift
      ? 'frameshift'
      : insertion
        ? 'in-frame-insertion'
        : 'in-frame-deletion';
    if (frameShift) {
      const downstream = cds.direction === 1 ? mutation.position : mutation.position - 1;
      const tailStart = insertion
        ? getCodonsForSingleCDS(
            cds,
            downstream,
            downstream + 1,
            sequence.sequence,
            geneticCode.code,
            geneticCode.basis
          )[0]?.residueIndex
        : Math.min(...seen);
      if (tailStart && tailStart <= request.translation.length)
        affectedTail = { start: tailStart, end: request.translation.length };
    }
  } else {
    const alternateDna =
      sequence.sequence.slice(0, start) + alternateBase + sequence.sequence.slice(start + length);
    const alternateCodons = getCodonsForSingleCDS(
      cds,
      0,
      sequence.sequence.length,
      alternateDna,
      geneticCode.code,
      geneticCode.basis
    );
    const read = codonReaderFor(cds, geneticCode.code, geneticCode.basis);
    let conditionalStop = false;
    for (const residue of [...seen].sort((a, b) => a - b)) {
      const pieces = alternateCodons.filter((codon) => codon.residueIndex === residue);
      const codon = pieces[0];
      if (!codon)
        return {
          ok: false,
          reason: userMessage('alignment.codonUntranslatable'),
        };
      const at = Math.min(...pieces.flatMap((piece) => [piece.startPos, piece.endPos])) + 1;
      const alternate = read(codon.codon, at);
      const original = completeCodons.find((codon) => codon.residueIndex === residue)!;
      const originalReading = read(original.codon, at);
      conditionalStop ||=
        alternate.alsoTerminates &&
        (alternate.kind !== originalReading.kind ||
          alternate.full !== originalReading.full ||
          !originalReading.alsoTerminates);
      changes.push({
        residue,
        reference: request.translation[residue - 1],
        alternate:
          residue === 1 && product.status === 'complete' ? product.sequence[0] : alternate.full,
      });
    }
    const stop = changes.find((change) => change.alternate === '*');
    proteinEffect = conditionalStop
      ? 'conditional-stop'
      : stop
        ? 'stop-gained'
        : changes.every((change) => change.reference === change.alternate)
          ? 'synonymous'
          : 'missense';
    if (stop && !conditionalStop)
      affectedTail = { start: stop.residue, end: request.translation.length };
  }
  request.variantContext = {
    trackId,
    trackLabel,
    mutationId: mutation.id,
    position: mutation.position,
    referenceBase,
    alternateBase,
    residueIndices: [...seen].map((position) => position - 1).sort((a, b) => a - b),
    mutationType: mutation.type,
    product,
    proteinEffect,
    changes,
    ...(affectedTail ? { affectedTail } : {}),
  };
  return { ok: true, request, selections };
}
