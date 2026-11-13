import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import type { ComponentExpressionT } from 'molstar/lib/extensions/mvs/tree/mvs/param-types';
import { SortedArray } from 'molstar/lib/mol-data/int';
import { Structure, Unit, type StructureElement } from 'molstar/lib/mol-model/structure';
import type { Model } from 'molstar/lib/mol-model/structure/model';
import {
  BondType,
  isNucleic,
  NucleicBackboneAtoms,
} from 'molstar/lib/mol-model/structure/model/types';
import * as NativeModelTypes from 'molstar/lib/mol-model/structure/model/types';
import { StructConn } from 'molstar/lib/mol-model-formats/structure/property/bonds/struct_conn';
import {
  DefaultBondProps,
  makeInterBondIgnoreTest,
  makeIntraBondIgnoreTest,
} from 'molstar/lib/mol-repr/structure/visual/util/bond';
import type { MolstarPlugin } from './cache';
import { DEFAULT_MOLECULAR_RENDER_PROFILE } from './molecularRenderProfile';
import { filterNucleotideAtomicStructure } from './nucleotideAtomicSelection';
import { unsupportedIonicMetalCoordination } from './molecularCoordination';

export type MolecularConnectionEndpoint = {
  labelAsymId: string;
  authAsymId: string;
  authSeqId: number;
  labelCompId: string;
  labelAtomId: string;
  element: string;
  instanceId: string;
  atomIndex: number | null;
  residueIndex: number | null;
  moleculeType: number;
  polymerType: number;
  coordinateAvailable: boolean;
  selector: ComponentExpressionT;
  residueSelector: ComponentExpressionT;
};

export type MolecularConnection = {
  id: string;
  structureIndex: number;
  kind: 'covalent' | 'disulfide' | 'metal-coordination' | 'hydrogen-bond' | 'unknown';
  source: 'deposited-struct_conn' | 'molstar-computed' | 'molstar-source-graph';
  sourceType: string;
  bondPresent: boolean;
  attachment: boolean;
  a: MolecularConnectionEndpoint;
  b: MolecularConnectionEndpoint;
};

export type MolecularConnectionCoverage = MolecularConnection & {
  status:
    | 'drawn'
    | 'not-depicted'
    | 'missing-attachment-geometry'
    | 'missing-coordinates'
    | 'source-bond-unavailable'
    | 'suppressed-unsupported-coordination';
  depictionIssue?: 'ionic-metal-to-metal';
  representationOwners: string[];
};

export type AttachmentSceneNode = {
  kind: string;
  ref?: string;
  params?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  children?: AttachmentSceneNode[];
};
export type AttachmentDocument = {
  root?: AttachmentSceneNode;
  snapshots?: Array<{ root: AttachmentSceneNode }>;
};

export class MolecularAttachmentError extends Error {
  readonly code = 'MISSING_COVALENT_ATTACHMENT';
  constructor(message: string) {
    super(message);
    this.name = 'MolecularAttachmentError';
  }
}

type InternalConnection = MolecularConnection & {
  model: Model;
  unitA?: Unit.Atomic;
  unitB?: Unit.Atomic;
  flags: BondType.Flag;
};
const inventoryCache = new WeakMap<Structure, InternalConnection[]>();
const atomicTypes = new Set(['ball_and_stick', 'ball-and-stick', 'line', 'spacefill', 'point']);
const surfaceTypes = new Set(['surface', 'molecular-surface', 'gaussian-surface']);
const moleculeTypes = (
  NativeModelTypes as unknown as { MoleculeType: { Unknown: number; Water: number } }
).MoleculeType;
const bondFlags = {
  Covalent: BondType.Names.covalent,
  Disulfide: BondType.Names.disulfide,
  MetallicCoordination: BondType.Names['metal-coordination'],
  HydrogenBond: BondType.Names['hydrogen-bond'],
  Computed: BondType.Names.computed,
};

function kind(flags: BondType.Flag): MolecularConnection['kind'] {
  if (flags & bondFlags.Disulfide) return 'disulfide';
  if (flags & bondFlags.Covalent) return 'covalent';
  if (flags & bondFlags.MetallicCoordination) return 'metal-coordination';
  if (flags & bondFlags.HydrogenBond) return 'hydrogen-bond';
  return 'unknown';
}

function endpoint(model: Model, atom: number, unit?: Unit.Atomic): MolecularConnectionEndpoint {
  const h = model.atomicHierarchy;
  const residue = h.residueAtomSegments.index[atom];
  const chain = h.chainAtomSegments.index[atom];
  const instanceId = unit?.conformation.operator.instanceId ?? '';
  const residueSelector: ComponentExpressionT = {
    label_asym_id: h.chains.label_asym_id.value(chain),
    auth_seq_id: h.residues.auth_seq_id.value(residue),
    label_comp_id: h.atoms.label_comp_id.value(atom),
    pdbx_PDB_ins_code: h.residues.pdbx_PDB_ins_code.value(residue),
    ...(instanceId ? { instance_id: instanceId } : {}),
  };
  return {
    labelAsymId: residueSelector.label_asym_id!,
    authAsymId: h.chains.auth_asym_id.value(chain),
    authSeqId: residueSelector.auth_seq_id!,
    labelCompId: residueSelector.label_comp_id!,
    labelAtomId: h.atoms.label_atom_id.value(atom),
    element: h.atoms.type_symbol.value(atom),
    instanceId,
    atomIndex: atom,
    residueIndex: residue,
    moleculeType: h.derived.residue.moleculeType[residue],
    polymerType: h.derived.residue.polymerType[residue],
    coordinateAvailable: !!unit,
    residueSelector,
    selector: {
      ...residueSelector,
      label_atom_id: h.atoms.label_atom_id.value(atom),
      atom_index: h.atomSourceIndex.value(atom),
    },
  };
}

function isAttachment(
  a: MolecularConnectionEndpoint,
  b: MolecularConnectionEndpoint,
  flags: BondType.Flag
): boolean {
  const distinctResidues =
    a.residueIndex !== null && b.residueIndex !== null
      ? a.residueIndex !== b.residueIndex
      : a.labelAsymId !== b.labelAsymId ||
        a.authSeqId !== b.authSeqId ||
        a.labelCompId !== b.labelCompId;
  return (
    !!(flags & bondFlags.Covalent) &&
    distinctResidues &&
    (a.polymerType === 0 || b.polymerType === 0) &&
    a.moleculeType !== moleculeTypes.Water &&
    b.moleculeType !== moleculeTypes.Water
  );
}

function pairKey(model: Model, a: number, b: number): string {
  return `${model.id}:${Math.min(a, b)}:${Math.max(a, b)}`;
}

function unitKey(unit: Unit.Atomic): string {
  return `${unit.model.id}:${unit.id}:${JSON.stringify(unit.conformation.operator.matrix)}`;
}

