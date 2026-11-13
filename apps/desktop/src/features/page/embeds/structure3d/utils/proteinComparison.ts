import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { CifWriter } from 'molstar/lib/mol-io/writer/cif';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { encodedResidueIdentity, readEncodedPolymerChain } from './encodedPolymer';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { MinimizeRmsd } from 'molstar/lib/mol-math/linear-algebra/3d/minimize-rmsd';
import { MOLECULAR_VIEW_MAX_COORDINATE_BYTES } from './molecularView';

export interface ProteinComparisonInput {
  reference: { text: string; format: 'pdb' | 'cif'; sequence: string; chainId?: string };
  alternate: { text: string; format: 'pdb' | 'cif'; sequence: string; chainId?: string };
  alternateToReference: Array<number | null>;
}

type ProteinAtom = {
  position: number;
  name: string;
  compId: string;
  element: string;
  alt: string;
  occupancy: number;
  bFactor: number;
  group: 'ATOM' | 'HETATM';
  xyz: Vec3;
};

export async function readVerifiedProteinChain(input: ProteinComparisonInput['reference']) {
  if (!/^[ACDEFGHIKLMNPQRSTVWY]{1,24000}$/.test(input.sequence))
    throw new Error('The comparison requires a complete, unambiguous protein sequence.');
  if (
    !input.text ||
    new TextEncoder().encode(input.text).length > MOLECULAR_VIEW_MAX_COORDINATE_BYTES
  )
    throw new Error('The comparison coordinates are empty or exceed the saved-view size limit.');
  const trajectory = await (async () => {
    if (input.format === 'pdb') {
      const parsed = await parsePDB(input.text).run();
      if (parsed.isError) throw new Error(parsed.message);
      return trajectoryFromPDB(parsed.result).run();
    }
    const parsed = await CIF.parseText(input.text).run();
    if (parsed.isError) throw new Error(parsed.message);
    if (parsed.result.blocks.length !== 1)
      throw new Error('Choose one coordinate model for comparison.');
    return trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  })();
  if (trajectory.frameCount !== 1) throw new Error('Choose one coordinate model for comparison.');
  const model = trajectory.representative;
  const hierarchy = model.atomicHierarchy;
  const matches = Array.from({ length: hierarchy.chains._rowCount }, (_, chain) => chain).filter(
    (chain) => {
      if (input.chainId && hierarchy.chains.label_asym_id.value(chain) !== input.chainId)
        return false;
      const sequence = readEncodedPolymerChain(model, chain);
      return (
        sequence?.kind === 'protein' &&
        !sequence.unresolved.length &&
        sequence.sequence === input.sequence
      );
    }
  );
  if (!matches.length)
    throw new Error('No coordinate chain matches the requested protein sequence.');
  if (matches.length !== 1) throw new Error('Choose one matching protein chain for comparison.');
  const chain = matches[0];
  const sequence = readEncodedPolymerChain(model, chain)!;
  const chainId = hierarchy.chains.label_asym_id.value(chain);
  const indices = new Map(sequence.positions.map((position, index) => [position, index]));
  const atoms: ProteinAtom[] = [];
  for (
    let i = hierarchy.chainAtomSegments.offsets[chain];
    i < hierarchy.chainAtomSegments.offsets[chain + 1];
    i++
  ) {
    const residue = hierarchy.residueAtomSegments.index[i];
    const position = indices.get(hierarchy.residues.label_seq_id.value(residue));
    if (position === undefined)
      throw new Error('An atom has no verified position in its protein sequence.');
    const compId = hierarchy.atoms.label_comp_id.value(i);
    const identity = encodedResidueIdentity(
      model,
      chainId,
      hierarchy.residues.label_seq_id.value(residue),
      compId
    );
    if (!identity || identity.unresolved || identity.code !== input.sequence[position])
      throw new Error('A coordinate atom residue disagrees with the requested protein sequence.');
    const xyz = Vec3.create(
      model.atomicConformation.x[i],
      model.atomicConformation.y[i],
      model.atomicConformation.z[i]
    );
    if (!xyz.every(Number.isFinite)) throw new Error('A comparison coordinate is not finite.');
    atoms.push({
      position,
      name: hierarchy.atoms.label_atom_id.value(i),
      compId,
      element: hierarchy.atoms.type_symbol.value(i),
      alt: hierarchy.atoms.label_alt_id.value(i),
      occupancy: model.atomicConformation.occupancy.value(i),
      bFactor: model.atomicConformation.B_iso_or_equiv.value(i),
      group: hierarchy.residues.group_PDB.value(residue),
      xyz,
    });
  }
  return {
    chainId: hierarchy.chains.label_asym_id.value(chain),
    atoms,
    components: sequence.components,
  };
}

