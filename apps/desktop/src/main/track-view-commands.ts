import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  TrackViewCommand,
  TrackViewCommandResult,
  TrackViewSourceInput,
} from '@waypoint/domain-services';
import {
  createIndexedBbiTrackId,
  DEFAULT_QUANTITATIVE_TRACK_PRESENTATION,
  type AdmittedTrackSource,
} from '@waypoint/genome-data';
import {
  validateTrackViewDocument,
  TRACK_VIEW_SCHEMA,
  TRACK_VIEW_SUFFIX,
  type SavedTrackView,
} from '../shared/track-view';
import {
  MAX_INDEXED_SEQUENCE_DATA_LAYER_CONTIG_BASES,
  sequenceDataLayerIndexedTargetId,
} from '../shared/sequence-data-layer-indexed-target';
import { trackViewCommandSchema } from '../shared/track-view-commands';
import type { PreparedReferenceAssemblyEntryV1 } from '../shared/reference-assets-ipc';
import type { TrackViewLibrary } from './track-view-library';

interface Dependencies {
  library: Pick<TrackViewLibrary, 'read' | 'save'>;
  resolveProject(project: string): Promise<string>;
  resolvePath?(path: string): Promise<string>;
  capture?(root: string, mutating: boolean): (() => void) | Promise<() => void>;
  assertWritable(root: string, path: string): Promise<void>;
  references(): Promise<readonly PreparedReferenceAssemblyEntryV1[]>;
  reference(id: string): Promise<PreparedReferenceAssemblyEntryV1>;
  admit(
    input: TrackViewSourceInput,
    reference: PreparedReferenceAssemblyEntryV1,
    root: string
  ): Promise<AdmittedTrackSource>;
}

function scopedPath(root: string, path: string): string {
  const target = resolve(root, path);
  const within = relative(root, target);
  if (
    !within ||
    within === '..' ||
    within.startsWith('../') ||
    within.startsWith('..\\') ||
    isAbsolute(within)
  )
    throw new Error('The Track View path must be inside the selected project.');
  return target;
}

function chromosomes(reference: PreparedReferenceAssemblyEntryV1) {
  return reference.members.map((member) => {
    if (!Number.isSafeInteger(member.lengthBp) || member.lengthBp! <= 0)
      throw new Error(`Reference chromosome ${member.chrom} has no verified length.`);
    return { chrom: member.chrom, length: member.lengthBp! };
  });
}

function sequenceDataLayerTargets(reference: PreparedReferenceAssemblyEntryV1) {
  if (!reference.referenceIdentity) return {};
  const targets = reference.members.flatMap((member) =>
    member.manifest &&
    Number.isSafeInteger(member.lengthBp) &&
    member.lengthBp! > 0 &&
    member.lengthBp! <= MAX_INDEXED_SEQUENCE_DATA_LAYER_CONTIG_BASES &&
    reference.members.filter((entry) => entry.chrom === member.chrom).length === 1
      ? [
          {
            chrom: member.chrom,
            targetDocumentId: sequenceDataLayerIndexedTargetId({
              referenceId: reference.id,
              chrom: member.chrom,
              ...reference.referenceIdentity!,
            }),
          },
        ]
      : []
  );
  return targets.length ? { sequenceDataLayerTargets: targets } : {};
}

function summary(saved: SavedTrackView, operation: 'create' | 'inspect'): TrackViewCommandResult {
  return {
    ok: true,
    operation,
    documentId: saved.document.id,
    name: saved.document.name,
    path: saved.path,
    revision: saved.revision,
    referenceId: saved.document.reference.assemblyId,
    viewport: saved.document.viewport,
    tracks: saved.document.dataTracks.map((track) => ({
      trackId: track.trackId,
      label: track.label,
      visible: track.visible,
      color: `#${track.color.toString(16).padStart(6, '0')}`,
      heightPx: track.trackPx,
    })),
    ...(saved.warning ? { warning: saved.warning } : {}),
  };
}

export class TrackViewCommands {
  private readonly inflight = new Map<
    string,
    { hash: string; promise: Promise<TrackViewCommandResult> }
  >();
  constructor(private readonly dependencies: Dependencies) {}

