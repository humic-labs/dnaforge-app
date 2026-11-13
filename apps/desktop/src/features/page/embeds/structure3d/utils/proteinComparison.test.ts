import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Structure } from 'molstar/lib/mol-model/structure';
import { getResiduesLoci } from '../hooks/useResidueHighlight';
import { StructureElement } from 'molstar/lib/mol-model/structure';
import { extractSequenceDataFromPlugin } from '../hooks/useSequenceData';
import { residueTargetsFromExtractedQueryChains } from './structureLinkTargets';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import {
  buildProteinComparisonCoordinates,
  buildProteinComparisonScene,
  readVerifiedProteinChain,
  type ProteinComparisonInput,
} from './proteinComparison';

const sequence =
  'MNIFEMLRIDEGLRLKIYKDTEGYYTIGIGHLLTKSPSLNAAKSELDKAIGRNTNGVITKDEAEKLFNQDVDAAVRGILRNAKLKPVYDSLDAVRRAALINMVFQMGETGVAGFTNSLRMLQQKRWDEAAVNLAKSRWYNQTPNRAKRVITTFRTGTWDAYKNL';
const source = (id: string) =>
  readFileSync(
    resolve(process.cwd(), '../../test-fixtures/structure-comparisons', `${id}.cif`),
    'utf8'
  );
function input(): ProteinComparisonInput {
  return {
    reference: { text: source('1L63'), format: 'cif', sequence },
    alternate: {
      text: source('1L90'),
      format: 'cif',
      sequence: sequence.slice(0, 98) + 'A' + sequence.slice(99),
    },
    alternateToReference: Array.from(sequence, (_, index) => index),
  };
}

describe('real reference and alternate protein coordinates', () => {
  it('recognizes encoded methionine while retaining actual selenomethionine atoms', async () => {
    const text = readFileSync(
      resolve(process.cwd(), '../../test-fixtures/structure-complexes/rcsb/1A8O.cif'),
      'utf8'
    );
    const verified = await readVerifiedProteinChain({
      text,
      format: 'cif',
      chainId: 'A',
      sequence: 'MDIRQGPKEPFRDYVDRFYKTLRAEQASQEVKNWMTETLLVQNANPDCKTILKALGPGATLEEMMTACQG',
    });
    expect(verified.components).toHaveLength(70);
    expect(verified.atoms.filter((atom) => atom.element.toUpperCase() === 'SE')).toHaveLength(4);
    expect(
      verified.atoms.filter((atom) => atom.position === 0).every((atom) => atom.compId === 'MSE')
    ).toBe(true);
  });
  it('superposes unchanged atoms, retains real LEU/ALA atoms, and separates their models', async () => {
    const result = await buildProteinComparisonCoordinates(input());
    expect(result.alignment.pairs).toHaveLength(161);
    expect(result.alignment.pairs.some((pair) => pair.reference === 98)).toBe(false);
    expect(result.alignment.rmsd).toBeCloseTo(0.10075410513767258, 7);
    expect(result.alignment.transform.slice(12, 15)).toEqual([
      expect.closeTo(0.01095408365306838, 4),
      expect.closeTo(-0.16377023564620607, 4),
      expect.closeTo(-0.06882249643521554, 4),
    ]);
    const parsed = await CIF.parseText(result.text).run();
    if (parsed.isError) throw new Error(parsed.message);
    const db = CIF.schema.mmCIF(parsed.result.blocks[0]);
    const atoms = db.atom_site;
    const rows = Array.from({ length: atoms._rowCount }, (_, i) => i);
    const at99 = (model: number) =>
      rows.filter(
        (i) => atoms.pdbx_PDB_model_num.value(i) === model && atoms.label_seq_id.value(i) === 99
      );
    expect(at99(1).map((i) => atoms.label_atom_id.value(i))).toEqual([
      'N',
      'CA',
      'C',
      'O',
      'CB',
      'CG',
      'CD1',
      'CD2',
    ]);
    expect(at99(1).map((i) => atoms.label_comp_id.value(i))).toEqual(Array(8).fill('LEU'));
    expect(at99(2).map((i) => atoms.label_atom_id.value(i))).toEqual(['N', 'CA', 'C', 'O', 'CB']);
    expect(at99(2).map((i) => atoms.label_comp_id.value(i))).toEqual(Array(5).fill('ALA'));
    const native = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
    expect(native.frameCount).toBe(2);
    expect(new Set(rows.map((i) => atoms.label_asym_id.value(i)))).toEqual(new Set(['R', 'V']));
    expect(rows.every((i) => atoms.group_PDB.value(i) === 'ATOM')).toBe(true);
    expect(rows.some((i) => atoms.label_seq_id.value(i) > 162)).toBe(false);
  });

  it('refuses reference coordinates relabeled as the alternate protein', async () => {
    const request = input();
    request.alternate.text = request.reference.text;
    await expect(buildProteinComparisonCoordinates(request)).rejects.toThrow(/sequence/i);
  });

  it('checks actual residue identities even when the declared sequence claims a match', async () => {
    const request = input();
    const original = request.alternate.text;
    request.alternate.text = original.replace(
      /(ATOM\s+\d+\s+\S+\s+\S+\s+\S+\s+)ALA(\s+A\s+1\s+99\s+)/g,
      '$1LEU$2'
    );
    expect(request.alternate.text).not.toBe(original);
    await expect(buildProteinComparisonCoordinates(request)).rejects.toThrow(/atom.*sequence/i);
  });

  it('refuses collinear anchors even when there are many of them', async () => {
    const request = input();
    const original = request.reference.text;
    const fields = [...original.matchAll(/^_atom_site\.(\w+)/gm)].map((match) => match[1]);
    request.reference.text = original.replace(/^ATOM\s+.+$/gm, (line) => {
      const values = line.trim().split(/\s+/);
      values[fields.indexOf('Cartn_y')] = '0';
      values[fields.indexOf('Cartn_z')] = '0';
      return values.join(' ');
    });
    expect(request.reference.text).not.toBe(original);
    await expect(buildProteinComparisonCoordinates(request)).rejects.toThrow(/non-collinear/i);
  });

  it('refuses non-unique or out-of-bounds residue correspondence', async () => {
    const request = input();
    request.alternateToReference[99] = 98;
    await expect(buildProteinComparisonCoordinates(request)).rejects.toThrow(/correspondence/i);
    request.alternateToReference[99] = 200;
    await expect(buildProteinComparisonCoordinates(request)).rejects.toThrow(/correspondence/i);
  });

  it('refuses an underdetermined fit without replacing absent coordinates', async () => {
    const request = input();
    request.alternateToReference = Array(sequence.length).fill(null);
    request.alternateToReference[0] = 0;
    request.alternateToReference[1] = 1;
    await expect(buildProteinComparisonCoordinates(request)).rejects.toThrow(/three.*anchor/i);
  });
});