function inventory(structure: Structure): InternalConnection[] {
  const cached = inventoryCache.get(structure);
  if (cached) return cached;
  const result: InternalConnection[] = [];
  const deposited = new Map<string, { property: StructConn; entry: StructConn.Entry }>();
  for (const model of structure.models) {
    const property = StructConn.Provider.get(model);
    for (const entry of property?.entries ?? [])
      deposited.set(pairKey(model, entry.partnerA.atomIndex, entry.partnerB.atomIndex), {
        property: property!,
        entry,
      });
  }
  const seen = new Set<string>();
  const representedRows = new Set<string>();
  const addGraphBond = (
    aUnit: Unit.Atomic,
    aAtom: number,
    bUnit: Unit.Atomic,
    bAtom: number,
    flags: BondType.Flag
  ) => {
    if (aUnit.model !== bUnit.model) return;
    const model = aUnit.model;
    const record = deposited.get(pairKey(model, aAtom, bAtom));
    if (record && record.entry.partnerA.atomIndex !== aAtom) {
      [aUnit, bUnit] = [bUnit, aUnit];
      [aAtom, bAtom] = [bAtom, aAtom];
    }
    const a = endpoint(model, aAtom, aUnit),
      b = endpoint(model, bAtom, bUnit);
    if (a.residueIndex === b.residueIndex) return;
    if (!record && a.polymerType !== 0 && b.polymerType !== 0 && !(flags & bondFlags.Disulfide))
      return;
    const id = [`${unitKey(aUnit)}:${aAtom}`, `${unitKey(bUnit)}:${bAtom}`].sort().join('~');
    if (seen.has(id)) return;
    seen.add(id);
    if (record) representedRows.add(`${model.id}:${record.entry.rowIndex}`);
    result.push({
      id,
      structureIndex: 0,
      model,
      unitA: aUnit,
      unitB: bUnit,
      flags,
      kind: kind(flags),
      source: record
        ? 'deposited-struct_conn'
        : flags & bondFlags.Computed
          ? 'molstar-computed'
          : 'molstar-source-graph',
      sourceType: record
        ? record.property.data.conn_type_id.value(record.entry.rowIndex)
        : kind(flags),
      bondPresent: true,
      attachment: isAttachment(a, b, flags),
      a,
      b,
    });
  };
  for (const unit of structure.units) {
    if (!Unit.isAtomic(unit)) continue;
    const { a, b, edgeProps } = unit.bonds;
    for (let i = 0; i < a.length; i++)
      if (a[i] < b[i])
        addGraphBond(unit, unit.elements[a[i]], unit, unit.elements[b[i]], edgeProps.flags[i]);
  }
  for (const edge of structure.interUnitBonds.edges) {
    const a = structure.unitMap.get(edge.unitA),
      b = structure.unitMap.get(edge.unitB);
    if (a && b && Unit.isAtomic(a) && Unit.isAtomic(b))
      addGraphBond(a, a.elements[edge.indexA], b, b.elements[edge.indexB], edge.props.flag);
  }
  for (const model of structure.models) {
    const property = StructConn.Provider.get(model);
    if (!property) continue;
    const resolved = new Map(property.entries.map((entry) => [entry.rowIndex, entry]));
    for (let row = 0; row < property.data._rowCount; row++) {
      if (representedRows.has(`${model.id}:${row}`)) continue;
      const entry = resolved.get(row);
      const rawEndpoint = (
        partner: 1 | 2,
        atom: number | undefined
      ): MolecularConnectionEndpoint => {
        const data = property.data;
        const labelAsymId =
          partner === 1 ? data.ptnr1_label_asym_id.value(row) : data.ptnr2_label_asym_id.value(row);
        const authAsymId =
          partner === 1 ? data.ptnr1_auth_asym_id.value(row) : data.ptnr2_auth_asym_id.value(row);
        const authSeqId =
          partner === 1 ? data.ptnr1_auth_seq_id.value(row) : data.ptnr2_auth_seq_id.value(row);
        const labelCompId =
          partner === 1 ? data.ptnr1_label_comp_id.value(row) : data.ptnr2_label_comp_id.value(row);
        const labelAtomId =
          partner === 1 ? data.ptnr1_label_atom_id.value(row) : data.ptnr2_label_atom_id.value(row);
        if (atom === undefined) {
          const h = model.atomicHierarchy;
          for (let index = 0; index < h.atoms._rowCount; index++) {
            if (
              h.atoms.label_atom_id.value(index) === labelAtomId &&
              h.atoms.label_comp_id.value(index) === labelCompId &&
              h.chains.label_asym_id.value(h.chainAtomSegments.index[index]) === labelAsymId &&
              h.residues.auth_seq_id.value(h.residueAtomSegments.index[index]) === authSeqId
            ) {
              atom = index;
              break;
            }
          }
        }
        const unit =
          atom === undefined
            ? undefined
            : structure.units.find(
                (u): u is Unit.Atomic =>
                  Unit.isAtomic(u) && u.model === model && SortedArray.has(u.elements, atom!)
              );
        if (atom !== undefined) return endpoint(model, atom, unit);
        const residueSelector = {
          label_asym_id: labelAsymId,
          auth_seq_id: authSeqId,
          label_comp_id: labelCompId,
        };
        return {
          labelAsymId,
          authAsymId,
          authSeqId,
          labelCompId,
          labelAtomId,
          element: '',
          instanceId: '',
          atomIndex: null,
          residueIndex: null,
          moleculeType: moleculeTypes.Unknown,
          polymerType: 0,
          coordinateAvailable: false,
          selector: { ...residueSelector, label_atom_id: labelAtomId },
          residueSelector,
        };
      };
      const sourceType = property.data.conn_type_id.value(row);
      const flags =
        entry?.flags ??
        (sourceType === 'covale'
          ? bondFlags.Covalent
          : sourceType === 'disulf'
            ? bondFlags.Covalent | bondFlags.Disulfide
            : sourceType === 'metalc'
              ? bondFlags.MetallicCoordination
              : sourceType === 'hydrog'
                ? bondFlags.HydrogenBond
                : BondType.fromNames([]));
      const a = rawEndpoint(1, entry?.partnerA.atomIndex),
        b = rawEndpoint(2, entry?.partnerB.atomIndex);
      result.push({
        id: `${model.id}:struct_conn:${row}`,
        structureIndex: 0,
        model,
        flags,
        kind: kind(flags),
        source: 'deposited-struct_conn',
        sourceType,
        bondPresent: false,
        attachment: isAttachment(a, b, flags),
        a,
        b,
      });
    }
  }
  inventoryCache.set(structure, result);
  return result;
}

function publicConnection(
  connection: InternalConnection,
  structureIndex: number
): MolecularConnection {
  const { model: _model, unitA: _unitA, unitB: _unitB, flags: _flags, ...value } = connection;
  return { ...value, structureIndex };
}

export function readMolecularConnections(plugin: MolstarPlugin): MolecularConnection[] {
  return plugin.managers.structure.hierarchy.current.structures.flatMap((entry, index) => {
    const structure = entry.cell?.obj?.data;
    return structure
      ? inventory(structure).map((connection) => publicConnection(connection, index))
      : [];
  });
}

function endpointUnit(
  structure: Structure,
  connection: InternalConnection,
  side: 'a' | 'b'
): Unit.Atomic | undefined {
  const endpoint = connection[side];
  const original = side === 'a' ? connection.unitA : connection.unitB;
  return structure.units.find(
    (unit): unit is Unit.Atomic =>
      Unit.isAtomic(unit) &&
      unit.model === connection.model &&
      (!original || unitKey(unit) === unitKey(original)) &&
      endpoint.atomIndex !== null &&
      SortedArray.has(unit.elements, endpoint.atomIndex)
  );
}

function containsResidue(
  structure: Structure,
  connection: InternalConnection,
  side: 'a' | 'b'
): boolean {
  const point = connection[side],
    original = side === 'a' ? connection.unitA : connection.unitB;
  return structure.units.some(
    (unit) =>
      Unit.isAtomic(unit) &&
      unit.model === connection.model &&
      (!original || unitKey(unit) === unitKey(original)) &&
      Array.from(unit.elements).some((atom) =>
        point.residueIndex === null
          ? unit.model.atomicHierarchy.atoms.label_comp_id.value(atom) === point.labelCompId &&
            unit.model.atomicHierarchy.chains.label_asym_id.value(unit.chainIndex[atom]) ===
              point.labelAsymId &&
            unit.model.atomicHierarchy.residues.auth_seq_id.value(unit.residueIndex[atom]) ===
              point.authSeqId
          : unit.residueIndex[atom] === point.residueIndex
      )
  );
}

function containsNonPolymerSide(structure: Structure, connection: InternalConnection): boolean {
  return (
    (connection.a.polymerType === 0 && containsResidue(structure, connection, 'a')) ||
    (connection.b.polymerType === 0 && containsResidue(structure, connection, 'b'))
  );
}

function hasDifferentEndpointAlternative(
  structure: Structure,
  connection: InternalConnection,
  side: 'a' | 'b'
): boolean {
  const point = connection[side];
  if (point.atomIndex === null) return false;
  const hierarchy = connection.model.atomicHierarchy;
  const alternate = hierarchy.atoms.label_alt_id.value(point.atomIndex);
  if (!alternate || alternate === '.' || alternate === '?') return false;
  const original = side === 'a' ? connection.unitA : connection.unitB;
  return structure.units.some(
    (unit) =>
      Unit.isAtomic(unit) &&
      unit.model === connection.model &&
      (!original || unitKey(unit) === unitKey(original)) &&
      Array.from(unit.elements).some((atom) => {
        const selected = hierarchy.atoms.label_alt_id.value(atom);
        return (
          unit.residueIndex[atom] === point.residueIndex &&
          hierarchy.atoms.label_atom_id.value(atom) === point.labelAtomId &&
          !!selected &&
          selected !== '.' &&
          selected !== '?' &&
          selected !== alternate
        );
      })
  );
}