  async run(input: TrackViewCommand): Promise<TrackViewCommandResult> {
    const request = trackViewCommandSchema.parse(input);
    if (request.operation === 'references')
      return {
        ok: true,
        operation: request.operation,
        references: (await this.dependencies.references()).map((entry) => ({
          id: entry.id,
          name: entry.name,
          organism: entry.organism,
          chromosomes: chromosomes(entry),
          ...sequenceDataLayerTargets(entry),
        })),
      };
    const root = await this.dependencies.resolveProject(request.project);
    const assertCurrent =
      (await this.dependencies.capture?.(root, request.operation === 'create')) ??
      (() => undefined);
    const intended = scopedPath(root, request.path);
    const path = scopedPath(root, await (this.dependencies.resolvePath?.(intended) ?? intended));
    assertCurrent();
    if (!path.endsWith(TRACK_VIEW_SUFFIX))
      throw new Error('Choose a native Track View file destination.');
    if (request.operation === 'inspect') {
      const saved = await this.dependencies.library.read(path);
      assertCurrent();
      return summary(saved, 'inspect');
    }
    await this.dependencies.assertWritable(root, path);
    const hash = createHash('sha256')
      .update(JSON.stringify({ ...request, project: root, path }))
      .digest('hex');
    const key = `${root}\0${request.requestId}`;
    const current = this.inflight.get(key);
    if (current) {
      if (current.hash !== hash)
        throw new Error('Track View request identity conflicts with different inputs.');
      return current.promise;
    }
    const promise = this.create({ ...request, project: root, path }, hash, assertCurrent);
    this.inflight.set(key, { hash, promise });
    try {
      return await promise;
    } finally {
      if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
    }
  }

  private async create(
    request: Extract<TrackViewCommand, { operation: 'create' }>,
    hash: string,
    assertCurrent: () => void
  ): Promise<TrackViewCommandResult> {
    const root = request.project;
    const id = `track-view-${createHash('sha256').update(`${root}\0${request.requestId}`).digest('hex')}`;
    let existing: SavedTrackView | undefined;
    try {
      existing = await this.dependencies.library.read(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing) {
      assertCurrent();
      if (existing.document.creationRequest?.inputHash !== hash || existing.path !== request.path)
        throw new Error('Track View request identity conflicts with an existing document.');
      return summary(existing, 'create');
    }
    const reference = await this.dependencies.reference(request.referenceId);
    assertCurrent();
    const chroms = chromosomes(reference);
    if (chroms.length === 0) throw new Error('The reference has no chromosomes.');
    let offset = 0;
    const selected = request.viewport;
    if (selected) {
      const chrom = chroms.find((entry) => entry.chrom === selected.chrom);
      if (!chrom || selected.end0 > chrom.length)
        throw new Error('The requested interval is outside its reference chromosome.');
      for (const entry of chroms) {
        if (entry === chrom) break;
        offset += entry.length;
      }
    }
    const dataTracks = [];
    const ids = new Set<string>();
    for (const [order, track] of request.tracks.entries()) {
      const source =
        track.source.kind === 'path'
          ? { kind: 'path' as const, path: scopedPath(root, track.source.path) }
          : track.source;
      const admitted = await this.dependencies.admit({ ...track, source }, reference, root);
      assertCurrent();
      const trackId = createIndexedBbiTrackId({ assemblyId: reference.id, source });
      if (ids.has(trackId)) throw new Error('The Track View contains a duplicate source.');
      ids.add(trackId);
      if (track.range && admitted.scientificKind !== 'quantitative')
        throw new Error('Fixed ranges require a quantitative signal.');
      dataTracks.push({
        trackId,
        trackType: admitted.recommendedTypes?.[0] ?? 'generic-interval',
        label: track.label ?? admitted.provenance.label ?? `Track ${order + 1}`,
        order,
        color: track.color ? parseInt(track.color.slice(1), 16) : 0x3b82f6,
        trackPx: track.heightPx ?? 96,
        laneHeightPx: 8,
        maxLanes: 32,
        visible: track.visible ?? true,
        ...(admitted.scientificKind === 'quantitative'
          ? {
              quantitativePresentation: {
                ...DEFAULT_QUANTITATIVE_TRACK_PRESENTATION,
                ...(track.range
                  ? {
                      scale: {
                        mode: 'fixed' as const,
                        transform: 'linear' as const,
                        ...track.range,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        source: admitted,
      });
    }
    const now = new Date().toISOString();
    const document = validateTrackViewDocument({
      schema: TRACK_VIEW_SCHEMA,
      kind: 'track-view',
      id,
      name: request.name,
      createdAt: now,
      updatedAt: now,
      creationRequest: { id: request.requestId, inputHash: hash },
      reference: {
        assemblyId: reference.id,
        name: reference.name,
        chromosomes: chroms,
        sourceFingerprint: null,
        inventoryFingerprint: null,
        bundleFingerprint: reference.portableView?.bundleFingerprint ?? null,
        ...reference.referenceIdentity,
      },
      viewport: selected
        ? { start0: offset + selected.start0, end0: offset + selected.end0 }
        : { start0: 0, end0: Math.min(chroms[0].length, 100_000) },
      scope: selected ? { kind: 'chromosome', chrom: selected.chrom } : { kind: 'all' },
      annotation: {
        policy: { isoformMode: 'canonical', laneLimit: 2 },
        orderedTrackIds: [...(reference.portableView?.trackTypes ?? [])],
        visibilityByTrackId: {},
      },
      dataTracks,
      bamTracks: [],
    });
    await this.dependencies.assertWritable(root, request.path);
    assertCurrent();
    return summary(
      await this.dependencies.library.save({
        document,
        expectedRevision: null,
        destination: { workspaceRoot: root, path: request.path },
      }),
      'create'
    );
  }
}
