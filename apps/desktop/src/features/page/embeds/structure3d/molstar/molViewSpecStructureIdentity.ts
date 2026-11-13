import {
  assignStructureRefsInRoot,
  type Node,
  prefix,
} from '../../../../../shared/molecular-scene-structure-identity';
export {
  assignStructureRefsInRoot,
  type Node,
  prefix,
  type StructureIdentityNode,
} from '../../../../../shared/molecular-scene-structure-identity';
import type { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import type { Structure } from 'molstar/lib/mol-model/structure';
import type { MolstarPlugin } from './cache';
import { deepEqual } from 'molstar/lib/mol-util';
import {
  ComponentExpressionT,
  ComponentSelectorT,
} from 'molstar/lib/extensions/mvs/tree/mvs/param-types';

type ComparisonDisplay = {
  groupId: string;
  objects: Array<{ structureRef: string; selector: unknown }>;
  direction: number[];
  up: number[];
};

export const MOLECULAR_COMPARISON_DISPLAY_GUIDANCE =
  'The fitted correspondence region establishes placement, not the complete object to display. On matched state/overlay steps, declare root.custom.dnaforge_comparison_display:{objects:[{structureRef:"exact reference ref",selector:{label_asym_id:"A",instance_id:"exact copy"}},{structureRef:"exact compared ref",selector:[{label_asym_id:"B"},{label_asym_id:"C"}]}]}. Select complete scientific comparison objects, including their fragments when necessary. Standard focus components frame their combined registered extent even while an endpoint is hidden; other assembly appearance remains intact. Those marked steps share objects and orientation. Optional direction/up specify the shared orientation; otherwise the first marked camera supplies it. Optional groupId separates genuinely distinct comparisons in one story. Unmarked overview/interface/detail cameras are unchanged. Empty objects, unknown source refs, invalid selectors and contradictory same-group declarations fail before mutation. This framing does not certify biological correspondence or ideal visibility.';

function comparisonDisplayError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function constructSharedComparisonDisplays(
  document: MVSData,
  objectSize?: (structureRef: string, selector: unknown) => number
): void {
  const roots =
    document.kind === 'multiple' ? document.snapshots.map((s) => s.root) : [document.root];
  const groups = new Map<string, ComparisonDisplay>();
  const allowedSelectorFields = new Set(
    Object.keys((ComponentExpressionT as unknown as { props: Record<string, unknown> }).props)
  );
  const selectorValid = (selector: unknown): boolean =>
    ComponentSelectorT.is(selector) ||
    (Array.isArray(selector)
      ? selector.length > 0 && selector.every(selectorValid)
      : !!selector &&
        typeof selector === 'object' &&
        ComponentExpressionT.is(selector) &&
        Object.keys(selector).every((key) => allowedSelectorFields.has(key)));
  const vector = (value: unknown): number[] => {
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      value.some((x) => typeof x !== 'number' || !Number.isFinite(x)) ||
      Math.hypot(...value) === 0
    )
      comparisonDisplayError(
        'MVS_COMPARISON_DISPLAY_INVALID',
        'Comparison direction/up must be finite nonzero three-vectors.'
      );
    const length = Math.hypot(...value);
    return value.map((x) => x / length);
  };
  const sameVector = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) <= 1e-10);
  const objectSizes = new Map<string, number>();
  for (const [index, root] of roots.entries()) {
    const value = root.custom?.dnaforge_comparison_display;
    if (value === undefined) continue;
    const input = value as Partial<ComparisonDisplay>;
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).some((key) => !['groupId', 'objects', 'direction', 'up'].includes(key)) ||
      (input.groupId !== undefined &&
        (typeof input.groupId !== 'string' || !input.groupId.trim())) ||
      !Array.isArray(input.objects) ||
      input.objects.length < 2
    )
      comparisonDisplayError(
        'MVS_COMPARISON_DISPLAY_INVALID',
        'Declare at least two source-qualified comparison objects; groupId and direction/up are optional.'
      );
    const bindings = molViewSpecStructureBindings(document, index);
    if (readSharedComparisonRegistration(document, index)?.status !== 'recorded')
      comparisonDisplayError(
        'MVS_COMPARISON_REGISTRATION_REQUIRED',
        'Comparison display objects require recorded source registration before constructing matched state views.'
      );
    for (const object of input.objects) {
      if (
        !object ||
        typeof object !== 'object' ||
        Object.keys(object).some((key) => !['structureRef', 'selector'].includes(key)) ||
        !bindings.some((binding) => binding.ref === object.structureRef) ||
        !selectorValid(object.selector)
      )
        comparisonDisplayError(
          'MVS_COMPARISON_DISPLAY_INVALID',
          'Each comparison object needs an exact loaded structureRef and an installed-standard MVS selector.'
        );
      if (objectSize) {
        const key = JSON.stringify(object);
        if (!objectSizes.has(key))
          objectSizes.set(key, objectSize(object.structureRef, object.selector));
        if (!(objectSizes.get(key)! > 0))
          comparisonDisplayError(
            'MVS_COMPARISON_DISPLAY_EMPTY',
            'A declared comparison object matches no native atoms; correct its source-qualified selector.'
          );
      }
    }
    if (new Set(input.objects.map((object) => object.structureRef)).size < 2)
      comparisonDisplayError(
        'MVS_COMPARISON_DISPLAY_INVALID',
        'Comparison display objects must account for at least two different registered structures.'
      );
    const groupId = input.groupId?.trim() ?? 'comparison';
    const prior = groups.get(groupId);
    const camera = root.children?.find((node) => node.kind === 'camera')?.params;
    const position = camera?.position as number[] | undefined;
    const target = camera?.target as number[] | undefined;
    const direction = vector(
      input.direction ??
        prior?.direction ??
        (position && target ? target.map((x, i) => x - position[i]) : [0, 0, -1])
    );
    const candidateUp = vector(input.up ?? prior?.up ?? camera?.up ?? [0, 1, 0]);
    const projection = candidateUp.reduce((sum, x, i) => sum + x * direction[i], 0);
    const orthogonalUp = candidateUp.map((x, i) => x - projection * direction[i]);
    if (Math.hypot(...orthogonalUp) <= 1e-10)
      comparisonDisplayError(
        'MVS_COMPARISON_DISPLAY_INVALID',
        'Comparison up and direction cannot be parallel.'
      );
    const display: ComparisonDisplay = {
      groupId,
      objects: structuredClone(input.objects),
      direction,
      up: vector(orthogonalUp),
    };
    if (
      prior &&
      (!deepEqual(prior.objects, display.objects) ||
        !sameVector(prior.direction, display.direction) ||
        !sameVector(prior.up, display.up))
    )
      comparisonDisplayError(
        'MVS_COMPARISON_DISPLAY_INCONSISTENT',
        'Marked steps in one comparison group must share the same display objects and orientation; use a different groupId for a distinct comparison.'
      );
    groups.set(groupId, prior ?? display);
    const shared = prior ?? display;
    const clearFocus = (node: Node): void => {
      node.children = node.children?.filter(
        (child) =>
          child.kind !== 'camera' &&
          child.kind !== 'focus' &&
          child.custom?.dnaforge_comparison_focus !== true
      );
      for (const child of node.children ?? []) clearFocus(child);
    };
    clearFocus(root);
    for (const object of shared.objects) {
      const structure = bindings.find((binding) => binding.ref === object.structureRef)!.node;
      structure.children ??= [];
      structure.children.push({
        kind: 'component',
        params: { selector: structuredClone(object.selector) },
        custom: { dnaforge_comparison_focus: true },
        children: [
          {
            kind: 'focus',
            params: {
              direction: shared.direction,
              up: shared.up,
              radius_factor: 1,
              radius_extent: 0,
            },
          },
        ],
      });
    }
    root.custom = { ...root.custom, dnaforge_comparison_display: structuredClone(shared) };
  }
}

