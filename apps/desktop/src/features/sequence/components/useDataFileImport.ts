import { useCallback, useMemo, useState } from 'react';

import {
  createDefaultFormatRegistry,
  decodeGenomeSessionFile,
  decodeTrackManifest,
  detectGenomeSessionFileKind,
  directTrackAdmissionRequest,
  GENOME_SESSION_FILE_MAX_BYTES,
  parseTrackAdmissionRequestV1,
  TRACK_ADMISSION_REQUEST_V1,
  TRACK_MANIFEST_MAX_BYTES,
  type DecodedGenomeSessionFile,
  type FormatHandler,
  type GenomeSessionLocus,
  type GenomeSessionResourceLocator,
  type TrackAdmissionIngressV1,
  type TrackAdmissionRequestV1,
  type TrackAssetLocatorV1,
  type TrackManifestArtifactV1,
  type TrackManifestArtifactV2,
  type TrackManifestV2,
} from '@waypoint/genome-data';

import { platform } from '../../../platform';
import type { AlignmentReferenceIdentity } from '../alignment-header-client';
import { chooseLocalCramReferenceThroughPicker } from '../attach-aligned-read-request';
import { importGenomeSources } from '../import-genome-sources';
import { basenameForPath, stableSourceHash } from '../read-pileup-import';
import {
  buildExperimentalHybridPileupDataset,
  createSignalReadPileupViewState,
} from '../experimental-hybrid-pileup';
import { useLaneContractStore } from '../lane-contract-store';
import type { BamTrackImportController } from './useBamTrackImport';
import type {
  IndexedTrackImportController,
  IndexedTrackImportNotice,
} from './useIndexedTrackImport';

const LOCAL_TEXT_INTERVAL_FORMAT_IDS = new Set([
  'bed',
  'gff3',
  'gtf',
  'genepred',
  'refflat',
  'narrowpeak',
  'broadpeak',
]);
const SUPPORTED_FORMAT_IDS = new Set([
  'bam',
  'cram',
  'bigbed',
  'bigwig',
  ...LOCAL_TEXT_INTERVAL_FORMAT_IDS,
]);
const DEFERRED_FORMAT_NAMES: Readonly<Record<string, string>> = {
  bcf: 'BCF',
  fasta: 'FASTA',
  genbank: 'GenBank',
  vcf: 'VCF',
};
const SESSION_FILE_EXTENSIONS = new Set(['xml', 'session', 'txt', 'ucsc', 'ct', 'tracks']);
const SESSION_DETECTION_HEAD_CHARS = 8192;

type DirectTrackSource =
  | Readonly<{ kind: 'path'; path: string }>
  | Readonly<{ kind: 'url'; url: string }>;

interface ImportCandidate {
  readonly source: DirectTrackSource;
  readonly ingress: Extract<TrackAdmissionIngressV1, { kind: 'file-picker' | 'manifest' }>;
}

interface SessionImport {
  readonly sessionId: string;
  readonly decoded: DecodedGenomeSessionFile;
  readonly requests: ReadonlyArray<TrackAdmissionRequestV1>;
  readonly skipped: ReadonlyArray<string>;
}

interface ResolvedManifestV2Artifact {
  readonly artifact: TrackManifestArtifactV2;
  readonly source: DirectTrackSource;
  readonly index?: DirectTrackSource;
  readonly reference?: DirectTrackSource;
}

interface ManifestV2Import {
  readonly manifestId: string;
  readonly manifest: TrackManifestV2;
  readonly artifacts: ReadonlyArray<ResolvedManifestV2Artifact>;
}

export interface DataFileImportController {
  readonly notice: IndexedTrackImportNotice | null;
  readonly clearNotice: () => void;
  readonly openFiles: () => Promise<void>;
  readonly importPaths: (paths: ReadonlyArray<string>) => Promise<void>;
}

