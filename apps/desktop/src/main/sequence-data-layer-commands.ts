import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  createGenomicLayerOperation,
  prepareSequenceDataLayer,
  reduceGenomicLayerOperation,
  type GenomicLayerInputPins,
  type GenomicLayerOperationEvent,
  type GenomicLayerOperationState,
  type GenomicLayerPublicationRequest,
  type SequenceDataLayerTarget,
} from '@waypoint/genome-data';
import { SCIENTIFIC_COLOR_PALETTES } from '@waypoint/sequence-utils';
import { canonicalJson } from '../shared/canonical-json';
import {
  MAX_SEQUENCE_DATA_LAYER_CSV_BYTES,
  MAX_SEQUENCE_DATA_LAYER_DOCUMENT_BYTES,
  SEQUENCE_DATA_LAYER_DIRECTORY,
  SEQUENCE_DATA_LAYER_SCHEMA,
  SEQUENCE_DATA_LAYER_SUFFIX,
  parseSequenceDataLayerDocument,
  sequenceDataLayerCommandSchema,
  sequenceDataLayerIdSchema,
  sequenceDataLayerInputIdentity,
  serializeSequenceDataLayerDocument,
  type PublishedSequenceDataLayer,
  type SequenceDataLayerAvailability,
  type SequenceDataLayerCommandResult,
  type SequenceDataLayerCreateRequest,
  type SequenceDataLayerDocument,
  type SequenceDataLayerFailure,
  type SequenceDataLayerPresentation,
  type SequenceDataLayerTargetSnapshot,
} from '../shared/sequence-data-layer';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import {
  canonicalWorkspacePath,
  WorkspaceFilePreconditionError,
  writeWorkspaceTextFileAtomicInMain,
} from './primer-artifact-files';
import type {
  WorkspaceTextFileAtomicWriteInput,
  WorkspaceTextFileAtomicWriteResult,
} from '../shared/workspace-file-atomic';

