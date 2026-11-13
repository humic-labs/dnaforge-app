import { createEntityReferenceInDb } from '../../main/entity-reference-commands';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../main/__tests__/test-db';
import type { ComputeJobRecord } from '../../shared/compute-jobs-ipc';
import {
  getCurrentMolecularSnapshot,
  type MolecularDocument,
} from '../../shared/molecular-document';
const state = vi.hoisted(() => ({ sqlite: null as Database.Database | null }));
vi.mock('../../db/index', () => ({
  getConnection: async () => ({
    createEntityReference: async (row: Parameters<typeof createEntityReferenceInDb>[1]) =>
      createEntityReferenceInDb(state.sqlite!, row),
    updateEntityReference: async (
      id: string,
      updates: Parameters<typeof updateEntityReferenceInDb>[2]
    ) => updateEntityReferenceInDb(state.sqlite!, id, updates),
    deleteEntityReference: async (id: string) => deleteEntityReferenceInDb(state.sqlite!, id),
    select: async (sql: string, params: unknown[]) => state.sqlite!.prepare(sql).all(...params),
    execute: async (sql: string, params: unknown[]) => state.sqlite!.prepare(sql).run(...params),
  }),
}));
import {
  registerPredictionResult,
  listProteinPredictions,
  loadProteinPrediction,
} from './prediction-library';

const coordinates = `ATOM      1  CA  MET A   1       0.000   0.000   0.000  1.00 90.00           C  
ATOM      2  CA  ALA A   2       3.800   0.000   0.000  1.00 90.00           C  
ATOM      3  CA  GLY A   3       7.600   1.000   0.000  1.00 90.00           C  
END
`;
const job = {
  id: 'job-a',
  provider: 'tamarind',
  remoteId: 'remote-a',
  toolId: 'esmfold',
  settings: { sequence: 'MAG', seed: 1 },
  settingsHash: 'settings-a',
  label: 'Original run',
  workspaceRoot: '/original',
  createdAt: '2026-10-06T00:00:00.000Z',
} as ComputeJobRecord;
const input = (run = job, text = coordinates) => ({
  job: run,
  filePath: `${run.workspaceRoot}/compute/${run.remoteId}/model.pdb`,
  coordinates: { text, format: 'pdb' as const },
  metrics: { plddt: 90 },
  provenance: {},
});
beforeEach(() => {
  state.sqlite = createTestDb();
  state.sqlite.exec(
    `CREATE TABLE entity_references (id TEXT PRIMARY KEY, entity_type TEXT, display_label TEXT, locator TEXT, deep_link_params TEXT, data TEXT, source TEXT, status TEXT, workspace_scope TEXT, workspace_root_path TEXT, created_at INTEGER, updated_at INTEGER)`
  );
});
afterEach(() => state.sqlite?.close());

it('discovers exact proteins globally, retains separate runs, and pins coordinates independently of source files', async () => {
  const first = await registerPredictionResult(input());
  const second = await registerPredictionResult(
    input({
      ...job,
      id: 'job-b',
      remoteId: 'remote-b',
      settingsHash: 'settings-b',
      settings: { sequence: 'MAG', seed: 2 },
      workspaceRoot: '/elsewhere',
    })
  );
  expect(first).not.toBe(second);
  expect(await registerPredictionResult(input())).toBe(first);
  const rows = await listProteinPredictions(' m a g * ');
  expect(new Set(rows.map((row) => row.id))).toEqual(new Set([first, second]));
  expect(rows.map((row) => row.chainId)).toEqual(['A', 'A']);
  expect(JSON.stringify(rows)).not.toContain('ATOM');
  expect(await listProteinPredictions('MWG')).toEqual([]);
  const loaded = await loadProteinPrediction(first, 'MAG', 'A');
  expect(loaded.coordinates.text).toBe(coordinates);
  expect(loaded.run.settings).toEqual(job.settings);
  expect(loaded.origin.workspaceRoot).toBe('/original');
  expect(loaded).not.toHaveProperty('measurements');
  await expect(loadProteinPrediction(first, 'MWG', 'A')).rejects.toThrow(/sequence/);
});

