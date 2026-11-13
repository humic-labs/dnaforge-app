import {
  trackAdmissionRequestLabel,
  type AdmittedTrackSource,
  type LocalFileTrackSourceV1,
  type TrackAdmissionRequestV1,
} from '@waypoint/genome-data';

import { platform } from '../../platform';
import { startAlignmentCoverageOperation } from './alignment-coverage-operation-client';
import type { AlignmentReferenceIdentity } from './alignment-header-client';
import { openAlignedReadSource, type OpenedAlignedReadSource } from './aligned-read-source-session';
import { useLaneContractStore } from './lane-contract-store';
import { buildReadPileupDataset } from './read-pileup-import';
import { admitTrackSource } from './track-admission';

export type AlignedReadImportPhase =
  | 'checking-index'
  | 'validating-assembly'
  | 'validating-reference'
  | 'adding-track';

export interface AlignedReadImportGenome {
  readonly laneOwnerId: string;
  readonly assemblyId: string;
  readonly displayName: string;
  readonly references: ReadonlyArray<AlignmentReferenceIdentity>;
}

export interface PreparedAlignmentSource {
  readonly bamPath: string;
  readonly indexPath?: string;
  readonly referencePath?: string;
  readonly generation?: NonNullable<AdmittedTrackSource['alignedReadGeneration']>;
  readonly grantExpiresAtMs?: number;
  readonly htsget?: NonNullable<OpenedAlignedReadSource['source']['htsget']>;
  readonly admittedSource: AdmittedTrackSource;
  readonly indexCreated: boolean;
}

export type AlignedReadProgressReporter = (
  phase: AlignedReadImportPhase,
  label: string,
  stepNumber: number
) => void;

export type LocalCramReferenceResolver = (
  request: TrackAdmissionRequestV1
) => Promise<LocalFileTrackSourceV1 | null>;

export interface AttachAlignedReadRequestInput {
  readonly request: TrackAdmissionRequestV1;
  readonly genome: AlignedReadImportGenome;
  readonly signal?: AbortSignal;
  readonly onProgress?: AlignedReadProgressReporter;
  readonly resolveLocalCramReference?: LocalCramReferenceResolver;
  readonly admit?: typeof admitTrackSource;
}

export interface AttachAlignedReadRequestResult {
  readonly status: 'added' | 'duplicate';
  readonly trackId: string;
  readonly label: string;
  readonly indexCreated: boolean;
  readonly coverage: Promise<void> | null;
}

export async function chooseLocalCramReferenceThroughPicker(
  request: TrackAdmissionRequestV1
): Promise<LocalFileTrackSourceV1> {
  const selection = await platform().dialog.open({
    multiple: false,
    title: `Choose the reference FASTA for ${trackAdmissionRequestLabel(request)}`,
    filters: [
      { name: 'Indexed reference FASTA', extensions: ['fa', 'fasta', 'fna'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  const referencePath = Array.isArray(selection) ? selection[0] : (selection ?? undefined);
  if (!referencePath) {
    throw new Error('This CRAM needs its matching indexed reference FASTA before it can be added.');
  }
  return { kind: 'local-file', path: referencePath };
}

export async function prepareAlignmentSource(
  request: TrackAdmissionRequestV1,
  genome: AlignedReadImportGenome,
  reportProgress: AlignedReadProgressReporter,
  options: {
    readonly signal?: AbortSignal;
    readonly resolveLocalCramReference?: LocalCramReferenceResolver;
    readonly admit?: typeof admitTrackSource;
  } = {}
): Promise<PreparedAlignmentSource> {
  const admit = options.admit ?? admitTrackSource;
  let admittedRuntime: OpenedAlignedReadSource | undefined;
  const admittedSource = await admit({
    request,
    assemblyId: genome.assemblyId,
    assemblyDisplayName: genome.displayName,
    assemblyReferences: genome.references,
    signal: options.signal,
    onAlignedReadProgress: ({ phase, label, stepNumber }) =>
      reportProgress(phase, label, stepNumber),
    onAlignedReadRuntime: (runtime) => {
      admittedRuntime = runtime;
    },
    ...(options.resolveLocalCramReference
      ? { resolveLocalCramReference: options.resolveLocalCramReference }
      : {}),
  });
  if (!admittedSource.request) {
    throw new Error('Aligned-read admission returned no durable request.');
  }
  if (admittedSource.readerKind !== 'bam' || admittedSource.scientificKind !== 'reads') {
    throw new Error('Aligned-read admission returned an invalid durable receipt.');
  }
  const opened =
    admittedRuntime ??
    (await openAlignedReadSource({
      source: admittedSource,
      assemblyReferences: genome.references,
      assemblyDisplayName: genome.displayName,
      signal: options.signal,
    }));
  const { bamPath, indexPath, referencePath, generation, grantExpiresAtMs, htsget } = opened.source;
  if (!indexPath && !htsget) throw new Error('Aligned-read admission returned no runtime index.');
  return {
    bamPath,
    ...(indexPath ? { indexPath } : {}),
    ...(referencePath ? { referencePath } : {}),
    generation,
    ...(grantExpiresAtMs !== undefined ? { grantExpiresAtMs } : {}),
    ...(htsget ? { htsget } : {}),
    admittedSource,
    indexCreated: admittedSource.alignedReadIndexState === 'created',
  };
}

export async function attachAlignedReadRequest(
  input: AttachAlignedReadRequestInput
): Promise<AttachAlignedReadRequestResult> {
  const report: AlignedReadProgressReporter = (phase, label, stepNumber) =>
    input.onProgress?.(phase, label, stepNumber);
  report('checking-index', 'Checking index', 1);
  const prepared = await prepareAlignmentSource(input.request, input.genome, report, {
    signal: input.signal,
    resolveLocalCramReference: input.resolveLocalCramReference,
    admit: input.admit,
  });
  if (input.signal?.aborted) {
    throw new Error('Adding the aligned-read track was cancelled before its lane was attached.');
  }
  report('adding-track', 'Adding track', 4);
  const { bamPath, indexPath, referencePath, generation, grantExpiresAtMs, htsget } = prepared;
  const dataset = buildReadPileupDataset({
    assemblyId: input.genome.assemblyId,
    assemblyDisplayName: input.genome.displayName,
    bamPath,
    indexPath,
    referencePath,
    generation,
    ...(grantExpiresAtMs !== undefined ? { grantExpiresAtMs } : {}),
    ...(htsget ? { htsget } : {}),
  });
  const status = useLaneContractStore
    .getState()
    .addLane(
      input.genome.laneOwnerId,
      input.genome.assemblyId,
      dataset,
      true,
      prepared.admittedSource
    );
  const coverage =
    status === 'added' && generation && indexPath
      ? startAlignmentCoverageOperation({
          assemblyId: input.genome.assemblyId,
          bamPath,
          indexPath,
          ...(referencePath ? { referencePath } : {}),
          sourceGeneration: generation,
          chroms: input.genome.references.map((reference) => reference.name),
        }).then(() => undefined)
      : null;
  return {
    status,
    trackId: dataset.trackId,
    label: dataset.label,
    indexCreated: prepared.indexCreated,
    coverage,
  };
}
