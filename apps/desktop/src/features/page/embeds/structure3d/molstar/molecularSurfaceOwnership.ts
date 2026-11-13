import { bindingRegionSchema, surfaceOwnerSchema } from './molecularBindingIntent';
export { bindingRegionSchema, surfaceOwnerSchema } from './molecularBindingIntent';
import { molecularAtomSelector } from './molecularConnections';
import type { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { Structure, Unit } from 'molstar/lib/mol-model/structure';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import type { MolecularProfileNode as Node } from './nucleotidePresentationSettings';
import {
  molecularColorIsElementPalette,
  molecularRepresentationVisible,
} from './molecularDisplayGroups';
import type { MolecularPresentationPreferences } from './molecularPresentationPreferences';
import { molecularBindingDetail } from './molecularBindingDetail';
import { primaryMolecularConformer } from './molecularPrimaryConformer';

const surfaceTypes = new Set(['surface', 'molecular-surface', 'gaussian-surface']);
const atomicTypes = new Set(['ball_and_stick', 'spacefill', 'line', 'point']);

export function requireComputedMolecularInterfaceSurfaces(document: MVSData): void {
  const roots =
    document.kind === 'multiple' ? document.snapshots.map((step) => step.root) : [document.root];
  for (const root of roots)
    for (const structure of walk(root as Node).filter((node) => node.kind === 'structure')) {
      const regions = new Map(
        (structure.children ?? [])
          .filter((node) => node.custom?.dnaforge_binding_region)
          .map((node) => [(node as Node & { ref?: string }).ref, node])
      );
      for (const component of structure.children ?? []) {
        const owner = surfaceOwnerSchema.safeParse(component.custom?.dnaforge_surface_owner);
        if (
          !owner.success ||
          !(component.children ?? []).some(
            (node) => node.kind === 'representation' && surfaceTypes.has(String(node.params?.type))
          )
        )
          continue;
        const region = regions.get(owner.data.regionRef);
        if (region?.custom?.dnaforge_presentation_role !== 'interface') continue;
        const intent = bindingRegionSchema.parse(region.custom.dnaforge_binding_region);
        if (
          region.custom.dnaforge_interaction_context !== 'native-interaction-context-v1' ||
          !intent.interfaceBurial
        )
          throw Object.assign(
            new Error(
              'Compute this interface surface with mol_show_interaction_context using the complete targetSelection and partnerSelection. A nearby residue selection or polar contact list cannot substitute for its native surface-burial patch.'
            ),
            { code: 'MVS_INTERFACE_SURFACE_COMPUTATION_REQUIRED' }
          );
      }
    }
}
function fail(message: string): never {
  const error = new Error(message);
  Object.assign(error, { code: 'MVS_SURFACE_OWNERSHIP_REQUIRED' });
  throw error;
}
function walk(node: Node): Node[] {
  return node.custom?.is_hidden === true ? [] : [node, ...(node.children ?? []).flatMap(walk)];
}
function select(source: Structure, selector: unknown): Structure {
  return substructureFromSelector(
    source,
    componentPropsFromSelector(selector as Parameters<typeof componentPropsFromSelector>[0])
  );
}
function keys(source: Structure) {
  return new Set(
    source.units.flatMap((u) =>
      Unit.isAtomic(u) ? Array.from(u.elements, (a) => `${u.id}:${a}`) : []
    )
  );
}
const intersects = (a: Set<string>, b: Set<string>) => [...a].some((k) => b.has(k));
const contains = (a: Set<string>, b: Set<string>) => [...b].every((k) => a.has(k));

function keyedSubset(source: Structure, included: Set<string>): Structure {
  const builder = source.subsetBuilder(true);
  for (const unit of source.units) {
    builder.beginUnit(unit.id);
    for (const atom of Array.from(unit.elements))
      if (included.has(`${unit.id}:${atom}`)) builder.addElement(atom);
    builder.commitUnit();
  }
  return builder.getStructure();
}

function chainKeys(source: Structure): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  for (const unit of source.units) {
    if (!Unit.isAtomic(unit)) continue;
    for (const atom of Array.from(unit.elements)) {
      const chain = `${unit.id}:${unit.model.atomicHierarchy.chainAtomSegments.index[atom]}`;
      const atoms = groups.get(chain) ?? new Set<string>();
      atoms.add(`${unit.id}:${atom}`);
      groups.set(chain, atoms);
    }
  }
  return groups;
}