function actualBondDrawn(
  structure: Structure,
  connection: InternalConnection,
  type: string,
  props: Record<string, unknown>
): boolean {
  const a = endpointUnit(structure, connection, 'a'),
    b = endpointUnit(structure, connection, 'b');
  if (!a || !b) return false;
  const visuals = props.visuals as string[] | undefined;
  if (type !== 'ball-and-stick' && type !== 'line') return false;
  const bondProps = { ...DefaultBondProps, ...props };
  const ai = SortedArray.indexOf(a.elements, connection.a.atomIndex!),
    bi = SortedArray.indexOf(b.elements, connection.b.atomIndex!);
  if (unsupportedIonicMetalCoordination(structure, a, ai, b, bi, connection.flags)) return false;
  if (a.id === b.id) {
    if (visuals && !visuals.some((v) => v === 'intra-bond' || v === 'structure-intra-bond'))
      return false;
    const bonds = a.bonds;
    for (let i = bonds.offset[ai]; i < bonds.offset[ai + 1]; i++)
      if (bonds.b[i] === bi && !makeIntraBondIgnoreTest(structure, a, bondProps)?.(i)) return true;
    return false;
  }
  if (visuals && !visuals.includes('inter-bond')) return false;
  const edge = structure.interUnitBonds.getEdgeIndex(
    ai as StructureElement.UnitIndex,
    a.id,
    bi as StructureElement.UnitIndex,
    b.id
  );
  return edge >= 0 && !makeInterBondIgnoreTest(structure, bondProps)?.(edge);
}

function nativeCarbohydrateLinkDrawn(
  structure: Structure,
  connection: InternalConnection,
  props: Record<string, unknown>
): boolean {
  const visuals = props.visuals as string[] | undefined;
  if (
    visuals &&
    !visuals.includes('carbohydrate-terminal-link') &&
    !visuals.includes('carbohydrate-link')
  )
    return false;
  const data = structure.carbohydrates;
  return (
    ((!visuals || visuals.includes('carbohydrate-terminal-link')) &&
      data.terminalLinks.some((link) => {
        const sugar = data.elements[link.carbohydrateIndex];
        const atom = link.elementUnit.elements[link.elementIndex];
        return (
          (sugar.unit.model === connection.model &&
            sugar.residueIndex === connection.a.residueIndex &&
            link.elementUnit.model === connection.model &&
            atom === connection.b.atomIndex) ||
          (sugar.unit.model === connection.model &&
            sugar.residueIndex === connection.b.residueIndex &&
            link.elementUnit.model === connection.model &&
            atom === connection.a.atomIndex)
        );
      })) ||
    ((!visuals || visuals.includes('carbohydrate-link')) &&
      data.links.some((link) => {
        const a = data.elements[link.carbohydrateIndexA],
          b = data.elements[link.carbohydrateIndexB];
        return (
          a.unit.model === connection.model &&
          b.unit.model === connection.model &&
          ((a.residueIndex === connection.a.residueIndex &&
            b.residueIndex === connection.b.residueIndex) ||
            (a.residueIndex === connection.b.residueIndex &&
              b.residueIndex === connection.a.residueIndex))
        );
      }))
  );
}

export function molecularRepresentationOwnerRef(component: {
  cell: { transform?: { ref?: string }; obj?: { label?: string } };
}): string {
  return component.cell.transform?.ref ?? component.cell.obj?.label ?? 'Unnamed selection';
}

const nativeContactOwnerContract = 'native-bond-contact-owner-v1';

function contactAtomKey(unit: Unit.Atomic, atom: number): string {
  return `${unitKey(unit)}:${atom}`;
}

function nativeContactPairs(source: Structure): Map<string, InternalConnection> {
  const pairs = new Map<string, InternalConnection>();
  for (const connection of inventory(source)) {
    if (
      !connection.bondPresent ||
      !['hydrogen-bond', 'metal-coordination'].includes(connection.kind)
    )
      continue;
    const a = endpointUnit(source, connection, 'a'),
      b = endpointUnit(source, connection, 'b');
    if (!a || !b || connection.a.atomIndex === null || connection.b.atomIndex === null) continue;
    pairs.set(
      [contactAtomKey(a, connection.a.atomIndex), contactAtomKey(b, connection.b.atomIndex)]
        .sort()
        .join('|'),
      connection
    );
  }
  return pairs;
}

function effectiveContactOwnerSource(
  source: Structure,
  type: string,
  props: Record<string, unknown>
): Structure {
  return type === 'ball-and-stick'
    ? filterNucleotideAtomicStructure(
        source,
        props.dnaforgeNucleotideAtomicMode === 'base-only' ? 'base-only' : 'full',
        (props.dnaforgeNucleotideKeepAtoms ?? []) as readonly unknown[]
      )
    : source;
}

function positiveContactSize(props: Record<string, unknown>): boolean {
  return (
    (props.sizeFactor === undefined || Number(props.sizeFactor) > 0) &&
    (props.sizeAspectRatio === undefined || Number(props.sizeAspectRatio) > 0)
  );
}

export function resolveMolViewSpecNativeContactOwners<T extends AttachmentDocument>(
  document: T,
  sourceForStructure: (node: AttachmentSceneNode, snapshotIndex: number) => Structure | undefined
): T {
  const resolved = structuredClone(document);
  const roots = [resolved.root, ...(resolved.snapshots ?? []).map((s) => s.root)].filter(
    (root): root is AttachmentSceneNode => !!root
  );
  for (const [index, root] of roots.entries()) {
    const sources = new Map<string, Structure>();
    const pairsBySource = new Map<Structure, Map<string, InternalConnection>>();
    const owners: Array<AttachmentOwner & { structureRef: string }> = [];
    const collect = (node: AttachmentSceneNode, hidden = false): void => {
      hidden ||= node.custom?.is_hidden === true;
      if (node.kind === 'structure' && node.ref) {
        const source = sourceForStructure(node, index);
        if (source) {
          sources.set(node.ref, source);
          if (!pairsBySource.has(source)) pairsBySource.set(source, nativeContactPairs(source));
          if (!hidden)
            for (const component of node.children ?? []) {
              if (component.kind !== 'component' || component.custom?.is_hidden === true) continue;
              for (const representation of component.children ?? []) {
                if (
                  representation.kind !== 'representation' ||
                  representation.custom?.is_hidden === true ||
                  !['ball_and_stick', 'line'].includes(String(representation.params?.type)) ||
                  sceneOpacity(representation) <= 0 ||
                  representation.children?.some(
                    (child) => child.kind === 'opacity' && Number(child.params?.opacity) <= 0
                  )
                )
                  continue;
                owners.push({
                  component,
                  representation,
                  source: selectedStructure(source, component.params?.selector),
                  structureRef: node.ref,
                });
              }
            }
        }
      }
      for (const child of node.children ?? []) collect(child, hidden);
    };
    collect(root);
    const oneAtom = (source: Structure, point: unknown) => {
      const p = point as { expressions?: unknown; expression?: unknown } | undefined;
      if (!p || Array.isArray(p) || !(p.expressions ?? p.expression)) return;
      const selected = selectedStructure(source, p.expressions ?? p.expression);
      if (selected.elementCount !== 1 || selected.units[0]?.kind !== 0) return;
      return { unit: selected.units[0] as Unit.Atomic, atom: selected.units[0].elements[0] };
    };
    const visit = (node: AttachmentSceneNode, defaultRef?: string): void => {
      if (node.kind === 'structure') defaultRef = node.ref;
      if (node.kind === 'primitives' && typeof node.params?.structure_ref === 'string')
        defaultRef = node.params.structure_ref;
      if (node.kind === 'primitive') {
        if (node.custom) delete node.custom.dnaforge_contact_native_owner;
        const evidence = node.custom?.dnaforge_contact_evidence as
          | { contract?: string }
          | undefined;
        if (
          evidence?.contract === 'typed-native-contact-v1' &&
          ['tube', 'distance_measurement'].includes(String(node.params?.kind))
        ) {
          const aPoint = node.params?.start as { structure_ref?: string } | undefined,
            bPoint = node.params?.end as { structure_ref?: string } | undefined;
          const aRef = aPoint?.structure_ref ?? defaultRef,
            bRef = bPoint?.structure_ref ?? defaultRef;
          const source = aRef && sources.get(aRef),
            other = bRef && sources.get(bRef);
          if (source && source === other && aRef === bRef) {
            const a = oneAtom(source, aPoint),
              b = oneAtom(source, bPoint);
            const connection =
              a &&
              b &&
              pairsBySource
                .get(source)
                ?.get(
                  [contactAtomKey(a.unit, a.atom), contactAtomKey(b.unit, b.atom)].sort().join('|')
                );
            if (connection) {
              const owner = owners.find((owner) => {
                const type = String(owner.representation.params?.type).replace(/_/g, '-');
                const props = (owner.representation.custom?.molstar_representation_params ??
                  {}) as Record<string, unknown>;
                return (
                  owner.structureRef === aRef &&
                  positiveContactSize(props) &&
                  actualBondDrawn(
                    effectiveContactOwnerSource(owner.source, type, props),
                    connection,
                    type,
                    props
                  )
                );
              });
              if (owner) {
                node.custom = {
                  ...node.custom,
                  dnaforge_contact_native_owner: {
                    contract: nativeContactOwnerContract,
                    structureRef: aRef,
                    kind: connection.kind,
                    source: connection.source,
                    sourceType: connection.sourceType,
                    a: connection.a.selector,
                    b: connection.b.selector,
                    owner: {
                      selector: owner.component.params?.selector,
                      type: String(owner.representation.params?.type).replace(/_/g, '-'),
                      nativeProps: owner.representation.custom?.molstar_representation_params ?? {},
                    },
                  },
                };
              }
            }
          }
        }
      }
      for (const child of node.children ?? []) visit(child, defaultRef);
    };
    visit(root);
  }
  return resolved;
}