interface Dependencies {
  resolveProject(project: string): Promise<string>;
  capture(root: string, mutating: boolean): (() => void) | Promise<() => void>;
  assertWritable(root: string, path: string): Promise<void>;
  resolveTarget(documentId: string, root: string): Promise<SequenceDataLayerTargetSnapshot>;
  publish?(
    input: WorkspaceTextFileAtomicWriteInput,
    assertCurrent: () => void
  ): Promise<WorkspaceTextFileAtomicWriteResult>;
  onState?(state: GenomicLayerOperationState): void;
  now?(): string;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function layerId(root: string, requestId: string): string {
  return `layer-${createHash('sha256').update(`${root}\0${requestId}`).digest('hex')}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function failure(
  disposition: SequenceDataLayerFailure['disposition'],
  error: unknown,
  requestId?: string,
  id?: string
): SequenceDataLayerFailure {
  return {
    status: 'failed',
    disposition,
    message: message(error),
    ...(requestId ? { requestId } : {}),
    ...(id ? { id } : {}),
  };
}

function pinnedTarget(
  snapshot: SequenceDataLayerTargetSnapshot,
  annotation: boolean
): SequenceDataLayerTarget {
  return {
    documentId: snapshot.documentId,
    sequenceFingerprint: snapshot.sequenceFingerprint,
    length: snapshot.length,
    ...(annotation ? { annotationFingerprint: snapshot.annotationFingerprint } : {}),
  };
}

function defaultPresentation(
  document: Pick<SequenceDataLayerDocument, 'dataset'>,
  annotationColors: boolean
): SequenceDataLayerPresentation {
  const sample = document.dataset.samples[0];
  if (!sample) throw new Error('A layer needs a measured sample.');
  const values = sample.observations.flatMap((row) => (row.value === null ? [] : [row.value]));
  let low = values.length ? Math.min(...values) : 0;
  let high = values.length ? Math.max(...values) : 1;
  if (low === high) {
    if (low === 0) {
      low = -1;
      high = 1;
    } else if (low > 0) low /= 2;
    else high /= 2;
  }
  return {
    sampleId: sample.id,
    annotationColors,
    signalVisible: true,
    style: {
      geometry: 'bars',
      colorScale: {
        kind: 'continuous',
        domain: [low, high],
        colors: [...SCIENTIFIC_COLOR_PALETTES.viridis.colors],
        missingColor: '#cbd5e1',
        transform: 'linear',
      },
    },
  };
}

function identity(
  document: Pick<
    SequenceDataLayerDocument,
    | 'label'
    | 'unit'
    | 'target'
    | 'source'
    | 'mapping'
    | 'valueColumns'
    | 'unresolvedPolicy'
    | 'aggregation'
    | 'creationRequest'
  >
): string {
  return digest(
    sequenceDataLayerInputIdentity({
      label: document.label,
      unit: document.unit,
      target: document.target,
      sourceSha256: document.source.sha256,
      ...(document.source.origin ? { sourceOrigin: document.source.origin } : {}),
      mapping: document.mapping,
      valueColumns: document.valueColumns,
      unresolvedPolicy: document.unresolvedPolicy,
      aggregation: document.aggregation,
      requestedPresentation: document.creationRequest.requestedPresentation,
    })
  );
}

export class SequenceDataLayerCommands {
  private readonly inflight = new Map<
    string,
    { inputHash: string; promise: Promise<SequenceDataLayerCommandResult> }
  >();
  private readonly generation = randomUUID();

  constructor(private readonly dependencies: Dependencies) {}

  async run(
    input: unknown,
    options: { signal?: AbortSignal } = {}
  ): Promise<SequenceDataLayerCommandResult> {
    try {
      return await this.execute(input, options);
    } catch (error) {
      const request = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      if (
        request.operation === 'target' ||
        request.operation === 'inspect' ||
        request.operation === 'list'
      )
        throw error;
      const requestId =
        typeof request.requestId === 'string' && request.requestId.length <= 512
          ? request.requestId.trim()
          : undefined;
      return failure('not-published', error, requestId);
    }
  }

  private async execute(
    input: unknown,
    options: { signal?: AbortSignal }
  ): Promise<SequenceDataLayerCommandResult> {
    const request = sequenceDataLayerCommandSchema.parse(input);
    const root = await this.dependencies.resolveProject(request.project);
    if (!isAbsolute(root))
      throw new Error('The owning project must have an absolute canonical root.');
    const assertCurrent = await this.dependencies.capture(root, request.operation === 'create');
    assertCurrent();
    if (request.operation === 'target') {
      const snapshot = await this.dependencies.resolveTarget(request.targetDocumentId, root);
      assertCurrent();
      if (snapshot.documentId !== request.targetDocumentId)
        throw new Error('The target identity changed.');
      return {
        status: 'target',
        target: pinnedTarget(snapshot, Boolean(snapshot.annotationFingerprint)),
        annotationIdentifiers: (['id', 'locus_tag', 'ID'] as const).map((field) => {
          const values =
            snapshot.annotations?.flatMap((annotation) =>
              field === 'id' ? [annotation.id] : [...(annotation.qualifiers?.[field] ?? [])]
            ) ?? [];
          return { field, count: values.length, distinct: new Set(values).size };
        }),
      };
    }
    if (request.operation === 'inspect') {
      const result = await this.read(root, request.id);
      const published = await this.published(root, result, true);
      assertCurrent();
      return published;
    }
    if (request.operation === 'list') {
      const directory = join(root, SEQUENCE_DATA_LAYER_DIRECTORY);
      const layers: PublishedSequenceDataLayer[] = [];
      const errors: { id: string; message: string }[] = [];
      let entries: string[];
      try {
        await canonicalWorkspacePath({ workspaceRoot: root, path: directory });
        entries = (await readdir(directory))
          .filter((name) => name.endsWith(SEQUENCE_DATA_LAYER_SUFFIX))
          .sort();
      } catch (error) {
        if (!fileMissing(error)) throw error;
        return { status: 'listed', layers, errors };
      }
      if (entries.length > 1000) throw new Error('Narrow the layer collection before listing it.');
      for (const entry of entries) {
        const id = entry.slice(0, -SEQUENCE_DATA_LAYER_SUFFIX.length);
        try {
          const result = await this.read(root, id);
          assertCurrent();
          if (
            !request.targetDocumentId ||
            result.document.target.documentId === request.targetDocumentId
          ) {
            layers.push(await this.published(root, result, true));
          }
        } catch (error) {
          errors.push({ id, message: message(error) });
        }
      }
      assertCurrent();
      return { status: 'listed', layers, errors };
    }
    const id = layerId(root, request.requestId);
    const path = join(root, SEQUENCE_DATA_LAYER_DIRECTORY, `${id}${SEQUENCE_DATA_LAYER_SUFFIX}`);
    await this.dependencies.assertWritable(root, path);
    assertCurrent();
    const retained = await this.readSource(root, id, request, assertCurrent);
    const source = retained.source;
    const assertPublicationCurrent = () => {
      assertCurrent();
      retained.assertCurrent();
    };
    assertPublicationCurrent();
    const target: Omit<SequenceDataLayerTarget, 'length'> = {
      documentId: request.targetDocumentId,
      sequenceFingerprint: request.expectedSequenceFingerprint,
      ...(request.mapping.kind === 'annotation'
        ? { annotationFingerprint: request.expectedAnnotationFingerprint }
        : {}),
    };
    const inputHash = digest(
      canonicalJson({
        ...request,
        project: root,
        csv: {
          kind: 'snapshot',
          sha256: source.sha256,
          ...(source.origin ? { origin: source.origin } : {}),
        },
      })
    );
    const key = `${root}\0${request.requestId}`;
    const active = this.inflight.get(key);
    if (active) {
      if (active.inputHash !== inputHash)
        throw new Error('The layer request ID conflicts with different inputs.');
      return active.promise;
    }
    const promise = this.create(
      root,
      path,
      id,
      request,
      source,
      target,
      assertPublicationCurrent,
      options.signal
    );
    this.inflight.set(key, { inputHash, promise });
    try {
      return await promise;
    } finally {
      if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
    }
  }

  private async readSource(
    root: string,
    id: string,
    request: SequenceDataLayerCreateRequest,
    assertTargetCurrent: () => void
  ): Promise<{ source: SequenceDataLayerDocument['source']; assertCurrent: () => void }> {
    if (request.csv.kind !== 'layer') {
      const csv = await this.readCsv(root, request.csv);
      return {
        source: { kind: 'csv-snapshot', csv, sha256: digest(csv) },
        assertCurrent: () => {},
      };
    }
    const reference = request.csv.source;
    let existing: Awaited<ReturnType<SequenceDataLayerCommands['read']>> | undefined;
    try {
      existing = await this.read(root, id);
    } catch (error) {
      if (!fileMissing(error)) throw error;
    }
    if (existing) {
      if (canonicalJson(existing.document.source.origin ?? null) !== canonicalJson(reference))
        throw new Error('The layer request ID conflicts with a different dataset source.');
      return { source: existing.document.source, assertCurrent: () => {} };
    }
    const sourceRoot = await this.dependencies.resolveProject(reference.project);
    assertTargetCurrent();
    if (!isAbsolute(reference.project) || sourceRoot !== reference.project)
      throw new Error('Use the dataset source project returned by the native layer owner.');
    const assertCurrent = await this.dependencies.capture(sourceRoot, false);
    assertCurrent();
    const retained = await this.read(sourceRoot, reference.id);
    assertCurrent();
    assertTargetCurrent();
    if (retained.revision !== reference.revision)
      throw new Error('The retained dataset revision changed. Inspect its source again.');
    if (
      request.unit !== retained.document.unit ||
      request.valueColumns.some((column) => !retained.document.valueColumns.includes(column))
    )
      throw new Error('Reuse the source measurement columns and units without relabeling them.');
    return {
      source: {
        kind: 'csv-snapshot',
        csv: retained.document.source.csv,
        sha256: retained.document.source.sha256,
        origin: reference,
      },
      assertCurrent,
    };
  }

  private async readCsv(
    root: string,
    csv: Exclude<SequenceDataLayerCreateRequest['csv'], { kind: 'layer' }>
  ): Promise<string> {
    let bytes: Uint8Array;
    if (csv.kind === 'text') bytes = new TextEncoder().encode(csv.text);
    else {
      if (isAbsolute(csv.path))
        throw new Error('Choose a CSV path relative to its owning project.');
      const path = resolve(root, csv.path);
      const inside = relative(root, path);
      if (
        !inside ||
        inside === '..' ||
        inside.startsWith('../') ||
        inside.startsWith('..\\') ||
        isAbsolute(inside)
      ) {
        throw new Error('The CSV must be inside its owning project.');
      }
      await canonicalWorkspacePath({ workspaceRoot: root, path });
      bytes = await readFileBoundedFromHandle(path, MAX_SEQUENCE_DATA_LAYER_CSV_BYTES);
    }
    if (bytes.byteLength > MAX_SEQUENCE_DATA_LAYER_CSV_BYTES)
      throw new Error('The CSV exceeds the bounded layer import size.');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  }

  private async read(
    root: string,
    id: string
  ): Promise<{ document: SequenceDataLayerDocument; path: string; revision: string }> {
    sequenceDataLayerIdSchema.parse(id);
    const path = join(root, SEQUENCE_DATA_LAYER_DIRECTORY, `${id}${SEQUENCE_DATA_LAYER_SUFFIX}`);
    await canonicalWorkspacePath({ workspaceRoot: root, path });
    const bytes = await readFileBoundedFromHandle(path, MAX_SEQUENCE_DATA_LAYER_DOCUMENT_BYTES);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const document = parseSequenceDataLayerDocument(content);
    if (
      document.id !== id ||
      layerId(root, document.creationRequest.id) !== id ||
      digest(document.source.csv) !== document.source.sha256 ||
      identity(document) !== document.creationRequest.inputHash
    ) {
      throw new Error('The saved layer identity or retained source fingerprint does not match.');
    }
    return { document, path, revision: createHash('sha256').update(bytes).digest('hex') };
  }

  private async availability(
    root: string,
    document: SequenceDataLayerDocument
  ): Promise<SequenceDataLayerAvailability> {
    let current: SequenceDataLayerTargetSnapshot;
    try {
      current = await this.dependencies.resolveTarget(document.target.documentId, root);
    } catch (error) {
      return { status: 'unavailable', reason: message(error) };
    }
    if (
      current.documentId !== document.target.documentId ||
      current.sequenceFingerprint !== document.target.sequenceFingerprint ||
      current.length !== document.target.length
    ) {
      return { status: 'stale', reason: 'sequence-changed' };
    }
    if (
      document.mapping.kind === 'annotation' &&
      current.annotationFingerprint !== document.target.annotationFingerprint
    ) {
      return { status: 'stale', reason: 'annotations-changed' };
    }
    return { status: 'current' };
  }

  private async published(
    root: string,
    result: { document: SequenceDataLayerDocument; path: string; revision: string },
    alreadyPublished: boolean,
    warning?: string
  ): Promise<PublishedSequenceDataLayer> {
    return {
      status: 'published',
      project: root,
      ...result,
      alreadyPublished,
      availability: await this.availability(root, result.document),
      ...(warning ? { warning } : {}),
    };
  }

  private async create(
    root: string,
    path: string,
    id: string,
    request: SequenceDataLayerCreateRequest,
    source: SequenceDataLayerDocument['source'],
    expected: Omit<SequenceDataLayerTarget, 'length'>,
    assertCurrent: () => void,
    signal?: AbortSignal
  ): Promise<SequenceDataLayerCommandResult> {
    const csv = source.csv;
    let existing: Awaited<ReturnType<SequenceDataLayerCommands['read']>> | undefined;
    try {
      existing = await this.read(root, id);
    } catch (error) {
      if (!fileMissing(error)) throw error;
    }
    if (existing) {
      const requestedHash = identity({
        ...existing.document,
        label: request.label,
        unit: request.unit,
        target: { ...expected, length: existing.document.target.length },
        source,
        mapping: request.mapping,
        valueColumns: request.valueColumns,
        unresolvedPolicy: request.unresolvedPolicy,
        aggregation: request.aggregation,
        creationRequest: {
          ...existing.document.creationRequest,
          requestedPresentation: request.presentation ?? null,
        },
      });
      if (
        existing.document.creationRequest.id !== request.requestId ||
        existing.document.creationRequest.inputHash !== requestedHash
      ) {
        throw new Error('The layer request ID conflicts with an existing artifact.');
      }
      const published = await this.published(root, existing, true);
      assertCurrent();
      return published;
    }
    const inputs: GenomicLayerInputPins = {
      dataset: { id, fingerprint: digest(csv) },
      target: {
        documentKey: expected.documentId,
        sequenceFingerprint: expected.sequenceFingerprint,
        ...(expected.annotationFingerprint
          ? { annotationFingerprint: expected.annotationFingerprint }
          : {}),
      },
      mappingSpecFingerprint: digest(
        canonicalJson({
          mapping: request.mapping,
          valueColumns: request.valueColumns,
          aggregation: request.aggregation,
          unresolvedPolicy: request.unresolvedPolicy,
        })
      ),
      unresolvedPolicy: request.unresolvedPolicy,
      expectedPublicationRevision: null,
    };
    let state = createGenomicLayerOperation(this.generation);
    const transition = (event: GenomicLayerOperationEvent) => {
      const result = reduceGenomicLayerOperation(state, event);
      if (result.status === 'rejected')
        throw new Error(`Layer operation refused: ${result.reason}`);
      if (result.status === 'ignored')
        throw new Error(`Layer operation became obsolete: ${result.reason}`);
      state = result.state;
      this.dependencies.onState?.(state);
    };
    const attempt = { id: randomUUID(), ownerGeneration: this.generation, inputs };
    transition({ kind: 'start', attempt });
    try {
      const snapshot = await this.dependencies.resolveTarget(expected.documentId, root);
      assertCurrent();
      const annotation = request.mapping.kind === 'annotation';
      const target = pinnedTarget(snapshot, annotation);
      if (
        target.documentId !== expected.documentId ||
        target.sequenceFingerprint !== expected.sequenceFingerprint ||
        (annotation &&
          (!expected.annotationFingerprint ||
            target.annotationFingerprint !== expected.annotationFingerprint))
      ) {
        throw new Error(
          'The target sequence or annotation revision changed. Inspect it and prepare a new mapping.'
        );
      }
      const prepared = prepareSequenceDataLayer({
        datasetId: id,
        label: request.label,
        unit: request.unit,
        csv,
        target,
        mapping: request.mapping,
        valueColumns: request.valueColumns,
        annotations: snapshot.annotations,
        unresolvedPolicy: request.unresolvedPolicy,
        aggregation: request.aggregation,
      });
      if (signal?.aborted) {
        transition({ kind: 'cancel', attempt });
        throw new Error('The layer request was cancelled before publication.');
      }
      if (!prepared.publishable) {
        transition({
          kind: 'needs-input',
          attempt,
          report: {
            counts: prepared.report.counts,
            issues: prepared.report.outcomes
              .filter((row) => row.kind !== 'mapped')
              .map((row) => row.message),
          },
        });
        return { status: 'needs-input', target, prepared };
      }
      const document: SequenceDataLayerDocument = {
        schema: SEQUENCE_DATA_LAYER_SCHEMA,
        id,
        label: request.label,
        unit: request.unit,
        createdAt: this.dependencies.now?.() ?? new Date().toISOString(),
        target,
        annotations: annotation ? [...(snapshot.annotations ?? [])] : [],
        source,
        mapping: request.mapping,
        valueColumns: request.valueColumns,
        unresolvedPolicy: request.unresolvedPolicy,
        aggregation: request.aggregation,
        dataset: prepared.dataset,
        report: prepared.report,
        annotationAggregation: prepared.annotationAggregation,
        presentation: request.presentation ?? defaultPresentation(prepared, annotation),
        creationRequest: {
          id: request.requestId,
          inputHash: '',
          requestedPresentation: request.presentation ?? null,
        },
      };
      const ready = {
        ...document,
        creationRequest: { ...document.creationRequest, inputHash: identity(document) },
      };
      const content = serializeSequenceDataLayerDocument(ready);
      if (Buffer.byteLength(content, 'utf8') > MAX_SEQUENCE_DATA_LAYER_DOCUMENT_BYTES)
        throw new Error('The prepared layer exceeds the bounded document size.');
      const candidate = {
        id: `${id}:prepared`,
        fingerprint: digest(content),
        counts: prepared.report.counts,
      };
      transition({ kind: 'prepared', attempt, candidate });
      const current = await this.dependencies.resolveTarget(expected.documentId, root);
      assertCurrent();
      if (
        current.documentId !== target.documentId ||
        current.sequenceFingerprint !== target.sequenceFingerprint ||
        current.length !== target.length ||
        (annotation && current.annotationFingerprint !== target.annotationFingerprint)
      ) {
        transition({
          kind: 'inputs-changed',
          attempt,
          currentInputs: {
            ...inputs,
            target: {
              documentKey: current.documentId,
              sequenceFingerprint: current.sequenceFingerprint,
              ...(annotation ? { annotationFingerprint: current.annotationFingerprint } : {}),
            },
          },
        });
        throw new Error(
          'The target changed while preparing this layer. No artifact was published.'
        );
      }
      await this.dependencies.assertWritable(root, path);
      assertCurrent();
      if (signal?.aborted) {
        transition({ kind: 'cancel', attempt });
        throw new Error('The layer request was cancelled before publication.');
      }
      const publication: GenomicLayerPublicationRequest = {
        id: request.requestId,
        artifactId: id,
        path,
        candidateId: candidate.id,
        candidateFingerprint: candidate.fingerprint,
        inputs,
      };
      transition({ kind: 'publish', attempt, currentInputs: inputs, request: publication });
      try {
        const write =
          this.dependencies.publish ??
          ((input: WorkspaceTextFileAtomicWriteInput, guard: () => void) =>
            writeWorkspaceTextFileAtomicInMain(input, { durable: true, beforePublish: guard }));
        const result = await write(
          {
            workspaceRoot: root,
            path,
            content,
            mode: 'create',
            artifactNoun: 'sequence data layer',
          },
          assertCurrent
        );
        const saved = await this.read(root, id);
        if (
          saved.revision !== result.contentHash ||
          saved.revision !== candidate.fingerprint.slice('sha256:'.length)
        )
          throw new Error('The published layer does not match its intended artifact.');
        transition({
          kind: 'publication-confirmed',
          request: publication,
          artifact: { artifactId: id, path, revision: saved.revision, request: publication },
        });
        return this.published(root, saved, false, result.cleanupWarning);
      } catch (error) {
        transition({ kind: 'publication-uncertain', request: publication, reason: message(error) });
        try {
          const saved = await this.read(root, id);
          if (saved.revision !== candidate.fingerprint.slice('sha256:'.length)) {
            transition({
              kind: 'publication-reconciled',
              request: publication,
              outcome: {
                kind: 'conflict',
                currentRevision: saved.revision,
                reason: 'The artifact differs from this publication request.',
              },
            });
            throw new Error('The layer destination contains a different publication.');
          }
          transition({
            kind: 'publication-reconciled',
            request: publication,
            outcome: {
              kind: 'committed',
              artifact: { artifactId: id, path, revision: saved.revision, request: publication },
            },
          });
          return this.published(
            root,
            saved,
            false,
            'The layer was published; its write acknowledgment required reconciliation.'
          );
        } catch (reconciliationError) {
          if (fileMissing(reconciliationError) && error instanceof WorkspaceFilePreconditionError) {
            transition({
              kind: 'publication-reconciled',
              request: publication,
              outcome: { kind: 'not-committed', reason: message(error) },
            });
            return failure('not-published', error, request.requestId, id);
          }
          return failure(
            'publication-uncertain',
            `The layer publication could not be confirmed. ${message(error)} Readback: ${message(reconciliationError)}`,
            request.requestId,
            id
          );
        }
      }
    } catch (error) {
      if (state.kind === 'preparing')
        transition({ kind: 'preparation-failed', attempt, reason: message(error) });
      const pending =
        state.kind === 'publishing' ||
        state.kind === 'publication-uncertain' ||
        state.kind === 'published' ||
        (state.kind === 'failed' && state.stage === 'publication');
      return failure(
        pending ? 'publication-uncertain' : 'not-published',
        error,
        request.requestId,
        id
      );
    }
  }
}