export function completeLigandTarget(target: Structure, source: Structure): boolean {
  if (target.elementCount < 2) return false;
  const selected = keys(target);
  const residues = new Set<string>();
  for (const unit of target.units) {
    if (!Unit.isAtomic(unit)) return false;
    const hierarchy = unit.model.atomicHierarchy;
    for (const atom of Array.from(unit.elements)) {
      const chain = hierarchy.chainAtomSegments.index[atom];
      const entity = unit.model.entities.getEntityIndex(
        hierarchy.chains.label_entity_id.value(chain)
      );
      const entityType = unit.model.entities.data.type.value(entity);
      if (entityType !== 'non-polymer' && entityType !== 'branched') return false;
      residues.add(`${unit.id}:${hierarchy.residueAtomSegments.index[atom]}`);
    }
  }
  const residueSizes = new Map<string, number>();
  for (const unit of source.units) {
    if (!Unit.isAtomic(unit)) continue;
    for (const atom of Array.from(unit.elements)) {
      const residue = `${unit.id}:${unit.model.atomicHierarchy.residueAtomSegments.index[atom]}`;
      if (!residues.has(residue)) continue;
      if (!selected.has(`${unit.id}:${atom}`)) return false;
      residueSizes.set(residue, (residueSizes.get(residue) ?? 0) + 1);
    }
  }
  return [...residueSizes.values()].every((size) => size > 1);
}

export function containsMolecularLigand(side: Structure): boolean {
  const sizes = new Map<string, number>();
  for (const unit of side.units) {
    if (!Unit.isAtomic(unit)) continue;
    const hierarchy = unit.model.atomicHierarchy;
    for (const atom of Array.from(unit.elements)) {
      const chain = hierarchy.chainAtomSegments.index[atom];
      const entity = unit.model.entities.getEntityIndex(
        hierarchy.chains.label_entity_id.value(chain)
      );
      const type = unit.model.entities.data.type.value(entity);
      if (type !== 'non-polymer' && type !== 'branched') continue;
      const residue = `${unit.id}:${hierarchy.residueAtomSegments.index[atom]}`;
      const count = (sizes.get(residue) ?? 0) + 1;
      if (count > 1) return true;
      sizes.set(residue, count);
    }
  }
  return false;
}

export function nonPolymerBindingTarget(target: Structure): boolean {
  if (!target.elementCount) return false;
  return target.units.every((unit) => {
    if (!Unit.isAtomic(unit)) return false;
    return Array.from(unit.elements).every((atom) => {
      const hierarchy = unit.model.atomicHierarchy;
      const chain = hierarchy.chainAtomSegments.index[atom];
      const entity = unit.model.entities.getEntityIndex(
        hierarchy.chains.label_entity_id.value(chain)
      );
      const entityType = unit.model.entities.data.type.value(entity);
      return entityType === 'non-polymer' || entityType === 'branched';
    });
  });
}

function uniformCarbonIdentity(layer: Node, repr: Node): Node | undefined {
  const theme = (layer.custom?.molstar_color_theme_params ??
    repr.custom?.molstar_color_theme_params) as
    | { carbonColor?: { name?: string; params?: { value?: number } } }
    | undefined;
  const value = theme?.carbonColor?.params?.value;
  if (
    theme?.carbonColor?.name !== 'uniform' ||
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffffff
  )
    return undefined;
  if (layer.custom?.dnaforge_element_color_layer === true) return undefined;
  const selectors = Array.isArray(layer.params?.selector)
    ? layer.params?.selector
    : [layer.params?.selector];
  if (
    selectors.some(
      (selector) => selector && typeof selector === 'object' && 'type_symbol' in selector
    )
  )
    return undefined;
  return {
    ...layer,
    params: { ...layer.params, color: `#${value.toString(16).padStart(6, '0')}` },
  };
}

