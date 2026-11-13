import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  findJob: vi.fn(),
  readView: vi.fn(),
}));

vi.mock('../scientific-document/public/read-desktop-scientific-document', () => ({
  readDesktopScientificDocument: mocks.readFile,
}));
vi.mock('../../platform', () => ({
  platform: () => ({ compute: { findJob: mocks.findJob } }),
}));
vi.mock('../molecular-documents/public/services', () => ({
  readMolecularDocument: mocks.readView,
}));
vi.mock('./prediction-coordinates', () => ({
  validatePredictionCoordinates: vi.fn(async () => {}),
}));

import { loadInspectionPrediction } from './inspection-prediction';
import { buildDefaultMolecularDocument } from '../../shared/default-molecular-view';
import { coordinateDigest } from '../page/public/embeds/structure3d/molecularView';

const PDB = 'ATOM      1  CA  MET A   1       0.000   0.000   0.000  1.00 90.00           C\nEND\n';

beforeEach(() => {
  mocks.readFile.mockReset();
  mocks.findJob.mockReset();
  mocks.readView.mockReset();
});

it('loads a migrated compute/ prediction from the view that replaced it ', async () => {
  const sha256 = await coordinateDigest(PDB);
  const view = await buildDefaultMolecularDocument({
    name: 'GFP prediction',
    format: 'pdb',
    text: PDB,
    createdAt: 1,
    documentId: '11111111-1111-4111-8111-111111111111',
    referenceId: '22222222-2222-4222-8222-222222222222',
  });
  mocks.readFile.mockResolvedValue({ ok: false, error: { message: 'The file is missing.' } });
  mocks.findJob.mockResolvedValue({
    importedPaths: ['/ws/designs.fasta', '/ws/GFP prediction.dnaforge-molecular.json'],
  });
  mocks.readView.mockResolvedValue({ document: view });

  await expect(
    loadInspectionPrediction({
      jobRecordId: 'job-1',
      provider: 'boltz',
      remoteId: 'r1',
      toolId: 'boltz-2',
      workspaceRoot: '/ws',
      filePath: '/ws/compute/boltz/r1/model.pdb',
      format: 'pdb',
      sha256,
      proteinSequenceSha256: 'a'.repeat(64),
      metrics: {},
      provenance: {},
    })
  ).resolves.toEqual({ text: PDB, format: 'pdb', sha256 });
  expect(mocks.findJob).toHaveBeenCalledWith('boltz', 'r1');
  expect(mocks.readView).toHaveBeenCalledWith('/ws/GFP prediction.dnaforge-molecular.json', '/ws');

  mocks.readView.mockResolvedValue({
    document: await buildDefaultMolecularDocument({
      name: 'Other',
      format: 'pdb',
      text: PDB.replace('MET', 'ALA'),
      createdAt: 1,
      documentId: '33333333-3333-4333-8333-333333333333',
      referenceId: '44444444-4444-4444-8444-444444444444',
    }),
  });
  await expect(
    loadInspectionPrediction({
      jobRecordId: 'job-1',
      provider: 'boltz',
      remoteId: 'r1',
      toolId: 'boltz-2',
      workspaceRoot: '/ws',
      filePath: '/ws/compute/boltz/r1/model.pdb',
      format: 'pdb',
      sha256,
      proteinSequenceSha256: 'a'.repeat(64),
      metrics: {},
      provenance: {},
    })
  ).rejects.toThrow('The file is missing.');
});