export function omitNativeOwnedContactGuideGeometry(root: AttachmentSceneNode): void {
  for (const node of nodesOfKind(root, 'primitives'))
    node.children = node.children?.filter(
      (child) =>
        (child.custom?.dnaforge_contact_native_owner as { contract?: string } | undefined)
          ?.contract !== nativeContactOwnerContract
    );
}

export function requireMolViewSpecNativeContactOwners(
  plugin: MolstarPlugin,
  root: AttachmentSceneNode,
  sourceForStructure: (node: AttachmentSceneNode) => Structure | undefined
): void {
  const claims = nodesOfKind(root, 'primitive')
    .map(
      (node) =>
        node.custom?.dnaforge_contact_native_owner as
          | {
              contract?: string;
              structureRef: string;
              kind: string;
              a: ComponentExpressionT;
              b: ComponentExpressionT;
            }
          | undefined
    )
    .filter((claim) => claim?.contract === nativeContactOwnerContract);
  if (!claims.length) return;
  const sources = new Map(
    nodesOfKind(root, 'structure').map((node) => [node.ref, sourceForStructure(node)])
  );
  const entries = plugin.managers.structure.hierarchy.current.structures;
  const pairsBySource = new Map<Structure, Map<string, InternalConnection>>();
  const hidden = (ref: string): boolean => {
    let cell = plugin.state.data.cells.get(ref);
    while (cell) {
      if (cell.state.isHidden) return true;
      const parent = plugin.state.data.tree.transforms.get(cell.transform.ref)?.parent;
      if (!parent || parent === cell.transform.ref) break;
      cell = plugin.state.data.cells.get(parent);
    }
    return false;
  };
  for (const claim of claims) {
    const source = sources.get(claim!.structureRef);
    const structureIndex = entries.findIndex((entry) => entry.cell?.obj?.data === source);
    const selected = (selector: ComponentExpressionT) =>
      source ? selectedStructure(source, selector) : undefined;
    const a = selected(claim!.a),
      b = selected(claim!.b);
    const signature = (selected: Structure | undefined) =>
      selected?.elementCount === 1 && selected.units[0]?.kind === 0
        ? contactAtomKey(selected.units[0], selected.units[0].elements[0])
        : undefined;
    const pair = [signature(a), signature(b)].sort().join('|');
    if (source && !pairsBySource.has(source)) pairsBySource.set(source, nativeContactPairs(source));
    const connection = source && pairsBySource.get(source)?.get(pair);
    const valid =
      source &&
      structureIndex >= 0 &&
      signature(a) &&
      signature(b) &&
      connection?.kind === claim!.kind &&
      entries[structureIndex].components.some((component) => {
        const ownerSource = component.cell.obj?.data;
        if (!ownerSource || hidden(component.cell.transform.ref)) return false;
        return component.representations.some((representation) => {
          const repr = representation.cell.obj?.data.repr;
          const type = representation.cell.params?.values.type?.name;
          if (
            !repr?.state.visible ||
            hidden(representation.cell.transform.ref) ||
            Number(repr.state.alphaFactor) <= 0 ||
            Number(repr.props.alpha) <= 0 ||
            !positiveContactSize(repr.props) ||
            !type ||
            !repr.renderObjects.some(
              (object) => object.state.visible && object.values.drawCount.ref.value > 0
            ) ||
            !actualBondDrawn(
              effectiveContactOwnerSource(ownerSource, type, repr.props),
              connection,
              type,
              repr.props
            )
          )
            return false;
          const endpoints = new Set<string>();
          let bondLocation = false;
          repr.eachLocation((location) => {
            if (location.kind === 'element-location' && Unit.isAtomic(location.unit))
              endpoints.add(contactAtomKey(location.unit, location.element));
            if (
              location.kind === 'bond-location' &&
              Unit.isAtomic(location.aUnit) &&
              Unit.isAtomic(location.bUnit)
            ) {
              const nativePair = [
                contactAtomKey(location.aUnit, location.aUnit.elements[location.aIndex]),
                contactAtomKey(location.bUnit, location.bUnit.elements[location.bIndex]),
              ]
                .sort()
                .join('|');
              if (nativePair === pair) bondLocation = true;
            }
          });
          return bondLocation || (endpoints.has(signature(a)!) && endpoints.has(signature(b)!));
        });
      });
    if (!valid)
      throw new Error(
        'A computed contact delegated to a native bond has no enabled exact source/instance endpoint edge.'
      );
  }
}

export function readMolecularConnectionCoverage(
  plugin: MolstarPlugin
): MolecularConnectionCoverage[] {
  return plugin.managers.structure.hierarchy.current.structures.flatMap((entry, structureIndex) => {
    const root = entry.cell?.obj?.data;
    if (!root) return [];
    return inventory(root).map((connection) => {
      const unitA = endpointUnit(root, connection, 'a'),
        unitB = endpointUnit(root, connection, 'b');
      if (
        unitA &&
        unitB &&
        unsupportedIonicMetalCoordination(
          root,
          unitA,
          SortedArray.indexOf(unitA.elements, connection.a.atomIndex!),
          unitB,
          SortedArray.indexOf(unitB.elements, connection.b.atomIndex!),
          connection.flags
        )
      )
        return {
          ...publicConnection(connection, structureIndex),
          status: 'suppressed-unsupported-coordination' as const,
          depictionIssue: 'ionic-metal-to-metal' as const,
          representationOwners: [],
        };
      let depicted = false;
      let selectedA = false,
        selectedB = false,
        alternateA = false,
        alternateB = false;
      const representationOwners: string[] = [];
      for (const component of entry.components) {
        const source = component.cell.obj?.data;
        if (!source) continue;
        for (const representation of component.representations) {
          const repr = representation.cell.obj?.data.repr;
          const values = representation.cell.params?.values;
          if (
            !repr?.state.visible ||
            repr.state.alphaFactor === 0 ||
            repr.props.alpha === 0 ||
            !values?.type
          )
            continue;
          const type = values.type.name;
          if (!atomicTypes.has(type) && !surfaceTypes.has(type) && type !== 'carbohydrate')
            continue;
          if (atomicTypes.has(type)) {
            const atomicSource = effectiveContactOwnerSource(source, type, repr.props);
            selectedA ||= !!endpointUnit(atomicSource, connection, 'a');
            selectedB ||= !!endpointUnit(atomicSource, connection, 'b');
            alternateA ||= hasDifferentEndpointAlternative(atomicSource, connection, 'a');
            alternateB ||= hasDifferentEndpointAlternative(atomicSource, connection, 'b');
          }
          if (containsNonPolymerSide(source, connection)) depicted = true;
          if (
            actualBondDrawn(source, connection, type, repr.props) ||
            (type === 'carbohydrate' && nativeCarbohydrateLinkDrawn(source, connection, repr.props))
          )
            representationOwners.push(molecularRepresentationOwnerRef(component));
        }
      }
      const status: MolecularConnectionCoverage['status'] = representationOwners.length
        ? 'drawn'
        : !depicted || (alternateA && !selectedA) || (alternateB && !selectedB)
          ? 'not-depicted'
          : !connection.a.coordinateAvailable || !connection.b.coordinateAvailable
            ? 'missing-coordinates'
            : !connection.bondPresent
              ? 'source-bond-unavailable'
              : 'missing-attachment-geometry';
      return { ...publicConnection(connection, structureIndex), status, representationOwners };
    });
  });
}