type ComparisonException = {
  kind: 'no-corresponding-region';
  reason: string;
  sources: Array<{ uri: string; limitation: string }>;
};

function comparisonException(
  root: Node,
  sources: readonly string[]
): ComparisonException | undefined {
  const value = root.custom?.dnaforge_comparison_exception as ComparisonException | undefined;
  if (value === undefined) return undefined;
  if (
    !value ||
    value.kind !== 'no-corresponding-region' ||
    typeof value.reason !== 'string' ||
    !value.reason.trim() ||
    !Array.isArray(value.sources) ||
    value.sources.length !== sources.length ||
    new Set(value.sources.map((source) => source?.uri)).size !== sources.length ||
    value.sources.some(
      (source) =>
        !source ||
        !sources.includes(source.uri) ||
        typeof source.limitation !== 'string' ||
        !source.limitation.trim()
    )
  )
    throw Object.assign(
      new Error(
        'A comparison exception must be kind:"no-corresponding-region", explain the scientific limitation, and account for every pinned source with {uri,limitation}. A fit that has not yet been attempted is not an absence of correspondence.'
      ),
      { code: 'MVS_COMPARISON_EXCEPTION_INVALID' }
    );
  return {
    kind: value.kind,
    reason: value.reason.trim(),
    sources: sources.map((uri) => ({
      uri,
      limitation: value.sources.find((source) => source.uri === uri)!.limitation.trim(),
    })),
  };
}

