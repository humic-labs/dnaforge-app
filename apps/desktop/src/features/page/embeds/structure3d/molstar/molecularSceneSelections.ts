import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import { DefaultMultilayerColorThemeProps } from 'molstar/lib/extensions/mvs/components/multilayer-color-theme';
import { Structure, StructureElement, Unit } from 'molstar/lib/mol-model/structure';
import { isNucleic, isPolymer, isProtein } from 'molstar/lib/mol-model/structure/model/types';
import { ElementNames } from 'molstar/lib/mol-model/structure/model/properties/atomic/types';
import {
  ElementSymbolColors,
  ElementSymbolColorTheme,
  ElementSymbolColorThemeParams,
} from 'molstar/lib/mol-theme/color/element-symbol';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition';
import type { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import type { MolecularProfileNode as Node } from './nucleotidePresentationSettings';
import {
  molecularRepresentationVisible,
  type SelectionDesignation,
} from './molecularDisplayGroups';
import { molecularPresentationOverrideSchema } from './molecularPresentationPreferences';
import { molecularAtomSelector } from './molecularConnections';

export function molecularSceneSelections(source: Structure) {
  const cache = new Map<string, Structure>();
  function select(selector: unknown, parent = source) {
    const key = JSON.stringify(selector);
    if (parent === source && cache.has(key)) return cache.get(key)!;
    const selected = substructureFromSelector(
      parent,
      componentPropsFromSelector(selector as Parameters<typeof componentPropsFromSelector>[0])
    );
    if (parent === source) cache.set(key, selected);
    return selected;
  }
  function hasNucleotides(selector: unknown) {
    return select(selector).units.some(
      (unit) =>
        Unit.isAtomic(unit) &&
        Array.from(unit.elements).some((atom) =>
          isNucleic(
            unit.model.atomicHierarchy.derived.residue.moleculeType[unit.residueIndex[atom]]
          )
        )
    );
  }
  function describe(
    selector: unknown,
    colorSelector?: unknown,
    colorNode?: Node
  ): SelectionDesignation | undefined {
    const scope = select(selector);
    const selected = colorSelector === undefined ? scope : select(colorSelector, scope);
    return describeStructure(selected, colorSelector === undefined ? undefined : scope, colorNode);
  }
  function describeStructure(
    selected: Structure,
    colorScope?: Structure,
    colorNode?: Node
  ): SelectionDesignation | undefined {
    if (!selected.elementCount) return { label: 'Empty molecular selection', empty: true };
    const types = new Set<number>();
    const components = new Set<string>();
    const elements = new Set<string>();
    for (const unit of selected.units) {
      if (!Unit.isAtomic(unit)) return undefined;
      const h = unit.model.atomicHierarchy;
      for (let i = 0; i < unit.elements.length; i++) {
        const atom = unit.elements[i];
        types.add(h.derived.residue.moleculeType[unit.residueIndex[atom]]);
        components.add(h.atoms.label_comp_id.value(atom));
        elements.add(h.atoms.type_symbol.value(atom));
      }
    }
    if (components.size === 1 && select('ion', selected).elementCount === selected.elementCount) {
      const comp = [...components][0];
      const element = elements.size === 1 ? [...elements][0] : undefined;
      let color = element ? (ElementSymbolColors as Record<string, number>)[element] : undefined;
      if (element && colorNode?.custom?.molstar_color_theme_name === 'element-symbol') {
        const params = {
          ...PD.getDefaultValues(ElementSymbolColorThemeParams),
          ...(colorNode.custom.molstar_color_theme_params as Record<string, unknown> | undefined),
        } as Parameters<typeof ElementSymbolColorTheme>[1];
        const unit = selected.units[0];
        color = ElementSymbolColorTheme({ structure: selected }, params).color(
          StructureElement.Location.create(selected, unit, unit.elements[0]),
          false
        );
      }
      return {
        label: `${element ? (ElementNames[element] ?? comp) : comp} ions`,
        ionId: `ion:${comp}`,
        ...(color === undefined ? {} : { color: `#${color.toString(16).padStart(6, '0')}` }),
      };
    }
    const elementColorLayer =
      colorScope !== undefined &&
      elements.size === 1 &&
      !elements.has('C') &&
      selected.elementCount < colorScope.elementCount;
    const chemistry = elementColorLayer ? { elementColorLayer: true } : {};
    const chains = [
      ...new Set(
        selected.units.flatMap((unit) =>
          Unit.isAtomic(unit)
            ? Array.from(unit.elements, (atom) =>
                unit.model.atomicHierarchy.chains.auth_asym_id.value(unit.chainIndex[atom])
              )
            : []
        )
      ),
    ].sort();
    const chainLabel = `${chains.length === 1 ? 'chain' : 'chains'} ${chains.join(', ')}`;
    if ([...types].every(isNucleic))
      return { label: `Nucleic acid ${chainLabel}`.slice(0, 80), ...chemistry };
    if ([...types].every(isProtein))
      return { label: `Protein ${chainLabel}`.slice(0, 80), ...chemistry };
    if (![...types].some((type) => isProtein(type) || isNucleic(type)) && components.size === 1) {
      const copies = new Set(
        selected.units.flatMap((unit) =>
          Unit.isAtomic(unit)
            ? Array.from(unit.elements, (atom) => `${unit.id}:${unit.residueIndex[atom]}`)
            : []
        )
      );
      const firstUnit = selected.units[0];
      const firstAtom = firstUnit.elements[0];
      const firstHierarchy = Unit.isAtomic(firstUnit) ? firstUnit.model.atomicHierarchy : undefined;
      const copyLabel =
        firstHierarchy && Unit.isAtomic(firstUnit)
          ? `chain ${firstHierarchy.chains.auth_asym_id.value(firstUnit.chainIndex[firstAtom])}, residue ${firstHierarchy.residues.auth_seq_id.value(firstUnit.residueIndex[firstAtom])}`
          : undefined;
      return {
        label: (copies.size === 1 && copyLabel
          ? `${[...components][0]} · ${copyLabel}`
          : `${[...components][0]} ligands (${copies.size} copies)`
        ).slice(0, 80),
        ...chemistry,
        ...(copies.size === 1 ? { ligandCopyId: `ligand:${[...copies][0]}` } : {}),
        ligandCopyCount: copies.size,
      };
    }
    return elementColorLayer ? { label: 'Molecular detail', ...chemistry } : undefined;
  }
  function residualStructure(selector: unknown, colorSelectors: unknown[]) {
    const scope = select(selector);
    let remaining = Structure.toStructureElementLoci(scope);
    for (const colorSelector of colorSelectors)
      remaining = StructureElement.Loci.subtract(
        remaining,
        Structure.toSubStructureElementLoci(scope, select(colorSelector, scope))
      );
    return StructureElement.Loci.toStructure(remaining);
  }
  function describeResidual(selector: unknown, colorSelectors: unknown[]) {
    const description = describeStructure(residualStructure(selector, colorSelectors));
    if (!description?.ionId) return undefined;
    return {
      ...description,
      color: `#${DefaultMultilayerColorThemeProps.background.toString(16).padStart(6, '0')}`,
    };
  }
  function describeResidualGroups(selector: unknown, colorSelectors: unknown[]) {
    const remaining = residualStructure(selector, colorSelectors);
    const waters = new Set(
      select('water', remaining).units.flatMap((u) => Array.from(u.elements, (a) => `${u.id}:${a}`))
    );
    const ions = new Set(
      select('ion', remaining).units.flatMap((u) => Array.from(u.elements, (a) => `${u.id}:${a}`))
    );
    const groups = new Map<string, Array<{ atom_index: number; instance_id: string }>>();
    for (const unit of remaining.units) {
      if (!Unit.isAtomic(unit)) return [];
      for (const atom of Array.from(unit.elements)) {
        const h = unit.model.atomicHierarchy,
          residue = unit.residueIndex[atom];
        const type = h.derived.residue.moleculeType[residue];
        const atomKey = `${unit.id}:${atom}`;
        const ownerId = waters.has(atomKey)
          ? 'water'
          : ions.has(atomKey)
            ? `ion:${h.atoms.label_comp_id.value(atom)}`
            : isProtein(type) || isNucleic(type)
              ? `polymer:${unit.id}:${unit.chainIndex[atom]}`
              : `ligand:${unit.id}:${residue}`;
        const atoms = groups.get(ownerId) ?? [];
        atoms.push({
          atom_index: h.atomSourceIndex.value(atom),
          instance_id: unit.conformation.operator.instanceId,
        });
        groups.set(ownerId, atoms);
      }
    }
    return [...groups].flatMap(([physicalOwnerId, atoms]) => {
      const selected = select(atoms);
      const description =
        physicalOwnerId === 'water' ? { label: 'Waters' } : describeStructure(selected);
      if (!description) return [];
      return [
        {
          ...description,
          physicalOwnerId,
          color: `#${DefaultMultilayerColorThemeProps.background.toString(16).padStart(6, '0')}`,
          selector: molecularAtomSelector(selected, source),
        },
      ];
    });
  }
  function colorsCover(selector: unknown, colorSelectors: unknown[], parentSelector?: unknown) {
    const scope = select(selector, parentSelector === undefined ? source : select(parentSelector));
    const remaining = new Set(
      scope.units.flatMap((u) => Array.from(u.elements, (a) => `${u.id}:${a}`))
    );
    for (const colorSelector of colorSelectors)
      for (const u of select(colorSelector, scope).units)
        for (const a of Array.from(u.elements)) remaining.delete(`${u.id}:${a}`);
    return remaining.size === 0;
  }
  function selectionRelation(
    leftComponent: unknown,
    leftColor: unknown,
    rightComponent: unknown,
    rightColor: unknown,
    leftExcluded: unknown[] = [],
    rightExcluded: unknown[] = []
  ) {
    const keys = (component: unknown, color: unknown, excluded: unknown[], carbonOnly = false) => {
      const scope = select(component);
      const omitted = new Set(
        excluded.flatMap((selector) =>
          select(selector, scope).units.flatMap((unit) =>
            Array.from(unit.elements, (atom) => `${unit.id}:${atom}`)
          )
        )
      );
      return new Set(
        select(color, scope).units.flatMap((unit) =>
          Array.from(unit.elements)
            .filter(
              (atom) =>
                !omitted.has(`${unit.id}:${atom}`) &&
                (!carbonOnly ||
                  (Unit.isAtomic(unit) &&
                    unit.model.atomicHierarchy.atoms.type_symbol.value(atom) === 'C'))
            )
            .map((atom) => `${unit.id}:${atom}`)
        )
      );
    };
    const left = keys(leftComponent, leftColor, leftExcluded);
    const right = keys(rightComponent, rightColor, rightExcluded);
    const leftCarbon = keys(leftComponent, leftColor, leftExcluded, true);
    const rightCarbon = keys(rightComponent, rightColor, rightExcluded, true);
    return {
      leftAtomCount: left.size,
      rightAtomCount: right.size,
      sharedAtomCount: [...left].filter((atom) => right.has(atom)).length,
      leftCarbonCount: leftCarbon.size,
      rightCarbonCount: rightCarbon.size,
      sharedCarbonCount: [...leftCarbon].filter((atom) => rightCarbon.has(atom)).length,
    };
  }
  function bindingScope(selector: unknown, colorSelector: unknown, siteSelectors: unknown[]) {
    const selected = select(colorSelector, select(selector));
    const site = new Set(
      siteSelectors.flatMap((siteSelector) =>
        select(siteSelector).units.flatMap((unit) =>
          Array.from(unit.elements, (atom) => `${unit.id}:${atom}`)
        )
      )
    );
    let inside = 0;
    for (const unit of selected.units)
      for (const atom of Array.from(unit.elements)) if (site.has(`${unit.id}:${atom}`)) inside++;
    return inside === 0
      ? ('context' as const)
      : inside === selected.elementCount
        ? ('site' as const)
        : ('mixed' as const);
  }
  return {
    select,
    hasNucleotides,
    describe,
    describeResidual,
    describeResidualGroups,
    colorsCover,
    selectionRelation,
    bindingScope,
  };
}

export function molecularPolymerContextBaselineIndex(
  current: MVSData,
  activeIndex: number,
  proposed: MVSData,
  proposedIndex: number
): number {
  return current.kind === 'multiple' &&
    proposed.kind === 'multiple' &&
    current.snapshots[proposedIndex]
    ? proposedIndex
    : activeIndex;
}

export function requirePreservedPolymerContext(
  current: MVSData,
  activeIndex: number,
  proposed: MVSData,
  source: Structure,
  structureRef?: string
): void {
  const selections = molecularSceneSelections(source);
  function coverage(root: Node) {
    const traces = new Set<string>();
    function visit(node: Node) {
      if (node.custom?.is_hidden === true) return;
      if (
        node.kind === 'structure' &&
        structureRef &&
        (node as Node & { ref?: string }).ref !== structureRef
      )
        return;
      if (node.kind === 'component') {
        if (
          !node.children?.some(
            (r) =>
              r.kind === 'representation' &&
              ['cartoon', 'backbone', 'surface'].includes(String(r.params?.type)) &&
              !r.custom?.dnaforge_nucleotide_generated &&
              molecularRepresentationVisible(r)
          )
        )
          return;
        for (const unit of selections.select(node.params?.selector ?? 'all').units) {
          if (Unit.isAtomic(unit)) {
            for (let i = 0; i < unit.elements.length; i++) {
              const atom = unit.elements[i];
              const residue = unit.residueIndex[atom];
              if (isPolymer(unit.model.atomicHierarchy.derived.residue.moleculeType[residue]))
                traces.add(`${unit.id}:${residue}`);
            }
          } else
            for (const element of Array.from(unit.polymerElements))
              traces.add(`${unit.id}:${element}`);
        }
        return;
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(root);
    return traces;
  }
  const currentRoot =
    current.kind === 'multiple' ? current.snapshots[activeIndex]?.root : current.root;
  if (!currentRoot) return;
  const roots =
    proposed.kind === 'multiple' ? proposed.snapshots.map((s) => s.root) : [proposed.root];
  for (const [index, typedRoot] of roots.entries()) {
    const root = typedRoot as Node;
    const baselineIndex = molecularPolymerContextBaselineIndex(
      current,
      activeIndex,
      proposed,
      index
    );
    const baselineRoot =
      current.kind === 'multiple' ? current.snapshots[baselineIndex]?.root : current.root;
    const expected = coverage((baselineRoot ?? currentRoot) as Node);
    if (root.custom?.dnaforge_comparison && structureRef) {
      const nodes = [root] as Array<Node & { ref?: string }>;
      let hiddenSource = false;
      while (nodes.length) {
        const node = nodes.pop()!;
        if (
          node.kind === 'structure' &&
          node.ref === structureRef &&
          node.custom?.is_hidden === true
        )
          hiddenSource = true;
        nodes.push(...(node.children ?? []));
      }
      if (hiddenSource) continue;
    }
    const profile = root.custom?.dnaforge_render_profile as
      | { presentation?: { preservePolymerContext: boolean } }
      | undefined;
    if (!profile?.presentation?.preservePolymerContext) continue;
    const exception = root.custom?.dnaforge_presentation_override;
    if (
      exception !== undefined &&
      molecularPresentationOverrideSchema.parse(exception).fields.includes('preservePolymerContext')
    )
      continue;
    const actual = coverage(root);
    if ([...expected].some((trace) => !actual.has(trace))) {
      const error = new Error(
        `Story step ${index + 1} removes existing polymer context. Retain its cartoon/backbone/surface coverage or record a scientific reason with a preservePolymerContext presentation override.`
      );
      Object.assign(error, { code: 'MVS_POLYMER_CONTEXT_REQUIRED' });
      throw error;
    }
  }
}
