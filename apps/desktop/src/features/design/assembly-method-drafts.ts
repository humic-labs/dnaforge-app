import type {
  AssemblyMethod,
  AssemblyMethodDraftSnapshot,
  GoldenGateEnzyme,
  SequenceDesign,
} from './types';
import { isHomologyAssemblyMethod } from './restriction-digest';
import {
  deriveAssemblyIssues,
  issueBlocksGate,
  issuesToValidationErrors,
} from '../assembly/public/issues/assembly-issues';

export function switchAssemblyMethodPreservingDraft(input: {
  design: SequenceDesign;
  method: AssemblyMethod;
  enzyme?: GoldenGateEnzyme;
  version: number;
  now: Date;
}): SequenceDesign {
  const { design, method, version, now } = input;
  const enzyme =
    input.enzyme ??
    (method === 'goldengate' ? preferredGoldenGateEnzymeForDesign(design) : undefined) ??
    design.goldenGateConfig?.enzyme ??
    'BsaI';
  const enzymeChanged =
    method === 'goldengate' &&
    design.assemblyMethod === 'goldengate' &&
    design.goldenGateConfig?.enzyme !== enzyme;
  if (design.assemblyMethod === method && !enzymeChanged) return design;

  const compositionKey = assemblyDraftCompositionKey(design);
  const snapshots = {
    ...(design.assemblyMethodDrafts ?? {}),
    [design.assemblyMethod]: createAssemblyMethodDraftSnapshot(design, compositionKey, now),
  };
  const targetSnapshot = !enzymeChanged ? snapshots[method] : undefined;
  const canRestore =
    targetSnapshot &&
    targetSnapshot.compositionKey === compositionKey &&
    (method !== 'goldengate' || targetSnapshot.goldenGateConfig?.enzyme === enzyme);
  const restored = canRestore
    ? restoreAssemblyMethodDraft(targetSnapshot)
    : freshAssemblyMethodDraft(method, enzyme);

  return withCanonicalDraftValidation({
    ...design,
    ...restored,
    assemblyMethod: method,
    assemblyMethodDrafts: snapshots,
    assemblyResult: undefined,
    version,
    updatedAt: now,
  });
}

export function assemblyDraftCompositionKey(design: SequenceDesign): string {
  return JSON.stringify({
    topology: design.topology,
    primerDesignConstraints: design.primerDesignConstraints,
    regions: design.regions.map((region) => ({
      id: region.id,
      sourceSequenceId: region.sourceSequenceId,
      sourceStart: region.sourceStart,
      sourceEnd: region.sourceEnd,
      sequence: region.sequence,
      isPlaceholder: region.isPlaceholder === true,
      schemaSlotId: region.schemaSlotId ?? null,
      sourceType: region.isPlaceholder ? null : (region.sourceType ?? 'pcr'),
      rdOverhangs: region.rdOverhangs ?? null,
      rdSourceEnzyme: region.rdSourceEnzyme ?? null,
      rdSourceEnzymeName: region.rdSourceEnzymeName ?? null,
      rdEnds: region.rdEnds ?? null,
    })),
    spacers: [...(design.spacers ?? [])]
      .sort((a, b) => a.junctionIndex - b.junctionIndex)
      .map((spacer) => ({
        junctionIndex: spacer.junctionIndex,
        sequence: spacer.sequence,
      })),
  });
}

export function preferredGoldenGateEnzymeForDesign(
  design: Pick<SequenceDesign, 'regions' | 'goldenGateConfig'>
): GoldenGateEnzyme | undefined {
  const enzymes = new Set<GoldenGateEnzyme>();
  for (const region of design.regions) {
    if ((region.sourceType === 'rd' || region.rdOverhangs) && region.rdSourceEnzyme) {
      enzymes.add(region.rdSourceEnzyme);
    }
  }

  if (enzymes.size === 1) {
    return [...enzymes][0];
  }

  return design.goldenGateConfig?.enzyme;
}