export function requireMolecularAttachmentCoverage(plugin: MolstarPlugin): void {
  const missing = readMolecularConnectionCoverage(plugin).filter(
    (connection) =>
      connection.attachment && connection.status !== 'drawn' && connection.status !== 'not-depicted'
  );
  if (missing.length)
    throw new MolecularAttachmentError(
      `Covalent attachment is not drawn: ${missing
        .map(
          (c) =>
            `${c.a.labelAsymId}:${c.a.labelCompId}${c.a.authSeqId}/${c.a.labelAtomId} — ${c.b.labelAsymId}:${c.b.labelCompId}${c.b.authSeqId}/${c.b.labelAtomId} (${c.status})`
        )
        .join(
          '; '
        )}. Keep both recorded endpoints in one bond-rendering component with intra-bond/inter-bond visuals enabled; do not invent a bond for missing coordinates.`
    );
}

function nodesOfKind(root: AttachmentSceneNode, target: string): AttachmentSceneNode[] {
  return [
    ...(root.kind === target ? [root] : []),
    ...(root.children ?? []).flatMap((child) => nodesOfKind(child, target)),
  ];
}

function selectedStructure(root: Structure, selector: unknown): Structure {
  return substructureFromSelector(
    root,
    componentPropsFromSelector(selector as Parameters<typeof componentPropsFromSelector>[0])
  );
}

export function molecularAtomSelector(
  structure: Structure,
  fullSource = structure.root
): ComponentExpressionT[] {
  const chainKey = (unit: Unit.Atomic, atom: number) =>
    JSON.stringify([
      unit.model.id,
      unit.conformation.operator.instanceId,
      unit.model.atomicHierarchy.chains.label_asym_id.value(unit.chainIndex[atom]),
    ]);
  const selected = new Set(
    structure.units.flatMap((unit) => Array.from(unit.elements, (atom) => `${unit.id}:${atom}`))
  );
  const chains = new Map<string, { selector: ComponentExpressionT; complete: boolean }>();
  if (fullSource.models.length === 1 && fullSource.units.every(Unit.isAtomic))
    for (const unit of fullSource.units) {
      if (!Unit.isAtomic(unit)) continue;
      for (let i = 0; i < unit.elements.length; i++) {
        const atom = unit.elements[i];
        const key = chainKey(unit, atom);
        const group = chains.get(key) ?? {
          selector: {
            label_asym_id: unit.model.atomicHierarchy.chains.label_asym_id.value(
              unit.chainIndex[atom]
            ),
            ...(unit.conformation.operator.instanceId
              ? { instance_id: unit.conformation.operator.instanceId }
              : {}),
          },
          complete: true,
        };
        if (!selected.has(`${unit.id}:${atom}`)) group.complete = false;
        chains.set(key, group);
      }
    }
  const wholeChains = [...chains.values()]
    .filter((group) => group.complete)
    .map((group) => group.selector);
  return [
    ...wholeChains,
    ...structure.units.flatMap((unit) => {
      if (!Unit.isAtomic(unit)) return [];
      const h = unit.model.atomicHierarchy;
      const residues = new Map<number, number[]>();
      for (let i = 0; i < unit.elements.length; i++) {
        const atom = unit.elements[i],
          residue = unit.residueIndex[atom];
        if (chains.get(chainKey(unit, atom))?.complete) continue;
        const atoms = residues.get(residue) ?? [];
        atoms.push(atom);
        residues.set(residue, atoms);
      }
      return [...residues].flatMap(([residue, atoms]): ComponentExpressionT[] => {
        if (
          atoms.length ===
          h.residueAtomSegments.offsets[residue + 1] - h.residueAtomSegments.offsets[residue]
        ) {
          const selector = endpoint(unit.model, atoms[0], unit).residueSelector;
          if (atoms.some((atom) => h.atoms.label_comp_id.value(atom) !== selector.label_comp_id))
            delete selector.label_comp_id;
          return [selector];
        }
        return atoms.map((atom) => ({
          atom_index: h.atomSourceIndex.value(atom),
          ...(unit.conformation.operator.instanceId
            ? { instance_id: unit.conformation.operator.instanceId }
            : {}),
        }));
      });
    }),
  ];
}

type AttachmentOwner = {
  component: AttachmentSceneNode;
  representation: AttachmentSceneNode;
  source: Structure;
};

function sceneOpacity(node: AttachmentSceneNode): number {
  const native = node.custom?.molstar_representation_params as Record<string, unknown> | undefined;
  if (typeof native?.alpha === 'number') return native.alpha;
  const opacity = node.children?.filter((child) => child.kind === 'opacity').pop()?.params?.opacity;
  return typeof opacity === 'number' ? opacity : 1;
}

function extendOwner(
  owner: AttachmentOwner,
  selectors: ComponentExpressionT[],
  source: Structure
): void {
  const original = owner.component.params?.selector;
  const existing =
    typeof original === 'object'
      ? Array.isArray(original)
        ? original
        : [original]
      : molecularAtomSelector(owner.source);
  const unique = new Map(
    [...existing, ...selectors].map((selector) => [JSON.stringify(selector), selector])
  );
  owner.component.params = { ...owner.component.params, selector: [...unique.values()] };
  owner.source = selectedStructure(source, owner.component.params.selector);
}

function containsAnyAtoms(first: Structure, second: Structure): boolean {
  return second.units.some((unit) => {
    const candidate = first.unitMap.get(unit.id);
    return (
      candidate &&
      Array.from(unit.elements).some((atom) => SortedArray.has(candidate.elements, atom))
    );
  });
}

export function molecularResidueCovalentPath(
  unit: Unit.Atomic,
  from: number,
  to: number
): number[] | undefined {
  const start = SortedArray.indexOf(unit.elements, from);
  const target = SortedArray.indexOf(unit.elements, to);
  const residue = unit.residueIndex[from];
  if (start < 0 || target < 0 || unit.residueIndex[to] !== residue) return;
  const parents = new Map<number, number>([[start, -1]]);
  const queue = [start];
  for (let offset = 0; offset < queue.length && !parents.has(target); offset++) {
    const current = queue[offset];
    for (let edge = unit.bonds.offset[current]; edge < unit.bonds.offset[current + 1]; edge++) {
      const next = unit.bonds.b[edge];
      if (
        !(unit.bonds.edgeProps.flags[edge] & bondFlags.Covalent) ||
        unit.residueIndex[unit.elements[next]] !== residue ||
        parents.has(next)
      )
        continue;
      parents.set(next, current);
      queue.push(next);
    }
  }
  if (!parents.has(target)) return;
  const path: number[] = [];
  for (let current = target; current >= 0; current = parents.get(current)!)
    path.push(unit.elements[current]);
  return path;
}

function selectorsToNativeTrace(
  point: MolecularConnectionEndpoint,
  unit: Unit.Atomic | undefined
): ComponentExpressionT[] {
  const selectors: ComponentExpressionT[] = [];
  if (!unit || point.atomIndex === null || point.residueIndex === null)
    throw new MolecularAttachmentError(
      'A displayed attachment lacks source endpoint coordinates. A renderer must not fabricate this bond.'
    );
  const h = unit.model.atomicHierarchy;
  const atoms = [point.atomIndex];
  const trace = h.derived.residue.traceElementIndex[point.residueIndex];
  if (point.polymerType !== 0 && trace < 0)
    throw new MolecularAttachmentError(
      'The attachment residue has no coordinate for its polymer trace atom. Show an existing atomic attachment context; do not fabricate a connection to a missing cartoon.'
    );
  if (point.polymerType !== 0 && trace >= 0 && trace !== point.atomIndex) {
    const path = molecularResidueCovalentPath(unit, point.atomIndex, trace);
    if (!path)
      throw new MolecularAttachmentError(
        'The recorded attachment has no native covalent path to its polymer trace atom. Show an existing atomic attachment context; do not fabricate a connection to the cartoon.'
      );
    atoms.push(...path);
  }
  for (const atom of new Set(atoms))
    selectors.push({
      atom_index: h.atomSourceIndex.value(atom),
      ...(unit.conformation.operator.instanceId
        ? { instance_id: unit.conformation.operator.instanceId }
        : {}),
    });
  return selectors;
}

