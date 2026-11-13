import {
  canonicalPredictionProtein,
  submittedProteins,
} from '../../shared/compute-protein-sequence';
export { canonicalPredictionProtein } from '../../shared/compute-protein-sequence';
import { z } from 'zod';
import { readEncodedPolymerChain } from '../page/public/embeds/structure3d/encodedPolymer';
import { createEntityReference, getEntityReference } from '../../db/entity-references';
import { listPredictionArtifactRows } from '../../db/prediction-artifacts';
import type { ComputeJobRecord } from '../../shared/compute-jobs-ipc';
import {
  coordinateDigest,
  molecularCoordinatesSchema,
} from '../page/public/embeds/structure3d/molecularView';
import { readVerifiedProteinChain } from '../page/public/embeds/structure3d/proteinComparison';
import { readPredictionCoordinateModel } from '../structure-drawer/public/prediction-coordinates';

const id = z.string().min(1).max(2000);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const chainSchema = z.object({
  chainId: id,
  sequenceSha256: digest,
  sequence: z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]{1,24000}$/),
});
const runSchema = z.object({
  jobRecordId: id,
  provider: id,
  remoteId: id,
  toolId: id,
  label: z.string().nullable(),
  createdAt: z.string(),
  settingsHash: id,
  settings: z.record(z.unknown()),
});
const metadataSchema = z.object({
  kind: z.literal('protein-prediction-result'),
  version: z.literal(1),
  run: runSchema,
  origin: z.object({ workspaceRoot: id, filePath: id }),
  chainCount: z.number().int().positive(),
  metrics: z.record(z.unknown()),
  provenance: z.record(z.string()),
});
const artifactSchema = metadataSchema
  .extend({
    coordinates: molecularCoordinatesSchema.extend({ format: z.enum(['pdb', 'cif']) }),
    chains: z.array(chainSchema).min(1).max(500),
  })
  .refine(
    (value) => value.chainCount === value.chains.length,
    'Stored chain count is inconsistent.'
  )
  .refine(
    (value) => new Set(value.chains.map((chain) => chain.chainId)).size === value.chains.length,
    'Stored chain identities must be unique.'
  );
export type ProteinPredictionResult = z.infer<typeof artifactSchema>;
const summarySchema = metadataSchema.extend({ run: runSchema.omit({ settings: true }) });
export type ProteinPredictionSummary = z.infer<typeof summarySchema> & {
  id: string;
  chainId: string;
  proteinLength: number;
};

export interface RegisterPredictionResultInput {
  job: ComputeJobRecord;
  filePath: string;
  coordinates: { text: string; format: 'pdb' | 'cif' };
  metrics: Record<string, unknown>;
  provenance: Record<string, string>;
}