it('authors two models with genuine changed side-chain selectors and explicit opacity', async () => {
  const result = await buildProteinComparisonCoordinates(input());
  const scene = JSON.parse(buildProteinComparisonScene(result));
  const models = scene.root.children[0].children[0].children;
  expect(models.map((m: any) => m.params.model_index)).toEqual([0, 1]);
  const sidechain = (i: number) =>
    models[i].children.find((c: any) => Array.isArray(c.params.selector));
  expect(sidechain(0).params.selector.map((a: any) => a.label_atom_id)).toEqual([
    'CB',
    'CG',
    'CD1',
    'CD2',
  ]);
  expect(sidechain(1).params.selector).toEqual([
    { label_asym_id: 'V', label_seq_id: 99, label_atom_id: 'CB' },
  ]);
  expect(
    sidechain(0).children.find((n: any) => n.kind === 'representation').children
  ).toContainEqual({
    kind: 'opacity',
    params: { opacity: 0.35 },
  });
  expect(
    sidechain(1).children.find((n: any) => n.kind === 'representation').children
  ).toContainEqual({
    kind: 'opacity',
    params: { opacity: 1 },
  });
});

it('reads both comparison models and maps the alternate with the declared correspondence', async () => {
  const result = await buildProteinComparisonCoordinates(input());
  const parsed = await CIF.parseText(result.text).run();
  if (parsed.isError) throw new Error(parsed.message);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const { Task } = await import('molstar/lib/mol-task');
  const models = await Promise.all(
    [0, 1].map(async (i) => {
      const model = trajectory.getFrameAtIndex(i);
      return Task.is(model) ? model.run() : model;
    })
  );
  const plugin = {
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: models.map((model) => ({
              cell: { obj: { data: Structure.ofModel(model) } },
            })),
          },
        },
      },
    },
  };
  const loci = getResiduesLoci(plugin as any, [
    { chain: 'R', position: 99 },
    { chain: 'V', position: 99 },
  ]);
  expect(loci.map((l) => StructureElement.Loci.size(l as StructureElement.Loci))).toEqual([8, 5]);
  const chains = extractSequenceDataFromPlugin(plugin, 'chain', true)!.chains;
  expect(
    chains.map((chain) => [
      chain.labelAsymId,
      chain.residues.find((r) => r.labelSeqId === 99)?.name3,
    ])
  ).toEqual([
    ['R', 'LEU'],
    ['V', 'ALA'],
  ]);
  const mapping = [0, null, 1, ...Array.from({ length: 161 }, (_, i) => i + 2)];
  const attrs = { comparisonProvenance: { allele: { alternateToReference: mapping } } } as any;
  const targets = residueTargetsFromExtractedQueryChains(attrs, chains, sequence);
  expect(targets.find((t) => t.labelAsymId === 'V')!.residues!.slice(0, 3)).toEqual([
    { residueIndex: 0, position: 1, labelSeqId: 1 },
    { residueIndex: 1, position: 3, labelSeqId: 3 },
    { residueIndex: 2, position: 4, labelSeqId: 4 },
  ]);
});
