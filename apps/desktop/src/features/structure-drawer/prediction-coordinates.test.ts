import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { coordinateDigest } from '../page/public/embeds/structure3d/molecularView';
import { validatePredictionCoordinates } from './prediction-coordinates';

const pdb = `ATOM      1  CA  MET A   1       0.000   0.000   0.000  1.00 90.00           C  
ATOM      2  CA  ALA A   2       3.800   0.000   0.000  1.00 90.00           C  
ATOM      3  CA  GLY A   3       7.600   0.000   0.000  1.00 90.00           C  
END
`;
describe('predicted coordinate identity', () => {
  it('uses the encoded parent sequence without changing modified coordinate chemistry', async () => {
    const text = readFileSync(
      resolve(process.cwd(), '../../test-fixtures/structure-complexes/rcsb/1A8O.cif'),
      'utf8'
    );
    await expect(
      validatePredictionCoordinates(
        text,
        'cif',
        await coordinateDigest(
          'MDIRQGPKEPFRDYVDRFYKTLRAEQASQEVKNWMTETLLVQNANPDCKTILKALGPGATLEEMMTACQG'
        )
      )
    ).resolves.toBeUndefined();
  });
  it('parses actual coordinates and refuses a different protein or invalid file', async () => {
    await expect(
      validatePredictionCoordinates(pdb, 'pdb', await coordinateDigest('MAG'))
    ).resolves.toBeUndefined();
    await expect(
      validatePredictionCoordinates(pdb, 'pdb', await coordinateDigest('MWG'))
    ).rejects.toThrow(/protein/);
    await expect(
      validatePredictionCoordinates('not coordinates', 'pdb', await coordinateDigest('MAG'))
    ).rejects.toThrow();
  });
});