export async function registerPredictionResult(
  input: RegisterPredictionResultInput
): Promise<string> {
  if (input.provenance.livemode === 'false')
    throw new Error('Provider test-mode output cannot be registered as a reusable prediction.');
  const { job, coordinates } = input;
  if (!job.remoteId || !job.workspaceRoot)
    throw new Error('The prediction has no durable run or workspace owner.');
  const submitted = submittedProteins(job.settings);
  const model = await readPredictionCoordinateModel(coordinates.text, coordinates.format);
  const chains: ProteinPredictionResult['chains'] = [];
  for (let i = 0; i < model.atomicHierarchy.chains._rowCount; i++) {
    const chainId = model.atomicHierarchy.chains.label_asym_id.value(i);
    const sequence = readEncodedPolymerChain(model, i);
    if (sequence?.kind !== 'protein') continue;
    if (sequence.unresolved.length)
      throw new Error('The output contains an unresolved encoded protein sequence.');
    const protein = sequence.sequence;
    if (!submitted.includes(protein))
      throw new Error('The output protein sequence does not match this run’s submitted input.');
    await readVerifiedProteinChain({ ...coordinates, sequence: protein, chainId });
    chains.push({ chainId, sequence: protein, sequenceSha256: await coordinateDigest(protein) });
  }
  if (submitted.some((sequence) => !chains.some((chain) => chain.sequence === sequence)))
    throw new Error('The output is missing a submitted protein sequence.');
  const artifact = artifactSchema.parse({
    kind: 'protein-prediction-result',
    version: 1,
    run: {
      jobRecordId: job.id,
      provider: job.provider,
      remoteId: job.remoteId,
      toolId: job.toolId,
      settingsHash: job.settingsHash,
      settings: job.settings,
      label: job.label ?? null,
      createdAt: job.createdAt,
    },
    origin: { workspaceRoot: job.workspaceRoot, filePath: input.filePath },
    coordinates: { ...coordinates, sha256: await coordinateDigest(coordinates.text) },
    chains,
    chainCount: chains.length,
    metrics: input.metrics,
    provenance: input.provenance,
  });
  const referenceId = `prediction:${await coordinateDigest(JSON.stringify([job.id, input.filePath]))}`;
  const sameExisting = async () => {
    const prior = await getEntityReference(referenceId);
    if (!prior) return false;
    const parsed = artifactSchema.safeParse(prior.data ? JSON.parse(prior.data) : null);
    const identity = (value: ProteinPredictionResult) =>
      JSON.stringify({
        run: value.run,
        origin: value.origin,
        coordinates: value.coordinates,
        chains: value.chains,
      });
    if (
      prior.entity_type !== 'protein-prediction' ||
      !parsed.success ||
      identity(parsed.data) !== identity(artifact)
    )
      throw new Error(
        'This run’s stored prediction result changed. The original artifact was retained.'
      );
    return true;
  };
  if (await sameExisting()) return referenceId;
  try {
    await createEntityReference(
      {
        entityType: 'protein-prediction',
        displayLabel: job.label ?? `${job.toolId} · ${job.remoteId}`,
        locator: `entity://protein-prediction/${referenceId}`,
        deepLinkParams: null,
        data: artifact,
        source: 'compute',
        workspaceScope: null,
        workspaceRootPath: job.workspaceRoot,
      },
      { id: referenceId }
    );
  } catch (error) {
    if (!(await sameExisting())) throw error;
  }
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event('waypoint:predictions-changed'));
  return referenceId;
}

export async function listProteinPredictions(
  sequence: string
): Promise<ProteinPredictionSummary[]> {
  const canonical = canonicalPredictionProtein(sequence);
  const rows = await listPredictionArtifactRows(await coordinateDigest(canonical));
  return rows.map((row) => {
    const summary = summarySchema.parse(JSON.parse(row.summary));
    const chain = chainSchema.parse(JSON.parse(row.chain));
    if (chain.sequence !== canonical)
      throw new Error('Stored prediction sequence identity is inconsistent.');
    return { ...summary, id: row.id, chainId: chain.chainId, proteinLength: canonical.length };
  });
}

export async function loadProteinPrediction(
  referenceId: string,
  sequence: string,
  chainId: string
): Promise<ProteinPredictionResult> {
  const canonical = canonicalPredictionProtein(sequence);
  return loadProteinPredictionByDigest(referenceId, await coordinateDigest(canonical), chainId);
}

export async function loadProteinPredictionByDigest(
  referenceId: string,
  sequenceSha256: string,
  chainId: string
): Promise<ProteinPredictionResult> {
  const row = await getEntityReference(referenceId);
  if (!row || row.entity_type !== 'protein-prediction' || !row.data)
    throw new Error('The saved prediction result is unavailable.');
  const result = artifactSchema.parse(JSON.parse(row.data));
  if (
    !result.chains.some(
      (chain) => chain.chainId === chainId && chain.sequenceSha256 === sequenceSha256
    )
  )
    throw new Error('The chosen prediction chain does not match this protein sequence.');
  if ((await coordinateDigest(result.coordinates.text)) !== result.coordinates.sha256)
    throw new Error('The saved prediction coordinate digest does not match its pinned bytes.');
  const chain = result.chains.find((chain) => chain.chainId === chainId)!;
  if ((await coordinateDigest(chain.sequence)) !== chain.sequenceSha256)
    throw new Error('The saved prediction protein sequence digest is inconsistent.');
  await readVerifiedProteinChain({ ...result.coordinates, sequence: chain.sequence, chainId });
  return result;
}