export function useDataFileImport(input: {
  readonly assemblyId: string;
  readonly assemblyDisplayName: string;
  readonly bamImport: BamTrackImportController;
  readonly indexedImport: IndexedTrackImportController;
  readonly laneOwnerId?: string;
  readonly assemblyReferences?: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly assemblyUcscGenomeId?: string | null;
  readonly importSources?: typeof importGenomeSources;
}): DataFileImportController {
  const registry = useMemo(() => createDefaultFormatRegistry(), []);
  const [notice, setNotice] = useState<IndexedTrackImportNotice | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);

  const importPaths = useCallback(
    async (paths: ReadonlyArray<string>): Promise<void> => {
      if (paths.length === 0) return;
      const candidates: ImportCandidate[] = [];
      const manifestNames: string[] = [];
      const manifestErrors: string[] = [];
      const manifestV2Imports: ManifestV2Import[] = [];
      const sessions: SessionImport[] = [];
      for (const path of paths) {
        if (isTrackManifestPath(path)) {
          try {
            const { text } = await platform().fs.readTextFileSlice(
              path,
              TRACK_MANIFEST_MAX_BYTES + 1
            );
            const manifest = decodeTrackManifest(text, input.assemblyId);
            const manifestStat = await platform().fs.stat(path);
            const manifestId = basenameForPath(path);
            if (manifest.contract === 'dnaforge.track-manifest.v2') {
              const artifacts = await Promise.all(
                manifest.artifacts.map((artifact) =>
                  resolveManifestV2Artifact(path, manifestStat.canonicalPath, artifact)
                )
              );
              manifestV2Imports.push({
                manifestId,
                manifest,
                artifacts,
              });
            } else {
              const resolvedArtifacts = await Promise.all(
                manifest.artifacts.map((artifact) =>
                  resolveManifestArtifact(path, manifestStat.canonicalPath, artifact)
                )
              );
              candidates.push(
                ...resolvedArtifacts.map((source) => ({
                  source,
                  ingress: { kind: 'manifest' as const, manifestId },
                }))
              );
            }
            manifestNames.push(manifestId);
          } catch (error) {
            manifestErrors.push(
              `${basenameForPath(path)}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          continue;
        }
        if (isSessionCandidatePath(path)) {
          try {
            const session = await readSessionFile(path, input.assemblyId);
            if (session) {
              sessions.push(session);
              continue;
            }
          } catch (error) {
            manifestErrors.push(
              `${basenameForPath(path)}: ${error instanceof Error ? error.message : String(error)}`
            );
            continue;
          }
        }
        candidates.push({ source: { kind: 'path', path }, ingress: { kind: 'file-picker' } });
      }
      const alignedReadRequests: TrackAdmissionRequestV1[] = [];
      const indexedRequests: TrackAdmissionRequestV1[] = [];
      const unsupported: string[] = [];
      const seenSources = new Set<string>();

      for (const candidate of candidates) {
        const { source } = candidate;
        const identity =
          source.kind === 'path' ? `path\u0000${source.path}` : `url\u0000${source.url}`;
        if (seenSources.has(identity)) continue;
        seenSources.add(identity);
        const handler = registry.detect(source);
        if (handler?.id === 'bam' || handler?.id === 'cram') {
          alignedReadRequests.push(
            directTrackAdmissionRequest({
              assemblyId: input.assemblyId,
              input: source,
              formatId: handler.id,
              scientificKind: 'reads',
              ingress: candidate.ingress.kind,
              ...(candidate.ingress.kind === 'manifest'
                ? { manifestId: candidate.ingress.manifestId }
                : {}),
            })
          );
        } else if (
          handler &&
          (handler.id === 'bigwig' ||
            handler.id === 'bigbed' ||
            (source.kind === 'path' && LOCAL_TEXT_INTERVAL_FORMAT_IDS.has(handler.id)))
        ) {
          indexedRequests.push(
            directTrackAdmissionRequest({
              assemblyId: input.assemblyId,
              input: source,
              formatId: handler.id,
              ingress: candidate.ingress.kind,
              ...(candidate.ingress.kind === 'manifest'
                ? { manifestId: candidate.ingress.manifestId }
                : {}),
            })
          );
        } else {
          const locator = source.kind === 'path' ? source.path : source.url;
          unsupported.push(unsupportedFileMessage(locator, handler));
        }
      }

      if (alignedReadRequests.length > 0) {
        await input.bamImport.addRequests(alignedReadRequests);
      }
      const indexedOutcomes =
        indexedRequests.length > 0 ? await input.indexedImport.addRequests(indexedRequests) : [];
      const indexedFailures = indexedOutcomes
        .filter((outcome) => outcome.status === 'error')
        .map((outcome) => `${outcome.label}: ${outcome.message}`);
      const attachedIndexedCount = indexedOutcomes.length - indexedFailures.length;

      let attachedManifestV2SourceCount = 0;
      let attachedManifestV2ViewCount = 0;
      const manifestV2Failures: string[] = [];
      for (const manifestImport of manifestV2Imports) {
        const imported = await importManifestV2(manifestImport);
        attachedManifestV2SourceCount += imported.attachedSourceCount;
        attachedManifestV2ViewCount += imported.attachedViewCount;
        manifestV2Failures.push(...imported.failures);
      }

      const sessionNotices: IndexedTrackImportNotice[] = [];
      for (const session of sessions) {
        sessionNotices.push(await importSession(session));
      }

      const manifestSuccessText =
        manifestNames.length === 0
          ? null
          : attachedManifestV2ViewCount > 0
            ? `Attached outputs and ${attachedManifestV2ViewCount} signal-to-reads ${attachedManifestV2ViewCount === 1 ? 'view' : 'views'} from ${manifestNames.join(', ')}.`
            : `Attached outputs from ${manifestNames.join(', ')}.`;
      if (manifestErrors.length > 0) {
        setNotice({
          kind: 'error',
          text: [
            ...manifestErrors,
            ...manifestV2Failures,
            ...indexedFailures,
            ...sessionNotices.map((n) => n.text),
          ].join(' '),
        });
      } else if (
        unsupported.length > 0 ||
        indexedFailures.length > 0 ||
        manifestV2Failures.length > 0
      ) {
        const anythingAttached =
          alignedReadRequests.length > 0 ||
          attachedIndexedCount > 0 ||
          attachedManifestV2SourceCount > 0 ||
          attachedManifestV2ViewCount > 0;
        setNotice({
          kind:
            !anythingAttached && (indexedFailures.length > 0 || manifestV2Failures.length > 0)
              ? 'error'
              : 'warn',
          text: [
            ...(attachedManifestV2ViewCount > 0 && manifestSuccessText
              ? [manifestSuccessText]
              : []),
            `Not attached: ${[...unsupported, ...indexedFailures, ...manifestV2Failures].join(
              manifestV2Failures.length > 0 ? '; ' : ', '
            )}.`,
            ...sessionNotices.map((n) => n.text),
          ].join(' '),
        });
      } else if (sessionNotices.length > 0) {
        setNotice({
          kind: sessionNotices.some((n) => n.kind === 'error')
            ? 'error'
            : sessionNotices.some((n) => n.kind === 'warn')
              ? 'warn'
              : 'success',
          text: [
            ...(manifestSuccessText ? [manifestSuccessText] : []),
            ...sessionNotices.map((n) => n.text),
          ].join(' '),
        });
      } else if (manifestSuccessText) {
        setNotice({
          kind: 'success',
          text: manifestSuccessText,
        });
      }

      async function importManifestV2(manifestImport: ManifestV2Import): Promise<{
        readonly attachedSourceCount: number;
        readonly attachedViewCount: number;
        readonly failures: ReadonlyArray<string>;
      }> {
        if (!input.laneOwnerId) {
          return {
            attachedSourceCount: 0,
            attachedViewCount: 0,
            failures: [
              `${manifestImport.manifestId} cannot be imported without an open track view`,
            ],
          };
        }

        const failures: string[] = [];
        const requestEntries: Array<{
          readonly artifact: TrackManifestArtifactV2;
          readonly request: TrackAdmissionRequestV1;
        }> = [];
        for (const resolved of manifestImport.artifacts) {
          const handler = registry.findById(resolved.artifact.formatId);
          const isReads =
            resolved.artifact.scientificKind === 'reads' &&
            (handler?.id === 'bam' || handler?.id === 'cram');
          const isSupportedData =
            (handler?.id === 'bigwig' && resolved.artifact.scientificKind === 'quantitative') ||
            handler?.id === 'bigbed' ||
            (resolved.source.kind === 'path' &&
              Boolean(handler && LOCAL_TEXT_INTERVAL_FORMAT_IDS.has(handler.id)));
          if (!handler || (!isReads && !isSupportedData)) {
            const locator =
              resolved.source.kind === 'path' ? resolved.source.path : resolved.source.url;
            failures.push(
              `${manifestImport.manifestId} artifact ${resolved.artifact.id}: ${unsupportedFileMessage(locator, handler)}`
            );
            continue;
          }
          requestEntries.push({
            artifact: resolved.artifact,
            request: directTrackAdmissionRequest({
              assemblyId: input.assemblyId,
              input: resolved.source,
              ...(resolved.index ? { index: resolved.index } : {}),
              ...(resolved.reference ? { reference: resolved.reference } : {}),
              formatId: handler.id,
              scientificKind: resolved.artifact.scientificKind,
              ...(resolved.artifact.label ? { label: resolved.artifact.label } : {}),
              ingress: 'manifest',
              manifestId: manifestImport.manifestId,
            }),
          });
        }

        if (requestEntries.length === 0) {
          return { attachedSourceCount: 0, attachedViewCount: 0, failures };
        }
        const outcomes = await (input.importSources ?? importGenomeSources)({
          laneOwnerId: input.laneOwnerId,
          assemblyId: input.assemblyId,
          assemblyDisplayName: input.assemblyDisplayName,
          assemblyReferences: input.assemblyReferences ?? [],
          requests: requestEntries.map((entry) => entry.request),
          resolveLocalCramReference: chooseLocalCramReferenceThroughPicker,
          localAuthorityContext: 'workspace-grounded',
        });
        const trackIdByArtifactId = new Map<string, string>();
        let attachedSourceCount = 0;
        for (const [index, entry] of requestEntries.entries()) {
          const outcome = outcomes[index];
          if (!outcome) {
            failures.push(
              `${manifestImport.manifestId} artifact ${entry.artifact.id}: import returned no outcome`
            );
            continue;
          }
          if (outcome.status === 'failed') {
            failures.push(
              `${manifestImport.manifestId} artifact ${entry.artifact.id}: ${outcome.message}`
            );
            continue;
          }
          attachedSourceCount += 1;
          trackIdByArtifactId.set(entry.artifact.id, outcome.trackId);
        }

        let attachedViewCount = 0;
        for (const view of manifestImport.manifest.views) {
          const readsTrackId = trackIdByArtifactId.get(view.reads);
          const signalTrackId = trackIdByArtifactId.get(view.signal);
          if (!readsTrackId || !signalTrackId) {
            failures.push(
              `${manifestImport.manifestId} view ${view.id}: one or more declared source artifacts did not attach`
            );
            continue;
          }
          const lanes = useLaneContractStore.getState().lanesForOwner(input.laneOwnerId);
          const readsLane = lanes.find((lane) => lane.dataset.trackId === readsTrackId);
          const signalLane = lanes.find((lane) => lane.dataset.trackId === signalTrackId);
          if (readsLane?.dataset.kind !== 'pileup' || !readsLane.dataset.source) {
            failures.push(
              `${manifestImport.manifestId} view ${view.id}: artifact ${view.reads} is not an admitted BAM or CRAM read pileup`
            );
            continue;
          }
          if (signalLane?.dataset.trackType !== 'quantitative') {
            failures.push(
              `${manifestImport.manifestId} view ${view.id}: artifact ${view.signal} is not an admitted quantitative signal`
            );
            continue;
          }
          const viewState = createSignalReadPileupViewState({
            assemblyId: input.assemblyId,
            alignment: readsLane.dataset,
            signal: signalLane.dataset,
            trackId: `signal-read-${input.assemblyId}-${stableSourceHash(
              [view.id, readsTrackId, signalTrackId].join('\u0000')
            )}`,
            label: view.label,
            order: Math.max(-1, ...lanes.map((lane) => lane.order)) + 1,
            presentation: view.presentation,
          });
          const status = useLaneContractStore.getState().addLane(
            input.laneOwnerId,
            input.assemblyId,
            buildExperimentalHybridPileupDataset({
              alignment: readsLane.dataset,
              signal: signalLane.dataset,
              view: viewState,
            }),
            viewState.visible,
            undefined,
            viewState.order,
            'skip'
          );
          if (status === 'added' || status === 'duplicate') attachedViewCount += 1;
          if (view.showSourceTracks !== true) {
            const store = useLaneContractStore.getState();
            store.setLaneVisible(input.laneOwnerId, readsTrackId, false);
            store.setLaneVisible(input.laneOwnerId, signalTrackId, false);
          }
        }
        return { attachedSourceCount, attachedViewCount, failures };
      }

      async function importSession(session: SessionImport): Promise<IndexedTrackImportNotice> {
        const parts: string[] = [];
        const { decoded } = session;
        if (
          decoded.genome &&
          input.assemblyUcscGenomeId &&
          decoded.genome !== input.assemblyUcscGenomeId
        ) {
          parts.push(
            `${session.sessionId} was saved for ${decoded.genome}; the open reference is ${input.assemblyUcscGenomeId}.`
          );
        }
        let kind: IndexedTrackImportNotice['kind'] = 'success';
        if (session.requests.length === 0) {
          parts.push(`${session.sessionId} names no source DNAForge can attach.`);
          kind = 'error';
        } else if (!input.laneOwnerId) {
          parts.push(`${session.sessionId} cannot be imported without an open track view.`);
          kind = 'error';
        } else {
          const outcomes = await (input.importSources ?? importGenomeSources)({
            laneOwnerId: input.laneOwnerId,
            assemblyId: input.assemblyId,
            assemblyDisplayName: input.assemblyDisplayName,
            assemblyReferences: input.assemblyReferences ?? [],
            requests: session.requests,
            resolveLocalCramReference: chooseLocalCramReferenceThroughPicker,
            localAuthorityContext: 'workspace-grounded',
          });
          const added = outcomes.filter((outcome) => outcome.status === 'added').length;
          const duplicates = outcomes.filter((outcome) => outcome.status === 'duplicate').length;
          const failures = outcomes.flatMap((outcome) =>
            outcome.status === 'failed' ? [`${outcome.label}: ${outcome.message}`] : []
          );
          parts.push(
            `Attached ${added} of ${outcomes.length} ${outcomes.length === 1 ? 'source' : 'sources'} from ${session.sessionId}.`
          );
          if (duplicates > 0) {
            parts.push(`${duplicates} already ${duplicates === 1 ? 'was' : 'were'} on this view.`);
          }
          if (failures.length > 0) parts.push(`Not attached: ${failures.join('; ')}.`);
          kind = added === 0 ? 'error' : failures.length > 0 ? 'warn' : 'success';
        }
        if (session.skipped.length > 0) {
          parts.push(`Skipped: ${session.skipped.join('; ')}.`);
          if (kind === 'success') kind = 'warn';
        }
        if (decoded.locus) parts.push(`Session locus ${formatLocus(decoded.locus)}.`);
        return { kind, text: parts.join(' ') };
      }
    },
    [input, registry]
  );

  const openFiles = useCallback(async () => {
    clearNotice();
    input.bamImport.clearNotice();
    input.indexedImport.clearNotice();
    let selection: string | string[] | null;
    try {
      selection = await platform().dialog.open({
        multiple: true,
        title: `Add data to ${input.assemblyDisplayName}`,
        filters: [
          {
            name: 'Genomic data, DNAForge track manifest, or browser session',
            extensions: [
              'bam',
              'cram',
              'bb',
              'bigBed',
              'bigbed',
              'bw',
              'bigWig',
              'bigwig',
              'bed',
              'gff',
              'gff3',
              'gtf',
              'genePred',
              'genepred',
              'refFlat',
              'refflat',
              'narrowPeak',
              'narrowpeak',
              'broadPeak',
              'broadpeak',
              'gz',
              'bgz',
              'json',
              'xml',
              'txt',
            ],
          },
          { name: 'All files', extensions: ['*'] },
        ],
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!selection) return;
    const paths = Array.isArray(selection) ? selection : [selection];
    await importPaths(paths);
  }, [clearNotice, importPaths, input]);

  return { notice, clearNotice, openFiles, importPaths };
}

function isTrackManifestPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.dnaforge-track.json') || lower.endsWith('.dnaforge-tracks.json');
}

function isSessionCandidatePath(path: string): boolean {
  const extension = basenameForPath(path).toLowerCase().split('.').pop() ?? '';
  return SESSION_FILE_EXTENSIONS.has(extension);
}

async function readSessionFile(path: string, assemblyId: string): Promise<SessionImport | null> {
  let text: string;
  try {
    text = (await platform().fs.readTextFileSlice(path, GENOME_SESSION_FILE_MAX_BYTES + 1)).text;
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  const kind = detectGenomeSessionFileKind(
    basenameForPath(path),
    text.slice(0, SESSION_DETECTION_HEAD_CHARS)
  );
  if (!kind) return null;
  const decoded = decodeGenomeSessionFile(kind, text);
  const sessionId = basenameForPath(path);
  const sessionStat = await platform().fs.stat(path);
  const requests: TrackAdmissionRequestV1[] = [];
  const skipped = decoded.skipped.map((skip) => `${skip.subject} (${skip.reason})`);
  for (const resource of decoded.resources) {
    const subject = resource.label ?? locatorSubject(resource.source);
    try {
      const source = await resolveSessionLocator(path, sessionStat.canonicalPath, resource.source);
      const index = resource.index
        ? await resolveSessionLocator(path, sessionStat.canonicalPath, resource.index)
        : undefined;
      requests.push(
        parseTrackAdmissionRequestV1({
          contract: TRACK_ADMISSION_REQUEST_V1,
          assemblyId,
          source,
          ...(index ? { index } : {}),
          ...(resource.formatId ? { formatId: resource.formatId } : {}),
          ...(resource.label ? { label: resource.label } : {}),
          ingress: { kind: 'session', sessionId },
        })
      );
    } catch (error) {
      skipped.push(`${subject} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return { sessionId, decoded, requests, skipped };
}

async function resolveSessionLocator(
  sessionPath: string,
  canonicalSessionPath: string,
  locator: GenomeSessionResourceLocator
): Promise<TrackAssetLocatorV1> {
  switch (locator.kind) {
    case 'url':
      return { kind: 'http', url: locator.url };
    case 's3':
      return { kind: 's3', bucket: locator.bucket, key: locator.key };
    case 'gcs':
      return { kind: 'gcs', bucket: locator.bucket, object: locator.object };
    default: {
      const resolvedPath = locator.relative
        ? joinBesideFile(sessionPath, locator.path)
        : locator.path;
      const stat = await platform().fs.stat(resolvedPath);
      if (!stat.isFile) throw new Error(`${locator.path} is not a regular file`);
      if (isCanonicalChild(canonicalSessionPath, stat.canonicalPath)) {
        const authority = await platform().dialog.authorizeLocalIndexedTrack({
          path: stat.canonicalPath,
          relatedManifestPath: canonicalSessionPath,
        });
        return { kind: 'local-file', path: authority.canonicalPath };
      }
      return { kind: 'local-file', path: stat.canonicalPath };
    }
  }
}

function locatorSubject(locator: GenomeSessionResourceLocator): string {
  switch (locator.kind) {
    case 'url':
      return basenameForPath(locator.url);
    case 's3':
      return `s3://${locator.bucket}/${locator.key}`;
    case 'gcs':
      return `gs://${locator.bucket}/${locator.object}`;
    default:
      return basenameForPath(locator.path);
  }
}

function formatLocus(locus: GenomeSessionLocus): string {
  if (locus.start0 === undefined || locus.end0 === undefined) return locus.chrom;
  return `${locus.chrom}:${(locus.start0 + 1).toLocaleString('en-US')}-${locus.end0.toLocaleString('en-US')}`;
}

async function resolveManifestArtifact(
  manifestPath: string,
  canonicalManifestPath: string,
  artifact: TrackManifestArtifactV1
): Promise<{ kind: 'path'; path: string } | { kind: 'url'; url: string }> {
  if (artifact.url) return { kind: 'url', url: artifact.url };
  const resolvedPath = joinBesideFile(manifestPath, artifact.path as string);
  const artifactStat = await platform().fs.stat(resolvedPath);
  if (!artifactStat.isFile) throw new Error(`${artifact.path} is not a regular file.`);
  if (!isCanonicalChild(canonicalManifestPath, artifactStat.canonicalPath)) {
    throw new Error(`${artifact.path} resolves outside the manifest directory.`);
  }
  const authority = await platform().dialog.authorizeLocalIndexedTrack({
    path: artifactStat.canonicalPath,
    relatedManifestPath: canonicalManifestPath,
  });
  return { kind: 'path', path: authority.canonicalPath };
}

async function resolveManifestV2Artifact(
  manifestPath: string,
  canonicalManifestPath: string,
  artifact: TrackManifestArtifactV2
): Promise<ResolvedManifestV2Artifact> {
  const source = await resolveManifestArtifact(manifestPath, canonicalManifestPath, {
    ...(artifact.path ? { path: artifact.path } : { url: artifact.url as string }),
  });
  const index = artifact.indexPath
    ? await resolveManifestArtifact(manifestPath, canonicalManifestPath, {
        path: artifact.indexPath,
      })
    : artifact.indexUrl
      ? await resolveManifestArtifact(manifestPath, canonicalManifestPath, {
          url: artifact.indexUrl,
        })
      : undefined;
  const reference = artifact.referencePath
    ? await resolveManifestArtifact(manifestPath, canonicalManifestPath, {
        path: artifact.referencePath,
      })
    : artifact.referenceUrl
      ? await resolveManifestArtifact(manifestPath, canonicalManifestPath, {
          url: artifact.referenceUrl,
        })
      : undefined;
  return {
    artifact,
    source,
    ...(index ? { index } : {}),
    ...(reference ? { reference } : {}),
  };
}

function joinBesideFile(filePath: string, relativePath: string): string {
  const separator = filePath.includes('\\') && !filePath.includes('/') ? '\\' : '/';
  const normalizedFile = filePath.replace(/[\\/]+$/, '');
  const lastSeparator = Math.max(normalizedFile.lastIndexOf('/'), normalizedFile.lastIndexOf('\\'));
  const directory = lastSeparator >= 0 ? normalizedFile.slice(0, lastSeparator) : '.';
  return `${directory}${separator}${relativePath.replace(/[\\/]/g, separator)}`;
}

function isCanonicalChild(canonicalManifestPath: string, canonicalArtifactPath: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const manifest = normalize(canonicalManifestPath);
  const lastSeparator = manifest.lastIndexOf('/');
  const directory = lastSeparator >= 0 ? manifest.slice(0, lastSeparator) : '.';
  const candidate = normalize(canonicalArtifactPath);
  const windowsStyle = /^[A-Za-z]:\//.test(directory);
  const comparableDirectory = windowsStyle ? directory.toLocaleLowerCase('en-US') : directory;
  const comparableCandidate = windowsStyle ? candidate.toLocaleLowerCase('en-US') : candidate;
  return comparableCandidate.startsWith(`${comparableDirectory}/`);
}

function unsupportedFileMessage(path: string, handler: FormatHandler | null): string {
  const name = basenameForPath(path);
  if (!handler) return `${name} (unsupported file type)`;
  if (SUPPORTED_FORMAT_IDS.has(handler.id)) return name;
  const formatName = DEFERRED_FORMAT_NAMES[handler.id] ?? handler.id.toUpperCase();
  return `${name} (${formatName} viewing is not available yet)`;
}
