import { describe, expect, it } from 'vitest';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure } from 'molstar/lib/mol-model/structure';
import { molecularSceneSelections } from './molecularSceneSelections';
import { computeMolecularInterfaceBurial } from './molecularInterfaceBurial';

async function fixture(partnerX = 3, ligand = false) {
  const atom = (serial: number, name: string, chain: string, residue: number, x: number) =>
    `${ligand && chain === 'B' ? 'HETATM' : 'ATOM  '}${String(serial).padStart(5)} ${name.padEnd(4)} ${ligand && chain === 'B' ? 'LIG' : 'ALA'} ${chain}${String(residue).padStart(4)}    ${x.toFixed(3).padStart(8)}${'0.000'.padStart(8)}${'0.000'.padStart(8)}  1.00 20.00           C  `;
  const pdb = [
    atom(1, ' CA ', 'A', 1, 0),
    atom(2, ' CB ', 'A', 1, 1),
    atom(3, ' CA ', 'A', 2, 30),
    atom(4, ' CB ', 'A', 2, 31),
    'TER',
    atom(5, ' CA ', 'B', 1, partnerX),
    atom(6, ' CB ', 'B', 1, partnerX + 1),
    'END',
  ].join('\n');
  const parsed = await parsePDB(pdb).run();
  if (parsed.isError) throw Error(parsed.message);
  const source = Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative);
  const selections = molecularSceneSelections(source);
  return {
    source,
    target: selections.select({ auth_asym_id: 'A' }),
    partner: selections.select({ auth_asym_id: 'B' }),
  };
}

describe('partner-induced native surface burial', () => {
  it('includes a nonpolar interface and excludes the remote residue', async () => {
    const f = await fixture();
    const result = await computeMolecularInterfaceBurial(f.source, f.target, f.partner);
    const patch = molecularSceneSelections(f.source).select(result.target.selector);
    expect(result.target.buriedArea).toBeGreaterThan(0);
    expect(result.partner.buriedArea).toBeGreaterThan(0);
    expect(result.target.residueCount).toBe(1);
    expect(patch.elementCount).toBe(2);
    expect(result.parameters).toEqual({
      probeSize: 1.4,
      numberOfSpherePoints: 92,
      nonPolymer: true,
      traceOnly: false,
    });
  });

  it('does not equate existing low exposure or proximity to partner-induced burial', async () => {
    const f = await fixture(60);
    const result = await computeMolecularInterfaceBurial(f.source, f.target, f.partner);
    expect(result.target.buriedArea).toBe(0);
    expect(result.partner.buriedArea).toBe(0);
    expect(result.target.residueCount).toBe(0);
    expect(result.target.selector).toEqual([]);
  });

  it('includes nonpolymer partners in the same fixed native calculation', async () => {
    const f = await fixture(3, true);
    const result = await computeMolecularInterfaceBurial(f.source, f.target, f.partner);
    expect(result.target.buriedArea).toBeGreaterThan(0);
    expect(result.partner.residueCount).toBe(1);
  });
});
