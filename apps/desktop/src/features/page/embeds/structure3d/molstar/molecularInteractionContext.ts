import { MVSData, type MVSData as Scene } from 'molstar/lib/extensions/mvs/mvs-data';
import {
  Structure,
  StructureElement,
  StructureSelection,
  Unit,
} from 'molstar/lib/mol-model/structure';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { Script } from 'molstar/lib/mol-script/script';
import { StructureSelectionQueries } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import { InteractionsProvider } from 'molstar/lib/mol-model-props/computed/interactions';
import {
  Interactions,
  ContactProviderParams,
} from 'molstar/lib/mol-model-props/computed/interactions/interactions';
import { ContactsParams } from 'molstar/lib/mol-model-props/computed/interactions/contacts';
import {
  interactionTypeLabel,
  FeatureGroup,
  FeatureTypes,
  InteractionFlag,
  InteractionType,
} from 'molstar/lib/mol-model-props/computed/interactions/common';
import { InteractionTypeColorTheme } from 'molstar/lib/mol-model-props/computed/themes/interaction-type';
import { Features } from 'molstar/lib/mol-model-props/computed/interactions/features';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { SortedArray } from 'molstar/lib/mol-data/int';
import { isProtein, PolymerNames } from 'molstar/lib/mol-model/structure/model/types';
import { ValenceModelProvider } from 'molstar/lib/mol-model-props/computed/valence-model';
import { Task } from 'molstar/lib/mol-task';
import { fovNormalizedCameraPosition } from 'molstar/lib/mol-util/camera';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition';
import { PLUGIN_VERSION } from 'molstar/lib/mol-plugin/version';
import { MOLECULAR_CONTACT_TYPES } from './molecularContactPolicy';
import type { ElementIndex } from 'molstar/lib/mol-model/structure/model';
import {
  molecularAtomSelector,
  molecularResidueCovalentPath,
  readMolecularConnections,
  resolveMolViewSpecAttachments,
  resolveMolViewSpecNativeContactOwners,
} from './molecularConnections';
import type { MolstarPlugin } from './cache';
import type { MolecularProfileNode as Node } from './nucleotidePresentationSettings';
import type { MolecularPresentationRole } from './molecularPresentationRoles';
import { resolveMolViewSpecStructureRef } from './molViewSpecStructureIdentity';
import { primaryMolecularConformer } from './molecularPrimaryConformer';
import {
  completeLigandTarget,
  containsMolecularLigand,
  nonPolymerBindingTarget,
} from './molecularSurfaceOwnership';
import { computeMolecularInterfaceBurial } from './molecularInterfaceBurial';
import { molecularIonPhysicalContext } from './molecularIonContext';
import {
  currentMolecularRenderProfile,
  getMolViewSpecRenderProfile,
  resolveMolViewSpecRenderProfile,
} from './molecularRenderProfile';
import { resolveNucleotideAppearance } from './nucleotideAppearance';
import { normalizeActiveMolecularSource } from './molecularSourceEdit';
import type { MolecularBindingIntent } from './molecularBindingIntent';

export type InteractionContextOptions = {
  sceneStructureRef?: string;
  surfaceColorMode?: 'identity' | 'emphasis';
  surfaceSide?: 'target' | 'partner';
  surfaceExtent?: 'complete' | 'contact-patch';
  interfaceDetailSide?: MolecularBindingIntent['interfaceDetailSide'];
  interfaceDetailBasis?: MolecularBindingIntent['interfaceDetailBasis'];
  interfaceProteinAtomicMode?: MolecularBindingIntent['interfaceProteinAtomicMode'];
  partnerSelector?: unknown;
  targetSelector?: unknown;
  focus?: boolean;
  measurements?: boolean;
  maxMeasurements?: number;
  presentationRole?: Extract<MolecularPresentationRole, 'binding-site' | 'interface'>;
};
type Atom = { unit: Unit.Atomic; index: ElementIndex };
export type Contact = {
  type: number;
  label: string;
  a: Atom[];
  b: Atom[];
  distance: number;
  color: string;
  excludedReason?: string;
  chargeMembers?: { a: Atom[]; b: Atom[] };
};

export function molecularContactGuide(contact: Contact, measurement = false): Node {
  if (contact.excludedReason)
    throw new InteractionContextError('INTERACTION_CHEMISTRY_UNSUPPORTED', contact.excludedReason);
  let a = contact.a,
    b = contact.b;
  const endpointMode =
    contact.type === InteractionType.Ionic
      ? 'nearest-charge-members'
      : contact.type === InteractionType.PiStacking
        ? 'ring-centers'
        : contact.type === InteractionType.CationPi
          ? 'ring-charge-centers'
          : 'atoms';
  if (!a.length || !b.length || (endpointMode === 'atoms' && (a.length !== 1 || b.length !== 1)))
    throw new InteractionContextError(
      'INTERACTION_ENDPOINT_UNSUPPORTED',
      'An atomic contact requires one classified atom on each side; group features require their own endpoint meaning.'
    );
  measurement = measurement && endpointMode === 'atoms';
  if (endpointMode === 'nearest-charge-members') {
    let nearest = Number.POSITIVE_INFINITY;
    for (const atomA of contact.chargeMembers?.a ?? contact.a) {
      for (const atomB of contact.chargeMembers?.b ?? contact.b) {
        const distance = Vec3.squaredDistance(position(atomA), position(atomB));
        if (distance < nearest) {
          nearest = distance;
          a = [atomA];
          b = [atomB];
        }
      }
    }
  } else if (endpointMode === 'ring-charge-centers' && contact.chargeMembers) {
    a = contact.chargeMembers.a;
    b = contact.chargeMembers.b;
  }
  const displayedDistance = Vec3.distance(center(a), center(b));
  const description =
    endpointMode === 'nearest-charge-members'
      ? `charge-group association, shown through nearest classified members (${displayedDistance.toFixed(2)} Å); feature centers ${contact.distance.toFixed(2)} Å; not an additional hydrogen bond`
      : endpointMode === 'ring-centers' || endpointMode === 'ring-charge-centers'
        ? `${endpointMode === 'ring-centers' ? 'ring centers' : 'ring and charge-group centers'} ${displayedDistance.toFixed(2)} Å; not an atom-to-atom bond`
        : `classified atom endpoints ${displayedDistance.toFixed(2)} Å`;
  return {
    kind: 'primitive',
    custom: {
      dnaforge_contact_evidence: {
        contract: 'typed-native-contact-v1',
        type: contact.type,
        classification: contact.label,
        endpointMode,
        featureA: endpoint(contact.a),
        featureB: endpoint(contact.b),
        featureCenterDistance: contact.distance,
        displayedDistance,
      },
    },
    params: {
      kind: measurement ? 'distance_measurement' : 'tube',
      start: endpoint(a),
      end: endpoint(b),
      color: contact.color,
      radius: 0.06,
      dash_length: endpointMode === 'nearest-charge-members' ? 0.22 : 0.12,
      ...(measurement
        ? { label_template: '{{distance}} Å', label_size: 0.6, label_color: contact.color }
        : { tooltip: `${contact.label} (Molstar inferred contact; ${description})` }),
    },
  };
}