function connectorSelectors(connection: InternalConnection): ComponentExpressionT[] {
  return [
    ...selectorsToNativeTrace(connection.a, connection.unitA),
    ...selectorsToNativeTrace(connection.b, connection.unitB),
  ];
}

function bondOnlyConnector(
  selectors: ComponentExpressionT[],
  root: AttachmentSceneNode
): AttachmentSceneNode {
  const profile =
    (root.custom?.dnaforge_render_profile as
      | {
          ballAndStick?: { sizeFactor?: number; atomScale?: number; bondToAtomRatio?: number };
          atomicColors?: { carbonColor?: string; saturation?: number; lightness?: number };
          atomicOpacity?: number;
        }
      | undefined) ?? DEFAULT_MOLECULAR_RENDER_PROFILE;
  const carbon = profile?.atomicColors?.carbonColor;
  return {
    kind: 'component',
    params: {
      selector: [
        ...new Map(selectors.map((selector) => [JSON.stringify(selector), selector])).values(),
      ],
    },
    custom: { dnaforge_attachment_integrity: 'source-bond-connector-v1' },
    children: [
      {
        kind: 'representation',
        params: {
          type: 'ball_and_stick',
          size_factor:
            profile.ballAndStick?.sizeFactor ??
            DEFAULT_MOLECULAR_RENDER_PROFILE.ballAndStick.sizeFactor,
        },
        custom: {
          molstar_representation_params: {
            visuals: ['intra-bond', 'inter-bond'],
            includeParent: false,
            alpha: profile.atomicOpacity ?? DEFAULT_MOLECULAR_RENDER_PROFILE.atomicOpacity,
            sizeFactor:
              profile.ballAndStick?.atomScale ??
              DEFAULT_MOLECULAR_RENDER_PROFILE.ballAndStick.atomScale,
            sizeAspectRatio:
              profile.ballAndStick?.bondToAtomRatio ??
              DEFAULT_MOLECULAR_RENDER_PROFILE.ballAndStick.bondToAtomRatio,
          },
        },
        children: [
          {
            kind: 'color',
            params: { color: carbon ?? DEFAULT_MOLECULAR_RENDER_PROFILE.atomicColors.carbonColor },
            custom: {
              molstar_color_theme_name: 'element-symbol',
              molstar_color_theme_params: {
                ...(carbon
                  ? {
                      carbonColor: {
                        name: 'uniform',
                        params: { value: parseInt(carbon.slice(1), 16) },
                      },
                    }
                  : {}),
                saturation:
                  profile?.atomicColors?.saturation ??
                  DEFAULT_MOLECULAR_RENDER_PROFILE.atomicColors.saturation,
                lightness:
                  profile?.atomicColors?.lightness ??
                  DEFAULT_MOLECULAR_RENDER_PROFILE.atomicColors.lightness,
                colors: { name: 'default', params: {} },
              },
            },
          },
        ],
      },
    ],
  };
}