export function readSharedComparisonRegistration(document: MVSData, activeIndex: number) {
  const root = document.kind === 'multiple' ? document.snapshots[activeIndex]?.root : document.root;
  const policy = root?.custom?.dnaforge_comparison as
    | { layout?: string; sources?: string[] }
    | undefined;
  if (!root || policy?.layout !== 'shared-scene' || !policy.sources?.length) return undefined;
  const bindings = molViewSpecStructureBindings(document, activeIndex);
  const sourceByRef = new Map(bindings.map((b) => [b.ref, b.resourceUri]));
  type Fit = {
    contract: string;
    referenceStructureRef: string;
    mobileStructureRef: string;
    referenceRegion?: Record<string, unknown>;
    mobileRegion?: Record<string, unknown>;
    rmsd: number;
    pairs: unknown[];
    matrix: number[];
  };
  const fits: Fit[] = [];
  for (const binding of bindings) {
    for (const transform of binding.node.children ?? []) {
      const fit = transform.custom?.dnaforge_alignment as Fit | undefined;
      const matrix = transform.params?.matrix;
      if (
        transform.kind !== 'transform' ||
        fit?.contract !== 'source-polymer-alignment-v1' ||
        fit.mobileStructureRef !== binding.ref ||
        !sourceByRef.has(fit.referenceStructureRef) ||
        !Number.isFinite(fit.rmsd) ||
        fit.rmsd < 0 ||
        !Array.isArray(fit.pairs) ||
        fit.pairs.length < 3 ||
        !Array.isArray(matrix) ||
        matrix.length !== 16 ||
        !Array.isArray(fit.matrix) ||
        fit.matrix.length !== 16 ||
        matrix.some((value, index) => !Number.isFinite(value) || value !== fit.matrix[index])
      )
        continue;
      fits.push(fit);
    }
  }
  const registeredSources = new Set([policy.sources[0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const fit of fits) {
      const reference = sourceByRef.get(fit.referenceStructureRef)!;
      const mobile = sourceByRef.get(fit.mobileStructureRef)!;
      if (!registeredSources.has(reference) && !registeredSources.has(mobile)) continue;
      for (const source of [reference, mobile]) {
        if (!registeredSources.has(source)) {
          registeredSources.add(source);
          changed = true;
        }
      }
    }
  }
  const unregisteredSources = policy.sources.filter((source) => !registeredSources.has(source));
  return {
    status:
      unregisteredSources.length === 0
        ? ('recorded' as const)
        : registeredSources.size > 1
          ? ('partial' as const)
          : ('not-recorded' as const),
    referenceSource: policy.sources[0],
    unregisteredSources,
    fits: fits.map(
      ({
        referenceStructureRef,
        mobileStructureRef,
        referenceRegion,
        mobileRegion,
        rmsd,
        pairs,
      }) => ({
        referenceStructureRef,
        mobileStructureRef,
        referenceRegion,
        mobileRegion,
        rmsd,
        matchedPairs: pairs.length,
      })
    ),
    limitation:
      'Recorded registration reports source-verified rigid fits, not whether the chosen regions are scientifically appropriate or the comparison is visually legible.',
  };
}

export function preserveSharedComparisonSources(
  proposed: MVSData,
  current: MVSData,
  activeIndex: number,
  comparisonPresentation: 'overlay' | 'authored' = 'authored',
  nativeAlignmentChange = false,
  comparisonObjectSize?: (structureRef: string, selector: unknown) => number
): MVSData {
  const currentRoots =
    current.kind === 'multiple' ? current.snapshots.map((s) => s.root) : [current.root];
  const currentRoot = currentRoots[activeIndex] ?? currentRoots[0];
  const policy = currentRoot.custom?.dnaforge_comparison as
    | { layout?: string; sources?: string[] }
    | undefined;
  if (policy?.layout !== 'shared-scene' || !policy.sources?.length) return proposed;
  const roots =
    proposed.kind === 'multiple' ? proposed.snapshots.map((s) => s.root) : [proposed.root];
  const branchFor = (root: Node, uri: string) =>
    root.children?.find((n) => n.kind === 'download' && n.params?.url === uri);
  const structures = (node: Node): Node[] => [
    ...(node.kind === 'structure' ? [node] : []),
    ...(node.children ?? []).flatMap(structures),
  ];
  for (const uri of policy.sources) {
    const baseline = branchFor(currentRoot, uri);
    if (!baseline) throw new Error('The shared comparison lost its source inventory.');
    const baselineStructures = structures(baseline);
    const selected =
      branchFor(roots[activeIndex] ?? roots[0], uri) ??
      roots.map((root) => branchFor(root, uri)).find(Boolean) ??
      baseline;
    const placements = structures(selected).map((node, index) => {
      const authored = (node.children ?? []).filter((child) => child.kind === 'transform');
      const retained = (baselineStructures[index]?.children ?? []).filter(
        (child) => child.kind === 'transform'
      );
      const selectedTransforms = authored.length ? authored : retained;
      if (
        !nativeAlignmentChange &&
        [...retained, ...selectedTransforms].some((child) => child.custom?.dnaforge_alignment) &&
        !deepEqual(selectedTransforms, retained)
      )
        throw Object.assign(
          new Error(
            'Recorded comparison alignment and its placement are owned by mol_align_structures. Ordinary scene edits retain that placement; use the alignment tool to establish or revise coordinate correspondence.'
          ),
          { code: 'MVS_COMPARISON_ALIGNMENT_OWNED' }
        );
      return structuredClone(selectedTransforms);
    });
    for (const root of roots) {
      let branch = branchFor(root, uri);
      if (!branch) {
        branch = structuredClone(baseline);
        root.children ??= [];
        root.children.push(branch as NonNullable<typeof root.children>[number]);
      }
      for (const [index, node] of structures(branch).entries()) {
        const source = baselineStructures[index];
        if (!source) continue;
        node.ref = source.ref;
        node.params = structuredClone(source.params);
        node.children = [
          ...(node.children ?? []).filter((child) => child.kind !== 'transform'),
          ...structuredClone(placements[index] ?? []),
        ];
      }
      root.custom = { ...root.custom, dnaforge_comparison: structuredClone(policy) };
    }
  }
  for (const root of roots) {
    root.children = [
      ...policy.sources.map((uri) => branchFor(root, uri)!),
      ...(root.children ?? []).filter(
        (n) => n.kind !== 'download' || !policy.sources!.includes(String(n.params?.url))
      ),
    ] as typeof root.children;
  }
  constructSharedComparisonDisplays(proposed, comparisonObjectSize);
  if (comparisonPresentation === 'authored') return proposed;
  const exceptions = roots.map((root) => comparisonException(root, policy.sources!));
  if (exceptions.some(Boolean)) {
    if (
      exceptions.some((exception) => !exception) ||
      exceptions.some((exception) => JSON.stringify(exception) !== JSON.stringify(exceptions[0]))
    )
      throw Object.assign(
        new Error('The same scientific comparison exception must be recorded on every story step.'),
        { code: 'MVS_COMPARISON_EXCEPTION_INVALID' }
      );
    return proposed;
  }
  const visible = (n: Node): boolean =>
    n.custom?.is_hidden !== true &&
    (n.kind === 'representation'
      ? ((n.children ?? []).filter((c) => c.kind === 'opacity').slice(-1)[0]?.params?.opacity ??
          (n.custom?.molstar_representation_params as { alpha?: number } | undefined)?.alpha ??
          1) !== 0
      : (n.children ?? []).some(visible));
  const visibleSources = roots.map((root) =>
    policy.sources!.filter((uri) => {
      const branch = branchFor(root, uri);
      return branch && visible(branch);
    })
  );
  const registration = readSharedComparisonRegistration(proposed, 0)!;
  const stateJourney =
    roots.length > 1 || visibleSources.some((sources) => sources.length < policy.sources!.length);
  if (stateJourney && registration.status !== 'recorded')
    throw Object.assign(
      new Error(
        `The shared comparison needs recorded alignment before separate state views or a multi-step comparison can be constructed. Unregistered sources: ${registration.unregisteredSources.join(', ')}. Use mol_align_structures on scientifically justified corresponding regions in the all-visible staging scene, then author the journey. When the structures genuinely lack a corresponding region, record a no-corresponding-region exception for every source; do not infer alignment from co-loading or camera motion.`
      ),
      { code: 'MVS_COMPARISON_REGISTRATION_REQUIRED' }
    );
  if (visibleSources.some((sources) => sources.length === policy.sources!.length)) return proposed;
  if (registration.status !== 'recorded') return proposed;
  const regionByRef = new Map<string, Record<string, unknown> | undefined>();
  for (const fit of registration.fits) {
    if (!regionByRef.has(fit.referenceStructureRef))
      regionByRef.set(fit.referenceStructureRef, fit.referenceRegion);
    regionByRef.set(fit.mobileStructureRef, fit.mobileRegion);
  }
  const bindings = molViewSpecStructureBindings(proposed, 0);
  const comparisonRefs = policy.sources.map(
    (uri) =>
      bindings.find((binding) => binding.resourceUri === uri && regionByRef.has(binding.ref))!.ref
  );
  const overview = structuredClone(
    roots.find((root) => root.custom?.dnaforge_comparison_display) ?? roots[0]
  );
  const display = overview.custom?.dnaforge_comparison_display as ComparisonDisplay | undefined;
  overview.custom = {
    ...overview.custom,
    dnaforge_comparison_overview: true,
    dnaforge_presentation_override: {
      reason:
        'The aligned comparison isolates corresponding polymers; complete assembly context is retained in the authored views.',
      fields: ['preservePolymerContext'],
    },
  };
  for (const n of structures(overview)) {
    const stateIndex = comparisonRefs.indexOf(n.ref ?? '');
    n.custom = { ...n.custom, is_hidden: stateIndex < 0 };
    if (stateIndex < 0) continue;
    if (display) continue;
    const reference = stateIndex === 0;
    const region = regionByRef.get(n.ref!);
    const chain = region
      ? Object.fromEntries(
          Object.entries(region).filter(([k]) =>
            ['label_asym_id', 'auth_asym_id', 'instance_id'].includes(k)
          )
        )
      : {};
    const label = reference
      ? 'Reference conformation'
      : `Compared conformation${comparisonRefs.length > 2 ? ` ${stateIndex}` : ''}`;
    n.children = [
      ...(n.children ?? []).filter((c) => c.kind === 'transform'),
      {
        kind: 'component',
        params: { selector: Object.values(chain).some((v) => v !== undefined) ? chain : 'polymer' },
        children: [
          {
            kind: 'representation',
            params: { type: 'cartoon' },
            children: [
              {
                kind: 'color',
                params: { color: ['#4477aa', '#d98b3a', '#228833', '#aa3377'][stateIndex] },
                custom: { dnaforge_legend_label: label },
              },
              { kind: 'opacity', params: { opacity: reference ? 0.45 : 1 } },
            ],
          },
        ],
      },
    ];
  }
  const describeRegion = (region: Record<string, unknown> | undefined) => {
    const name = region?.auth_asym_id ?? region?.label_asym_id ?? 'declared';
    const copy = region?.instance_id ? `, copy ${region.instance_id}` : '';
    const range =
      region?.beg_auth_seq_id !== undefined || region?.end_auth_seq_id !== undefined
        ? `, residues ${region?.beg_auth_seq_id ?? 'start'}–${region?.end_auth_seq_id ?? 'end'}`
        : '';
    return `chain ${name}${copy}${range}`;
  };
  const metadata = {
    linger_duration_ms: 5000,
    title: 'Aligned comparison',
    description: `Corresponding polymers are shown together. ${registration.fits.map((fit) => `The fit uses reference ${describeRegion(fit.referenceRegion)} and compared ${describeRegion(fit.mobileRegion)}; root mean square separation of the fitted atoms: ${fit.rmsd.toFixed(2)} Å.`).join(' ')} Colors distinguish the states. Binding detail remains in the other views.`,
    key: 'dnaforge-aligned-comparison',
  };
  const result: MVSData = {
    kind: 'multiple',
    metadata: proposed.metadata,
    snapshots: [
      ...(proposed.kind === 'multiple'
        ? proposed.snapshots
        : [{ root: proposed.root, metadata: { linger_duration_ms: 5000 } }]),
      { root: overview as NonNullable<typeof currentRoot>, metadata },
    ],
  };
  constructSharedComparisonDisplays(result, comparisonObjectSize);
  return result;
}

export function assignMolViewSpecStructureRefs(document: MVSData): MVSData {
  const roots =
    document.kind === 'multiple' ? document.snapshots.map((s) => s.root) : [document.root];
  for (const root of roots) assignStructureRefsInRoot(root);
  return document;
}

export function molViewSpecStructureBindings(document: MVSData, index = 0) {
  const root = document.kind === 'multiple' ? document.snapshots[index]?.root : document.root;
  if (!root) throw new Error('The requested structure view does not exist.');
  assignStructureRefsInRoot(root);
  const bindings: Array<{
    ref: string;
    node: Node;
    resourceUri?: string;
    parseParams?: Record<string, unknown>;
  }> = [];
  const visit = (node: Node, resourceUri?: string, parseParams?: Record<string, unknown>) => {
    if (node.kind === 'download') resourceUri = String(node.params?.url);
    if (node.kind === 'parse') parseParams = node.params;
    if (node.kind === 'structure')
      bindings.push({ ref: node.ref!, node, resourceUri, parseParams });
    for (const child of node.children ?? []) visit(child, resourceUri, parseParams);
  };
  visit(root);
  return bindings;
}

export function molViewSpecStructureBindingKey(
  binding: ReturnType<typeof molViewSpecStructureBindings>[number]
): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, stable(v)])
          )
        : value;
  const params = {
    ...binding.node.params,
    model_index: binding.node.params?.model_index ?? 0,
  };
  return JSON.stringify(stable([binding.resourceUri, binding.parseParams, params]));
}