export function molecularContactCenterMarkers(guide: Node): Node[] {
  const evidence = guide.custom?.dnaforge_contact_evidence as { endpointMode?: string } | undefined;
  if (!['ring-centers', 'ring-charge-centers'].includes(evidence?.endpointMode ?? '')) return [];
  return [guide.params?.start, guide.params?.end].flatMap((point) => {
    const expressions = (point as { expressions?: unknown[] })?.expressions;
    if (!expressions || expressions.length < 2) return [];
    return [
      {
        kind: 'primitive',
        custom: { dnaforge_contact_feature_center: true },
        params: {
          kind: 'ellipsoid',
          center: point,
          radius: 0.12,
          color: guide.params?.color,
          tooltip: 'Classified interaction feature center (not an atom)',
        },
      },
    ];
  });
}

export function resolveMolecularContactCenterMarkers(root: Node): void {
  for (const group of walk(root)) {
    if (group.kind !== 'primitives' || group.custom?.dnaforge_interaction_context !== contextTag)
      continue;
    const children = coalesceMolecularContactGuides(
      (group.children ?? []).filter((node) => node.custom?.dnaforge_contact_feature_center !== true)
    );
    const markers = new Map<string, Node>();
    for (const guide of children) {
      const evidence = guide.custom?.dnaforge_contact_evidence as { contract?: string } | undefined;
      if (evidence?.contract !== 'typed-native-contact-v1') continue;
      for (const marker of molecularContactCenterMarkers(guide))
        markers.set(canonicalEndpoint(marker.params?.center), marker);
    }
    group.children = [...children, ...markers.values()];
  }
}
const atomicTypes = new Set(['ball_and_stick', 'line', 'spacefill', 'point']);
const contextTag = 'native-interaction-context-v1';
const contextRef = 'dnaforge-interaction-environment';
export class InteractionContextError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
function key(unit: Unit, atom: number) {
  return `${unit.id}:${atom}`;
}
function atoms(source: Structure): Atom[] {
  return source.units.flatMap((unit) =>
    Unit.isAtomic(unit) ? Array.from(unit.elements, (index) => ({ unit, index })) : []
  );
}
function select(source: Structure, selector: unknown) {
  return substructureFromSelector(
    source,
    componentPropsFromSelector(selector as Parameters<typeof componentPropsFromSelector>[0])
  );
}
function subset(source: Structure, predicate: (unit: Unit, atom: number) => boolean): Structure {
  const builder = source.subsetBuilder(true);
  for (const unit of source.units) {
    builder.beginUnit(unit.id);
    for (let i = 0; i < unit.elements.length; i++) {
      const atom = unit.elements[i];
      if (predicate(unit, atom)) builder.addElement(atom);
    }
    builder.commitUnit();
  }
  return builder.getStructure();
}
function position(point: Atom) {
  return point.unit.conformation.position(point.index, Vec3());
}
function endpoint(points: Atom[]) {
  return {
    expressions: points.map((point) => ({
      atom_index: point.unit.model.atomicHierarchy.atomSourceIndex.value(point.index),
      ...(point.unit.conformation.operator.instanceId
        ? { instance_id: point.unit.conformation.operator.instanceId }
        : {}),
    })),
  };
}
function featureAtoms(unit: Unit.Atomic, feature: number, data: Features): Atom[] {
  const result: Atom[] = [];
  for (let i = data.offsets[feature]; i < data.offsets[feature + 1]; i++)
    result.push({ unit, index: unit.elements[data.members[i]] });
  return result;
}
function chargedFeatureMembers(points: Atom[], feature: number, data: Features): Atom[] {
  return data.groups[feature] === FeatureGroup.QuaternaryAmine
    ? points.filter(
        ({ unit, index }) => unit.model.atomicHierarchy.atoms.type_symbol.value(index) === 'N'
      )
    : points;
}
function center(points: Atom[]) {
  const out = Vec3();
  for (const point of points) Vec3.add(out, out, position(point));
  return Vec3.scale(out, out, 1 / points.length);
}

export function unsupportedNitrogenCharge(
  source: Structure,
  points: Atom[],
  feature: number,
  data: Features
): string | undefined {
  if (
    Number(data.types[feature]) !== FeatureTypes.NegativeCharge ||
    data.groups[feature] !== FeatureGroup.None ||
    !points.every(({ unit, index }) => {
      const atoms = unit.model.atomicHierarchy.atoms;
      return (
        atoms.type_symbol.value(index) === 'N' &&
        !PolymerNames.has(atoms.label_comp_id.value(index))
      );
    })
  )
    return;
  const valence = ValenceModelProvider.get(source).value;
  if (
    points.some(
      ({ unit, index }) =>
        unit.model.atomicHierarchy.atoms.pdbx_formal_charge.value(index) < 0 ||
        (valence?.get(unit.id)?.charge[SortedArray.indexOf(unit.elements, index)] ?? 0) < 0
    )
  )
    return;
  return 'The native negative-charge feature contains non-polymer nitrogen without a supporting negative deposited or computed valence charge; it cannot be drawn as an ionic association.';
}

export function focusContacts(source: Structure, data: Interactions): Contact[] {
  const theme = InteractionTypeColorTheme({ structure: source }, {});
  const seen = new Set<string>();
  const result: Contact[] = [];
  const add = (ua: Unit, ia: number, ub: Unit, ib: number, type: number, flag: number) => {
    if (flag & InteractionFlag.Filtered || !Unit.isAtomic(ua) || !Unit.isAtomic(ub)) return;
    const fa = data.unitsFeatures.get(ua.id),
      fb = data.unitsFeatures.get(ub.id);
    if (!fa || !fb) return;
    const a = featureAtoms(ua, ia, fa),
      b = featureAtoms(ub, ib, fb);
    if (!a.length || !b.length) return;
    const id = [`${ua.id}:${ia}`, `${ub.id}:${ib}`].sort().join('|') + ':' + type;
    if (seen.has(id)) return;
    seen.add(id);
    const location = Interactions.Location(
      data,
      source,
      ua,
      ia as Parameters<typeof Interactions.Location>[3],
      ub,
      ib as Parameters<typeof Interactions.Location>[5]
    );
    result.push({
      type,
      label: interactionTypeLabel(type),
      a,
      b,
      distance: Vec3.distance(
        Features.setPosition(Vec3(), ua, ia as Features.FeatureIndex, fa),
        Features.setPosition(Vec3(), ub, ib as Features.FeatureIndex, fb)
      ),
      color: '#' + theme.color(location, false).toString(16).padStart(6, '0'),
      ...([InteractionType.Ionic, InteractionType.CationPi].includes(type)
        ? {
            chargeMembers: {
              a: chargedFeatureMembers(a, ia, fa),
              b: chargedFeatureMembers(b, ib, fb),
            },
          }
        : {}),
      ...(type === InteractionType.Ionic
        ? {
            excludedReason:
              unsupportedNitrogenCharge(source, a, ia, fa) ??
              unsupportedNitrogenCharge(source, b, ib, fb),
          }
        : {}),
    });
  };
  for (const unit of source.units) {
    const contacts = data.unitsContacts.get(unit.id);
    if (!contacts) continue;
    for (let i = 0; i < contacts.a.length; i++)
      if (contacts.a[i] < contacts.b[i])
        add(
          unit,
          contacts.a[i],
          unit,
          contacts.b[i],
          contacts.edgeProps.type[i],
          contacts.edgeProps.flag[i]
        );
  }
  for (const edge of data.contacts.edges) {
    const a = source.unitMap.get(edge.unitA),
      b = source.unitMap.get(edge.unitB);
    if (a && b) add(a, edge.indexA, b, edge.indexB, edge.props.type, edge.props.flag);
  }
  return result.sort((a, b) => a.type - b.type || a.distance - b.distance);
}
function walk(node: Node): Node[] {
  return [node, ...(node.children ?? []).flatMap(walk)];
}