function ownerSurfaceColors(
  owner: Structure,
  source: Structure,
  structure: Node,
  emphasis: boolean
): Node[] {
  const ownerChains = chainKeys(owner);
  const colors: Node[] = [];
  const covered = new Set<string>();
  const atomicIdentity = new Map<string, { layer: Node; scopeSize: number }>();
  for (const types of [new Set(['cartoon', 'backbone']), atomicTypes]) {
    for (const component of structure.children ?? []) {
      if (component.kind !== 'component' || component.custom?.is_hidden === true) continue;
      const intent = bindingRegionSchema.safeParse(component.custom?.dnaforge_binding_region);
      const scope = intent.success
        ? keyedSubset(
            owner,
            new Set([
              ...keys(select(owner, intent.data.target)),
              ...keys(select(owner, intent.data.partner)),
            ])
          )
        : select(owner, component.params?.selector ?? 'all');
      if (!scope.elementCount) continue;
      for (const repr of component.children ?? []) {
        if (
          !types.has(String(repr.params?.type)) ||
          !molecularRepresentationVisible(repr) ||
          repr.custom?.dnaforge_nucleotide_generated
        )
          continue;
        for (const layer of repr.children?.filter((n) => n.kind === 'color') ?? []) {
          const atomic = types === atomicTypes;
          const identity =
            (atomic ? uniformCarbonIdentity(layer, repr) : undefined) ??
            (molecularColorIsElementPalette(layer, repr) ? undefined : layer);
          if (!identity) continue;
          const painted = select(scope, layer.params?.selector ?? 'all');
          const paintedKeys = keys(painted);
          if (!paintedKeys.size) continue;
          const wholeChains = [...ownerChains.entries()].filter(([, atoms]) =>
            intersects(paintedKeys, atoms)
          );
          const complete =
            wholeChains.length > 0 &&
            wholeChains.every(([, atoms]) => contains(paintedKeys, atoms));
          if ((!emphasis || atomic) && !complete) continue;
          const admitted = atomic
            ? wholeChains.filter(([chain]) => !covered.has(chain))
            : wholeChains;
          if (!admitted.length) continue;
          if (atomic) {
            for (const [chain] of admitted) {
              const previous = atomicIdentity.get(chain);
              if (!previous || paintedKeys.size <= previous.scopeSize)
                atomicIdentity.set(chain, { layer: identity, scopeSize: paintedKeys.size });
            }
            continue;
          }
          const color = structuredClone(identity);
          color.params = { ...color.params, selector: molecularAtomSelector(painted, source) };
          colors.push(color);
          if (complete) for (const [chain] of admitted) covered.add(chain);
        }
      }
    }
  }
  const atomicLayers = new Map<Node, Set<string>>();
  for (const [chain, { layer }] of atomicIdentity) {
    const atoms = atomicLayers.get(layer) ?? new Set<string>();
    for (const atom of ownerChains.get(chain)!) atoms.add(atom);
    atomicLayers.set(layer, atoms);
  }
  for (const [layer, atoms] of atomicLayers) {
    const color = structuredClone(layer);
    color.params = {
      ...color.params,
      selector: molecularAtomSelector(keyedSubset(owner, atoms), source),
    };
    colors.push(color);
  }
  const paintedAtoms = new Set(
    colors.flatMap((color) => [...keys(select(owner, color.params?.selector ?? 'all'))])
  );
  const uncovered = keyedSubset(
    owner,
    new Set([...keys(owner)].filter((atom) => !paintedAtoms.has(atom)))
  );
  return uncovered.elementCount
    ? [
        {
          kind: 'color',
          params: { color: '#909090', selector: molecularAtomSelector(uncovered, source) },
        },
        ...colors,
      ]
    : colors;
}

