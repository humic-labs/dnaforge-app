import { describe, expect, it, vi } from 'vitest';
import { sanitizeClosedBetaProperties } from '../../shared/analytics-allowlist';
import { installGenomeViewTelemetry, type GenomeViewTelemetryDeps } from './genome-view-telemetry';

vi.mock('../canvas/public/store', () => ({
  useCanvasStore: { getState: vi.fn(), subscribe: vi.fn() },
}));
vi.mock('../../lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/analytics')>()),
  trackRendererEvent: vi.fn(),
}));

type FakeTab = ReturnType<GenomeViewTelemetryDeps['tabs']>[number];

function harness(initial: FakeTab[]) {
  let tabs = initial;
  let clock = 1_000;
  let listener: () => void = () => {};
  const track = vi.fn();
  const uninstall = installGenomeViewTelemetry({
    tabs: () => tabs,
    subscribe: (next) => {
      listener = next;
      return vi.fn();
    },
    track,
    now: () => clock,
  });
  return {
    track,
    uninstall,
    advance(ms: number, next: FakeTab[]) {
      clock += ms;
      tabs = next;
      listener();
    },
  };
}

function tab(id: string, loadStatus: FakeTab['loadStatus'], assemblyId?: string): FakeTab {
  return {
    id,
    loadStatus,
    indexedGenome: {
      sourcePath: '/private/reads/patient-17.fa',
      chrom: 'patient-17',
      ...(assemblyId ? { assembly: { assemblyId } } : {}),
      bamTracks: [{}, {}],
      variantSource: {},
    },
  } as FakeTab;
}

describe('genome view telemetry', () => {
  it('reports a catalog build becoming ready with its load time and track count', () => {
    const view = harness([tab('t1', 'indexed-pending', 'sacCer3')]);
    view.advance(2_500, [tab('t1', 'indexed', 'sacCer3')]);
    expect(view.track).toHaveBeenCalledOnce();
    const [event, properties] = view.track.mock.calls[0];
    expect(event).toBe('genome_view_observed');
    expect(properties).toEqual({
      feature_area: 'scientific_workflow',
      view_phase: 'ready',
      genome_source: 'catalog',
      genome_build: 'sacCer3',
      track_count_bucket: '2_5',
      duration_ms: 2_500,
    });
    expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
    view.advance(100, [tab('t1', 'indexed', 'sacCer3')]);
    expect(view.track).toHaveBeenCalledOnce();
  });

  it('reports failures and views closed while loading without naming local sources', () => {
    const view = harness([
      tab('local', 'indexed-pending', 'local-0123456789abcdef01234567'),
      tab('file', 'indexed-pending'),
    ]);
    view.advance(400, [tab('local', 'indexed-error', 'local-0123456789abcdef01234567')]);
    const sent = view.track.mock.calls.map(([, properties]) => properties);
    expect(sent).toEqual([
      expect.objectContaining({ view_phase: 'failed', genome_source: 'local_reference' }),
      expect.objectContaining({ view_phase: 'abandoned', genome_source: 'indexed_file' }),
    ]);
    for (const properties of sent) {
      expect(properties).not.toHaveProperty('genome_build');
      expect(JSON.stringify(properties)).not.toMatch(/patient|private|local-/);
    }
  });

  it('ignores views restored already loaded and drops builds outside the catalog', () => {
    const view = harness([tab('restored', 'indexed', 'grch38')]);
    view.advance(10, [tab('restored', 'indexed', 'grch38')]);
    expect(view.track).not.toHaveBeenCalled();
    expect(sanitizeClosedBetaProperties({ genome_build: 'my-private-build' })).toEqual({});
    expect(sanitizeClosedBetaProperties({ genome_build: 'grch38' })).toEqual({
      genome_build: 'grch38',
    });
  });
});
