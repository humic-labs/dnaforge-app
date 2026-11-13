import { z } from 'zod';
import { resolveSequenceGeneticCode, type AnnotatedSequence } from '@waypoint/sequence-utils';
import type { SequenceVariantCall } from '@waypoint/api-client';
import { canonicalJson } from '../../shared/canonical-json';
import { encodedMoleculeIdentityPayload } from '../../shared/encoded-molecule';
import { buildStructureDrawerRequestFromCds } from '../structure-drawer/public/api/build-structure-request';
import { sha256Hex } from '../structure-drawer/public/api/protein-identity';
import type { StructureDrawerRequest } from '../structure-drawer/public/types/structure-drawer';
import {
  MEASUREMENT_PALETTES,
  residueMeasurementSchema,
  variantSignalValues,
  type VariantMeasurementEvidence,
  type ResidueMeasurement,
} from '../page/public/embeds/structure3d/residueMeasurement';
import { variantCallMutation, type VariantAnalysis } from './variant-analysis';
import { buildMutationProteinContext } from './utils/mutation-protein-context';

export const variantProteinMeasurementOptionsSchema = z
  .object({
    name: z.string().min(1).max(200),
    filter: z.enum(['pass', 'pass-or-unfiltered', 'all']).default('pass-or-unfiltered'),
    effect: z.enum(['all', 'amino-acid-changing']).default('all'),
    pseudocount: z
      .number()
      .finite()
      .nonnegative()
      .default(1)
      .describe(
        'Ignored for a raw allele fraction; zero is allowed without a baseline. A baseline log2 fraction ratio requires a positive smoothing pseudocount.'
      ),
    scale: residueMeasurementSchema.innerType().shape.scale.optional(),
  })
  .strict();
export type VariantProteinMeasurementOptions = z.input<
  typeof variantProteinMeasurementOptionsSchema
>;

export function variantProteinMeasurementIdentity(
  measurement: Omit<ResidueMeasurement, 'id'> & { id?: string }
): string {
  const { id: _id, ...definition } = measurement;

  const { correspondence: _correspondence, ...source } = definition.source;
  return `variant-measurement:v1:${sha256Hex(canonicalJson({ ...definition, source }))}`;
}