function createAssemblyMethodDraftSnapshot(
  design: SequenceDesign,
  compositionKey: string,
  now: Date
): AssemblyMethodDraftSnapshot {
  return {
    id: `${design.id}:${design.assemblyMethod}:${design.version}`,
    method: design.assemblyMethod,
    compositionKey,
    savedAtVersion: design.version,
    savedAtMs: now.getTime(),
    assemblyState: design.assemblyState,
    status: design.status,
    validationErrors: cloneDraftValue(design.validationErrors ?? []),
    homologyRegions: cloneDraftValue(design.homologyRegions ?? []),
    goldenGateConfig: cloneDraftValue(design.goldenGateConfig),
    goldenGateJunctions: cloneDraftValue(design.goldenGateJunctions),
    designPrimers: cloneDraftValue(design.designPrimers ?? []),
    assemblyWorkbench: cloneDraftValue(design.assemblyWorkbench),
    selectedJunctionIndex: design.selectedJunctionIndex,
    scrollToPosition: design.scrollToPosition,
    highlightRange: cloneDraftValue(design.highlightRange),
  };
}

function restoreAssemblyMethodDraft(
  snapshot: AssemblyMethodDraftSnapshot
): Pick<
  SequenceDesign,
  | 'assemblyState'
  | 'status'
  | 'validationErrors'
  | 'homologyRegions'
  | 'goldenGateConfig'
  | 'goldenGateJunctions'
  | 'designPrimers'
  | 'assemblyWorkbench'
  | 'selectedJunctionIndex'
  | 'scrollToPosition'
  | 'highlightRange'
> {
  return {
    assemblyState: snapshot.assemblyState,
    status: snapshot.status,
    validationErrors: [],
    homologyRegions: isHomologyAssemblyMethod(snapshot.method)
      ? cloneDraftValue(snapshot.homologyRegions)
      : [],
    goldenGateConfig:
      snapshot.method === 'goldengate' ? cloneDraftValue(snapshot.goldenGateConfig) : undefined,
    goldenGateJunctions:
      snapshot.method === 'goldengate'
        ? cloneDraftValue(snapshot.goldenGateJunctions ?? [])
        : undefined,
    designPrimers: cloneDraftValue(snapshot.designPrimers),
    assemblyWorkbench: cloneDraftValue(snapshot.assemblyWorkbench),
    selectedJunctionIndex: snapshot.selectedJunctionIndex,
    scrollToPosition: snapshot.scrollToPosition,
    highlightRange: cloneDraftValue(snapshot.highlightRange),
  };
}

function freshAssemblyMethodDraft(
  method: AssemblyMethod,
  enzyme: GoldenGateEnzyme
): Pick<
  SequenceDesign,
  | 'assemblyState'
  | 'status'
  | 'validationErrors'
  | 'homologyRegions'
  | 'goldenGateConfig'
  | 'goldenGateJunctions'
  | 'designPrimers'
  | 'selectedJunctionIndex'
  | 'scrollToPosition'
  | 'highlightRange'
> {
  return {
    assemblyState: 'drafting',
    status: 'draft',
    validationErrors: [],
    homologyRegions: [],
    goldenGateConfig: method === 'goldengate' ? { enzyme } : undefined,
    goldenGateJunctions: method === 'goldengate' ? [] : undefined,
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
  };
}

function cloneDraftValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function withCanonicalDraftValidation(design: SequenceDesign): SequenceDesign {
  const issues = deriveAssemblyIssues({ design });
  const hasRunBlockers = issues.some((issue) => issueBlocksGate(issue, 'run'));
  return {
    ...design,
    assemblyState: hasRunBlockers ? 'drafting' : design.assemblyState,
    status: hasRunBlockers ? 'draft' : design.status,
    validationErrors: issuesToValidationErrors(issues),
  };
}