function resolveNucleotideBackboneJunctions(
  structureNode: AttachmentSceneNode,
  source: Structure,
  root: AttachmentSceneNode
): void {
  if (structureNode.custom?.is_hidden === true) return;
  const hasAtom = (selected: Structure, unit: Unit.Atomic, atom: number) => {
    const found = selected.unitMap.get(unit.id);
    return found?.model === unit.model && SortedArray.has(found.elements, atom);
  };
  const components = (structureNode.children ?? []).filter(
    (node) => node.kind === 'component' && node.custom?.is_hidden !== true
  );
  const traces = components.flatMap((component) =>
    (component.children ?? []).flatMap((rep) => {
      const props = rep.custom?.molstar_representation_params as
        | Record<string, unknown>
        | undefined;
      const visuals = props?.visuals as string[] | undefined;
      return ['cartoon', 'backbone'].includes(String(rep.params?.type)) &&
        rep.custom?.is_hidden !== true &&
        sceneOpacity(rep) > 0 &&
        (!visuals || visuals.includes('polymer-trace') || rep.params?.type === 'backbone')
        ? [
            {
              component,
              representation: rep,
              source: selectedStructure(source, component.params?.selector),
            },
          ]
        : [];
    })
  );
  if (!traces.length) return;
  const profile = root.custom?.dnaforge_render_profile as { version?: number } | undefined;
  const owners = components.flatMap((component) =>
    (component.children ?? []).flatMap((representation) => {
      if (
        !atomicTypes.has(String(representation.params?.type)) ||
        representation.custom?.is_hidden === true ||
        sceneOpacity(representation) <= 0
      )
        return [];
      const raw = selectedStructure(source, component.params?.selector);
      let props = (representation.custom?.molstar_representation_params ?? {}) as Record<
        string,
        unknown
      >;
      const keep = Array.isArray(props.dnaforgeNucleotideKeepAtoms)
        ? props.dnaforgeNucleotideKeepAtoms
        : [];
      if (
        (profile?.version ?? 0) >= 12 &&
        props.dnaforgeNucleotideAtomicMode === 'base-only' &&
        keep.length
      ) {
        const required = selectedStructure(raw, keep);
        const needsBackbone = required.units.some(
          (unit) =>
            Unit.isAtomic(unit) &&
            Array.from(unit.elements).some((atom) => {
              const name = unit.model.atomicHierarchy.atoms.label_atom_id.value(atom);
              return (
                isNucleic(
                  unit.model.atomicHierarchy.derived.residue.moleculeType[unit.residueIndex[atom]]
                ) &&
                (NucleicBackboneAtoms.has(name) || name.includes("'") || name.includes('*'))
              );
            })
        );
        if (needsBackbone) {
          props = { ...props, dnaforgeNucleotideAtomicMode: 'full' };
          representation.custom = {
            ...representation.custom,
            molstar_representation_params: props,
          };
        }
      }
      const displayed = filterNucleotideAtomicStructure(
        raw,
        props.dnaforgeNucleotideAtomicMode === 'base-only' ? 'base-only' : 'full',
        keep
      );
      const previous = (component.custom?.dnaforge_nucleotide_junction_atoms ??
        []) as ComponentExpressionT[];
      const supplemental = selectedStructure(source, previous);
      if (previous.length)
        for (const part of component.children ?? []) {
          if (!part.custom?.dnaforge_nucleotide_generated) continue;
          const native = (part.custom.molstar_representation_params ?? {}) as Record<
            string,
            unknown
          >;
          const excluded = (native.dnaforgeNucleotideExclude ?? []) as unknown[];
          part.custom = {
            ...part.custom,
            molstar_representation_params: {
              ...native,
              dnaforgeNucleotideExclude: [
                ...new Map([...excluded, ...previous].map((s) => [JSON.stringify(s), s])).values(),
              ],
            },
          };
        }
      return [
        { component, representation, source: displayed, seed: displayed, supplemental, props },
      ];
    })
  );
  const atomicResidues = new Map<number, Set<number>>();
  for (const owner of owners) {
    if (owner.props.dnaforgeNucleotideAtomicMode === 'base-only') continue;
    for (const unit of owner.seed.units) {
      if (!Unit.isAtomic(unit)) continue;
      const blocked = atomicResidues.get(unit.id) ?? new Set<number>();
      for (let i = 0; i < unit.elements.length; i++) {
        const atom = unit.elements[i];
        if (!hasAtom(owner.supplemental, unit, atom)) blocked.add(unit.residueIndex[atom]);
      }
      atomicResidues.set(unit.id, blocked);
    }
  }
  const restoreTrace = (unit: Unit.Atomic, atom: number) => {
    const h = unit.model.atomicHierarchy;
    const trace = h.derived.residue.traceElementIndex[unit.residueIndex[atom]];
    if (trace < 0 || traces.some((t) => hasAtom(t.source, unit, trace))) return;
    const targets = new Map<number, (typeof traces)[number]>();
    for (const t of traces) {
      const selected = t.source.unitMap.get(unit.id);
      if (!selected || !Unit.isAtomic(selected) || selected.model !== unit.model) continue;
      for (let i = 0; i < selected.elements.length; i++) {
        const a = selected.elements[i];
        const r = unit.residueIndex[a];
        if (a === h.derived.residue.traceElementIndex[r]) targets.set(a, t);
      }
    }
    if (!targets.size) return;
    const start = SortedArray.indexOf(unit.elements, atom);
    const parents = new Map<number, number>([[start, -1]]);
    const queue = [start];
    let reached = -1;
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      if (targets.has(unit.elements[current])) {
        reached = current;
        break;
      }
      for (let e = unit.bonds.offset[current]; e < unit.bonds.offset[current + 1]; e++) {
        const next = unit.bonds.b[e],
          a = unit.elements[next],
          r = unit.residueIndex[a];
        if (
          !(unit.bonds.edgeProps.flags[e] & bondFlags.Covalent) ||
          parents.has(next) ||
          atomicResidues.get(unit.id)?.has(r) ||
          !isNucleic(h.derived.residue.moleculeType[r]) ||
          h.derived.residue.polymerType[r] === 0 ||
          h.derived.residue.traceElementIndex[r] < 0
        )
          continue;
        parents.set(next, current);
        queue.push(next);
      }
    }
    if (reached < 0) return;
    const target = targets.get(unit.elements[reached])!;
    const selectors = new Map<number, ComponentExpressionT>();
    for (let current = reached; current >= 0; current = parents.get(current)!) {
      const a = unit.elements[current],
        r = unit.residueIndex[a];
      if (!hasAtom(target.source, unit, h.derived.residue.traceElementIndex[r]))
        selectors.set(r, endpoint(unit.model, a, unit).residueSelector);
    }
    if (selectors.size) extendOwner(target, [...selectors.values()], source);
  };
  for (const unit of source.units) {
    if (!Unit.isAtomic(unit)) continue;
    for (let i = 0; i < unit.elements.length; i++) {
      const a = unit.elements[i];
      for (let e = unit.bonds.offset[i]; e < unit.bonds.offset[i + 1]; e++) {
        const b = unit.elements[unit.bonds.b[e]];
        if (
          a >= b ||
          !(unit.bonds.edgeProps.flags[e] & bondFlags.Covalent) ||
          unit.residueIndex[a] === unit.residueIndex[b] ||
          !isNucleic(
            unit.model.atomicHierarchy.derived.residue.moleculeType[unit.residueIndex[a]]
          ) ||
          !isNucleic(unit.model.atomicHierarchy.derived.residue.moleculeType[unit.residueIndex[b]])
        )
          continue;
        for (const owner of owners) {
          if (owner.props.dnaforgeNucleotideAtomicMode === 'base-only') continue;
          const inA = hasAtom(owner.seed, unit, a) && !hasAtom(owner.supplemental, unit, a);
          const inB = hasAtom(owner.seed, unit, b) && !hasAtom(owner.supplemental, unit, b);
          if (inA !== inB) restoreTrace(unit, inA ? b : a);
        }
      }
    }
  }
  const consider = (
    unitA: Unit.Atomic,
    atomA: number,
    unitB: Unit.Atomic,
    atomB: number,
    flags: BondType.Flag
  ) => {
    if (
      !(flags & bondFlags.Covalent) ||
      unitA.model !== unitB.model ||
      (unitA.id === unitB.id && unitA.residueIndex[atomA] === unitB.residueIndex[atomB])
    )
      return;
    const a = endpoint(unitA.model, atomA, unitA),
      b = endpoint(unitB.model, atomB, unitB);
    if (!isNucleic(a.moleculeType) || !isNucleic(b.moleculeType)) return;
    for (const owner of owners) {
      if (
        !['ball_and_stick', 'ball-and-stick', 'line'].includes(
          String(owner.representation.params?.type)
        )
      )
        continue;
      const inA = hasAtom(owner.seed, unitA, atomA) && !hasAtom(owner.supplemental, unitA, atomA);
      const inB = hasAtom(owner.seed, unitB, atomB) && !hasAtom(owner.supplemental, unitB, atomB);
      if (inA === inB) continue;
      const outside = inA ? b : a,
        unit = inA ? unitB : unitA;
      const trace =
        unit.model.atomicHierarchy.derived.residue.traceElementIndex[outside.residueIndex!];
      if (trace < 0 || !traces.some((selected) => hasAtom(selected.source, unit, trace))) continue;
      if (hasAtom(owner.source, unitA, atomA) && hasAtom(owner.source, unitB, atomB)) continue;
      const selectors = selectorsToNativeTrace(outside, unit);
      const extra = selectedStructure(source, selectors);
      if (owners.some((other) => other !== owner && containsAnyAtoms(other.source, extra)))
        throw new MolecularAttachmentError(
          'A nucleotide backbone junction has another atomic owner. Keep the connected backbone in one owner; duplicate atoms must not be added.'
        );
      extendOwner(owner, selectors, source);
      const bindingRegion = owner.component.custom?.dnaforge_binding_region as
        | Record<string, unknown>
        | undefined;
      if (bindingRegion)
        owner.component.custom = {
          ...owner.component.custom,
          dnaforge_binding_region: {
            ...bindingRegion,
            detail: structuredClone(owner.component.params?.selector),
          },
        };
      const previous = (owner.component.custom?.dnaforge_nucleotide_junction_atoms ??
        []) as ComponentExpressionT[];
      const added = [
        ...new Map([...previous, ...selectors].map((s) => [JSON.stringify(s), s])).values(),
      ];
      owner.component.custom = {
        ...owner.component.custom,
        dnaforge_nucleotide_junction_atoms: added,
      };
      for (const part of owner.component.children ?? []) {
        if (!part.custom?.dnaforge_nucleotide_generated) continue;
        const native = (part.custom.molstar_representation_params ?? {}) as Record<string, unknown>;
        const excluded = (native.dnaforgeNucleotideExclude ?? []) as unknown[];
        part.custom = {
          ...part.custom,
          molstar_representation_params: {
            ...native,
            dnaforgeNucleotideExclude: [
              ...new Map([...excluded, ...selectors].map((s) => [JSON.stringify(s), s])).values(),
            ],
          },
        };
      }
      owner.representation.custom = {
        ...owner.representation.custom,
        molstar_representation_params: {
          ...owner.props,
          includeParent: false,
          visuals: [
            ...new Set([
              ...((owner.props.visuals as string[]) ??
                (owner.representation.params?.type === 'line'
                  ? ['intra-bond', 'inter-bond', 'element-point', 'element-cross']
                  : ['element-sphere', 'intra-bond', 'inter-bond'])),
              'intra-bond',
              'inter-bond',
            ]),
          ],
        },
      };
    }
  };
  for (const unit of source.units) {
    if (!Unit.isAtomic(unit)) continue;
    const bonds = unit.bonds;
    for (let edge = 0; edge < bonds.a.length; edge++)
      if (bonds.a[edge] < bonds.b[edge])
        consider(
          unit,
          unit.elements[bonds.a[edge]],
          unit,
          unit.elements[bonds.b[edge]],
          bonds.edgeProps.flags[edge]
        );
  }
  for (const edge of source.interUnitBonds.edges) {
    const a = source.unitMap.get(edge.unitA),
      b = source.unitMap.get(edge.unitB);
    if (a && b && Unit.isAtomic(a) && Unit.isAtomic(b))
      consider(a, a.elements[edge.indexA], b, b.elements[edge.indexB], edge.props.flag);
  }
  const fullOwners = owners.filter((o) => o.props.dnaforgeNucleotideAtomicMode !== 'base-only');
  const supplemental = fullOwners.flatMap(
    (o) => (o.component.custom?.dnaforge_nucleotide_junction_atoms ?? []) as unknown[]
  );
  if (supplemental.length) {
    const atomicSelectors = fullOwners.map((o) => o.component.params?.selector);
    for (const component of components)
      for (const representation of component.children ?? []) {
        if (representation.params?.type !== 'cartoon') continue;
        const props = (representation.custom?.molstar_representation_params ?? {}) as Record<
          string,
          unknown
        >;
        const visuals = props.visuals as string[] | undefined;
        const generated = representation.custom?.dnaforge_nucleotide_generated === true;
        const extra = generated
          ? [
              ...supplemental,
              ...(visuals?.includes('dnaforge-nucleotide-connector') ? atomicSelectors : []),
            ]
          : atomicSelectors;
        const previous = Array.isArray(props.dnaforgeNucleotideExclude)
          ? props.dnaforgeNucleotideExclude
          : [];
        representation.custom = {
          ...representation.custom,
          molstar_representation_params: {
            ...props,
            dnaforgeNucleotideExclude: [
              ...new Map([...previous, ...extra].map((s) => [JSON.stringify(s), s])).values(),
            ],
          },
        };
      }
  }
}