function alphaCarbons(atoms: ProteinAtom[]) {
  const result = new Map<number, ProteinAtom>();
  for (const atom of atoms) {
    if (atom.name !== 'CA' || atom.occupancy <= 0) continue;
    const prior = result.get(atom.position);
    if (
      !prior ||
      atom.occupancy > prior.occupancy ||
      (atom.occupancy === prior.occupancy && atom.alt < prior.alt)
    )
      result.set(atom.position, atom);
  }
  return result;
}

function nonCollinear(points: Vec3[]): boolean {
  if (points.length < 3) return false;
  const origin = points[0];
  const farthest = points.reduce((best, point) =>
    Vec3.squaredDistance(origin, point) > Vec3.squaredDistance(origin, best) ? point : best
  );
  const axis = Vec3.sub(Vec3(), farthest, origin);
  const scale = Vec3.squaredMagnitude(axis);
  return (
    scale > 0 &&
    points.some(
      (point) =>
        Vec3.squaredMagnitude(Vec3.cross(Vec3(), axis, Vec3.sub(Vec3(), point, origin))) >
        scale * scale * 1e-10
    )
  );
}

export async function buildProteinComparisonCoordinates(input: ProteinComparisonInput): Promise<{
  text: string;
  format: 'cif';
  alignment: {
    pairs: Array<{ reference: number; alternate: number }>;
    transform: number[];
    rmsd: number;
  };
  referenceChain: string;
  alternateChain: string;
  changedSidechains: Array<
    Array<{ label_asym_id: string; label_seq_id: number; label_atom_id: string }>
  >;
}> {
  const map = input.alternateToReference;
  const mapped = map.filter((position): position is number => position !== null);
  if (
    map.length !== input.alternate.sequence.length ||
    mapped.some(
      (position) =>
        !Number.isInteger(position) || position < 0 || position >= input.reference.sequence.length
    ) ||
    new Set(mapped).size !== mapped.length ||
    mapped.some((position, i) => i > 0 && position <= mapped[i - 1])
  )
    throw new Error('The residue correspondence is not a one-to-one ordered protein mapping.');
  const [reference, alternate] = await Promise.all([
    readVerifiedProteinChain(input.reference),
    readVerifiedProteinChain(input.alternate),
  ]);
  const refCa = alphaCarbons(reference.atoms),
    altCa = alphaCarbons(alternate.atoms);
  const pairs = map.flatMap((ref, alt) =>
    ref !== null &&
    refCa.has(ref) &&
    altCa.has(alt) &&
    input.reference.sequence[ref] === input.alternate.sequence[alt]
      ? [{ reference: ref, alternate: alt }]
      : []
  );
  const a = pairs.map((pair) => refCa.get(pair.reference)!.xyz);
  const b = pairs.map((pair) => altCa.get(pair.alternate)!.xyz);
  if (!nonCollinear(a) || !nonCollinear(b))
    throw new Error(
      'Comparison needs at least three non-collinear unchanged alpha-carbon anchors.'
    );
  const positions = (points: Vec3[]) => ({
    x: points.map((p) => p[0]),
    y: points.map((p) => p[1]),
    z: points.map((p) => p[2]),
  });
  const { bTransform } = MinimizeRmsd.compute({ a: positions(a), b: positions(b) });
  if (!bTransform.every(Number.isFinite))
    throw new Error('The protein alignment did not produce a finite transform.');
  const transform = (point: Vec3) => Vec3.transformMat4(Vec3(), point, bTransform);
  const rmsd = Math.sqrt(
    a.reduce((sum, point, i) => sum + Vec3.squaredDistance(point, transform(b[i])), 0) /
      pairs.length
  );
  const encoder = CifWriter.createEncoder({
    binary: false,
    encoderName: 'DNAForge protein comparison',
  });
  encoder.startDataBlock('protein_comparison');
  const category = (name: string, rows: Array<Record<string, string | number>>) => {
    encoder.writeCategory({
      name,
      instance: () => ({
        fields: Object.keys(rows[0]).map((key) =>
          typeof rows[0][key] === 'number'
            ? CifWriter.Field.float(key, (i: number) => rows[i][key] as number, { digitCount: 6 })
            : CifWriter.Field.str(key, (i: number) => rows[i][key] as string)
        ),
        source: [{ rowCount: rows.length }],
      }),
    });
  };
  category('entity', [
    { id: '1', type: 'polymer', pdbx_description: 'Reference protein' },
    { id: '2', type: 'polymer', pdbx_description: 'Allele protein, rigidly aligned' },
  ]);
  category('struct_asym', [
    { id: 'R', entity_id: '1' },
    { id: 'V', entity_id: '2' },
  ]);
  category(
    'entity_poly',
    [input.reference, input.alternate].map((protein, i) => ({
      entity_id: String(i + 1),
      type: 'polypeptide(L)',
      pdbx_seq_one_letter_code: protein.sequence,
      pdbx_seq_one_letter_code_can: protein.sequence,
      pdbx_strand_id: i ? 'V' : 'R',
    }))
  );
  category(
    'entity_poly_seq',
    [reference, alternate].flatMap((protein, i) =>
      protein.components.map((mon_id, position) => ({
        entity_id: String(i + 1),
        num: position + 1,
        mon_id,
        hetero: 'n',
      }))
    )
  );
  category(
    'atom_site',
    [reference, alternate]
      .flatMap((protein, i) =>
        protein.atoms.map((atom) => {
          const xyz = i ? transform(atom.xyz) : atom.xyz;
          return {
            group_PDB: atom.group,
            type_symbol: atom.element,
            label_atom_id: atom.name,
            label_alt_id: atom.alt,
            label_comp_id: atom.compId,
            label_asym_id: i ? 'V' : 'R',
            label_entity_id: String(i + 1),
            label_seq_id: atom.position + 1,
            Cartn_x: xyz[0],
            Cartn_y: xyz[1],
            Cartn_z: xyz[2],
            occupancy: atom.occupancy,
            B_iso_or_equiv: atom.bFactor,
            auth_seq_id: atom.position + 1,
            auth_comp_id: atom.compId,
            auth_asym_id: i ? 'V' : 'R',
            auth_atom_id: atom.name,
            pdbx_PDB_model_num: i + 1,
          };
        })
      )
      .map((row, i) => ({ id: i + 1, ...row }))
  );
  const text = encoder.getData() as string;
  if (new TextEncoder().encode(text).length > MOLECULAR_VIEW_MAX_COORDINATE_BYTES)
    throw new Error('The combined protein coordinates exceed the saved-view size limit.');
  const unchangedReference = new Set(
    map.flatMap((ref, alt) =>
      ref !== null && input.reference.sequence[ref] === input.alternate.sequence[alt] ? [ref] : []
    )
  );
  return {
    text,
    format: 'cif',
    alignment: { pairs, transform: Array.from(bTransform), rmsd },
    referenceChain: reference.chainId,
    alternateChain: alternate.chainId,
    changedSidechains: [reference, alternate].map((protein, i) => {
      const changed = i
        ? new Set(
            map.flatMap((ref, alt) =>
              ref === null || input.reference.sequence[ref] !== input.alternate.sequence[alt]
                ? [alt]
                : []
            )
          )
        : new Set(
            Array.from(input.reference.sequence, (_, ref) => ref).filter(
              (ref) => !unchangedReference.has(ref)
            )
          );
      const seen = new Set<string>();
      return protein.atoms
        .filter((atom) => {
          if (
            !changed.has(atom.position) ||
            ['N', 'CA', 'C', 'O', 'OXT'].includes(atom.name) ||
            ['H', 'D', 'T'].includes(atom.element)
          )
            return false;
          const key = `${atom.position}:${atom.name}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((atom) => ({
          label_asym_id: i ? 'V' : 'R',
          label_seq_id: atom.position + 1,
          label_atom_id: atom.name,
        }));
    }),
  };
}

export function buildProteinComparisonScene(
  coordinates: Awaited<ReturnType<typeof buildProteinComparisonCoordinates>>
): string {
  const builder = MVSData.createBuilder();
  const parsed = builder.download({ url: 'structure.cif' }).parse({ format: 'mmcif' });
  for (const model_index of [0, 1]) {
    const model = parsed.modelStructure({ model_index });
    const context = model.component({ selector: 'protein' }).representation({ type: 'cartoon' });
    context.color({ color: model_index ? '#97b3bd' : '#b0b0b0' });
    context.opacity({ opacity: model_index ? 0.15 : 0.1 });
    const selector = coordinates.changedSidechains[model_index];
    if (!selector.length) continue;
    const component = model.component({ selector });
    if (model_index === 0 || !coordinates.changedSidechains[0].length)
      component.focus({ radius_extent: 6 });
    const atoms = component.representation({ type: 'ball_and_stick' });
    atoms.color({
      color: model_index ? '#e63946' : '#b0b0b0',
      custom: {
        dnaforge_legend_label: model_index ? 'Allele side chains' : 'Reference side chains',
      },
    });
    atoms.opacity({ opacity: model_index ? 1 : 0.35 });
  }
  return MVSData.toMVSJ(builder.getState());
}