function canonicalEndpoint(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      const values = item.map(normalize);
      return values.every((value) => typeof value === 'object' && value !== null)
        ? values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        : values;
    }
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, normalize(value)])
      );
    return item;
  };
  return JSON.stringify(normalize(value));
}

function contactEvidence(node: Node): unknown[] {
  return Array.isArray(node.custom?.dnaforge_contact_evidence_set)
    ? node.custom.dnaforge_contact_evidence_set
    : node.custom?.dnaforge_contact_evidence
      ? [node.custom.dnaforge_contact_evidence]
      : [];
}

export function coalesceMolecularContactGuides(children: Node[]): Node[] {
  const result: Node[] = [];
  const segments = new Map<string, number>();
  for (const node of children) {
    const primary = node.custom?.dnaforge_contact_evidence as
      | { contract?: string; endpointMode?: string }
      | undefined;
    const line =
      node.kind === 'primitive' &&
      ['tube', 'distance_measurement'].includes(String(node.params?.kind)) &&
      node.params?.start &&
      node.params?.end;
    if (!line) {
      result.push(node);
      continue;
    }
    const typed = primary?.contract === 'typed-native-contact-v1';
    const key = typed
      ? [canonicalEndpoint(node.params!.start), canonicalEndpoint(node.params!.end)]
          .sort()
          .join('|')
      : `literal:${canonicalEndpoint(node)}`;
    const previousIndex = segments.get(key);
    if (previousIndex === undefined) {
      segments.set(key, result.length);
      result.push(node);
      continue;
    }
    const previous = result[previousIndex];
    if (!typed) {
      previous.custom = {
        ...previous.custom,
        dnaforge_contact_duplicate_count:
          Number(previous.custom?.dnaforge_contact_duplicate_count ?? 1) +
          Number(node.custom?.dnaforge_contact_duplicate_count ?? 1),
      };
      continue;
    }
    const oldPrimary = previous.custom?.dnaforge_contact_evidence as { endpointMode?: string };
    const chosen =
      primary?.endpointMode === 'atoms' &&
      (oldPrimary.endpointMode !== 'atoms' ||
        (node.params!.kind === 'distance_measurement' && previous.params!.kind === 'tube'))
        ? node
        : previous;
    const records = [...contactEvidence(previous), ...contactEvidence(node)];
    const classifications = [
      ...new Set(records.map((record) => (record as { classification: string }).classification)),
    ];
    result[previousIndex] = {
      ...chosen,
      custom: { ...chosen.custom, dnaforge_contact_evidence_set: records },
      params: {
        ...chosen.params,
        ...(chosen.params!.kind === 'tube'
          ? {
              tooltip:
                `${classifications.join(' + ')} (Molstar inferred evidence sharing one guide; ` +
                'classifications are retained individually, not additional bonds)',
            }
          : {}),
      },
    };
  }
  return result;
}

function managedContactSets(scene: string) {
  const document = MVSData.fromMVSJ(scene);
  const roots =
    document.kind === 'multiple' ? document.snapshots.map((step) => step.root) : [document.root];
  return roots.flatMap((root, snapshotIndex) =>
    walk(root as Node).flatMap((node) => {
      if (node.kind !== 'primitives' || node.custom?.dnaforge_interaction_context !== contextTag)
        return [];
      const contactNodes = (node.children ?? []).filter(
        (child) =>
          child.kind === 'primitive' &&
          ['tube', 'distance_measurement'].includes(String(child.params?.kind)) &&
          child.params?.start &&
          child.params?.end &&
          Number(child.params?.radius ?? 1) > 0
      );
      const segment = (child: Node) =>
        [canonicalEndpoint(child.params!.start), canonicalEndpoint(child.params!.end)]
          .sort()
          .join('|');
      const contacts = contactNodes.map(segment);
      const nativeOwnerContactCount = new Set(
        contactNodes
          .filter(
            (child) =>
              (child.custom?.dnaforge_contact_native_owner as { contract?: string } | undefined)
                ?.contract === 'native-bond-contact-owner-v1'
          )
          .map(segment)
      ).size;
      const classifications = new Set(
        (node.children ?? []).flatMap(contactEvidence).map(canonicalEndpoint)
      );
      return [
        {
          snapshotIndex,
          contacts: new Set(contacts),
          classifications,
          nativeOwnerContactCount,
          visible: Number(node.params?.opacity ?? 1) > 0,
        },
      ];
    })
  );
}

export function readManagedInteractionContacts(scene: string) {
  return managedContactSets(scene).map(
    ({ snapshotIndex, contacts, visible, nativeOwnerContactCount }) => ({
      snapshotIndex,
      contactCount: contacts.size,
      visible,
      ...(nativeOwnerContactCount ? { nativeOwnerContactCount } : {}),
    })
  );
}