export function requireMolecularSurfaceOwnership(
  document: MVSData,
  sourceFor: (structure: Node & { ref?: string }, index: number) => Structure | undefined,
  authoring = false
): void {
  const roots =
    document.kind === 'multiple' ? document.snapshots.map((s) => s.root) : [document.root];
  for (const [index, root] of roots.entries()) {
    if (authoring)
      root.custom = { ...root.custom, dnaforge_surface_ownership_contract: 'single-side-v1' };
    if (
      !authoring &&
      root.custom?.dnaforge_surface_ownership_contract !== 'single-side-v1' &&
      !walk(root as Node).some(
        (n) => n.custom?.dnaforge_binding_region || n.custom?.dnaforge_surface_owner
      ) &&
      (root.custom?.dnaforge_render_profile as { surfaceOwnership?: string } | undefined)
        ?.surfaceOwnership !== 'single-side-v1'
    )
      continue;
    for (const structure of walk(root as Node).filter((n) => n.kind === 'structure')) {
      const components = walk(structure).filter(
        (n) => n.kind === 'component' && n.custom?.is_hidden !== true
      );
      const regions = components.filter((n) => n.custom?.dnaforge_binding_region !== undefined);
      const surfaces = components.filter((n) =>
        n.children?.some(
          (r) => surfaceTypes.has(String(r.params?.type)) && molecularRepresentationVisible(r)
        )
      );
      const guides = walk(structure).filter(
        (n) => n.kind === 'primitives' && n.custom?.dnaforge_interaction_context
      );
      if (!regions.length && !surfaces.length && !guides.length) continue;
      const source = sourceFor(structure, index);
      if (!source) fail('Surface ownership requires the matching loaded coordinate source.');
      const declared = new Map<
        string,
        { target: Set<string>; partner: Set<string>; side?: string }
      >();
      const atomic = new Set<string>();
      for (const component of components) {
        const reps =
          component.children?.filter(
            (r) => r.kind === 'representation' && molecularRepresentationVisible(r)
          ) ?? [];
        if (
          reps.some(
            (r) =>
              atomicTypes.has(String(r.params?.type)) &&
              Number(
                (r.custom?.molstar_representation_params as { alpha?: number } | undefined)
                  ?.alpha ??
                  r.children?.find((c) => c.kind === 'opacity')?.params?.opacity ??
                  1
              ) === 1
          )
        )
          for (const k of keys(select(source, component.params?.selector ?? 'all'))) atomic.add(k);
      }
      for (const node of regions) {
        const ref = (node as Node & { ref?: string }).ref;
        const parsed = bindingRegionSchema.safeParse(node.custom!.dnaforge_binding_region);
        if (!parsed.success || !ref || declared.has(ref))
          fail('A binding region requires a unique ref and explicit target/partner selectors.');
        const region = parsed.data;
        const target = keys(select(source, region.target));
        const partner = keys(select(source, region.partner));
        if (!target.size || !partner.size || intersects(target, partner))
          fail(
            'Binding surface sides must be nonempty and disjoint in the actual coordinate instance.'
          );
        if (
          region.detail !== undefined &&
          (!keys(select(source, region.detail)).size ||
            !contains(atomic, keys(select(source, region.detail))))
        )
          fail(
            'The binding region is missing opaque atomic contact detail. Retain both sides of the source-computed environment.'
          );
        declared.set(ref, { target, partner, side: region.surfaceSide });
      }
      const endpointExpressions = guides
        .flatMap((g) => g.children ?? [])
        .flatMap((g) => [g.params?.start, g.params?.end])
        .flatMap(
          (e) => (e as { expressions?: Record<string, unknown>[] } | undefined)?.expressions ?? []
        );
      const requestedIndices = new Set(
        endpointExpressions
          .map((e) => e.atom_index)
          .filter((i): i is number => typeof i === 'number')
      );
      const sourceEndpoints = new Map<number, Array<{ key: string; instance: string }>>();
      for (const unit of source.units) {
        if (!Unit.isAtomic(unit)) continue;
        for (const atom of Array.from(unit.elements)) {
          const index = unit.model.atomicHierarchy.atomSourceIndex.value(atom);
          if (!requestedIndices.has(index)) continue;
          const entries = sourceEndpoints.get(index) ?? [];
          entries.push({
            key: `${unit.id}:${atom}`,
            instance: unit.conformation.operator.instanceId,
          });
          sourceEndpoints.set(index, entries);
        }
      }
      const endpointKeys = (expressions: Record<string, unknown>[]) => {
        if (
          !expressions.every(
            (e) =>
              typeof e.atom_index === 'number' &&
              Object.keys(e).every((k) => ['atom_index', 'instance_id'].includes(k))
          )
        )
          return keys(select(source, expressions));
        return new Set(
          expressions.flatMap((e) =>
            (sourceEndpoints.get(e.atom_index as number) ?? [])
              .filter((a) => e.instance_id === undefined || a.instance === e.instance_id)
              .map((a) => a.key)
          )
        );
      };
      for (const guidesNode of guides) {
        for (const guide of guidesNode.children ?? []) {
          for (const endpoint of [guide.params?.start, guide.params?.end]) {
            const expressions = (
              endpoint as { expressions?: Record<string, unknown>[] } | undefined
            )?.expressions;
            const selected = expressions ? endpointKeys(expressions) : undefined;
            if (selected && (!selected.size || !contains(atomic, selected)))
              fail(
                'A contact guide is missing opaque atomic endpoints on one or both interaction sides.'
              );
          }
        }
      }
      const used = new Map<string, string>();
      for (const component of surfaces) {
        const owner = surfaceOwnerSchema.safeParse(component.custom?.dnaforge_surface_owner);
        const selected = keys(select(source, component.params?.selector ?? 'all'));
        if (!owner.success) {
          if (
            component.custom?.dnaforge_presentation_role === 'context' &&
            component.custom?.dnaforge_surface_owner === undefined &&
            ![...declared.values()].some((r) =>
              r.side === 'target'
                ? intersects(selected, r.target)
                : r.side === 'partner'
                  ? intersects(selected, r.partner)
                  : intersects(selected, r.target) || intersects(selected, r.partner)
            )
          )
            continue;
          fail(
            'Every binding surface requires an explicit surface owner {regionRef,side}; context surfaces must be disjoint from declared binding surface owners.'
          );
        }
        const region = declared.get(owner.data.regionRef);
        if (!region)
          fail('The surface owner must refer to a binding region in this same coordinate source.');
        const side = owner.data.side;
        if (
          (region.side && region.side !== side) ||
          (used.has(owner.data.regionRef) && used.get(owner.data.regionRef) !== side)
        )
          fail('An interaction can have surfaces on only one declared side.');
        const expected = region[side];
        if (selected.size !== expected.size || !contains(expected, selected))
          fail(
            'A binding surface must cover its complete declared side, without atoms from its partner or unrelated residues.'
          );
        used.set(owner.data.regionRef, side);
      }
    }
  }
}

