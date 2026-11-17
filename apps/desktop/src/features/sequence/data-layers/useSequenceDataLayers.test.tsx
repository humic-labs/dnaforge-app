import { webcrypto } from 'node:crypto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareSequenceDataLayer } from '@waypoint/genome-data';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type {
  PublishedSequenceDataLayer,
  SequenceDataLayerCommand,
} from '../../../shared/sequence-data-layer';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useCanvasStore } from '../../canvas/public/store';
import {
  fingerprintSequenceDataLayerTarget,
  sequenceDataLayerProject,
  sequenceDataLayerRenderAvailability,
  useSequenceDataLayers,
  useSavedSequenceDataLayers,
} from './useSequenceDataLayers';

const native = vi.hoisted(() => vi.fn());
vi.mock('../../../platform', () => ({ platform: () => ({ sequenceDataLayers: { run: native } }) }));
vi.mock('@waypoint/genome-renderer', () => ({
  PixiGenomicSignalTrackRenderer: class {
    type = 'quantitative';
  },
}));

const DOCUMENT = 'project:sequence:old-plasmid';
const ID = `layer-${'a'.repeat(64)}`;
const SECOND = `layer-${'d'.repeat(64)}`;
const sequence: AnnotatedSequence = {
  id: 'old-plasmid',
  name: 'Old plasmid',
  sequence: 'ACGTACGT',
  length: 8,
  circular: false,
  annotations: [
    {
      name: 'geneA',
      type: 'gene',
      start: 1,
      end: 4,
      direction: 1,
      canonicalIdentity: 'geneA',
      qualifiers: { locus_tag: ['locusA'] },
    },
  ],
};
let layer: PublishedSequenceDataLayer;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  native.mockReset();
  useCanvasStore.getState().reset();
  useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: DOCUMENT,
    label: 'Old plasmid',
    sequenceDocument: {
      kind: 'import-source-sequence',
      documentId: DOCUMENT,
      sourcePath: '/project/old.gb',
    },
  });
  useWorkspaceStore.setState({ folders: [{ name: 'Project', path: '/project', addedAt: 1 }] });
  const fingerprints = await fingerprintSequenceDataLayerTarget(sequence);
  const target = { documentId: DOCUMENT, length: 8, ...fingerprints };
  const csv = 'locus_tag,value\nlocusA,3\n';
  const mapping = {
    kind: 'annotation' as const,
    identifierColumn: 'locus_tag',
    identifierField: 'locus_tag' as const,
  };
  const prepared = prepareSequenceDataLayer({
    datasetId: ID,
    label: 'Fitness',
    unit: 'fitness',
    csv,
    target,
    mapping,
    valueColumns: ['value'],
    annotations: [{ id: 'geneA', start0: 0, end0: 4, qualifiers: { locus_tag: ['locusA'] } }],
    unresolvedPolicy: 'reject',
    aggregation: 'none',
  });
  layer = {
    status: 'published',
    path: `/project/.dnaforge/sequence-data-layers/${ID}.dnalayer.json`,
    revision: 'saved-layer-revision',
    availability: { status: 'current' },
    alreadyPublished: false,
    document: {
      schema: 'dnaforge.sequence-data-layer.v1',
      id: ID,
      label: 'Fitness',
      unit: 'fitness',
      createdAt: '2026-11-16T00:00:00.000Z',
      target,
      annotations: [],
      source: { kind: 'csv-snapshot', csv, sha256: `sha256:${'b'.repeat(64)}` },
      mapping,
      valueColumns: ['value'],
      unresolvedPolicy: 'reject',
      aggregation: 'none',
      dataset: prepared.dataset,
      report: prepared.report,
      annotationAggregation: 'none',
      presentation: {
        sampleId: prepared.dataset.samples[0].id,
        annotationColors: true,
        signalVisible: true,
        style: {
          geometry: 'bars',
          colorScale: {
            kind: 'continuous',
            domain: [0, 6],
            colors: ['#000000', '#ffffff'],
            missingColor: '#cccccc',
            transform: 'linear',
          },
        },
      },
      creationRequest: {
        id: 'original-request',
        inputHash: `sha256:${'c'.repeat(64)}`,
        requestedPresentation: null,
      },
    },
  };
  native.mockImplementation(async (request: SequenceDataLayerCommand) => {
    if (request.operation === 'list') return { status: 'listed', layers: [layer], errors: [] };
    if (request.operation === 'target')
      return { status: 'target', target, annotationIdentifiers: [] };
    return layer;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function options(current = sequence) {
  return { documentId: DOCUMENT, sequence: current, onSelectionChange: vi.fn() };
}

describe('ordinary sequence data layers', () => {
  it('keeps the original viewer binding after its source is promoted into a managed package', async () => {
    const imported = {
      ...sequence,
      metadata: {
        sequenceDocument: {
          source: { path: '/project/Existing MG1655 rut locus.gb' },
        },
      },
    };
    const promoted = {
      ...imported,
      metadata: {
        sequenceDocument: {
          source: {
            path: '/project/Existing MG1655 rut locus/Existing MG1655 rut locus.gb',
          },
        },
      },
    };
    layer = {
      ...layer,
      document: {
        ...layer.document,
        target: {
          ...layer.document.target,
          annotationFingerprint: (await fingerprintSequenceDataLayerTarget(promoted))
            .annotationFingerprint,
        },
      },
    };
    const { result } = renderHook(() => useSequenceDataLayers(options(imported)));
    await waitFor(() => expect(result.current.tracks).toHaveLength(1));
    expect(result.current.annotationColorsByIdentity?.get('locusA')).toBe('#808080');
  });

  it.each([
    { start: 2 },
    { end: 5 },
    { canonicalIdentity: 'another-annotation' },
    { qualifiers: { locus_tag: ['another-locus'] } },
    { qualifiers: { locus_tag: ['locusA'], ID: ['another-ID'] } },
  ])('fences saved mappings after a real annotation input changes: %j', async (patch) => {
    const { result, rerender } = renderHook((props) => useSequenceDataLayers(props), {
      initialProps: options(),
    });
    await waitFor(() => expect(result.current.tracks).toHaveLength(1));
    rerender(options({ ...sequence, annotations: [{ ...sequence.annotations[0], ...patch }] }));
    expect(result.current.tracks).toHaveLength(0);
    expect(result.current.annotationColorsByIdentity).toBeUndefined();
    await waitFor(() => expect(native).toHaveBeenCalledTimes(2));
    expect(result.current.tracks).toHaveLength(0);
  });

  it('keeps saved layers attached when the same document is parsed through a source path alias', async () => {
    const sourceSequence = { ...sequence, id: '/project/old.gb' };
    const { result } = renderHook(() => useSequenceDataLayers(options(sourceSequence)));
    await waitFor(() => expect(result.current.tracks).toHaveLength(1));
    expect(result.current.annotationColorsByIdentity?.get('locusA')).toBe('#808080');
  });

  it('uses source annotations across visibility and draft previews and fences historical annotations', async () => {
    const { result, rerender } = renderHook((props) => useSequenceDataLayers(props), {
      initialProps: { ...options(), dataLayerSourceSequence: sequence },
    });
    await waitFor(() => expect(result.current.tracks).toHaveLength(1));
    const callsBeforePreview = native.mock.calls.length;
    rerender({
      ...options({ ...sequence, annotations: [] }),
      dataLayerSourceSequence: sequence,
    });
    expect(result.current.tracks).toHaveLength(1);
    expect(result.current.annotationColorsByIdentity?.get('locusA')).toBe('#808080');
    rerender({
      ...options({
        ...sequence,
        annotations: [...sequence.annotations, { ...sequence.annotations[0], name: 'Draft' }],
      }),
      dataLayerSourceSequence: sequence,
    });
    expect(result.current.tracks).toHaveLength(1);
    expect(native).toHaveBeenCalledTimes(callsBeforePreview);
    const historicalSequence = { ...sequence, annotations: [] };
    rerender({ ...options(historicalSequence), dataLayerSourceSequence: historicalSequence });
    expect(result.current.tracks).toHaveLength(0);
    expect(result.current.annotationColorsByIdentity).toBeUndefined();
    await waitFor(() => expect(native).toHaveBeenCalledTimes(callsBeforePreview + 1));
    expect(result.current.tracks).toHaveLength(0);
  });

  it('uses native saved data on arbitrary sequence content and removes it immediately when that content changes', async () => {
    const { result, rerender } = renderHook((props) => useSequenceDataLayers(props), {
      initialProps: options(),
    });
    await waitFor(() => expect(result.current.tracks).toHaveLength(1));
    expect(result.current.annotationColorsByIdentity?.get('locusA')).toBe('#808080');
    const track = result.current.tracks[0].data as {
      records: { value: number; start: number; end: number }[];
    };
    expect(track.records[0]).toMatchObject({ value: 3, start: 0, end: 4 });
    rerender(options({ ...sequence, sequence: 'TCGTACGT' }));
    expect(result.current.tracks).toHaveLength(0);
    expect(result.current.annotationColorsByIdentity).toBeUndefined();
    await waitFor(() => expect(native).toHaveBeenCalledTimes(2));
    expect(result.current.tracks).toHaveLength(0);
  });

  it('honors the existing view-owner hidden selection without deleting a saved layer', async () => {
    const { result } = renderHook(() =>
      useSequenceDataLayers({
        ...options(),
        selection: { project: '/project', layerId: null },
      })
    );
    await waitFor(() => expect(native).toHaveBeenCalled());
    expect(result.current.tracks).toHaveLength(0);
    expect(result.current.annotationColorsByIdentity).toBeUndefined();
    expect(native.mock.calls.every(([request]) => request.operation === 'list')).toBe(true);
  });

  it('styles the displayed layer through view state without republishing or changing its saved mapping', async () => {
    const onSelectionChange = vi.fn();
    const { result, rerender } = renderHook((props) => useSequenceDataLayers(props), {
      initialProps: {
        ...options(),
        onSelectionChange,
        selection: { project: '/project', layerId: ID },
      },
    });
    await waitFor(() => expect(result.current.trackControls.rows).toHaveLength(1));
    const presentation = {
      ...layer.document.presentation,
      style: { ...layer.document.presentation.style, geometry: 'points' as const },
    };
    act(() => result.current.trackControls.onPresentationChange(ID, presentation));
    const selection = onSelectionChange.mock.calls[0][0];
    expect(selection).toEqual({
      project: '/project',
      layerId: ID,
      visibleLayerIds: [ID],
      presentationByLayerId: { [ID]: presentation },
    });
    rerender({ ...options(), onSelectionChange, selection });
    expect(result.current.tracks[0].data).toMatchObject({ style: { geometry: 'points' } });
    act(() => result.current.trackControls.onVisibilityChange(ID, false));
    const hidden = onSelectionChange.mock.calls[1][0];
    rerender({ ...options(), onSelectionChange, selection: hidden });
    expect(result.current.tracks).toHaveLength(0);
    act(() => result.current.trackControls.onVisibilityChange(ID, true));
    expect(onSelectionChange.mock.calls[2][0]).toEqual(selection);
    expect(layer.document.presentation.style.geometry).toBe('bars');
    expect(native.mock.calls.every(([request]) => request.operation === 'list')).toBe(true);
  });

  it('falls back to saved presentation when retained view state refers to an absent sample', async () => {
    const retained = {
      ...layer.document.presentation,
      sampleId: 'sample-from-another-layer',
    };
    const { result } = renderHook(() =>
      useSequenceDataLayers({
        ...options(),
        selection: {
          project: '/project',
          layerId: ID,
          presentationByLayerId: { [ID]: retained },
        },
      })
    );
    await waitFor(() => expect(result.current.tracks).toHaveLength(1));
    expect(result.current.trackControls.rows[0].presentation).toEqual(layer.document.presentation);
    expect(result.current.tracks[0].data).toMatchObject({
      sampleId: layer.document.presentation.sampleId,
    });
  });

  it('composes independently visible saved layers, retains hidden styles and uses last visible annotation colors', async () => {
    const second = {
      ...layer,
      document: {
        ...layer.document,
        id: SECOND,
        label: 'Expression',
        dataset: { ...layer.document.dataset, id: SECOND },
        presentation: {
          ...layer.document.presentation,
          style: {
            ...layer.document.presentation.style,
            colorScale: {
              ...layer.document.presentation.style.colorScale,
              colors: ['#ff0000', '#ff0000'],
            },
          },
        },
      },
    };
    native.mockResolvedValue({ status: 'listed', layers: [layer, second], errors: [] });
    const onSelectionChange = vi.fn();
    const firstStyle = {
      ...layer.document.presentation,
      style: { ...layer.document.presentation.style, geometry: 'points' as const },
    };
    const initialSelection = {
      project: '/project',
      layerId: SECOND,
      visibleLayerIds: [ID, SECOND],
      presentationByLayerId: { [ID]: firstStyle },
    };
    const { result, rerender } = renderHook((props) => useSequenceDataLayers(props), {
      initialProps: { ...options(), onSelectionChange, selection: initialSelection },
    });
    await waitFor(() => expect(result.current.tracks).toHaveLength(2));
    expect(result.current.tracks.map((track) => track.track.id)).toEqual([
      `sequence-data-${ID}`,
      `sequence-data-${SECOND}`,
    ]);
    expect(result.current.annotationColorsByIdentity?.get('locusA')).toBe('#ff0000');
    expect(result.current.trackControls.rows.every((row) => row.visible)).toBe(true);
    act(() => result.current.trackControls.onVisibilityChange(SECOND, false));
    const hidden = onSelectionChange.mock.calls[0][0];
    rerender({ ...options(), onSelectionChange, selection: hidden });
    expect(hidden).toEqual({ ...initialSelection, layerId: ID, visibleLayerIds: [ID] });
    expect(result.current.tracks).toHaveLength(1);
    expect(result.current.tracks[0].data).toMatchObject({ style: { geometry: 'points' } });
    expect(result.current.annotationColorsByIdentity?.get('locusA')).toBe('#808080');
    act(() => result.current.trackControls.onVisibilityChange(SECOND, true));
    const restored = onSelectionChange.mock.calls[1][0];
    rerender({ ...options(), onSelectionChange, selection: restored });
    expect(restored).toEqual(initialSelection);
    expect(result.current.tracks).toHaveLength(2);
    expect(native.mock.calls.every(([request]) => request.operation === 'list')).toBe(true);
  });

  it('refuses a style override with a sample outside the saved dataset', async () => {
    const onSelectionChange = vi.fn();
    const { result } = renderHook(() => useSequenceDataLayers({ ...options(), onSelectionChange }));
    await waitFor(() => expect(result.current.trackControls.rows).toHaveLength(1));
    act(() =>
      result.current.trackControls.onPresentationChange(ID, {
        ...layer.document.presentation,
        sampleId: 'not-in-this-dataset',
      })
    );
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('keeps annotation colors when positional signal geometry is unsupported', async () => {
    const { result } = renderHook(() =>
      useSequenceDataLayers({ ...options(), signalsSupported: false })
    );
    await waitFor(() =>
      expect(result.current.annotationColorsByIdentity?.get('locusA')).toBe('#808080')
    );
    expect(result.current.tracks).toHaveLength(0);
  });

  it('ignores a late layer list after the displayed sequence revision changes', async () => {
    const first = deferred<unknown>();
    native.mockReturnValueOnce(first.promise);
    const { result, rerender } = renderHook((props) => useSequenceDataLayers(props), {
      initialProps: options(),
    });
    await waitFor(() => expect(native).toHaveBeenCalledTimes(1));
    rerender(options({ ...sequence, sequence: 'TCGTACGT' }));
    await waitFor(() => expect(native).toHaveBeenCalledTimes(2));
    await act(async () => {
      first.resolve({ status: 'listed', layers: [layer], errors: [] });
    });
    expect(result.current.tracks).toHaveLength(0);
    expect(result.current.annotationColorsByIdentity).toBeUndefined();
  });
});

describe('data layer identity and project boundaries', () => {
  it('ignores parser path aliases while preserving annotation mapping changes', async () => {
    const canonical = { ...sequence, id: DOCUMENT };
    const fingerprints = await fingerprintSequenceDataLayerTarget(canonical);
    expect(
      await fingerprintSequenceDataLayerTarget({ ...sequence, id: '/project/old.gb' })
    ).toEqual(fingerprints);
    const changed = await fingerprintSequenceDataLayerTarget({
      ...sequence,
      id: '/project/old.gb',
      annotations: [],
    });
    expect(changed.sequenceFingerprint).toBe(fingerprints.sequenceFingerprint);
    expect(changed.annotationFingerprint).not.toBe(fingerprints.annotationFingerprint);
  });

  it('requires explicit project choice when no source owner is known among multiple folders', () => {
    const folders = [
      { name: 'A', path: '/a', addedAt: 1 },
      { name: 'B', path: '/b', addedAt: 1 },
    ];
    expect(sequenceDataLayerProject(folders, undefined)).toBe('');
    expect(sequenceDataLayerProject(folders, undefined, '/b')).toBe('/b');
    expect(sequenceDataLayerProject(folders, undefined, '/unmounted')).toBe('');
  });

  it('uses the canonical source path boundary instead of a misleading selected project', () => {
    const folders = [
      { name: 'A', path: '/a', addedAt: 1 },
      { name: 'B', path: '/b', addedAt: 1 },
    ];
    expect(
      sequenceDataLayerProject(
        folders,
        {
          id: 'tab',
          type: 'sequence',
          entityId: DOCUMENT,
          label: 'sequence',
          sequenceDocument: {
            kind: 'managed-sequence',
            packageId: DOCUMENT,
            packageRoot: '/a/packages/sequence',
          },
        },
        '/b'
      )
    ).toBe('/a');
  });

  it('refuses colors from mismatching renderer annotations or another sequence document', async () => {
    const fingerprints = await fingerprintSequenceDataLayerTarget(sequence);
    expect(
      sequenceDataLayerRenderAvailability(layer, DOCUMENT, {
        ...fingerprints,
        annotationFingerprint: 'changed',
      })
    ).toContain('annotations have changed');
    expect(sequenceDataLayerRenderAvailability(layer, 'another-document', fingerprints)).toContain(
      'another sequence'
    );
  });
});

describe('saved layers with native target pins', () => {
  it('keeps an unused layer input stable across native camera renders', () => {
    const initialProps = {
      documentId: DOCUMENT,
      project: '/project',
      fingerprints: null,
      enabled: false,
      onSelectionChange: vi.fn(),
    };
    const { result, rerender } = renderHook((props) => useSavedSequenceDataLayers(props), {
      initialProps,
    });
    const tracks = result.current.tracks;
    rerender({ ...initialProps });
    expect(result.current.tracks).toBe(tracks);
    expect(native).not.toHaveBeenCalled();
  });

  it('refuses a saved-view artifact whose exact retained revision changed', async () => {
    const { result } = renderHook(() =>
      useSavedSequenceDataLayers({
        documentId: DOCUMENT,
        project: '/project',
        fingerprints: {
          sequenceFingerprint: layer.document.target.sequenceFingerprint,
          annotationFingerprint: layer.document.target.annotationFingerprint!,
        },
        pinnedRevisions: { [ID]: 'original-saved-view-revision' },
        selection: { project: '/project', layerId: ID, visibleLayerIds: [ID] },
        onSelectionChange: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.loadedLayers).toHaveLength(1));
    expect(result.current.trackControls.rows[0].unavailable).toContain(
      'dataset revision has changed'
    );
    expect(result.current.tracks).toHaveLength(0);
    expect(result.current.annotationColorsByIdentity).toBeUndefined();
  });

  it('projects exact native pins without loading or hashing a complete renderer sequence', async () => {
    vi.stubGlobal('crypto', {});
    const fingerprints = {
      sequenceFingerprint: layer.document.target.sequenceFingerprint,
      annotationFingerprint: layer.document.target.annotationFingerprint!,
    };
    const initialProps = {
      documentId: DOCUMENT,
      project: '/project',
      fingerprints,
      onSelectionChange: vi.fn(),
    };
    const { result, rerender } = renderHook((props) => useSavedSequenceDataLayers(props), {
      initialProps,
    });
    expect(result.current.loadedLayers).toBeNull();
    await waitFor(() => expect(result.current.tracks).toHaveLength(1));
    expect(native).toHaveBeenCalledWith({
      operation: 'list',
      project: '/project',
      targetDocumentId: DOCUMENT,
    });
    expect(result.current.loadedLayers).toEqual([layer]);
    expect(result.current.annotationColorsByIdentity?.get('locusA')).toBe('#808080');
    const tracks = result.current.tracks;
    rerender({ ...initialProps, fingerprints: { ...fingerprints } });
    expect(result.current.tracks).toBe(tracks);
    expect(native).toHaveBeenCalledTimes(1);
    rerender({
      ...initialProps,
      fingerprints: { ...fingerprints, sequenceFingerprint: `sha256:${'f'.repeat(64)}` },
    });
    expect(result.current.tracks).toHaveLength(0);
    expect(result.current.loadedLayers).toBeNull();
    await waitFor(() => expect(native).toHaveBeenCalledTimes(2));
    expect(result.current.tracks).toHaveLength(0);
    expect(result.current.trackControls.rows[0].unavailable).toContain('sequence has changed');
  });

  it('ignores an old native list while waiting for new authoritative pins', async () => {
    const first = deferred<unknown>();
    native.mockReturnValueOnce(first.promise);
    const fingerprints = {
      sequenceFingerprint: layer.document.target.sequenceFingerprint,
      annotationFingerprint: layer.document.target.annotationFingerprint!,
    };
    const initialProps: Parameters<typeof useSavedSequenceDataLayers>[0] = {
      documentId: DOCUMENT,
      project: '/project',
      fingerprints,
      onSelectionChange: vi.fn(),
    };
    const { result, rerender } = renderHook((props) => useSavedSequenceDataLayers(props), {
      initialProps,
    });
    await waitFor(() => expect(native).toHaveBeenCalledTimes(1));
    rerender({ ...initialProps, fingerprints: null });
    await act(async () => {
      first.resolve({ status: 'listed', layers: [layer], errors: [] });
    });
    expect(result.current.loadedLayers).toBeNull();
    expect(result.current.tracks).toHaveLength(0);
    expect(result.current.annotationColorsByIdentity).toBeUndefined();
    expect(native).toHaveBeenCalledTimes(1);
  });
});