export function requireConstructedInteractionGuides(
  currentScene: string,
  proposedScene: string
): void {
  type Group = { scope: string; segments: Set<string>; evidence: Set<string> };
  type Context = { identity: string; membership: string };
  type Collected = { groups: Group[]; contexts: Context[] };
  const failContext = () => {
    throw new InteractionContextError(
      'MVS_UNCONSTRUCTED_INTERACTION_CONTEXT',
      'Atomic interaction context must be constructed by mol_show_interaction_context from the chosen physical target. ' +
        'Retain its complete native component, reference, selector, and computed binding-region membership in at least one detail step. ' +
        'Appearance, surface side, and surface colors remain editable; use the native tool to compute a different context.'
    );
  };
  const collect = (
    scene: string,
    trusted: boolean,
    known: Collected = { groups: [], contexts: [] }
  ) => {
    const document = MVSData.fromMVSJ(scene);
    const roots =
      document.kind === 'multiple' ? document.snapshots.map((step) => step.root) : [document.root];
    const groups: Group[] = [];
    const contexts: Context[] = [];
    const fail = () => {
      throw new InteractionContextError(
        'MVS_UNCONSTRUCTED_INTERACTION_GUIDE',
        'Contact guides must be constructed by mol_show_interaction_context from the chosen physical target. ' +
          'A public scene edit may retain and style an existing complete computed set, but cannot add hand-picked ' +
          'atom connections or a claimed contact set. Solid narrative arrows and unclassified distance measurements remain available.'
      );
    };
    const visit = (node: Node, resource: string, format: string, source: string, owner?: Group) => {
      if (node.kind === 'download') resource = String(node.params?.url ?? '');
      if (node.kind === 'parse') format = String(node.params?.format ?? '');
      if (node.kind === 'structure')
        source = canonicalEndpoint({ resource, format, ref: node.ref, params: node.params });
      if (node.kind === 'component' && !node.custom?.dnaforge_surface_owner) {
        const identity = canonicalEndpoint({ source, ref: node.ref });
        const native = node.custom?.dnaforge_interaction_context === contextTag;
        if (!trusted && !native && known.contexts.some((context) => context.identity === identity))
          failContext();
        if (native) {
          const region = node.custom?.dnaforge_binding_region as
            | Record<string, unknown>
            | undefined;
          const membership = canonicalEndpoint({
            selector: node.params?.selector,
            bindingRegion:
              region === undefined
                ? undefined
                : {
                    detail: region.detail,
                    target: region.target,
                    seed: region.seed,
                    partner: region.partner,
                    radius: region.radius,
                    detailMode: region.detailMode,
                    contactScope: region.contactScope,
                    interfaceBurial: region.interfaceBurial,
                    interfaceDetailSide: region.interfaceDetailSide,
                    interfaceDetailBasis: region.interfaceDetailBasis,
                    interfaceProteinAtomicMode: region.interfaceProteinAtomicMode,
                  },
          });
          const context = { identity, membership };
          if (
            !trusted &&
            !known.contexts.some(
              (existing) => existing.identity === identity && existing.membership === membership
            )
          )
            failContext();
          contexts.push(context);
        }
      }
      let group = owner;
      if (node.kind === 'primitives' && node.custom?.dnaforge_interaction_context === contextTag) {
        group = { scope: source, segments: new Set(), evidence: new Set() };
        groups.push(group);
      }
      if (node.kind === 'primitive') {
        const type = String(node.params?.kind);
        const evidence = contactEvidence(node);
        const isGuide =
          ['tube', 'line', 'lines'].includes(type) ||
          (type === 'arrow' && Number(node.params?.tube_dash_length ?? 0) > 0) ||
          evidence.length > 0;
        if (!trusted && type === 'distance_measurement' && !evidence.length) {
          const qualified = (point: unknown) =>
            !!point &&
            typeof point === 'object' &&
            !Array.isArray(point) &&
            ('expression' in point || 'expressions' in point) &&
            (!!source || 'structure_ref' in point);
          if (
            !qualified(node.params?.start) ||
            !qualified(node.params?.end) ||
            !['{{distance}}', '{{distance}} Å'].includes(
              String(node.params?.label_template ?? '{{distance}}')
            ) ||
            (node.params?.label_size !== undefined && Number(node.params.label_size) <= 0)
          )
            fail();
        }
        if (isGuide) {
          if (!group || !node.params?.start || !node.params?.end) {
            if (!trusted) fail();
          } else {
            group.segments.add(
              [canonicalEndpoint(node.params.start), canonicalEndpoint(node.params.end)]
                .sort()
                .join('|')
            );
            for (const record of evidence) group.evidence.add(canonicalEndpoint(record));
            if (!trusted && !evidence.length) fail();
          }
        }
      }
      for (const child of node.children ?? []) visit(child, resource, format, source, group);
    };
    for (const root of roots) visit(root as Node, '', '', '');
    if (!trusted)
      for (const group of groups) {
        const same = (a: Set<string>, b: Set<string>) =>
          a.size === b.size && [...a].every((x) => b.has(x));
        if (
          !known.groups.some(
            (existing) =>
              existing.scope === group.scope &&
              same(existing.segments, group.segments) &&
              same(existing.evidence, group.evidence)
          )
        )
          fail();
      }
    if (!trusted)
      for (const existing of known.contexts)
        if (
          !contexts.some(
            (context) =>
              context.identity === existing.identity && context.membership === existing.membership
          )
        )
          failContext();
    return { groups, contexts };
  };
  collect(proposedScene, false, collect(currentScene, true));
}

export function requireRetainedInteractionContacts(
  currentScene: string,
  proposedScene: string
): void {
  const previous = managedContactSets(currentScene).filter(
    (group) => group.contacts.size && group.visible
  );
  if (!previous.length) return;
  const proposed = managedContactSets(proposedScene).filter((group) => group.visible);
  for (const group of previous) {
    if (
      proposed.some(
        (candidate) =>
          [...group.contacts].every((contact) => candidate.contacts.has(contact)) &&
          [...group.classifications].every((record) => candidate.classifications.has(record))
      )
    )
      continue;
    throw new InteractionContextError(
      'MVS_INTERACTION_CONTACTS_LOST',
      `The scene replacement removes or changes computed contacts from story step ${group.snapshotIndex + 1} ` +
        `(${group.contacts.size} contacts). Keep its complete native-interaction-context-v1 primitives group ` +
        'from mol_get_scene in at least one relevant detail step. Edit its appearance without changing the ' +
        'physical endpoints; use mol_show_interaction_context to recompute a different target. ' +
        'The current scene has not changed.'
    );
  }
}
function isDetail(node: Node) {
  return (
    node.kind === 'representation' &&
    (atomicTypes.has(String(node.params?.type)) ||
      node.custom?.dnaforge_nucleotide_generated === true)
  );
}
function carbonColor(node: Node): string | undefined {
  const color = node.children?.find(
    (n) => n.kind === 'color' && typeof n.params?.color === 'string'
  );
  const theme = color?.custom?.molstar_color_theme_params as
    | { carbonColor?: { params?: { value?: number } } }
    | undefined;
  return typeof theme?.carbonColor?.params?.value === 'number'
    ? '#' + theme.carbonColor.params.value.toString(16).padStart(6, '0')
    : ((color?.params?.color as string | undefined) ??
        (node.custom?.dnaforge_carbon_color as string | undefined));
}
function elementColor(color: string, selector: unknown, label?: string): Node {
  return {
    kind: 'color',
    params: { color, selector },
    custom: {
      molstar_color_theme_name: 'element-symbol',
      molstar_color_theme_params: {
        carbonColor: { name: 'uniform', params: { value: parseInt(color.slice(1), 16) } },
        saturation: 0,
        lightness: 0,
        colors: { name: 'default', params: {} },
      },
      ...(label ? { dnaforge_legend_label: label } : {}),
    },
  };
}

export function requireDisplayedInteractionContext(
  plugin: MolstarPlugin,
  expectedAtomCount: number,
  componentRef = contextRef
) {
  const component = plugin.managers.structure.hierarchy.current.structures
    .flatMap((s) => s.components)
    .find((c) => c.cell.transform.tags?.includes(`mvs-ref:${componentRef}`));
  const atomCount = component?.cell.obj?.data.elementCount ?? 0;
  const representation = component?.representations.find(
    (r) => r.cell.params?.values.type.name === 'ball-and-stick'
  );
  const drawn = representation?.cell.obj?.data.repr.renderObjects.some(
    (object) => object.values.drawCount.ref.value > 0
  );
  if (atomCount !== expectedAtomCount || !drawn)
    throw new InteractionContextError(
      'INTERACTION_CONTEXT_NOT_RENDERED',
      `The requested interaction environment did not render (${atomCount}/${expectedAtomCount} atoms).`
    );
}

