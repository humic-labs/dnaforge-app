import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import { Structure, Unit } from 'molstar/lib/mol-model/structure';
import { isProtein, isNucleic } from 'molstar/lib/mol-model/structure/model/types';
import { getSequence } from 'molstar/lib/mol-model/sequence/alignment/sequence';
import { align } from 'molstar/lib/mol-model/sequence/alignment/alignment';
import {
  MinimizeRmsd,
  RmsdTransformState,
} from 'molstar/lib/mol-math/linear-algebra/3d/minimize-rmsd';
import { Matrix } from 'molstar/lib/mol-math/linear-algebra/matrix/matrix';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { SortedArray } from 'molstar/lib/mol-data/int';
import type { MolstarPlugin } from './cache';
import {
  assignMolViewSpecStructureRefs,
  molViewSpecStructureBindings,
  resolveMolViewSpecStructureRef,
} from './molViewSpecStructureIdentity';

type Anchor = {
  labelAsymId: string;
  authAsymId: string;
  authSeqId: number;
  labelSeqId: number;
  insertionCode: string;
  compId: string;
  atomName: string;
  atomIndex: number;
  sequenceCode: string;
  polymer: 'protein' | 'nucleic';
  position: number[];
};
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function anchors(parent: Structure, selector: unknown): Anchor[] {
  const selected = substructureFromSelector(
    parent,
    componentPropsFromSelector(selector as Parameters<typeof componentPropsFromSelector>[0])
  );
  const result: Anchor[] = [];
  const chains = new Set<string>();
  for (const selectedUnit of selected.units) {
    if (!Unit.isAtomic(selectedUnit))
      fail(
        'MVS_ALIGNMENT_COORDINATES_UNSUPPORTED',
        'Alignment requires atomic polymer coordinates.'
      );
    const unit = parent.unitMap.get(selectedUnit.id);
    if (!unit || !Unit.isAtomic(unit))
      fail(
        'MVS_ALIGNMENT_COORDINATES_UNSUPPORTED',
        'The selected polymer has no exact coordinate parent.'
      );
    const h = unit.model.atomicHierarchy;
    const residues = new Set(Array.from(selectedUnit.elements, (atom) => unit.residueIndex[atom]));
    let codes: Map<number, string> | undefined;
    for (const residue of residues) {
      const type = h.derived.residue.moleculeType[residue];
      if (!isProtein(type) && !isNucleic(type)) continue;
      const atom = h.derived.residue.traceElementIndex[residue];
      if (atom === -1 || !SortedArray.has(unit.elements, atom)) continue;
      chains.add(`${unit.id}:${unit.chainIndex[atom]}`);
      if (chains.size > 1)
        fail(
          'MVS_ALIGNMENT_AMBIGUOUS',
          'Select one physical polymer chain in each structure, including its instance when necessary.'
        );
      if (!codes) {
        const sequence = getSequence(unit);
        codes = new Map(
          Array.from({ length: sequence.length }, (_, i) => [
            sequence.seqId.value(i),
            sequence.code.value(i),
          ])
        );
      }
      const labelSeqId = h.residues.label_seq_id.value(residue);
      const sequenceCode = codes.get(labelSeqId);
      if (!sequenceCode || sequenceCode === 'X')
        fail(
          'MVS_ALIGNMENT_SEQUENCE_UNAVAILABLE',
          'The selected coordinate sequence contains an unidentified polymer residue.'
        );
      const chain = unit.chainIndex[atom];
      const position = Array.from(unit.conformation.position(atom, Vec3()));
      if (position.some((value) => !Number.isFinite(value)))
        fail(
          'MVS_ALIGNMENT_COORDINATES_UNAVAILABLE',
          'An alignment anchor has no finite coordinates.'
        );
      result.push({
        labelAsymId: h.chains.label_asym_id.value(chain),
        authAsymId: h.chains.auth_asym_id.value(chain),
        authSeqId: h.residues.auth_seq_id.value(residue),
        labelSeqId,
        insertionCode: h.residues.pdbx_PDB_ins_code.value(residue),
        compId: h.atoms.label_comp_id.value(atom),
        atomName: h.atoms.label_atom_id.value(atom),
        atomIndex: atom,
        sequenceCode,
        polymer: isProtein(type) ? 'protein' : 'nucleic',
        position,
      });
    }
  }
  if (!result.length)
    fail('MVS_ALIGNMENT_EMPTY', 'The declared region contains no observed polymer trace atoms.');
  if (result.length > 2000)
    fail(
      'MVS_ALIGNMENT_REGION_TOO_LARGE',
      'Select a region of at most 2,000 observed polymer residues for alignment.'
    );
  return result;
}

