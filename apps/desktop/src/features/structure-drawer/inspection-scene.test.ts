import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { MolecularView } from '../../shared/molecular-view';
import { loadInspectionScene } from './inspection-scene';

const owner = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../molecular-documents/public/references', () => ({
  resolveMolecularDocumentResult: owner.resolve,
}));
const text = readFileSync(
  resolve(process.cwd(), '../../test-fixtures/structure-comparisons/1L63.cif'),
  'utf8'
);
const view: MolecularView = {
  kind: 'molecular-view',
  version: 1,
  title: 'Deposited reference context',
  caption: '',
  scene: JSON.stringify({ kind: 'single', root: { kind: 'root' } }),
  coordinates: { text, format: 'cif', sha256: createHash('sha256').update(text).digest('hex') },
  source: { source: 'pdb', sourceId: '1L63' },
  evidence: [],
  preview: 'data:image/png;base64,AA==',
  createdAt: 1,
};
const revisionId = '26c99472-fad2-4df7-85e1-008ee823649c';
beforeEach(() => {
  vi.clearAllMocks();
  owner.resolve.mockResolvedValue({ snapshot: view });
});
it('restores the exact owning document snapshot', async () => {
  await expect(loadInspectionScene(revisionId)).resolves.toEqual(view);
});
it('refuses an inspection result when its owning document cannot be verified', async () => {
  owner.resolve.mockRejectedValue(new Error('No verified owning document.'));
  await expect(loadInspectionScene(revisionId)).rejects.toThrow('No verified owning document.');
});
it('refuses altered coordinate bytes before mounting the saved inspection', async () => {
  owner.resolve.mockResolvedValue({
    snapshot: { ...view, coordinates: { ...view.coordinates, text: text + 'changed' } },
  });
  await expect(loadInspectionScene(revisionId)).rejects.toThrow(/digest/i);
});