it('refuses coordinate drift, wrong proteins and provider test-mode data as reusable predictions', async () => {
  const id = await registerPredictionResult(input());
  await expect(
    registerPredictionResult(input(job, coordinates.replace('90.00', '91.00')))
  ).rejects.toThrow(/changed/);
  await expect(
    registerPredictionResult(
      input({ ...job, id: 'wrong', remoteId: 'wrong', settings: { sequence: 'MWG' } })
    )
  ).rejects.toThrow(/sequence/);
  await expect(
    registerPredictionResult({ ...input(), provenance: { livemode: 'false' } })
  ).rejects.toThrow(/test.mode/);
  state
    .sqlite!.prepare(
      "UPDATE entity_references SET data = json_set(data, '$.coordinates.text', 'corrupt') WHERE id = ?"
    )
    .run(id);
  await expect(loadProteinPrediction(id, 'MAG', 'A')).rejects.toThrow(/digest/);
});

it('keeps the first provenance when an older recovered import is downloaded again', async () => {
  const recovered = {
    ...input(),
    provenance: { recovered_from: 'Previously imported coordinate file' },
  };
  const id = await registerPredictionResult(recovered);
  expect(await registerPredictionResult(input())).toBe(id);
  expect((await loadProteinPrediction(id, 'MAG', 'A')).provenance).toEqual(recovered.provenance);
});

it('refuses ambiguous chain identities and inconsistent chain counts in saved artifacts', async () => {
  const id = await registerPredictionResult(input());
  const row = state.sqlite!.prepare('SELECT data FROM entity_references WHERE id = ?').get(id) as {
    data: string;
  };
  const original = JSON.parse(row.data);
  const write = (value: unknown) =>
    state
      .sqlite!.prepare('UPDATE entity_references SET data = ? WHERE id = ?')
      .run(JSON.stringify(value), id);
  write({ ...original, chains: [original.chains[0], original.chains[0]], chainCount: 2 });
  await expect(loadProteinPrediction(id, 'MAG', 'A')).rejects.toThrow(/chain/i);
  write({ ...original, chainCount: 2 });
  await expect(loadProteinPrediction(id, 'MAG', 'A')).rejects.toThrow(/chain/i);
});

it('discovers individual chains while retaining the complete complex and submitted context', async () => {
  const complex =
    coordinates.replace('END\n', 'TER\n') +
    coordinates.replaceAll(' A ', ' B ').replace('ALA', 'TRP');
  const complexJob = {
    ...job,
    settings: {
      polymers: [
        { id: 'A', molecule_type: 'protein', sequence: 'MAG' },
        { id: 'B', molecule_type: 'protein', sequence: 'MWG' },
      ],
      ligand: 'retained-context',
    },
  };
  const id = await registerPredictionResult(input(complexJob, complex));
  expect(await listProteinPredictions('MAG')).toMatchObject([{ id, chainId: 'A', chainCount: 2 }]);
  expect(await listProteinPredictions('MWG')).toMatchObject([{ id, chainId: 'B', chainCount: 2 }]);
  expect((await loadProteinPrediction(id, 'MWG', 'B')).coordinates.text).toBe(complex);
  expect((await loadProteinPrediction(id, 'MWG', 'B')).run.settings).toEqual(complexJob.settings);
  await expect(loadProteinPrediction(id, 'MWG', 'A')).rejects.toThrow(/sequence/);
});