function nonCollinear(points: readonly number[][]): boolean {
  const origin = Vec3.fromArray(Vec3(), points[0], 0);
  const vectors = points
    .slice(1)
    .map((p) => Vec3.sub(Vec3(), Vec3.fromArray(Vec3(), p, 0), origin));
  const longest = vectors.reduce((a, b) =>
    Vec3.squaredMagnitude(a) >= Vec3.squaredMagnitude(b) ? a : b
  );
  const scale = Vec3.squaredMagnitude(longest);
  return (
    scale > 0 &&
    vectors.some(
      (v) => Vec3.squaredMagnitude(Vec3.cross(Vec3(), longest, v)) > scale * scale * 1e-10
    )
  );
}

export function computeMolecularAlignment(
  reference: Structure,
  mobile: Structure,
  referenceSelector: unknown,
  mobileSelector: unknown
) {
  const a = anchors(reference, referenceSelector),
    b = anchors(mobile, mobileSelector);
  if (a[0].polymer !== b[0].polymer)
    fail(
      'MVS_ALIGNMENT_POLYMER_MISMATCH',
      'The declared regions contain different polymer classes.'
    );
  const correspondence = align(
    a.map((p) => p.sequenceCode),
    b.map((p) => p.sequenceCode),
    { substMatrix: a[0].polymer === 'protein' ? 'blosum62' : 'default' }
  );
  const pairs: Array<{ reference: Anchor; mobile: Anchor }> = [];
  let ai = 0,
    bi = 0;
  for (let i = 0; i < correspondence.aliA.length; i++) {
    const hasA = correspondence.aliA[i] !== '-',
      hasB = correspondence.aliB[i] !== '-';
    if (hasA && hasB) pairs.push({ reference: a[ai], mobile: b[bi] });
    if (hasA) ai++;
    if (hasB) bi++;
  }
  if (pairs.length < 3)
    fail(
      'MVS_ALIGNMENT_INSUFFICIENT',
      'Alignment requires at least three corresponding observed trace atoms.'
    );
  if (
    !nonCollinear(pairs.map((p) => p.reference.position)) ||
    !nonCollinear(pairs.map((p) => p.mobile.position))
  )
    fail('MVS_ALIGNMENT_DEGENERATE', 'Alignment requires non-collinear corresponding coordinates.');
  const positions = (side: 'reference' | 'mobile') => ({
    x: pairs.map((p) => p[side].position[0]),
    y: pairs.map((p) => p[side].position[1]),
    z: pairs.map((p) => p[side].position[2]),
  });
  const data = { a: positions('reference'), b: positions('mobile') };
  const fit = { bTransform: Mat4.zero(), rmsd: 0, nAlignedElements: 0 };
  const state = new RmsdTransformState(data, fit);
  state.evdCache.matrix = Matrix.create(4, 4, Float64Array);
  MinimizeRmsd.compute(data, fit, state);
  if (
    !Array.from(fit.bTransform).every(Number.isFinite) ||
    !Mat4.isRotationAndTranslation(fit.bTransform)
  )
    fail('MVS_ALIGNMENT_INVALID_TRANSFORM', 'The computed fit is not a finite rigid transform.');
  const rmsd = Math.sqrt(
    pairs.reduce((sum, pair) => {
      const transformed = Vec3.transformMat4(
        Vec3(),
        Vec3.fromArray(Vec3(), pair.mobile.position, 0),
        fit.bTransform
      );
      return (
        sum + Vec3.squaredDistance(transformed, Vec3.fromArray(Vec3(), pair.reference.position, 0))
      );
    }, 0) / pairs.length
  );
  return {
    matrix: fit.bTransform,
    rmsd,
    alignmentScore: correspondence.score,
    pairs,
    referenceSelector,
    mobileSelector,
    correspondenceSource: 'coordinates' as const,
  };
}