export function resolveMolViewSpecStructureRef(plugin: MolstarPlugin, ref: string): Structure {
  const tag = `mvs-ref:${ref}`;
  const tree = plugin.state.data.tree.transforms;
  const cells = [...plugin.state.data.cells.values()].filter((cell) =>
    tree.get(cell.transform.ref)?.tags?.includes(tag)
  );
  const entries = plugin.managers.structure.hierarchy.current.structures;
  if (!cells.length && ref.startsWith(prefix) && entries.length === 1) {
    const sole = entries[0].transform?.cell.obj?.data ?? entries[0].cell.obj?.data;
    if (sole) return sole;
  }
  if (cells.length > 1) {
    const ancestry = entries.map((entry) => {
      const refs = new Set<string>();
      let cursor = (entry.transform?.cell ?? entry.cell).transform?.ref;
      const tree = plugin.state?.data?.tree?.transforms;
      while (cursor && !refs.has(cursor)) {
        refs.add(cursor);
        cursor = tree?.get(cursor)?.parent;
      }
      return refs;
    });
    const owners = cells.map((cell) =>
      ancestry.flatMap((refs, index) =>
        cell.transform?.ref && refs.has(cell.transform.ref) ? [index] : []
      )
    );
    if (
      owners.some((matches) => matches.length !== 1) ||
      new Set(owners.map((m) => m[0])).size !== 1
    )
      throw new Error(`MVS structure reference ${ref} is ambiguous.`);
    const entry = entries[owners[0][0]];
    const parent = entry.transform?.cell.obj?.data ?? entry.cell.obj?.data;
    if (parent) return parent;
    throw new Error(`MVS structure reference ${ref} is not ready.`);
  }
  if (!cells.length) throw new Error(`MVS structure reference ${ref} is not loaded.`);
  const cell = cells[0];
  const matches = entries.filter(
    (entry) =>
      (cell.transform?.ref !== undefined && entry.cell.transform.ref === cell.transform.ref) ||
      entry.cell.obj?.data === cell.obj?.data ||
      entry.transform?.cell.obj?.data === cell.obj?.data
  );
  if (matches.length !== 1)
    throw new Error(`MVS structure reference ${ref} has no unique visible native parent.`);
  const parent = matches[0].transform?.cell.obj?.data ?? matches[0].cell.obj?.data;
  if (!parent) throw new Error(`MVS structure reference ${ref} is not ready.`);
  return parent;
}