it('the production import registers every coordinate output and an identical retry keeps the same artifacts', async () => {
  const { importComputeResult } = await import('./import-result');
  const saved = new Map<string, string>();
  const deps = {
    writePackage: vi.fn(
      async ({
        directory,
        name,
        document,
      }: {
        directory: string;
        name: string;
        document: MolecularDocument;
      }) => {
        const identity = JSON.stringify(getCurrentMolecularSnapshot(document).source);
        for (let n = 1; ; n += 1) {
          const path = `${directory}/${n === 1 ? name : `${name} ${n}`}.dnaforge-molecular.json`;
          if (!saved.has(path) || saved.get(path) === identity) {
            saved.set(path, identity);
            return path;
          }
        }
      }
    ),
    writeOutputFile: vi.fn(async () => ''),
    registerFile: vi.fn(async () => {}),
    openStructure: vi.fn(async () => {}),
    registerPrediction: registerPredictionResult,
    registerCatalog: vi.fn(async ({ filePath }) => `native-catalog:${filePath}`),
  };
  const bundle = {
    provider: job.provider,
    remoteId: job.remoteId!,
    toolId: job.toolId,
    job,
    outputKind: 'structure',
    metrics: {},
    provenance: {},
    files: ['model-1.pdb', 'model-2.pdb'].map((name) => ({
      name,
      content: coordinates,
      media_type: 'text/plain',
      size_bytes: null,
      url: null,
    })),
  };
  const folders = [{ path: '/original', name: 'Original workspace', addedAt: 1 }];
  const first = await importComputeResult(bundle, folders, { deps });
  expect(first).toMatchObject({
    ok: true,
    predictionLibraryWarnings: [],
    predictionResultIds: [expect.any(String), expect.any(String)],
  });
  const second = await importComputeResult(bundle, folders, { deps });
  if (!first.ok) throw new Error('import failed');
  expect(second).toEqual({
    ...first,
    importDetails: {
      ...first.importDetails,
      receipt: { ...first.importDetails.receipt, importedAt: expect.any(String) },
    },
  });
  expect(await listProteinPredictions('MAG')).toHaveLength(2);
  deps.writePackage.mockClear();
  await expect(
    importComputeResult(
      { ...bundle, files: [bundle.files[0], { ...bundle.files[0], name: '../model-1.pdb' }] },
      folders,
      { deps }
    )
  ).rejects.toThrow(/colliding/);
  expect(deps.writePackage).not.toHaveBeenCalled();
}, 60_000);

it('binds reused coordinates to the receiving inspection and leaves repeated choices unchanged', async () => {
  const { useCanvasStore } = await import('../canvas/public/store');
  const { openStructureInspection, structureInspectionId } =
    await import('../structure-drawer/public/structure-inspection');
  const { reuseInspectionPrediction, loadInspectionPrediction } =
    await import('../structure-drawer/public/inspection-prediction');
  const id = await registerPredictionResult(input());
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    recentlyClosed: [],
  });
  const documentId = 'sequence-document:receiver';
  useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: documentId,
    label: 'Synonymous recipient',
    sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
  });
  const request = {
    entityId: documentId,
    translation: 'MAG',
    hints: {},
    identityRequestKey: 'recipient-cds',
  };
  openStructureInspection(request);
  const where = useCanvasStore.getState().findTab('structure', structureInspectionId(documentId))!;
  const current = () =>
    useCanvasStore.getState().panels[where.panelId].tabs.find((t) => t.id === where.tabId)!
      .structureInspection!;
  await reuseInspectionPrediction(documentId, id, 'A');
  expect(current().request).toBe(request);
  expect(current().prediction!.workspaceRoot).toBe('/original');
  expect((await loadInspectionPrediction(current().prediction!)).text).toBe(coordinates);
  const saved = {
    ...current(),
    savedViewReferenceId: 'receiving-analysis',
    viewSettings: { candidateId: current().candidateId!, showSequenceViewer: true },
  };
  useCanvasStore.getState().updateTab(where.panelId, where.tabId, { structureInspection: saved });
  await reuseInspectionPrediction(documentId, id, 'A');
  expect(current()).toBe(saved);
  const inFlight = reuseInspectionPrediction(documentId, id, 'A');
  openStructureInspection({
    ...request,
    translation: 'MWG',
    identityRequestKey: 'edited-recipient',
  });
  await expect(inFlight).rejects.toThrow(/changed/);
  expect(current().prediction).toBeUndefined();
}, 60_000);
