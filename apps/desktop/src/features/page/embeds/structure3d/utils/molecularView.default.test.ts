import { describe, expect, it } from 'vitest';
import { molecularViewAttrs } from './molecularView';
import {
  buildDefaultMolecularDocument,
  coordinateFileStem,
  isDefaultMolecularScene,
  packagedCoordinateFormat,
} from '../../../../../shared/default-molecular-view';
import { getCurrentMolecularSnapshot } from '../../../../../shared/molecular-document';

const PDB = 'HEADER    TEST PROTEIN\nATOM      1  CA  ALA A   1\nEND\n';

async function defaultDocument() {
  return buildDefaultMolecularDocument({
    name: '1ABC',
    format: 'pdb',
    text: PDB,
    createdAt: 1_000,
    documentId: '11111111-1111-4111-8111-111111111111',
    referenceId: '22222222-2222-4222-8222-222222222222',
  });
}

describe('default molecular views for added coordinate files ', () => {
  it('recognizes coordinate files and names the view after the file', () => {
    expect(packagedCoordinateFormat('1ABC.pdb')).toBe('pdb');
    expect(packagedCoordinateFormat('1abc.ENT')).toBe('pdb');
    expect(packagedCoordinateFormat('1ABC.cif')).toBe('cif');
    expect(packagedCoordinateFormat('1ABC.mmcif')).toBe('cif');
    expect(packagedCoordinateFormat('1ABC.bcif')).toBe('bcif');
    expect(coordinateFileStem('1FS0.bcif')).toBe('1FS0');
    expect(packagedCoordinateFormat('notes.txt')).toBeNull();
    expect(coordinateFileStem('Lysozyme model.cif')).toBe('Lysozyme model');
  });

  it('opens a default view the way a loose coordinate file opens, so the viewer draws its own display', async () => {
    const document = await defaultDocument();
    const snapshot = getCurrentMolecularSnapshot(document);
    expect(isDefaultMolecularScene(snapshot.scene)).toBe(true);
    const attrs = molecularViewAttrs(
      'molecular-document:1ABC',
      snapshot,
      undefined,
      document.currentReferenceId
    );
    expect(attrs.molViewSpec).toBeUndefined();
    expect(attrs.molViewSpecSnapshotIndex).toBeUndefined();
    expect(attrs.molViewSpecSavedReferenceId).toBeUndefined();
    expect(attrs.coordinateSha256).toBeUndefined();
    expect(attrs).toMatchObject({ label: '1ABC', source: 'file', sourceId: PDB });
  });

  it('keeps an authored scene for a saved view', async () => {
    const snapshot = getCurrentMolecularSnapshot(await defaultDocument());
    const authored = {
      ...snapshot,
      scene: JSON.stringify({ kind: 'single', root: { kind: 'root' } }),
    };
    expect(molecularViewAttrs('molecular-document:1ABC', authored).molViewSpec).toBe(
      authored.scene
    );
  });
});
