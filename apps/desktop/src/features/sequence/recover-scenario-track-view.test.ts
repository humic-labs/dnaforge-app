import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateTrackViewDocument, type SavedTrackView } from '../../shared/track-view';
import { trackViewFixture } from '../../shared/track-view-fixture';
import { INTERNAL_TRACK_FIXTURES } from '../../shared/internal-track-fixtures';
import { recoverScenarioTrackView } from './recover-scenario-track-view';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  projectRoot: vi.fn(),
  retain: vi.fn(),
  admit: vi.fn(),
  save: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    path: { projectRoot: mocks.projectRoot },
    fs: { exists: mocks.exists },
    internalFixtures: { recoverTrack: mocks.retain },
  }),
}));
vi.mock('./indexed-track-admission', () => ({ admitIndexedBigWigRequest: mocks.admit }));
vi.mock('./track-view-library', () => ({ saveTrackView: mocks.save }));

const fixture = Object.values(INTERNAL_TRACK_FIXTURES)[0];
const saved = (): SavedTrackView => ({
  document: validateTrackViewDocument({
    ...trackViewFixture(),
    reference: { ...(trackViewFixture().reference as object), assemblyId: 'danRer11' },
    dataTracks: [
      {
        trackId: 'signal',
        trackType: 'quantitative',
        label: 'My label',
        order: 2,
        color: 0x8b5cf6,
        trackPx: 96,
        laneHeightPx: 18,
        maxLanes: 1,
        visible: false,
        source: {
          admissionVersion: 1,
          uri: `file:///removed/${fixture.relativePath}`,
          input: { kind: 'path', path: `/removed/${fixture.relativePath}` },
          formatId: 'bigwig',
          fingerprint: 'old-source',
          readerKind: 'bbi',
          scientificKind: 'quantitative',
          assemblyId: 'danRer11',
          referenceReceipt: {
            assemblyId: 'danRer11',
            referenceSignature: 'reference',
            sourceSignature: 'old-source',
            contigMap: { chr1: 'chr1' },
            checkedContigs: 1,
            status: 'compatible',
            checkedAt: '2026-09-29T00:00:00.000Z',
          },
          provenance: {
            provider: 'local-file',
            sourceKind: 'local-file',
            label: 'Signal',
            devScenarioFixture: true,
          },
          expectedValidators: { contentLength: fixture.sizeBytes },
        },
      },
    ],
  }),
  path: '/project/View.dnaforge-track-view.json',
  workspaceRoot: '/project',
  revision: 'a'.repeat(64),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.projectRoot.mockResolvedValue('/current-checkout');
  mocks.exists.mockResolvedValue(false);
  mocks.retain.mockResolvedValue({ path: '/profile/Track assets/verified/AGS001841.bw' });
  mocks.admit.mockResolvedValue({ fingerprint: 'new-admission' });
  mocks.save.mockImplementation(async (request) => ({
    saved: { ...saved(), document: request.document, revision: 'b'.repeat(64) },
  }));
});

describe('legacy saved demo track recovery', () => {
  it('admits the retained complete file and saves atomically with the original revision and presentation', async () => {
    const original = saved();
    const before = JSON.stringify(original);
    const restored = await recoverScenarioTrackView(original);
    expect(mocks.retain).toHaveBeenCalledWith({
      relativePath: fixture.relativePath,
      previousPath: `/removed/${fixture.relativePath}`,
    });
    expect(mocks.exists).not.toHaveBeenCalled();
    expect(mocks.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          source: { kind: 'local-file', path: '/profile/Track assets/verified/AGS001841.bw' },
        }),
        assemblyReferences: [{ name: 'pUC19', length: 2686 }],
      })
    );
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: original.revision,
        destination: { path: original.path, workspaceRoot: '/project' },
      })
    );
    const { source: _source, ...presentation } = restored.document.dataTracks[0];
    const { source: _old, ...expected } = original.document.dataTracks[0];
    expect(presentation).toEqual(expected);
    expect(restored.document.viewport).toEqual(original.document.viewport);
    expect(restored.document.annotation).toEqual(original.document.annotation);
    expect(JSON.stringify(original)).toBe(before);
  });

  it.each(['existing', 'ordinary-file', 'wrong-length', 'packaged'])(
    'preserves a source outside the narrowly identified missing demo case (%s)',
    async (caseName) => {
      const original = saved();
      if (caseName === 'existing') mocks.retain.mockResolvedValue({ path: null });
      if (caseName === 'ordinary-file')
        delete original.document.dataTracks[0].source.provenance.devScenarioFixture;
      if (caseName === 'wrong-length')
        original.document.dataTracks[0].source.expectedValidators = { contentLength: 10 };
      if (caseName === 'packaged') mocks.projectRoot.mockResolvedValue(null);
      expect(await recoverScenarioTrackView(original)).toBe(original);
      expect(mocks.admit).not.toHaveBeenCalled();
      expect(mocks.save).not.toHaveBeenCalled();
    }
  );

  it.each(['retention', 'admission', 'revision-conflict'])(
    'preserves the original document when %s fails',
    async (stage) => {
      const original = saved();
      const before = JSON.stringify(original);
      (stage === 'retention'
        ? mocks.retain
        : stage === 'admission'
          ? mocks.admit
          : mocks.save
      ).mockRejectedValue(new Error(stage));
      await expect(recoverScenarioTrackView(original)).rejects.toThrow(stage);
      expect(JSON.stringify(original)).toBe(before);
      if (stage !== 'revision-conflict') expect(mocks.save).not.toHaveBeenCalled();
    }
  );
});