export function planMolecularAlignment(
  plugin: MolstarPlugin,
  scene: string,
  snapshotIndex: number,
  referenceRef: string,
  mobileRef: string,
  referenceSelector: unknown,
  mobileSelector: unknown,
  maximumRmsd?: number
) {
  if (referenceRef === mobileRef)
    fail('MVS_ALIGNMENT_SAME_STRUCTURE', 'Choose two distinct structure references.');
  const document = assignMolViewSpecStructureRefs(MVSData.fromMVSJ(scene));
  const bindings = molViewSpecStructureBindings(document, snapshotIndex);
  const reference = bindings.find((b) => b.ref === referenceRef),
    mobile = bindings.find((b) => b.ref === mobileRef);
  if (!reference || !mobile)
    fail(
      'MVS_ALIGNMENT_STRUCTURE_UNAVAILABLE',
      'Both structures must be loaded in the current scene step.'
    );
  const fit = computeMolecularAlignment(
    resolveMolViewSpecStructureRef(plugin, referenceRef),
    resolveMolViewSpecStructureRef(plugin, mobileRef),
    referenceSelector,
    mobileSelector
  );
  if (maximumRmsd !== undefined && fit.rmsd > maximumRmsd)
    fail(
      'MVS_ALIGNMENT_RMSD_EXCEEDED',
      `The coordinate fit RMSD ${fit.rmsd.toFixed(3)} Å exceeds the requested ${maximumRmsd} Å.`
    );
  const provenance = {
    contract: 'source-polymer-alignment-v1',
    referenceStructureRef: referenceRef,
    mobileStructureRef: mobileRef,
    referenceRegion: referenceSelector,
    mobileRegion: mobileSelector,
    ...fit,
    matrix: Array.from(fit.matrix),
  };
  mobile.node.children ??= [];
  mobile.node.children.push({
    kind: 'transform',
    params: { matrix: Array.from(fit.matrix) },
    custom: { dnaforge_alignment: provenance },
  });
  return {
    scene: MVSData.toMVSJ(document),
    provenance,
    validateNative: (current: MolstarPlugin) => {
      const checked = computeMolecularAlignment(
        resolveMolViewSpecStructureRef(current, referenceRef),
        resolveMolViewSpecStructureRef(current, mobileRef),
        referenceSelector,
        mobileSelector
      );
      const identity = (a: Anchor) =>
        JSON.stringify([
          a.labelAsymId,
          a.authAsymId,
          a.authSeqId,
          a.labelSeqId,
          a.insertionCode,
          a.compId,
          a.atomName,
          a.atomIndex,
        ]);
      if (
        checked.pairs.length !== fit.pairs.length ||
        checked.pairs.some(
          (pair, i) =>
            identity(pair.reference) !== identity(fit.pairs[i].reference) ||
            identity(pair.mobile) !== identity(fit.pairs[i].mobile)
        )
      )
        fail(
          'MVS_ALIGNMENT_NATIVE_MISMATCH',
          'Native rendering changed the recorded coordinate correspondence.'
        );
      const actualRmsd = Math.sqrt(
        checked.pairs.reduce(
          (sum, pair) =>
            sum +
            Vec3.squaredDistance(
              Vec3.fromArray(Vec3(), pair.reference.position, 0),
              Vec3.fromArray(Vec3(), pair.mobile.position, 0)
            ),
          0
        ) / checked.pairs.length
      );
      if (Math.abs(actualRmsd - fit.rmsd) > 1e-5)
        fail(
          'MVS_ALIGNMENT_NATIVE_MISMATCH',
          'The native placement does not reproduce the recorded alignment.'
        );
    },
  };
}