export async function buildMolecularInteractionContext(
  plugin: MolstarPlugin,
  document: Scene,
  loci: StructureElement.Loci,
  options: InteractionContextOptions = {},
  activeIndex = 0
) {
  if (['contactTypes', 'radius', 'detailMode'].some((key) => key in options))
    throw new InteractionContextError(
      'INTERACTION_POLICY_OVERRIDE_FORBIDDEN',
      'The complete native Focus interaction set is fixed by the chosen physical target; contact categories, radius and subsets cannot be overridden.'
    );
  const originalSource = options.sceneStructureRef
    ? resolveMolViewSpecStructureRef(plugin, options.sceneStructureRef)
    : plugin.managers.structure.hierarchy.current.structures[0]?.cell.obj?.data;
  if (!originalSource || originalSource.models.length !== 1)
    throw new InteractionContextError(
      'INTERACTION_SOURCE_UNSUPPORTED',
      'Interaction context requires one coordinate model.'
    );
  const activeRoot = (
    document.kind === 'multiple' ? document.snapshots[activeIndex]?.root : document.root
  ) as Node | undefined;
  if (!activeRoot)
    throw new InteractionContextError(
      'MVS_STORY_STEP_INVALID',
      'The active story step is unavailable.'
    );
  const primaryConformer = primaryMolecularConformer(originalSource, activeRoot);
  const source = primaryConformer.structure;
  const rawTargetLoci = StructureElement.Loci.extendToWholeResidues(
    StructureElement.Loci.remap(loci, originalSource)
  );
  const target = primaryMolecularConformer(
    StructureElement.Loci.toStructure(rawTargetLoci),
    activeRoot
  ).structure;
  if (!target.elementCount || target.units.some((u) => !Unit.isAtomic(u)))
    throw new InteractionContextError(
      'EMPTY_SELECTION',
      'The target must contain atomic coordinates.'
    );
  const radius = 5;
  const declaredTarget =
    options.targetSelector === undefined ? target : select(source, options.targetSelector);
  const declaredTargetAtoms = new Set(atoms(declaredTarget).map((a) => key(a.unit, a.index)));
  if (!atoms(target).every((a) => declaredTargetAtoms.has(key(a.unit, a.index))))
    throw new InteractionContextError(
      'MVS_SURFACE_OWNERSHIP_REQUIRED',
      'The contact seed must belong to the declared target side.'
    );
  const nativeEnvironment = (focus: StructureElement.Loci) => {
    const expression = StructureElement.Bundle.toExpression(
      StructureElement.Bundle.fromLoci(focus)
    );
    const surrounding = StructureSelection.unionStructure(
      Script.getStructureSelection(
        MS.struct.modifier.includeSurroundings({
          0: expression,
          radius,
          'as-whole-residues': true,
        }),
        originalSource
      )
    );
    return primaryMolecularConformer(surrounding, activeRoot).structure;
  };
  const seedEnvironment = nativeEnvironment(rawTargetLoci);
  const ionContext = await molecularIonPhysicalContext(
    source,
    declaredTarget,
    seedEnvironment,
    radius,
    (task) => plugin.runTask(task)
  );
  const scientificTarget = ionContext?.cohort ?? declaredTarget;
  const scientificTargetAtoms = new Set(atoms(scientificTarget).map((a) => key(a.unit, a.index)));
  const environment = ionContext
    ? nativeEnvironment(
        StructureElement.Loci.remap(
          Structure.toStructureElementLoci(scientificTarget),
          originalSource
        )
      )
    : seedEnvironment;
  const parameters = {
    providers: structuredClone(PD.getDefaultValues(ContactProviderParams)),
    contacts: structuredClone(PD.getDefaultValues(ContactsParams)),
  };
  const contactTypes = MOLECULAR_CONTACT_TYPES.filter(
    (type) => parameters.providers[type].name === 'on'
  );
  const contactCalculation = {
    contract: 'native-molstar-focus-neighborhood-v1',
    engine: 'molstar-native-interactions',
    version: PLUGIN_VERSION,
    types: [...contactTypes],
    parameters: structuredClone(parameters),
    scope:
      'Every unfiltered native interaction within the complete 5 Å whole-residue Focus neighborhood; scientific surface sides do not prune contacts.',
    primaryConformer: primaryConformer.receipt,
    endpointPolicy:
      'Classified atoms, nearest charge-group members, or explicitly marked aromatic feature centers. Native negative non-polymer nitrogen charge features require negative valence-charge support.',
    excludedClassifications: [] as Array<{
      classification: string;
      reason: string;
      featureA: ReturnType<typeof endpoint>;
      featureB: ReturnType<typeof endpoint>;
    }>,
  };
  await plugin.runTask(
    Task.create('Compute native interaction context', (ctx) =>
      InteractionsProvider.attach(
        { runtime: ctx, assetManager: plugin.managers.asset, errorContext: plugin.errorContext },
        environment,
        parameters
      )
    )
  );
  const interactionData = InteractionsProvider.get(environment).value;
  const nativeContacts = interactionData ? focusContacts(environment, interactionData) : [];
  const scientificPartner =
    options.partnerSelector === undefined
      ? nonPolymerBindingTarget(scientificTarget)
        ? subset(source, (unit, atom) => !scientificTargetAtoms.has(key(unit, atom)))
        : undefined
      : select(source, options.partnerSelector);
  const ligandSide = completeLigandTarget(scientificTarget, source)
    ? 'target'
    : scientificPartner && completeLigandTarget(scientificPartner, source)
      ? 'partner'
      : undefined;
  const ligandBoundary = ligandSide !== undefined;
  const interfaceBoundary = options.presentationRole === 'interface' && !ligandBoundary;
  const proteinAtom = (unit: Unit.Atomic, atom: ElementIndex) =>
    isProtein(unit.model.atomicHierarchy.derived.residue.moleculeType[unit.residueIndex[atom]]);
  const proteinInterface =
    interfaceBoundary &&
    scientificPartner !== undefined &&
    atoms(scientificTarget).some((atom) => proteinAtom(atom.unit, atom.index)) &&
    atoms(scientificPartner).some((atom) => proteinAtom(atom.unit, atom.index));
  const interfaceDetailRequested =
    options.interfaceDetailSide !== undefined ||
    options.interfaceDetailBasis !== undefined ||
    options.interfaceProteinAtomicMode !== undefined;
  if (interfaceDetailRequested && !proteinInterface)
    throw new InteractionContextError(
      'INTERFACE_DETAIL_UNSUPPORTED',
      'Interface atomic-detail choices require protein on both declared interface sides. Ligand binding, single ions and RNA-only detail retain their native chemistry.'
    );
  if (
    proteinInterface &&
    (options.interfaceDetailSide === undefined || options.interfaceDetailBasis === undefined)
  )
    throw new InteractionContextError(
      'INTERFACE_DETAIL_REQUIRED',
      'New protein interfaces require both interfaceDetailSide:target|partner|both and interfaceDetailBasis:contacts|burial. Choose each from the scientific question; complete native measurements and required guide support remain intact.'
    );
  const interfaceDetail = proteinInterface
    ? {
        side: options.interfaceDetailSide!,
        basis: options.interfaceDetailBasis!,
        atomicMode: options.interfaceProteinAtomicMode ?? 'sidechain-with-trace',
      }
    : undefined;
  const bindingBoundary =
    nonPolymerBindingTarget(scientificTarget) ||
    (scientificPartner !== undefined && nonPolymerBindingTarget(scientificPartner)) ||
    interfaceBoundary;
  const presentationRole = ligandBoundary
    ? 'binding-site'
    : (options.presentationRole ?? 'binding-site');
  const surfaceSide = ligandSide ?? options.surfaceSide;
  const surfaceOwner = surfaceSide
    ? surfaceSide === 'target'
      ? scientificTarget
      : scientificPartner
    : undefined;
  const surfaceExtent =
    surfaceOwner && containsMolecularLigand(surfaceOwner)
      ? 'complete'
      : (options.surfaceExtent ?? 'contact-patch');
  const interfaceBurial =
    (interfaceBoundary || ligandBoundary) && scientificPartner
      ? await computeMolecularInterfaceBurial(source, scientificTarget, scientificPartner, (task) =>
          plugin.runTask(task)
        )
      : undefined;
  const partnerAtoms = scientificPartner
    ? new Set(atoms(scientificPartner).map((a) => key(a.unit, a.index)))
    : undefined;
  if (
    bindingBoundary &&
    partnerAtoms &&
    [...partnerAtoms].some((atom) => scientificTargetAtoms.has(atom))
  )
    throw new InteractionContextError(
      'MVS_SURFACE_OWNERSHIP_REQUIRED',
      'Binding partners must be disjoint physical selections.'
    );
  const onTarget = (feature: Atom[]) =>
    feature.every((atom) => scientificTargetAtoms.has(key(atom.unit, atom.index)));
  const onPartner = (feature: Atom[]) =>
    feature.every((atom) =>
      partnerAtoms
        ? partnerAtoms.has(key(atom.unit, atom.index))
        : !scientificTargetAtoms.has(key(atom.unit, atom.index))
    );
  const contacts = bindingBoundary
    ? nativeContacts.filter(
        (contact) =>
          (onTarget(contact.a) && onPartner(contact.b)) ||
          (onTarget(contact.b) && onPartner(contact.a))
      )
    : nativeContacts;
  if (bindingBoundary) {
    contactCalculation.contract = 'native-molstar-binding-boundary-v2';
    contactCalculation.scope =
      'Every standard native contact crossing the complete declared target and its partner; internal contacts on either side are excluded. Native categories and parameters are unchanged.';
  }
  if (contacts.length > 800)
    throw new InteractionContextError(
      'INTERACTION_CONTEXT_TOO_LARGE',
      'This selection produces too many contact guides for a saved view. Choose a more specific target.'
    );
  contactCalculation.excludedClassifications = contacts
    .filter((contact) => contact.excludedReason)
    .map((contact) => ({
      classification: contact.label,
      reason: contact.excludedReason!,
      featureA: endpoint(contact.a),
      featureB: endpoint(contact.b),
    }));
  if (contactCalculation.excludedClassifications.length)
    throw new InteractionContextError(
      'INTERACTION_CHEMISTRY_UNSUPPORTED',
      'Native Focus includes an unsupported charge assignment. A complete interaction display cannot silently omit it or present it as established chemistry.'
    );
  const detailMode = bindingBoundary ? ('contact-residues' as const) : ('neighborhood' as const);
  const contactAtoms = new Set(
    contacts.flatMap((contact) =>
      [
        ...contact.a,
        ...contact.b,
        ...(contact.chargeMembers?.a ?? []),
        ...(contact.chargeMembers?.b ?? []),
      ].map((atom) => key(atom.unit, atom.index))
    )
  );
  const supportingResidues = bindingBoundary
    ? StructureElement.Loci.toStructure(
        StructureElement.Loci.extendToWholeResidues(
          StructureElement.Loci.remap(
            Structure.toStructureElementLoci(
              subset(source, (unit, atom) => contactAtoms.has(key(unit, atom)))
            ),
            source
          )
        )
      )
    : environment;
  const detailedProteinSide = (unit: Unit.Atomic, atom: ElementIndex) =>
    !interfaceDetail ||
    interfaceDetail.side === 'both' ||
    (interfaceDetail.side === 'target'
      ? scientificTargetAtoms.has(key(unit, atom))
      : partnerAtoms!.has(key(unit, atom)));
  const included = new Set(
    atoms(supportingResidues)
      .filter((a) => !proteinAtom(a.unit, a.index) || detailedProteinSide(a.unit, a.index))
      .map((a) => key(a.unit, a.index))
  );
  for (const atom of contactAtoms) included.add(atom);
  if (ionContext) {
    for (const atom of atoms(ionContext.cohort)) included.add(key(atom.unit, atom.index));
    if (ionContext.packing)
      for (const atom of atoms(select(source, ionContext.packing.partner.selector)))
        included.add(key(atom.unit, atom.index));
  }
  if (ligandBoundary) {
    const ligand = ligandSide === 'target' ? scientificTarget : scientificPartner!;
    for (const atom of atoms(ligand)) included.add(key(atom.unit, atom.index));
  }
  if (interfaceBurial) {
    const packedSides = ligandBoundary
      ? [interfaceBurial[ligandSide === 'target' ? 'partner' : 'target']]
      : [interfaceBurial.target, interfaceBurial.partner];
    for (const packedSide of packedSides) {
      for (const atom of atoms(select(source, packedSide.selector)))
        if (
          !proteinAtom(atom.unit, atom.index) ||
          !interfaceDetail ||
          (interfaceDetail.basis === 'burial' && detailedProteinSide(atom.unit, atom.index))
        )
          included.add(key(atom.unit, atom.index));
    }
  }
  if (!included.size && interfaceDetailRequested)
    throw new InteractionContextError(
      'INTERFACE_DETAIL_EMPTY',
      'The selected interface detail has no native evidence atoms. Choose a supported detail basis or retain the overview.'
    );
  if (!included.size) for (const atom of atoms(target)) included.add(key(atom.unit, atom.index));
  if (interfaceDetail?.atomicMode === 'sidechain-with-trace') {
    const nativeSidechains = StructureSelection.unionStructure(
      Script.getStructureSelection(StructureSelectionQueries.sidechainWithTrace.expression, source)
    );
    const sidechainAtoms = new Set(atoms(nativeSidechains).map((a) => key(a.unit, a.index)));
    for (const atom of atoms(source)) {
      const atomKey = key(atom.unit, atom.index);
      if (
        included.has(atomKey) &&
        proteinAtom(atom.unit, atom.index) &&
        !sidechainAtoms.has(atomKey) &&
        !contactAtoms.has(atomKey)
      )
        included.delete(atomKey);
    }
    for (const atom of atoms(source)) {
      if (!included.has(key(atom.unit, atom.index)) || !proteinAtom(atom.unit, atom.index))
        continue;
      const trace =
        atom.unit.model.atomicHierarchy.derived.residue.traceElementIndex[
          atom.unit.residueIndex[atom.index]
        ];
      const path =
        trace >= 0 ? molecularResidueCovalentPath(atom.unit, atom.index, trace) : undefined;
      if (!path)
        throw new InteractionContextError(
          'INTERFACE_PROTEIN_TRACE_UNSUPPORTED',
          'The requested protein atom has no deposited covalent path to its actual cartoon trace. Retain full-residue presentation; a connection cannot be fabricated.'
        );
      for (const member of path) included.add(key(atom.unit, member));
    }
    if (!included.size)
      throw new InteractionContextError(
        'INTERFACE_DETAIL_EMPTY',
        'The native protein sidechain presentation contains no available evidence atoms. Retain full-residue presentation or choose supported interface evidence.'
      );
  }
  const sourceIndex = plugin.managers.structure.hierarchy.current.structures.findIndex(
    (entry) =>
      entry.cell.obj?.data === originalSource || entry.transform?.cell.obj?.data === originalSource
  );
  const connections = readMolecularConnections(plugin).filter(
    (c) => c.attachment && c.structureIndex === sourceIndex
  );
  for (let pass = 0; pass <= connections.length; pass++) {
    let changed = false;
    for (const connection of connections) {
      const pair = select(source, [connection.a.residueSelector, connection.b.residueSelector]);
      if (!atoms(pair).some((a) => included.has(key(a.unit, a.index)))) continue;
      for (const atom of atoms(pair))
        if (!included.has(key(atom.unit, atom.index))) {
          included.add(key(atom.unit, atom.index));
          changed = true;
        }
    }
    if (!changed) break;
  }
  const detail = subset(source, (unit, atom) => included.has(key(unit, atom)));
  const result = structuredClone(document);
  const root = (result.kind === 'multiple' ? result.snapshots[activeIndex]?.root : result.root) as
    | Node
    | undefined;
  if (!root)
    throw new InteractionContextError(
      'MVS_STORY_STEP_INVALID',
      'The active story step is unavailable.'
    );
  const structureNodes = walk(root).filter((n) => n.kind === 'structure');
  const structure = options.sceneStructureRef
    ? structureNodes.find((node) => node.ref === options.sceneStructureRef)
    : structureNodes.length === 1
      ? structureNodes[0]
      : undefined;
  if (!structure)
    throw new InteractionContextError(
      'INTERACTION_SOURCE_UNSUPPORTED',
      'Interaction context requires an exact scene structure source.'
    );
  for (const node of walk(structure))
    node.children = node.children?.filter((n) => n.kind !== 'focus');
  const colors: Node[] = [];
  const children: Node[] = [];
  const inheritColors = (atomic: boolean) => {
    for (const component of structure.children ?? []) {
      if (component.kind !== 'component') continue;
      const selected = select(source, component.params?.selector ?? 'all');
      const inside = subset(selected, (unit, atom) => included.has(key(unit, atom)));
      if (!inside.elementCount) continue;
      for (const repr of component.children ?? []) {
        if (repr.kind !== 'representation' || repr.custom?.dnaforge_nucleotide_generated) continue;
        if (atomicTypes.has(String(repr.params?.type)) !== atomic) continue;
        if (!atomic && repr.params?.type !== 'cartoon' && repr.params?.type !== 'backbone')
          continue;
        const colorNodes = repr.children?.filter((n) => n.kind === 'color') ?? [];
        for (const layer of colorNodes.length ? colorNodes : [repr]) {
          const color = carbonColor(layer === repr ? repr : { ...repr, children: [layer] });
          if (!color || !/^#[0-9a-f]{6}$/i.test(color)) continue;
          const scoped = select(inside, layer === repr ? 'all' : (layer.params?.selector ?? 'all'));
          if (!scoped.elementCount) continue;
          const rule = elementColor(
            color,
            molecularAtomSelector(scoped, originalSource),
            typeof layer.custom?.dnaforge_legend_label === 'string' &&
              layer.custom.dnaforge_legend_generated !== true
              ? layer.custom.dnaforge_legend_label
              : component.custom?.dnaforge_interaction_context === contextTag
                ? undefined
                : typeof repr.custom?.dnaforge_legend_label === 'string'
                  ? repr.custom.dnaforge_legend_label
                  : undefined
          );
          const equivalent = colors.findIndex(
            (old) => JSON.stringify(old) === JSON.stringify(rule)
          );
          if (equivalent >= 0) colors.splice(equivalent, 1);
          colors.push(rule);
        }
      }
    }
  };
  inheritColors(false);
  inheritColors(true);
  if (ionContext && colors.length)
    colors.unshift(elementColor(colors[0].params!.color as string, 'all'));
  for (const child of structure.children ?? []) {
    if (child.custom?.dnaforge_interaction_context === contextTag) continue;
    if (child.kind !== 'component' || !child.children?.some(isDetail)) {
      children.push(child);
      continue;
    }
    const selected = select(source, child.params?.selector ?? 'all');
    const inside = subset(selected, (unit, atom) => included.has(key(unit, atom)));
    if (!inside.elementCount) {
      children.push(child);
      continue;
    }
    const remaining = child.children.filter((n) => !isDetail(n));
    if (remaining.length) children.push({ ...child, children: remaining });
    const outside = subset(selected, (unit, atom) => !included.has(key(unit, atom)));
    if (outside.elementCount)
      children.push({
        ...child,
        params: { ...child.params, selector: molecularAtomSelector(outside, originalSource) },
        children: child.children.filter(isDetail),
      });
  }
  const hasNucleotides = detail.units.some(
    (unit) => Unit.isAtomic(unit) && unit.nucleotideElements.length > 0
  );
  const partner =
    options.partnerSelector === undefined
      ? subset(detail, (unit, atom) => !scientificTargetAtoms.has(key(unit, atom)))
      : scientificPartner!;
  if (interfaceBoundary && (!surfaceSide || options.partnerSelector === undefined))
    throw new InteractionContextError(
      'MVS_SURFACE_OWNERSHIP_REQUIRED',
      'An interface surface requires surfaceSide and an explicit partnerSelection; the atomic neighborhood is not the surface owner.'
    );
  const newContext: Node & { ref: string } = {
    kind: 'component',
    ref: options.sceneStructureRef ? `${contextRef}:${options.sceneStructureRef}` : contextRef,
    params: { selector: molecularAtomSelector(detail, originalSource) },
    custom: {
      dnaforge_interaction_context: contextTag,
      dnaforge_presentation_role: presentationRole,
      ...(ionContext ? { dnaforge_physical_ion_context: ionContext.receipt } : {}),
      ...(partner.elementCount
        ? {
            dnaforge_binding_region: {
              target: molecularAtomSelector(scientificTarget, originalSource),
              seed: molecularAtomSelector(target, originalSource),
              radius,
              detailMode,
              ...(bindingBoundary ? { contactScope: 'binding-boundary-v2' } : {}),
              ...(interfaceBurial ? { interfaceBurial } : {}),
              ...(interfaceDetail
                ? {
                    interfaceDetailSide: interfaceDetail.side,
                    interfaceDetailBasis: interfaceDetail.basis,
                    interfaceProteinAtomicMode: interfaceDetail.atomicMode,
                  }
                : {}),
              surfaceColorMode: options.surfaceColorMode ?? 'identity',
              partner: molecularAtomSelector(partner, originalSource),
              detail: molecularAtomSelector(detail, originalSource),
              ...(surfaceSide ? { surfaceSide, surfaceExtent } : {}),
            },
          }
        : {}),
    },
    children: [
      {
        kind: 'representation',
        params: { type: 'ball_and_stick' },
        custom: {
          molstar_representation_params: {
            excludeTypes: ['hydrogen-bond', 'metal-coordination'],
            ...(hasNucleotides
              ? {
                  dnaforgeNucleotideKeepAtoms: contacts.flatMap((contact) => [
                    ...endpoint(contact.a).expressions,
                    ...endpoint(contact.b).expressions,
                  ]),
                }
              : {}),
          },
          ...(hasNucleotides
            ? {
                dnaforge_nucleotide_presentation: {},
              }
            : {}),
        },
        children: colors,
      },
    ],
  };
  const camera = plugin.canvas3d?.camera.getSnapshot();
  if (options.focus !== false) {
    root.children = root.children?.filter((n) => n.kind !== 'camera');
    const direction = camera
      ? Vec3.normalize(Vec3(), Vec3.sub(Vec3(), camera.target, camera.position))
      : [0, 0, -1];
    newContext.children!.push({
      kind: 'focus',
      params: {
        direction: [...direction],
        up: camera ? [...camera.up] : [0, 1, 0],
        radius_extent: 4,
      },
    });
  } else if (camera) {
    const previousCamera = root.children?.find((node) => node.kind === 'camera');
    const position = fovNormalizedCameraPosition(
      camera.target,
      camera.position,
      camera.mode,
      camera.fov
    );
    root.children = (root.children ?? []).filter((node) => node.kind !== 'camera');
    root.children.push({
      ...previousCamera,
      kind: 'camera',
      params: {
        ...previousCamera?.params,
        target: [...camera.target],
        position: [...position],
        up: [...camera.up],
        near: camera.minNear,
      },
    });
  }
  const maxMeasurements = options.measurements === true ? (options.maxMeasurements ?? 6) : 0;
  let measurementCount = 0;
  const guides = coalesceMolecularContactGuides(
    contacts.map((contact) => {
      const measure =
        contact.a.length === 1 &&
        contact.b.length === 1 &&
        contact.type !== InteractionType.Hydrophobic &&
        measurementCount < maxMeasurements;
      if (measure) measurementCount++;
      return molecularContactGuide(contact, measure);
    })
  );
  measurementCount = guides.filter((guide) => guide.params?.kind === 'distance_measurement').length;
  const centers = new Map<string, Node>();
  for (const guide of guides)
    for (const marker of molecularContactCenterMarkers(guide))
      centers.set(canonicalEndpoint(marker.params?.center), marker);
  structure.children = [
    ...children,
    newContext,
    ...(guides.length
      ? [
          {
            kind: 'primitives',
            custom: {
              dnaforge_interaction_context: contextTag,
              dnaforge_contact_calculation: contactCalculation,
            },
            params: { opacity: 1 },
            children: [...guides, ...centers.values()],
          },
        ]
      : []),
  ];
  let completed = result;
  let environmentAtomCount = detail.elementCount;
  if (hasNucleotides) {
    const selection = getMolViewSpecRenderProfile(plugin);
    const sourceForStructure = (node: Node) =>
      node.ref === structure.ref ? originalSource : undefined;
    completed = normalizeActiveMolecularSource(
      result,
      activeIndex,
      structure.ref,
      (sourceDocument) => {
        const profiled = resolveMolViewSpecRenderProfile(
          sourceDocument,
          selection === 'native' ? currentMolecularRenderProfile() : selection,
          (selector, ref) =>
            ref === structure.ref &&
            select(originalSource, selector).units.some(
              (unit) => Unit.isAtomic(unit) && unit.nucleotideElements.length > 0
            )
        );
        return resolveMolViewSpecAttachments(
          plugin,
          resolveMolViewSpecNativeContactOwners(
            resolveNucleotideAppearance(profiled, sourceForStructure),
            sourceForStructure
          ),
          sourceForStructure
        );
      }
    );
    const completedRoot = (
      completed.kind === 'multiple' ? completed.snapshots[activeIndex].root : completed.root
    ) as Node;
    const completedContext = walk(completedRoot).find((node) => node.ref === newContext.ref)!;
    environmentAtomCount = select(originalSource, completedContext.params?.selector).elementCount;
  }
  const scene = MVSData.toMVSJ(completed);
  const issues = MVSData.validationIssues(MVSData.fromMVSJ(scene), { noExtra: true });
  if (issues?.length)
    throw new InteractionContextError('MVS_INVALID_SCENE', issues.slice(0, 4).join('\n'));
  return {
    scene,
    contextRef: newContext.ref,
    context: {
      source: 'molstar-native-interactions',
      contactCalculation,
      detailMode,
      ...(ionContext ? { physicalIonContext: ionContext.receipt } : {}),
      ...(interfaceDetail
        ? {
            interfaceDetailSide: interfaceDetail.side,
            interfaceDetailBasis: interfaceDetail.basis,
            interfaceProteinAtomicMode: interfaceDetail.atomicMode,
            requiredGuideFeatureAtomCount: contactAtoms.size,
          }
        : {}),
      ...(interfaceBurial
        ? {
            interfaceBurial,
            interfaceSurfaceMeaning:
              surfaceExtent === 'complete'
                ? 'The complete chosen scientific side supplies an unmasked molecular contour. Native partner-induced surface-burial measurements remain separate from contour visibility; they do not estimate binding energy.'
                : 'Residues losing solvent-accessible area upon adding the declared partner, in square angstroms. One complete side supplies the surface geometry; the visible residue patch is not an exact atomic contact face or a binding-energy estimate.',
          }
        : {}),
      presentationRole,
      ...(ligandBoundary
        ? {
            ligandContourMeaning:
              'The complete identified molecular ligand supplies the contour, independently of a requested interface role or protein-side surface. No protein atoms supply this mesh.',
            pocketDetailMeaning:
              'Complete residues with native partner-induced solvent-accessible area loss, plus typed contact support and chemical attachments. Packing membership does not depend on which dotted-line categories are enabled.',
          }
        : {}),
      ...(surfaceSide
        ? {
            surfaceSide,
            surfaceExtent,
            surfaceAtomCount: (surfaceSide === 'target' ? scientificTarget : partner).elementCount,
          }
        : {}),
      radius,
      targetAtomCount: target.elementCount,
      scientificTargetAtomCount: scientificTarget.elementCount,
      environmentAtomCount,
      contactCount: contacts.length,
      nativeCalculatedContactCount: nativeContacts.length,
      unrelatedContactCount: nativeContacts.length - contacts.length,
      displayedGuideCount: guides.length,
      excludedContactCount: contactCalculation.excludedClassifications.length,
      featureCenterMarkerCount: centers.size,
      measurementCount,
      countsByType: contacts.reduce(
        (counts, c) => ({ ...counts, [c.label]: (counts[c.label] ?? 0) + 1 }),
        {} as Record<string, number>
      ),
      guidance: bindingBoundary
        ? 'Standard native Molstar categories, parameters and guide geometry are unchanged. Every computed contact crossing the declared binding boundary is retained; internal contacts on either side are excluded. Complete supporting chemistry and attachments remain visible. Recompute through this tool for a different target; inspect the final image before saving.'
        : 'This is the complete installed-native Focus interaction set over the chosen conformer and its 5 Å whole-residue neighborhood. Native classifications are coordinate inference. Recompute through this tool for a different physical target; inspect the final image before saving.',
    },
  };
}