export function buildVariantProteinMeasurement(
  input: VariantProteinMeasurementOptions & {
    analysisId: string;
    analysis: VariantAnalysis;
    baseline?: { analysisId: string; analysis: VariantAnalysis };
    sequence: AnnotatedSequence;
    request: StructureDrawerRequest;
  }
) {
  const { analysisId, analysis, baseline, sequence } = input;
  const request = input.request.comparisonOf ?? input.request;
  const options = variantProteinMeasurementOptionsSchema.parse({
    name: input.name,
    filter: input.filter,
    effect: input.effect,
    pseudocount: input.pseudocount,
    scale: input.scale,
  });
  if (baseline && options.pseudocount === 0)
    throw new Error('A baseline log2 fraction ratio requires a positive pseudocount.');
  const refHash = sha256Hex(sequence.sequence.toUpperCase());
  const sources = [{ analysisId, analysis }, ...(baseline ? [baseline] : [])];
  for (const source of sources) {
    if (
      source.analysis.documentId !== analysis.documentId ||
      request.entityId !== analysis.documentId
    )
      throw new Error('The analysis and protein must belong to the same reference document.');
    if (source.analysis.referenceSha256 !== refHash)
      throw new Error(
        'The reference changed since this analysis. Import it again before deriving a protein signal.'
      );
    if (source.analysis.chrom !== analysis.chrom)
      throw new Error('The samples use different chromosome identities.');
  }
  const matches = (sequence.annotations ?? [])
    .filter((cds) => cds.type === 'CDS')
    .filter((cds) => {
      const current = buildStructureDrawerRequestFromCds({
        cds,
        sequence,
        entityId: analysis.documentId,
      });
      return (
        current &&
        !current.refusal &&
        current.identityRequestKey === request.identityRequestKey &&
        current.residueMolecule?.moleculeId === request.residueMolecule?.moleculeId &&
        current.translation === request.translation
      );
    });
  if (
    matches.length !== 1 ||
    !request.identityRequestKey ||
    !request.residueMolecule ||
    !request.proteinIdentity
  )
    throw new Error(
      'The selected protein no longer matches one current coding feature. Select a mutation again.'
    );
  const codingSequence = { ...sequence, annotations: matches };
  const contextJson = canonicalJson({
    annotation: matches[0],
    sequenceGeneticCode: resolveSequenceGeneticCode(sequence).code,
    proteinIdentity: request.proteinIdentity,
  });
  const molecule = { kind: 'protein' as const, sequence: request.translation };
  const excluded: VariantMeasurementEvidence['excluded'] = [];
  const key = (call: SequenceVariantCall) =>
    JSON.stringify([call.position, call.reference.toUpperCase(), call.alternate.toUpperCase()]);
  const index = (source: (typeof sources)[number]) => {
    const calls = new Map<string, SequenceVariantCall>();
    const seen = new Set<string>();
    for (const call of source.analysis.calls) {
      const id = key(call);
      if (seen.has(id))
        throw new Error(
          'This analysis has duplicate records for one DNA allele. Resolve duplicate evidence before aggregating.'
        );
      seen.add(id);
      const pass = call.filters.length === 1 && call.filters[0] === 'PASS';
      if (
        options.filter !== 'all' &&
        !pass &&
        !(options.filter === 'pass-or-unfiltered' && call.filters.length === 0)
      ) {
        excluded.push({ analysisId: source.analysisId, callId: call.id, reason: 'filtered' });
        continue;
      }
      calls.set(id, call);
    }
    return calls;
  };
  const after = index(sources[0]),
    before = baseline ? index(sources[1]) : new Map<string, SequenceVariantCall>();
  const snapshot = (call: SequenceVariantCall | undefined) =>
    call
      ? {
          callId: call.id,
          dnaPosition: call.position,
          reference: call.reference,
          alternate: call.alternate,
          alleleIndex: call.allele_index,
          alternateCount: call.alternate_count ?? null,
          totalAlleleCount: call.total_allele_count ?? null,
          filters: call.filters,
        }
      : null;
  const rows: VariantMeasurementEvidence['rows'] = [];
  for (const id of new Set([...after.keys(), ...before.keys()])) {
    const observed = after.get(id),
      control = before.get(id),
      call = observed ?? control!;
    let reason: string | undefined;
    try {
      const mutation = variantCallMutation(call, codingSequence);
      if (mutation.type !== 'substitution')
        reason = 'Indel junctions are not residue-abundance measurements.';
      else if (
        options.effect === 'amino-acid-changing' &&
        mutation.effect?.classification === 'synonymous'
      )
        reason = 'synonymous';
      else {
        const context = buildMutationProteinContext({
          sequence: codingSequence,
          documentId: analysis.documentId,
          mutation,
          trackId: analysis.sourceIdentity,
          trackLabel: analysis.name,
        });
        if (!context.ok) reason = context.reason;
        else
          for (const residue of context.request.variantContext!.residueIndices)
            rows.push({
              residue: residue + 1,
              observed: snapshot(observed),
              baseline: snapshot(control),
            });
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (reason) {
      if (observed) excluded.push({ analysisId, callId: observed.id, reason });
      if (control) excluded.push({ analysisId: baseline!.analysisId, callId: control.id, reason });
    }
  }
  if (!rows.length)
    throw new Error(
      'No eligible substitution alleles map to this protein with these filters. Indels and symbolic alleles are not substituted for residue measurements.'
    );
  const evidence: VariantMeasurementEvidence = {
    kind: baseline ? 'vcf-log2-fraction-ratio' : 'vcf-allele-fraction',
    referenceSha256: refHash,
    proteinFeatureKey: request.identityRequestKey,
    filter: options.filter,
    effect: options.effect,
    aggregation: baseline ? 'maximum-absolute' : 'maximum',
    ...(baseline ? { pseudocount: options.pseudocount } : {}),
    sources: sources.map(({ analysisId, analysis }) => ({
      analysisId,
      name: analysis.name,
      sourceIdentity: analysis.sourceIdentity,
      sample: analysis.sample,
      countBasis: analysis.countBasis,
    })),
    rows,
    excluded,
  };
  const values = variantSignalValues(evidence);
  const max = Math.max(1, ...values.map((point) => Math.abs(point.value ?? 0)));
  const definition = residueMeasurementSchema
    .innerType()
    .omit({ id: true })
    .parse({
      name: options.name,
      proteinSequenceSha256: sha256Hex(request.translation),
      source: {
        label: baseline ? `${analysis.name} / ${baseline.analysis.name}` : analysis.name,
        analysisId,
        revision: `sha256:${sha256Hex(JSON.stringify(evidence))}`,
        correspondence: {
          kind: 'translated-cds',
          version: 1,
          reference: {
            documentId: analysis.documentId,
            sequenceSha256: refHash,
            length: sequence.sequence.length,
            circular: !!sequence.circular,
          },
          featureKey: request.identityRequestKey,
          residueMoleculeId: request.residueMolecule.moleculeId,
          context: { json: contextJson, sha256: sha256Hex(contextJson) },
          molecule: {
            ...molecule,
            identitySha256: sha256Hex(encodedMoleculeIdentityPayload(molecule)),
          },
        },
      },
      units: baseline ? 'log2 allele fraction ratio' : 'allele fraction',
      values,
      variantEvidence: evidence,
      scale: options.scale ?? {
        transform: 'linear',
        domain: baseline ? [-max, max] : [0, 1],
        colors: baseline ? MEASUREMENT_PALETTES.diverging : MEASUREMENT_PALETTES.viridis,
        missingColor: '#9ca3af',
      },
    });
  return residueMeasurementSchema.parse({
    ...definition,
    id: variantProteinMeasurementIdentity(definition),
  });
}