export function resolveMolViewSpecAttachments<T extends AttachmentDocument>(
  plugin: MolstarPlugin,
  document: T,
  sourceForStructure?: (node: AttachmentSceneNode, snapshotIndex: number) => Structure | undefined
): T {
  const resolved = structuredClone(document);
  const entries = plugin.managers.structure.hierarchy.current.structures;
  for (const [snapshotIndex, root] of [
    resolved.root,
    ...(resolved.snapshots ?? []).map((snapshot) => snapshot.root),
  ]
    .filter((root): root is AttachmentSceneNode => !!root)
    .entries()) {
    const structureNodes = nodesOfKind(root, 'structure');
    for (const structureNode of structureNodes) {
      const source = sourceForStructure
        ? sourceForStructure(structureNode, snapshotIndex)
        : structureNodes.length === 1 && entries.length === 1
          ? (entries[0].transform?.cell.obj?.data ?? entries[0].cell?.obj?.data)
          : undefined;
      if (!source) continue;
      resolveNucleotideBackboneJunctions(structureNode, source, root);
      const connections = inventory(source).filter((c) => c.attachment);
      if (!connections.length) continue;
      const owners = (structureNode.children ?? [])
        .filter((node) => node.kind === 'component')
        .flatMap((component) =>
          (component.children ?? [])
            .filter(
              (node) =>
                node.kind === 'representation' &&
                sceneOpacity(node) > 0 &&
                (atomicTypes.has(String(node.params?.type)) || node.params?.type === 'carbohydrate')
            )
            .map((representation) => ({
              component,
              representation,
              source: selectedStructure(source, component.params?.selector),
            }))
        );
      for (let pass = 0; pass <= connections.length; pass++) {
        let changed = false;
        for (const connection of connections) {
          const affected = owners.filter(
            (owner) =>
              owner.component.custom?.dnaforge_attachment_integrity !==
                'source-bond-connector-v1' && containsNonPolymerSide(owner.source, connection)
          );
          if (!affected.length) continue;
          if (
            !connection.a.coordinateAvailable ||
            !connection.b.coordinateAvailable ||
            !connection.bondPresent
          )
            throw new MolecularAttachmentError(
              'A displayed covalent attachment has missing endpoint coordinates or no source-graph bond. Inspect the connection inventory; a renderer must not fabricate this bond.'
            );
          const complete = affected.filter(
            (owner) =>
              endpointUnit(owner.source, connection, 'a') &&
              endpointUnit(owner.source, connection, 'b')
          );
          if (complete.length) continue;
          if (affected.length !== 1)
            throw new MolecularAttachmentError(
              'Connected ligand atoms are owned by several atomic components. Put the connected molecule and its attachment residues in one component, with color layers inside that component.'
            );
          const owner = affected[0];
          const type = String(owner.representation.params?.type);
          if (type !== 'ball_and_stick' && type !== 'line' && type !== 'carbohydrate')
            throw new MolecularAttachmentError(
              'Space-filling or point atoms alone cannot show a covalent attachment. Use one native bond-rendering component for this connected molecule.'
            );
          const selectors = [connection.a.residueSelector, connection.b.residueSelector];
          const extra = selectedStructure(source, selectors);
          for (const other of owners) {
            if (other.component === owner.component) continue;
            const overlap = extra.units.some((unit) => {
              const candidate = other.source.unitMap.get(unit.id);
              return (
                candidate &&
                Array.from(unit.elements).some((atom) => SortedArray.has(candidate.elements, atom))
              );
            });
            if (overlap)
              throw new MolecularAttachmentError(
                'The attachment residue already has another atomic owner. Combine the connected selections in one component and preserve their colors as color layers; drawing it twice is forbidden.'
              );
          }
          const originalSelector = owner.component.params?.selector;
          const existing =
            typeof originalSelector === 'object'
              ? Array.isArray(originalSelector)
                ? originalSelector
                : [originalSelector]
              : molecularAtomSelector(owner.source);
          owner.component.params = {
            ...owner.component.params,
            selector: [...existing, ...selectors],
          };
          owner.component.custom = {
            ...owner.component.custom,
            dnaforge_attachment_integrity: 'source-bond-selection-closure-v1',
          };
          const native = (owner.representation.custom?.molstar_representation_params ??
            {}) as Record<string, unknown>;
          const requiredVisuals =
            type === 'carbohydrate'
              ? ['carbohydrate-symbol', 'carbohydrate-link', 'carbohydrate-terminal-link']
              : type === 'line'
                ? ['intra-bond', 'inter-bond', 'element-point', 'element-cross']
                : ['element-sphere', 'intra-bond', 'inter-bond'];
          owner.representation.custom = {
            ...owner.representation.custom,
            molstar_representation_params: {
              ...native,
              includeParent: false,
              visuals: [
                ...new Set([
                  ...((native.visuals as string[]) ?? requiredVisuals),
                  ...requiredVisuals.filter((v) => v.includes('bond') || v.includes('link')),
                ]),
              ],
            },
          };
          owner.source = selectedStructure(source, owner.component.params.selector);
          changed = true;
        }
        if (!changed) break;
      }
      const surfaces = (structureNode.children ?? [])
        .filter(
          (component) =>
            component.kind === 'component' &&
            component.children?.some(
              (representation) =>
                representation.kind === 'representation' &&
                sceneOpacity(representation) > 0 &&
                surfaceTypes.has(String(representation.params?.type))
            )
        )
        .map((component) => selectedStructure(source, component.params?.selector));
      let generated: AttachmentOwner | undefined;
      for (const connection of connections) {
        if (!surfaces.some((surface) => containsNonPolymerSide(surface, connection))) continue;
        const hasBond = owners.some((owner) => {
          const type = String(owner.representation.params?.type);
          const native = (owner.representation.custom?.molstar_representation_params ??
            {}) as Record<string, unknown>;
          return (
            actualBondDrawn(
              owner.source,
              connection,
              type === 'ball_and_stick' ? 'ball-and-stick' : type,
              native
            ) ||
            (type === 'carbohydrate' &&
              nativeCarbohydrateLinkDrawn(owner.source, connection, native))
          );
        });
        if (hasBond) continue;
        if (
          !connection.a.coordinateAvailable ||
          !connection.b.coordinateAvailable ||
          !connection.bondPresent
        )
          throw new MolecularAttachmentError(
            'A visible attached surface has missing source endpoint coordinates or no source-graph bond. Inspect the connection inventory; a renderer must not fabricate this bond.'
          );
        const selectors = connectorSelectors(connection);
        const required = selectedStructure(source, selectors);
        const touching = owners.filter((owner) => containsAnyAtoms(owner.source, required));
        if (touching.length > 1)
          throw new MolecularAttachmentError(
            'The surface attachment spans several atomic owners. Combine the needed connected atoms in one bond-rendering component, with color layers inside it; drawing the same atomic geometry twice is forbidden.'
          );
        let owner = touching[0];
        if (
          owner &&
          !['ball_and_stick', 'ball-and-stick', 'line'].includes(
            String(owner.representation.params?.type)
          )
        )
          throw new MolecularAttachmentError(
            'An existing atomic owner cannot draw the surface attachment bond. Use a native bond-rendering owner for those connected atoms; a second overlapping atomic component is forbidden.'
          );
        if (!owner) {
          if (!generated) {
            const component = bondOnlyConnector(selectors, root);
            structureNode.children = [...(structureNode.children ?? []), component];
            generated = { component, representation: component.children![0], source: required };
            owners.push(generated);
          }
          owner = generated;
        }
        extendOwner(owner, selectors, source);
        const native = (owner.representation.custom?.molstar_representation_params ?? {}) as Record<
          string,
          unknown
        >;
        const existingVisuals = native.visuals as string[] | undefined;
        owner.representation.custom = {
          ...owner.representation.custom,
          molstar_representation_params: {
            ...native,
            includeParent: false,
            visuals: [
              ...new Set([
                ...(existingVisuals ?? ['element-sphere', 'intra-bond', 'inter-bond']),
                'intra-bond',
                'inter-bond',
              ]),
            ],
          },
        };
      }
    }
  }
  return resolved;
}