export function constructMolecularBindingRegions(
  document: MVSData,
  sourceFor: (structure: Node & { ref?: string }, index: number) => Structure | undefined
): MVSData {
  const result = structuredClone(document);
  const roots = result.kind === 'multiple' ? result.snapshots.map((s) => s.root) : [result.root];
  for (const [index, root] of roots.entries()) {
    const preferences = (
      root.custom?.dnaforge_render_profile as
        | { presentation?: MolecularPresentationPreferences }
        | undefined
    )?.presentation;
    const exceptions =
      (root.custom?.dnaforge_presentation_override as { fields?: string[] } | undefined)?.fields ??
      [];
    const usedRefs = new Set(
      walk(root as Node)
        .map((n) => (n as Node & { ref?: string }).ref)
        .filter(Boolean)
    );
    for (const structure of walk(root as Node).filter((n) => n.kind === 'structure')) {
      const regions = (structure.children ?? []).filter(
        (n) => n.kind === 'component' && n.custom?.dnaforge_binding_region
      );
      if (!regions.length) continue;
      const source = sourceFor(structure, index);
      if (!source) fail('Binding construction requires the matching loaded coordinate source.');
      for (const regionNode of regions) {
        let region = bindingRegionSchema.parse(regionNode.custom!.dnaforge_binding_region);
        const ref = (regionNode as Node & { ref?: string }).ref;
        if (!ref) fail('Binding construction requires a region identity.');
        const target = keys(select(source, region.target));
        const partner = keys(select(source, region.partner));
        if (!target.size || !partner.size || intersects(target, partner))
          fail(
            'Binding surface sides must be nonempty and disjoint in the actual coordinate instance.'
          );
        const nativeBindingBoundary =
          regionNode.custom?.dnaforge_interaction_context === 'native-interaction-context-v1' &&
          region.contactScope === 'binding-boundary-v2';
        const conformerSource = nativeBindingBoundary
          ? primaryMolecularConformer(source, root as Node).structure
          : source;
        const ligandSide = completeLigandTarget(select(source, region.target), conformerSource)
          ? 'target'
          : nativeBindingBoundary &&
              completeLigandTarget(select(source, region.partner), conformerSource)
            ? 'partner'
            : undefined;
        const nativeLigand = nativeBindingBoundary && ligandSide !== undefined;
        const ligandSurfacePreferred =
          nativeLigand ||
          (regionNode.custom?.dnaforge_presentation_role === 'binding-site' &&
            preferences?.bindingSiteSurface === 'translucent' &&
            !exceptions.includes('bindingSiteSurface') &&
            ligandSide !== undefined);
        if (ligandSurfacePreferred && (!region.surfaceSide || nativeBindingBoundary))
          region = { ...region, surfaceSide: ligandSide };
        const seed = select(source, region.seed ?? region.target);
        if (!seed.elementCount || !contains(target, keys(seed)))
          fail('The contact seed must belong to the declared target side.');
        const interfaceOnly =
          regionNode.custom?.dnaforge_presentation_role === 'interface' && !nativeLigand;
        const endpoints = walk(structure)
          .filter((n) => n.kind === 'primitives' && n.custom?.dnaforge_interaction_context)
          .flatMap((n) => n.children ?? [])
          .flatMap((n) => {
            const evidence = (
              Array.isArray(n.custom?.dnaforge_contact_evidence_set)
                ? n.custom.dnaforge_contact_evidence_set
                : [n.custom?.dnaforge_contact_evidence]
            ) as Array<{ contract?: string; featureA?: unknown; featureB?: unknown } | undefined>;
            return [
              n.params?.start,
              n.params?.end,
              ...evidence
                .filter((record) => record?.contract === 'typed-native-contact-v1')
                .flatMap((record) => [record!.featureA, record!.featureB]),
            ];
          })
          .flatMap((e) =>
            (e as { expressions?: unknown[] } | undefined)?.expressions
              ? [(e as { expressions: unknown[] }).expressions]
              : []
          );
        const detailMode =
          region.detailMode ??
          (interfaceOnly && endpoints.length ? 'contact-residues' : 'neighborhood');
        const surfaceColorMode = region.surfaceColorMode ?? 'identity';
        const nativeContext =
          regionNode.custom?.dnaforge_interaction_context === 'native-interaction-context-v1';
        if (
          !nativeContext &&
          (region.interfaceDetailSide !== undefined ||
            region.interfaceDetailBasis !== undefined ||
            region.interfaceProteinAtomicMode !== undefined)
        )
          fail(
            'Interface atomic-detail choices require native interaction construction. Recompute through mol_show_interaction_context; exported choices cannot invent display membership.'
          );
        const neighborhood = nativeContext
          ? select(source, region.detail)
          : molecularBindingDetail(
              source,
              seed,
              select(source, region.target),
              select(source, region.partner),
              region.radius ?? 5,
              interfaceOnly,
              endpoints,
              detailMode
            );
        if (nativeContext) {
          const computed = keys(neighborhood);
          const displayed = keys(select(source, regionNode.params?.selector));
          if (
            region.detail === undefined ||
            !computed.size ||
            computed.size !== displayed.size ||
            !contains(computed, displayed)
          )
            fail(
              'A native interaction component must retain its complete computed atom membership.'
            );
        }
        const detailSelector = molecularAtomSelector(neighborhood, source);
        const owner = region.surfaceSide ? select(source, region[region.surfaceSide]) : undefined;
        const surfaceExtent = owner
          ? containsMolecularLigand(owner)
            ? 'complete'
            : (region.surfaceExtent ?? 'contact-patch')
          : undefined;
        regionNode.custom!.dnaforge_binding_region = {
          ...region,
          detail: detailSelector,
          detailMode,
          surfaceColorMode,
          ...(surfaceExtent ? { surfaceExtent } : {}),
        };
        regionNode.params = { ...regionNode.params, selector: detailSelector };
        const detail = keys(neighborhood);
        const owns = new Set([...target, ...partner]);
        const surfaceAtoms = owner ? keys(owner) : owns;
        const colors = owner
          ? ownerSurfaceColors(owner, source, structure, surfaceColorMode === 'emphasis')
          : [];
        const candidates: Node[] = [];
        const remaining: Node[] = [];
        for (const component of structure.children ?? []) {
          if (component.kind !== 'component' || component.custom?.is_hidden === true) {
            remaining.push(component);
            continue;
          }
          const componentAtoms = keys(select(source, component.params?.selector ?? 'all'));
          if (!component.children?.some((child) => child.kind === 'representation')) {
            remaining.push(component);
            continue;
          }
          const foreignOwner = (
            component.custom?.dnaforge_surface_owner as { regionRef?: string } | undefined
          )?.regionRef;
          if (foreignOwner && foreignOwner !== ref) {
            remaining.push(component);
            continue;
          }
          const claimed =
            (component.custom?.dnaforge_surface_owner as { regionRef?: string } | undefined)
              ?.regionRef === ref;
          const independentContext =
            !claimed &&
            component.custom?.dnaforge_surface_owner === undefined &&
            component.custom?.dnaforge_presentation_role === 'context' &&
            !intersects(componentAtoms, surfaceAtoms);
          const relevant = claimed || (!independentContext && intersects(componentAtoms, owns));
          const representations = component.children ?? [];
          const surfaces = relevant
            ? representations.filter(
                (r) => r.kind === 'representation' && surfaceTypes.has(String(r.params?.type))
              )
            : [];
          candidates.push(...surfaces);
          const kept = representations.filter((r) => !surfaces.includes(r));
          if (
            component !== regionNode &&
            !regions.includes(component) &&
            (intersects(componentAtoms, detail) ||
              (interfaceOnly && intersects(componentAtoms, owns)))
          ) {
            const atomic = kept.filter(
              (r) => r.kind === 'representation' && atomicTypes.has(String(r.params?.type))
            );
            const other = kept.filter((r) => !atomic.includes(r));
            if (other.length) remaining.push({ ...component, children: other });
            const outside = source.subsetBuilder(true);
            for (const unit of select(source, component.params?.selector ?? 'all').units) {
              outside.beginUnit(unit.id);
              for (const atom of Array.from(unit.elements))
                if (
                  !detail.has(`${unit.id}:${atom}`) &&
                  (!interfaceOnly ||
                    !owns.has(`${unit.id}:${atom}`) ||
                    component.custom?.dnaforge_presentation_role === 'focus')
                )
                  outside.addElement(atom);
              outside.commitUnit();
            }
            const outsideStructure = outside.getStructure();
            if (atomic.length && outsideStructure.elementCount) {
              const selectors = molecularAtomSelector(outsideStructure, source);
              const outsideNode: Node & { ref?: string } = {
                ...component,
                params: { ...component.params, selector: selectors },
                children: atomic,
              };
              if (other.length && outsideNode.ref) {
                const base = `${outsideNode.ref}:outside-binding`;
                let nextRef = base;
                for (let suffix = 1; usedRefs.has(nextRef); suffix++) nextRef = `${base}-${suffix}`;
                outsideNode.ref = nextRef;
                usedRefs.add(nextRef);
              }
              remaining.push(outsideNode);
            }
          } else if (kept.length) {
            component.children = kept;
            remaining.push(component);
          }
        }
        const preferredSurface =
          ligandSurfacePreferred ||
          (regionNode.custom?.dnaforge_presentation_role === 'interface' &&
            preferences?.interfaceSurface === 'translucent' &&
            !exceptions.includes('interfaceSurface'));
        if ((candidates.length || preferredSurface) && region.surfaceSide) {
          const template: Node = candidates.length
            ? structuredClone(candidates[0])
            : {
                kind: 'representation',
                params: { type: 'surface' },
                custom: { molstar_representation_params: { alpha: 0.3 } },
                children: [{ kind: 'opacity', params: { opacity: 0.3 } }],
              };
          template.custom = {
            ...template.custom,
            dnaforge_presentation_generated: ligandSurfacePreferred ? 'binding-site' : 'interface',
            dnaforge_legend_label:
              region.surfaceSide === 'target' ? 'Target surface' : 'Binding partner surface',
          };
          if (interfaceOnly && region.interfaceBurial && surfaceExtent !== 'complete') {
            const patch = region.interfaceBurial[region.surfaceSide];
            if (!patch.atomCount)
              fail(
                'The declared partners have no sampled buried surface on this side; no interface surface can be claimed.'
              );
            template.custom.dnaforge_interface_surface_patch = {
              contract: region.interfaceBurial.contract,
              selector: structuredClone(patch.selector),
            };
          } else {
            delete template.custom.dnaforge_interface_surface_patch;
          }
          template.children = [
            ...structuredClone(colors).map((color) => {
              if (color.kind === 'color' && color.custom) {
                delete color.custom.molstar_color_theme_name;
                delete color.custom.molstar_color_theme_params;
              }
              return color;
            }),
            ...(template.children ?? []).filter(
              (n) => !['color', 'color_from_uri', 'color_from_source'].includes(n.kind)
            ),
          ];
          remaining.push({
            kind: 'component',
            params: { selector: structuredClone(region[region.surfaceSide]) },
            custom: {
              dnaforge_surface_owner: { regionRef: ref, side: region.surfaceSide },
              ...(regionNode.custom?.dnaforge_interaction_context
                ? { dnaforge_interaction_context: regionNode.custom.dnaforge_interaction_context }
                : {}),
            },
            children: [template],
          });
        } else if (candidates.length || preferredSurface) {
          fail('A binding surface is constructed from one explicit surface side.');
        }
        structure.children = remaining;
      }
    }
  }
  return result;
}
