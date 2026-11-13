import {
  toUserMessage,
  type UserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';

import type {
  AssemblyMethod,
  DesignPrimer,
  DesignPrimerPair,
  GoldenGateEnzyme,
  HomologyRegion,
  SequenceDesign,
} from '../design/public/types';
import {
  GIBSON_MAX_HOMOLOGY_LENGTH,
  GIBSON_MIN_HOMOLOGY_LENGTH,
  GIBSON_OPTIMAL_GC_RANGE,
  GIBSON_OPTIMAL_HOMOLOGY_RANGE,
  GIBSON_OPTIMAL_TM,
} from '../design/public/validation-constants';
import {
  DEFAULT_PBS_LENGTH,
  isGoldenGateJunctionOffsetLocked,
  primerPbsLengthRange,
} from '../design/public/algorithms/draft-assembly';
import {
  getEffectiveDesignRegions,
  isRestrictionDigestRegion,
  isPcrTemplateRegion,
  selectPhysicalDesignPrimerPairs,
} from '../design/public/restriction-digest';
import { selectAssemblyBoundaryMap } from '../design/public/assembly-boundaries';
import {
  goldenGateConflictSeverity,
  goldenGateConflictTitle,
  validateGoldenGateAssembly,
} from '../design/public/validation/golden-gate-overhangs';
import {
  ASSEMBLY_WORKBENCH_CAPABILITIES,
  ASSEMBLY_WORKBENCH_COMMAND_TYPES,
  ASSEMBLY_WORKBENCH_CONTRACT_VERSION,
  goldenGateOffsetLimitBp,
  type AssemblyWorkbenchCapability,
  type AssemblyWorkbenchCommand,
  type AssemblyWorkbenchCommandType,
  type AssemblyWorkbenchEditableField,
  type AssemblyWorkbenchSourceContext,
  type AssemblyWorkbenchViewState,
} from './AssemblyWorkbenchContract';
import { computeJunctionCount, ensureAssemblyWorkbenchIdentity } from './AssemblyWorkbenchIdentity';
import {
  homologyJunctionEditability,
  recommendedHomologyEncodingForJunction,
  type HomologyArmEditability,
} from './HomologyJunctionEditabilityContract';

export const ASSEMBLY_WORKBENCH_SESSION_SCHEMA_VERSION = ASSEMBLY_WORKBENCH_CONTRACT_VERSION;
export {
  ASSEMBLY_WORKBENCH_CAPABILITIES,
  ASSEMBLY_WORKBENCH_COMMAND_TYPES,
  ASSEMBLY_WORKBENCH_CONTRACT_VERSION,
};
export type {
  AssemblyWorkbenchCapability,
  AssemblyWorkbenchCommand,
  AssemblyWorkbenchCommandType,
  AssemblyWorkbenchEditableField,
  AssemblyWorkbenchViewState,
};

export interface AssemblyWorkbenchFinding {
  id: string;
  severity: 'error' | 'warning' | 'info';
  code: string;
  title: string;
  message: UserMessage;
  junctionIndex?: number;
  regionIndex?: number;
  primer?: {
    fragmentIndex: number;
    direction: 'forward' | 'reverse';
  };
  command?: AssemblyWorkbenchCommand;
}

export interface AssemblyWorkbenchProposal {
  id: string;
  title: string;
  rationale: string;
  command: AssemblyWorkbenchCommand;
  fixesFindingIds: string[];
}

export interface AssemblyWorkbenchPrimerControl {
  id: string;
  regionId: string | null;
  fragmentIndex: number;
  direction: 'forward' | 'reverse';
  junctionIndex: number | null;
  junctionId: string | null;
  pbsLength: number;
  overhangLength: number;
  tm: number | null;
  canEditPbs: boolean;
  canEditOverhang: boolean;
}

export interface AssemblyWorkbenchSpacerControl {
  id: string | null;
  junctionIndex: number;
  sequence: string;
  name: string | null;
  length: number;
  canEdit: boolean;
}

export interface AssemblyWorkbenchJunctionControl {
  id: string;
  junctionIndex: number;
  label: string;
  selected: boolean;
  spacer: AssemblyWorkbenchSpacerControl;
  homology?: {
    onLeft: number;
    onRight: number;
    spacerLength: number;
    totalLength: number;
    crossoverLength: number;
    tmEstimate: number | null;
    gcContent: number | null;
  };
  goldenGate?: {
    enzyme: GoldenGateEnzyme;
    offset: number;
    overhang: string;
    overhangStart: number;
    overhangEnd: number;
    junctionPosition: number;
    offsetLimit: number;
    isFixed: boolean;
    isValid: boolean;
    validationError?: string;
  };
  primers: AssemblyWorkbenchPrimerControl[];
}

export interface AssemblyWorkbenchModeStrategySnapshot {
  mode: AssemblyMethod;
  title: string;
  description: string;
  primaryMetric: string;
  supports: {
    primerPbsLength: boolean;
    primerOverhangLength: boolean;
    spacerSequence: boolean;
    goldenGateOffset: boolean;
    enzymeSelection: boolean;
    autoOptimize: boolean;
  };
}

export interface AssemblyWorkbenchSession {
  schemaVersion: typeof ASSEMBLY_WORKBENCH_SESSION_SCHEMA_VERSION;
  readOnly?: boolean;
  designId: string;
  designVersion: number;
  mode: AssemblyMethod;
  selectedJunctionIndex: number | null;
  junctionCount: number;
  strategy: AssemblyWorkbenchModeStrategySnapshot;
  commandSurface: {
    schemaVersion: typeof ASSEMBLY_WORKBENCH_SESSION_SCHEMA_VERSION;
    commands: readonly AssemblyWorkbenchCommandType[];
    capabilities: AssemblyWorkbenchCapability[];
  };
  controls: {
    pcrSettingsAvailable: boolean;
    modes: Array<{ method: AssemblyMethod; selected: boolean; label: string }>;
    enzymes: GoldenGateEnzyme[];
    selectedEnzyme: GoldenGateEnzyme | null;
    junctions: AssemblyWorkbenchJunctionControl[];
  };
  editableFields: AssemblyWorkbenchEditableField[];
  findings: AssemblyWorkbenchFinding[];
  proposals: AssemblyWorkbenchProposal[];
}

export interface AssemblyWorkbenchSessionOptions {
  sourceContext?: AssemblyWorkbenchSourceContext;
  readOnly?: boolean;
}

interface ModeStrategy {
  snapshot: Omit<AssemblyWorkbenchModeStrategySnapshot, 'mode'>;
  buildFindings(
    design: SequenceDesign,
    selectedJunctionIndex: number | null
  ): AssemblyWorkbenchFinding[];
  buildProposals(
    design: SequenceDesign,
    findings: AssemblyWorkbenchFinding[],
    selectedJunctionIndex: number | null
  ): AssemblyWorkbenchProposal[];
}

const GOLDEN_GATE_ENZYMES: GoldenGateEnzyme[] = ['BsaI', 'BbsI', 'BsmBI', 'SapI'];
const PRIMER_PBS_WARN_MIN = 18;
const PRIMER_PBS_WARN_MAX = 35;

const MODE_STRATEGIES: Record<AssemblyMethod, ModeStrategy> = {
  gibson: createHomologyStrategy({
    title: 'Gibson',
    description: 'Homology overlap design with editable primer binding sites and tails.',
    primaryMetric: 'homology Tm',
  }),
  nebuilder: createHomologyStrategy({
    title: 'NEBuilder',
    description: 'Homology design with restriction-digest end resection constraints.',
    primaryMetric: 'resection-aware homology',
  }),
  goldengate: createGoldenGateStrategy(),
};

export function createAssemblyWorkbenchSession(
  design: SequenceDesign,
  viewState?: AssemblyWorkbenchViewState,
  options: AssemblyWorkbenchSessionOptions = {}
): AssemblyWorkbenchSession {
  const normalizedDesign = ensureAssemblyWorkbenchIdentity(design);
  const selectedJunctionIndex = resolveSelectedJunctionIndex(normalizedDesign, viewState);
  const strategy = MODE_STRATEGIES[normalizedDesign.assemblyMethod];
  const junctions = buildJunctionControls(normalizedDesign, selectedJunctionIndex);
  let editableFields = buildEditableFields(normalizedDesign, junctions, options.sourceContext);
  if (options.readOnly)
    editableFields = editableFields.map<AssemblyWorkbenchEditableField>((field) => ({
      ...field,
      disabled: true,
      constraints: [
        ...field.constraints,
        {
          code: 'read-only',
          severity: 'info',
          message: userMessage('assembly.finding.the-saved-assembly-is-read-only'),
        },
      ],
    }));
  const findings = strategy.buildFindings(normalizedDesign, selectedJunctionIndex);
  const proposals = strategy.buildProposals(normalizedDesign, findings, selectedJunctionIndex);

  return {
    schemaVersion: ASSEMBLY_WORKBENCH_SESSION_SCHEMA_VERSION,
    ...(options.readOnly ? { readOnly: true } : {}),
    designId: normalizedDesign.id,
    designVersion: normalizedDesign.version,
    mode: normalizedDesign.assemblyMethod,
    selectedJunctionIndex,
    junctionCount: computeJunctionCount(normalizedDesign),
    strategy: {
      mode: normalizedDesign.assemblyMethod,
      ...strategy.snapshot,
    },
    commandSurface: {
      schemaVersion: ASSEMBLY_WORKBENCH_SESSION_SCHEMA_VERSION,
      commands: ASSEMBLY_WORKBENCH_COMMAND_TYPES,
      capabilities: ASSEMBLY_WORKBENCH_CAPABILITIES,
    },
    controls: {
      pcrSettingsAvailable: normalizedDesign.regions.some(isPcrTemplateRegion),
      modes: [
        {
          method: 'gibson',
          selected: normalizedDesign.assemblyMethod === 'gibson',
          label: 'Gibson',
        },
        {
          method: 'nebuilder',
          selected: normalizedDesign.assemblyMethod === 'nebuilder',
          label: 'NEBuilder',
        },
        {
          method: 'goldengate',
          selected: normalizedDesign.assemblyMethod === 'goldengate',
          label: 'Golden Gate',
        },
      ],
      enzymes: GOLDEN_GATE_ENZYMES,
      selectedEnzyme:
        normalizedDesign.assemblyMethod === 'goldengate'
          ? (normalizedDesign.goldenGateConfig?.enzyme ?? 'BsaI')
          : null,
      junctions,
    },
    editableFields,
    findings,
    proposals,
  };
}

function createHomologyStrategy(input: {
  title: string;
  description: string;
  primaryMetric: string;
}): ModeStrategy {
  return {
    snapshot: {
      ...input,
      supports: {
        primerPbsLength: true,
        primerOverhangLength: true,
        spacerSequence: true,
        goldenGateOffset: false,
        enzymeSelection: false,
        autoOptimize: true,
      },
    },
    buildFindings: buildHomologyFindings,
    buildProposals: buildHomologyProposals,
  };
}

function createGoldenGateStrategy(): ModeStrategy {
  return {
    snapshot: {
      title: 'Golden Gate',
      description: 'Type IIS overhang design with enzyme and internal-site validation.',
      primaryMetric: 'overhang uniqueness',
      supports: {
        primerPbsLength: true,
        primerOverhangLength: false,
        spacerSequence: true,
        goldenGateOffset: true,
        enzymeSelection: true,
        autoOptimize: true,
      },
    },
    buildFindings: buildGoldenGateFindings,
    buildProposals: buildGoldenGateProposals,
  };
}

function buildJunctionControls(
  design: SequenceDesign,
  selectedJunctionIndex: number | null
): AssemblyWorkbenchJunctionControl[] {
  const junctionCount = computeJunctionCount(design);
  const primersByJunction = groupPrimersByJunction(
    design,
    selectPhysicalDesignPrimerPairs(design),
    design.assemblyMethod
  );
  const identities = design.assemblyWorkbench?.junctions ?? [];
  const boundariesByJunction = selectAssemblyBoundaryMap(design);
  const goldenGateOffsetLimit = goldenGateOffsetLimitBp(design.goldenGateConfig);
  return Array.from({ length: junctionCount }, (_, junctionIndex) => {
    const identity = identities.find((item) => item.slot === junctionIndex);
    const homology = design.homologyRegions.find((item) => item.junctionIndex === junctionIndex);
    const goldenGate = design.goldenGateJunctions?.find(
      (item) => item.junctionIndex === junctionIndex
    );
    const spacer = boundariesByJunction.get(junctionIndex)?.spacer ?? null;
    return {
      id: identity?.id ?? `junction:${junctionIndex}`,
      junctionIndex,
      label: `J${junctionIndex + 1}`,
      selected: junctionIndex === selectedJunctionIndex,
      spacer: {
        id: spacer?.id ?? null,
        junctionIndex,
        sequence: spacer?.sequence ?? '',
        name: spacer?.name ?? null,
        length: spacer?.sequence.length ?? 0,
        canEdit: true,
      },
      homology: homology ? homologyControl(homology, spacer?.sequence.length ?? 0) : undefined,
      goldenGate: goldenGate
        ? {
            enzyme: design.goldenGateConfig?.enzyme ?? 'BsaI',
            offset: goldenGate.offset,
            overhang: goldenGate.overhang,
            overhangStart: goldenGate.overhangStart,
            overhangEnd: goldenGate.overhangEnd,
            junctionPosition: goldenGate.junctionPosition,
            offsetLimit: goldenGateOffsetLimit,
            isFixed: isGoldenGateJunctionOffsetLocked(goldenGate),
            isValid: goldenGate.isValid,
            validationError: goldenGate.validationError,
          }
        : undefined,
      primers: primersByJunction.get(junctionIndex) ?? [],
    };
  });
}

function homologyControl(
  homology: HomologyRegion,
  spacerLength: number
): AssemblyWorkbenchJunctionControl['homology'] {
  const totalLength = homology.encoding.onLeft + homology.encoding.onRight;
  return {
    onLeft: homology.encoding.onLeft,
    onRight: homology.encoding.onRight,
    spacerLength,
    totalLength,
    crossoverLength: totalLength,
    tmEstimate: homology.metadata?.tmEstimate ?? null,
    gcContent: homology.metadata?.gcContent ?? null,
  };
}

function buildEditableFields(
  design: SequenceDesign,
  junctions: AssemblyWorkbenchJunctionControl[],
  sourceContext?: AssemblyWorkbenchSourceContext
): AssemblyWorkbenchEditableField[] {
  if (design.regions.length < 2) return [];
  return junctions.flatMap((junction) => {
    const leftIndex = junction.junctionIndex;
    const rightIndex = (leftIndex + 1) % design.regions.length;
    const leftRegion = design.regions[leftIndex];
    const rightRegion = design.regions[rightIndex];
    if (!leftRegion || !rightRegion) return [];
    const fields: AssemblyWorkbenchEditableField[] = [
      sourceContributionBoundaryField({
        design,
        junction,
        regionId: leftRegion.id,
        rowSide: 'left',
        side: 'downstream',
        value: leftRegion.sourceEnd,
        bioCol: 0,
        range: {
          min: leftRegion.sourceStart + 1,
          max: sourceLengthForRegion(leftRegion, sourceContext),
        },
      }),
      sourceContributionBoundaryField({
        design,
        junction,
        regionId: rightRegion.id,
        rowSide: 'right',
        side: 'upstream',
        value: rightRegion.sourceStart,
        bioCol: junction.spacer.length,
        range: {
          min: 0,
          max: Math.max(0, rightRegion.sourceEnd - 1),
        },
      }),
      junctionSpacerField(design, junction),
    ];

    if (junction.homology) {
      const editability = homologyJunctionEditability(design, junction.junctionIndex, {
        onLeft: junction.homology.onLeft,
        onRight: junction.homology.onRight,
      });
      fields.push(
        homologyArmField({
          design,
          junction,
          rowSide: 'left',
          value: junction.homology.onLeft,
          oppositeValue: junction.homology.onRight,
          armEditability: editability.leftArm,
          minValue:
            editability.leftArm.minValue ??
            -homologyBoundaryPbsIntrusionLimit(design, junction, 'left'),
        }),
        homologyArmField({
          design,
          junction,
          rowSide: 'right',
          value: junction.homology.onRight,
          oppositeValue: junction.homology.onLeft,
          armEditability: editability.rightArm,
          minValue:
            editability.rightArm.minValue ??
            -(
              junction.spacer.length + homologyBoundaryPbsIntrusionLimit(design, junction, 'right')
            ),
        })
      );
    }

    for (const primer of junction.primers) {
      const rowAnchor = primerAnchorForJunction(design, junction, primer);
      if (!rowAnchor) continue;
      fields.push(primerPbsField(design, junction, primer, rowAnchor));
      if (primer.canEditOverhang && junction.homology) {
        fields.push(primerTailField(design, junction, primer, rowAnchor));
      }
    }

    if (junction.goldenGate && !junction.goldenGate.isFixed) {
      fields.push(goldenGateOverhangField(design, junction, junction.goldenGate));
    }

    return fields;
  });
}

function junctionSpacerField(
  design: SequenceDesign,
  junction: AssemblyWorkbenchJunctionControl
): AssemblyWorkbenchEditableField {
  return {
    id: editableFieldId(design, junction, 'spacer', 'sequence'),
    kind: 'junctionSpacer',
    label: `${junction.label} synthetic spacer`,
    target: {
      junctionId: junction.id,
      junctionIndex: junction.junctionIndex,
    },
    value: junction.spacer.sequence,
    units: 'sequence',
    anchors: [
      {
        rowId: rowIdForSide(design.assemblyMethod, junction.junctionIndex, 'product'),
        rowKind: 'product',

        bioCol: Math.floor(junction.spacer.length / 2),
        role: 'boundary',
      },
    ],
    command: {
      type: 'setJunctionSpacer',
      payload: {
        junctionId: junction.id,
        junctionIndex: junction.junctionIndex,
        sequence: junction.spacer.sequence,
        expectedDesignVersion: design.version,
      },
      valueKey: 'sequence',
    },
    constraints: [],
    disabled: !junction.spacer.canEdit,
  };
}

function sourceContributionBoundaryField(input: {
  design: SequenceDesign;
  junction: AssemblyWorkbenchJunctionControl;
  regionId: string;
  rowSide: 'left' | 'right';
  side: 'upstream' | 'downstream';
  value: number;
  bioCol: number;
  range: { min: number; max: number };
}): AssemblyWorkbenchEditableField {
  const { design, junction, regionId, rowSide, side, value, bioCol, range } = input;
  const region = design.regions.find((item) => item.id === regionId);
  const isRdRegion = isRestrictionDigestRegion(region);
  const constraints: AssemblyWorkbenchEditableField['constraints'] = [];
  if (region && isRdRegion) {
    constraints.push({
      code: 'restriction-digest-physical-end',
      severity: 'error',
      message: userMessage(
        'assembly.finding.restriction-digest-physical-ends-use-method-specific-resection-fields'
      ),
    });
  }
  if (region && !region.sourceSequence) {
    constraints.push({
      code: 'source-context-required',
      severity: 'info',
      message: userMessage(
        'assembly.finding.editing-outside-the-copied-region-requires-source-context-for-this-template'
      ),
    });
  }

  return {
    id: editableFieldId(design, junction, 'source', regionId, side),
    kind: 'sourceContributionBoundary',
    label: `${junction.label} ${rowSide === 'left' ? 'upstream template end' : 'downstream template start'}`,
    target: {
      junctionId: junction.id,
      junctionIndex: junction.junctionIndex,
      regionId,
      side,
    },
    value,
    units: 'bp',
    range: { min: range.min, max: range.max, step: 1, largeStep: 10 },
    anchors: [
      {
        rowId: rowIdForSide(design.assemblyMethod, junction.junctionIndex, rowSide),
        rowKind: rowSide === 'left' ? 'left-source' : 'right-source',
        bioCol,
        role: 'boundary',
      },
    ],
    command: {
      type: 'setSourceContributionBoundary',
      payload: {
        regionId,
        side,
        sourcePosition: value,
        expectedDesignVersion: design.version,
      },
      valueKey: 'sourcePosition',
    },
    constraints,
    disabled: isRdRegion,
  };
}

function homologyArmField(input: {
  design: SequenceDesign;
  junction: AssemblyWorkbenchJunctionControl;
  rowSide: 'left' | 'right';
  value: number;
  oppositeValue: number;
  minValue: number;
  armEditability: HomologyArmEditability;
}): AssemblyWorkbenchEditableField {
  const { design, junction, rowSide, value, oppositeValue, minValue, armEditability } = input;
  const spacerLength = junction.spacer.length;
  const encoding =
    rowSide === 'left'
      ? { onLeft: value, onRight: oppositeValue }
      : { onLeft: oppositeValue, onRight: value };
  const tailStart = rowSide === 'left' ? spacerLength - value : spacerLength;
  const tailEnd = rowSide === 'left' ? spacerLength : spacerLength + value;
  const disabled = !armEditability.editable;
  const rangeMin = disabled ? value : minValue;
  const rangeMax = disabled ? value : GIBSON_MAX_HOMOLOGY_LENGTH;
  const constraints = armEditability.constraintCode
    ? [
        {
          code: armEditability.constraintCode,
          severity: 'error' as const,
          message: toUserMessage(armEditability.message, 'assembly.armConstrained'),
        },
      ]
    : [];
  return {
    id: editableFieldId(design, junction, 'homology', rowSide),
    kind: 'homologyArm',
    label: `${junction.label} ${rowSide} homology`,
    target: {
      junctionId: junction.id,
      junctionIndex: junction.junctionIndex,
      side: rowSide,
    },
    value,
    units: 'bp',
    range: { min: rangeMin, max: rangeMax, step: 1, largeStep: 5 },
    anchors: [
      {
        rowId: rowIdForSide(design.assemblyMethod, junction.junctionIndex, rowSide),
        rowKind: rowSide === 'left' ? 'left-source' : 'right-source',
        bioCol: tailStart,
        role: 'tail-start',
      },
      {
        rowId: rowIdForSide(design.assemblyMethod, junction.junctionIndex, rowSide),
        rowKind: rowSide === 'left' ? 'left-source' : 'right-source',
        bioCol: tailEnd,
        role: 'tail-end',
      },
    ],
    command: {
      type: 'setHomologyEncoding',
      payload: {
        junctionId: junction.id,
        junctionIndex: junction.junctionIndex,
        encoding,
        expectedDesignVersion: design.version,
      },
      valueKey: rowSide === 'left' ? 'encoding.onLeft' : 'encoding.onRight',
    },
    constraints,
    disabled,
  };
}

function homologyBoundaryPbsIntrusionLimit(
  design: SequenceDesign,
  junction: AssemblyWorkbenchJunctionControl,
  side: 'left' | 'right'
): number {
  const rightIndex = (junction.junctionIndex + 1) % design.regions.length;
  const primer =
    side === 'left'
      ? junction.primers.find(
          (item) => item.fragmentIndex === rightIndex && item.direction === 'forward'
        )
      : junction.primers.find(
          (item) => item.fragmentIndex === junction.junctionIndex && item.direction === 'reverse'
        );
  return primer?.pbsLength ?? 0;
}

function primerPbsField(
  design: SequenceDesign,
  junction: AssemblyWorkbenchJunctionControl,
  primer: AssemblyWorkbenchPrimerControl,
  anchor: PrimerFieldAnchor
): AssemblyWorkbenchEditableField {
  const productRowId = rowIdForSide(design.assemblyMethod, junction.junctionIndex, 'product');
  const pair = design.designPrimers.find(
    (candidate) => candidate.forward.id === primer.id || candidate.reverse.id === primer.id
  );
  const designPrimer = pair?.forward.id === primer.id ? pair.forward : pair?.reverse;
  const range = designPrimer
    ? primerPbsLengthRange(designPrimer, getEffectiveDesignRegions(design), design.spacers)
    : { min: primer.pbsLength, max: primer.pbsLength };
  return {
    id: editableFieldId(design, junction, 'primer-pbs', primer.id),
    kind: 'primerPbs',
    label: `${primer.direction} primer PBS`,
    target: {
      junctionId: junction.id,
      junctionIndex: junction.junctionIndex,
      regionId: primer.regionId ?? undefined,
      primerId: primer.id,
      fragmentIndex: primer.fragmentIndex,
      direction: primer.direction,
      side: anchor.rowSide,
    },
    value: primer.pbsLength,
    units: 'bp',
    range: { ...range, step: 1, largeStep: 5 },
    anchors: [
      { rowId: anchor.rowId, rowKind: anchor.rowKind, bioCol: anchor.pbsStart, role: 'pbs-start' },
      { rowId: anchor.rowId, rowKind: anchor.rowKind, bioCol: anchor.pbsEnd, role: 'pbs-end' },
      { rowId: productRowId, rowKind: 'product', bioCol: anchor.pbsStart, role: 'pbs-start' },
      { rowId: productRowId, rowKind: 'product', bioCol: anchor.pbsEnd, role: 'pbs-end' },
    ],
    command: {
      type: 'setPrimerPbsLength',
      payload: {
        primerId: primer.id,
        length: primer.pbsLength,
        expectedDesignVersion: design.version,
      },
      valueKey: 'length',
    },
    constraints: [],
    disabled: !primer.canEditPbs,
  };
}

function primerTailField(
  design: SequenceDesign,
  junction: AssemblyWorkbenchJunctionControl,
  primer: AssemblyWorkbenchPrimerControl,
  anchor: PrimerFieldAnchor
): AssemblyWorkbenchEditableField {
  const homology = junction.homology;
  const spacerLength = junction.spacer.length;
  const tailStart =
    anchor.rowSide === 'left'
      ? spacerLength - (homology?.onLeft ?? primer.overhangLength)
      : spacerLength;
  const tailEnd =
    anchor.rowSide === 'left'
      ? spacerLength
      : spacerLength + (homology?.onRight ?? primer.overhangLength);

  const productRowId = rowIdForSide(design.assemblyMethod, junction.junctionIndex, 'product');
  return {
    id: editableFieldId(design, junction, 'primer-tail', primer.id),
    kind: 'primerTail',
    label: `${primer.direction} primer tail`,
    target: {
      junctionId: junction.id,
      junctionIndex: junction.junctionIndex,
      regionId: primer.regionId ?? undefined,
      primerId: primer.id,
      fragmentIndex: primer.fragmentIndex,
      direction: primer.direction,
      side: anchor.rowSide,
    },
    value: primer.overhangLength,
    units: 'bp',
    range: { min: 0, max: GIBSON_MAX_HOMOLOGY_LENGTH + spacerLength, step: 1, largeStep: 5 },
    anchors: [
      { rowId: productRowId, rowKind: 'product', bioCol: tailStart, role: 'tail-start' },
      { rowId: productRowId, rowKind: 'product', bioCol: tailEnd, role: 'tail-end' },
    ],
    command: {
      type: 'setPrimerOverhangLength',
      payload: {
        primerId: primer.id,
        length: primer.overhangLength,
        expectedDesignVersion: design.version,
      },
      valueKey: 'length',
    },
    constraints: [],
    disabled: !primer.canEditOverhang,
  };
}

function goldenGateOverhangField(
  design: SequenceDesign,
  junction: AssemblyWorkbenchJunctionControl,
  overhang: NonNullable<AssemblyWorkbenchJunctionControl['goldenGate']>
): AssemblyWorkbenchEditableField {
  const anchorPosition = overhang.junctionPosition - junction.spacer.length;
  const startBioCol = overhang.overhangStart - anchorPosition;
  const endBioCol = overhang.overhangEnd - anchorPosition;
  const scarCenterBioCol = (startBioCol + endBioCol) / 2;
  return {
    id: editableFieldId(design, junction, 'goldengate-overhang', 'offset'),
    kind: 'goldenGateOverhang',
    label: `${junction.label} overhang offset`,
    target: {
      junctionId: junction.id,
      junctionIndex: junction.junctionIndex,
    },
    value: overhang.offset,
    units: 'bp',
    range: {
      min: -overhang.offsetLimit,
      max: overhang.offsetLimit,
      step: 1,
      largeStep: 5,
    },
    anchors: [
      {
        rowId: rowIdForSide(design.assemblyMethod, junction.junctionIndex, 'product'),
        rowKind: 'product',
        bioCol: scarCenterBioCol,
        role: 'boundary',
      },
    ],
    command: {
      type: 'setGoldenGateOffset',
      payload: {
        junctionId: junction.id,
        junctionIndex: junction.junctionIndex,
        offset: overhang.offset,
        previewRange: {
          startBioCol,
          endBioCol,
          spacerLength: junction.spacer.length,
        },
        expectedDesignVersion: design.version,
      },
      valueKey: 'offset',
    },
    constraints: [],
  };
}

interface PrimerFieldAnchor {
  rowSide: 'left' | 'right';
  rowId: string;
  rowKind: 'left-source' | 'right-source';
  pbsStart: number;
  pbsEnd: number;
}

function primerAnchorForJunction(
  design: SequenceDesign,
  junction: AssemblyWorkbenchJunctionControl,
  primer: AssemblyWorkbenchPrimerControl
): PrimerFieldAnchor | null {
  const rightIndex = (junction.junctionIndex + 1) % design.regions.length;
  if (primer.fragmentIndex === junction.junctionIndex && primer.direction === 'reverse') {
    return {
      rowSide: 'left',
      rowId: rowIdForSide(design.assemblyMethod, junction.junctionIndex, 'left'),
      rowKind: 'left-source',
      pbsStart: -primer.pbsLength,
      pbsEnd: 0,
    };
  }
  if (primer.fragmentIndex === rightIndex && primer.direction === 'forward') {
    const spacerLength = junction.spacer.length;
    return {
      rowSide: 'right',
      rowId: rowIdForSide(design.assemblyMethod, junction.junctionIndex, 'right'),
      rowKind: 'right-source',
      pbsStart: spacerLength,
      pbsEnd: spacerLength + primer.pbsLength,
    };
  }
  return null;
}

function rowIdForSide(
  method: AssemblyMethod,
  junctionIndex: number,
  side: 'left' | 'right' | 'product'
): string {
  const prefix =
    method === 'goldengate' ? 'goldengate' : method === 'nebuilder' ? 'nebuilder' : 'gibson';
  return `${prefix}-${junctionIndex}-${side}`;
}

function sourceLengthForRegion(
  region: {
    id: string;
    sourceSequenceId: string;
    sourceSequence?: string;
    sourceEnd: number;
  },
  sourceContext?: AssemblyWorkbenchSourceContext
): number {
  const context =
    sourceContext?.regions?.[region.id] ?? sourceContext?.sources?.[region.sourceSequenceId];
  return context?.sourceLength ?? region.sourceSequence?.length ?? region.sourceEnd;
}

function editableFieldId(
  design: SequenceDesign,
  junction: AssemblyWorkbenchJunctionControl,
  ...parts: Array<string | number | null | undefined>
): string {
  return [
    'field',
    design.id,
    junction.id,
    ...parts.filter((part) => part !== null && part !== undefined),
  ]
    .join(':')
    .replace(/\s+/g, '-');
}

function groupPrimersByJunction(
  design: SequenceDesign,
  pairs: DesignPrimerPair[],
  mode: AssemblyMethod
): Map<number, AssemblyWorkbenchPrimerControl[]> {
  const byJunction = new Map<number, AssemblyWorkbenchPrimerControl[]>();
  for (const pair of pairs) {
    for (const primer of [pair.forward, pair.reverse]) {
      if (primer.junctionIndex === null) continue;
      const control = primerControl(design, primer, mode);
      const current = byJunction.get(primer.junctionIndex) ?? [];
      current.push(control);
      byJunction.set(primer.junctionIndex, current);
    }
  }
  for (const controls of byJunction.values()) {
    controls.sort(
      (a, b) => a.fragmentIndex - b.fragmentIndex || a.direction.localeCompare(b.direction)
    );
  }
  return byJunction;
}

function primerControl(
  design: SequenceDesign,
  primer: DesignPrimer,
  mode: AssemblyMethod
): AssemblyWorkbenchPrimerControl {
  const pbsLength = Math.max(0, primer.pbs.end - primer.pbs.start);
  const regionId = design.regions[primer.fragmentIndex]?.id ?? null;
  const junctionId =
    primer.junctionIndex === null
      ? null
      : (design.assemblyWorkbench?.junctions.find(
          (junction) => junction.slot === primer.junctionIndex
        )?.id ?? null);
  return {
    id: primer.id,
    regionId,
    fragmentIndex: primer.fragmentIndex,
    direction: primer.direction,
    junctionIndex: primer.junctionIndex,
    junctionId,
    pbsLength,
    overhangLength: primer.overhang.tailLength ?? primer.overhang.sequence.length,
    tm: typeof primer.tm === 'number' && Number.isFinite(primer.tm) ? primer.tm : null,
    canEditPbs: true,
    canEditOverhang: mode !== 'goldengate' && primer.junctionIndex !== null,
  };
}

function buildHomologyFindings(
  design: SequenceDesign,
  selectedJunctionIndex: number | null
): AssemblyWorkbenchFinding[] {
  const findings: AssemblyWorkbenchFinding[] = [];
  const junctionCount = computeJunctionCount(design);
  if (junctionCount > 0 && design.homologyRegions.length === 0) {
    findings.push({
      id: `${design.id}:draft-missing`,
      severity: 'info',
      code: 'draft-missing',
      title: 'Draft assembly needed',
      message: userMessage(
        'assembly.finding.compute-homology-regions-and-primers-before-editing-junction-details'
      ),
      command: { type: 'draftAssembly' },
    });
  }

  for (const homology of design.homologyRegions) {
    if (!junctionIsInScope(homology.junctionIndex, selectedJunctionIndex)) continue;
    const total = homology.encoding.onLeft + homology.encoding.onRight;
    if (total < GIBSON_MIN_HOMOLOGY_LENGTH || total > GIBSON_MAX_HOMOLOGY_LENGTH) {
      findings.push({
        id: `${design.id}:homology-length:${homology.junctionIndex}`,
        severity: 'error',
        code: 'homology-length-out-of-range',
        title: 'Homology length outside supported range',
        message: userMessageWithValues(
          'assembly.finding.junction-value0-has-value1-bp-homology-supported-range-is-value2-value3-bp',
          {
            value0: userMessageValue(homology.junctionIndex + 1),
            value1: userMessageValue(total),
            value2: userMessageValue(GIBSON_MIN_HOMOLOGY_LENGTH),
            value3: userMessageValue(GIBSON_MAX_HOMOLOGY_LENGTH),
          }
        ),
        junctionIndex: homology.junctionIndex,
        command: {
          type: 'setHomologyEncoding',
          junctionIndex: homology.junctionIndex,
          encoding: recommendedHomologyEncodingForJunction(
            design,
            homology.junctionIndex,
            DEFAULT_PBS_LENGTH + 10,
            homology.encoding
          ),
        },
      });
    } else if (
      total < GIBSON_OPTIMAL_HOMOLOGY_RANGE.min ||
      total > GIBSON_OPTIMAL_HOMOLOGY_RANGE.max
    ) {
      findings.push({
        id: `${design.id}:homology-length-warning:${homology.junctionIndex}`,
        severity: 'warning',
        code: 'homology-length-suboptimal',
        title: 'Homology length is outside the preferred range',
        message: userMessageWithValues(
          'assembly.finding.junction-value0-has-value1-bp-homology-preferred-range-is-value2-value3-bp',
          {
            value0: userMessageValue(homology.junctionIndex + 1),
            value1: userMessageValue(total),
            value2: userMessageValue(GIBSON_OPTIMAL_HOMOLOGY_RANGE.min),
            value3: userMessageValue(GIBSON_OPTIMAL_HOMOLOGY_RANGE.max),
          }
        ),
        junctionIndex: homology.junctionIndex,
      });
    }

    const tm = homology.metadata?.tmEstimate;
    if (typeof tm === 'number' && Number.isFinite(tm) && Math.abs(tm - GIBSON_OPTIMAL_TM) > 12) {
      findings.push({
        id: `${design.id}:homology-tm:${homology.junctionIndex}`,
        severity: 'warning',
        code: 'homology-tm-suboptimal',
        title: 'Homology Tm is far from target',
        message: userMessageWithValues(
          'assembly.finding.junction-value0-homology-tm-is-value1-c-target-is-near-value2-c',
          {
            value0: userMessageValue(homology.junctionIndex + 1),
            value1: userMessageValue(tm.toFixed(1)),
            value2: userMessageValue(GIBSON_OPTIMAL_TM),
          }
        ),
        junctionIndex: homology.junctionIndex,
      });
    }

    const gc = homology.metadata?.gcContent;
    if (
      typeof gc === 'number' &&
      Number.isFinite(gc) &&
      (gc < GIBSON_OPTIMAL_GC_RANGE.min || gc > GIBSON_OPTIMAL_GC_RANGE.max)
    ) {
      findings.push({
        id: `${design.id}:homology-gc:${homology.junctionIndex}`,
        severity: 'warning',
        code: 'homology-gc-suboptimal',
        title: 'Homology GC content is outside preferred range',
        message: userMessageWithValues('assembly.finding.junction-value0-gc-content-is-value1', {
          value0: userMessageValue(homology.junctionIndex + 1),
          value1: userMessageValue(gc.toFixed(1)),
        }),
        junctionIndex: homology.junctionIndex,
      });
    }
  }

  findings.push(...buildPrimerFindings(design, selectedJunctionIndex));
  return findings;
}

function buildPrimerFindings(
  design: SequenceDesign,
  selectedJunctionIndex: number | null
): AssemblyWorkbenchFinding[] {
  const findings: AssemblyWorkbenchFinding[] = [];
  for (const pair of design.designPrimers) {
    for (const primer of [pair.forward, pair.reverse]) {
      if (!isPcrTemplateRegion(design.regions[primer.fragmentIndex])) continue;
      if (
        primer.junctionIndex !== null &&
        !junctionIsInScope(primer.junctionIndex, selectedJunctionIndex)
      ) {
        continue;
      }
      const pbsLength = primer.pbs.end - primer.pbs.start;
      const pbsRange = primerPbsLengthRange(
        primer,
        getEffectiveDesignRegions(design),
        design.spacers
      );
      if (pbsLength < pbsRange.min || pbsLength > pbsRange.max) {
        findings.push({
          id: `${design.id}:primer-pbs-error:${primer.id}`,
          severity: 'error',
          code: 'primer-pbs-out-of-range',
          title: 'Primer binding length outside supported range',
          message: userMessageWithValues(
            'assembly.finding.-value0-has-a-value1-bp-binding-site-available-template-range-is-value2-value3-bp',
            {
              value0: userMessageValue(primer.name),
              value1: userMessageValue(pbsLength),
              value2: userMessageValue(pbsRange.min),
              value3: userMessageValue(pbsRange.max),
            }
          ),
          junctionIndex: primer.junctionIndex ?? undefined,
          primer: { fragmentIndex: primer.fragmentIndex, direction: primer.direction },
          command: {
            type: 'setPrimerPbsLength',
            fragmentIndex: primer.fragmentIndex,
            direction: primer.direction,
            length: DEFAULT_PBS_LENGTH,
          },
        });
      } else if (pbsLength < PRIMER_PBS_WARN_MIN || pbsLength > PRIMER_PBS_WARN_MAX) {
        findings.push({
          id: `${design.id}:primer-pbs-warning:${primer.id}`,
          severity: 'warning',
          code: 'primer-pbs-suboptimal',
          title: 'Primer binding length is outside the preferred range',
          message: userMessageWithValues(
            'assembly.finding.-value0-has-a-value1-bp-binding-site-preferred-range-is-value2-value3-bp',
            {
              value0: userMessageValue(primer.name),
              value1: userMessageValue(pbsLength),
              value2: userMessageValue(PRIMER_PBS_WARN_MIN),
              value3: userMessageValue(PRIMER_PBS_WARN_MAX),
            }
          ),
          junctionIndex: primer.junctionIndex ?? undefined,
          primer: { fragmentIndex: primer.fragmentIndex, direction: primer.direction },
        });
      }
    }
  }
  return findings;
}

function buildHomologyProposals(
  _design: SequenceDesign,
  findings: AssemblyWorkbenchFinding[]
): AssemblyWorkbenchProposal[] {
  return findings
    .filter(
      (finding): finding is AssemblyWorkbenchFinding & { command: AssemblyWorkbenchCommand } =>
        Boolean(finding.command)
    )
    .map((finding) => ({
      id: `${finding.id}:proposal`,
      title: finding.title,
      rationale: finding.message,
      command: finding.command,
      fixesFindingIds: [finding.id],
    }));
}

function buildGoldenGateFindings(
  design: SequenceDesign,
  selectedJunctionIndex: number | null
): AssemblyWorkbenchFinding[] {
  const enzyme = design.goldenGateConfig?.enzyme ?? 'BsaI';
  const validation = validateGoldenGateAssembly(
    design.regions,
    design.topology === 'circular',
    enzyme,
    { backboneSequenceId: design.backboneSequenceId }
  );
  const findings: AssemblyWorkbenchFinding[] = validation.conflicts.map((conflict, index) => ({
    id: `${design.id}:goldengate-conflict:${index}:${conflict.type}`,
    severity: goldenGateConflictSeverity(conflict.type),
    code: `goldengate-${conflict.type}`,
    title: goldenGateConflictTitle(conflict.type),
    message: toUserMessage(conflict.message, 'assembly.failed'),
    regionIndex: conflict.involvedIndices[0],
  }));

  for (const junction of design.goldenGateJunctions ?? []) {
    if (!junctionIsInScope(junction.junctionIndex, selectedJunctionIndex)) continue;
    if (!junction.isValid) {
      findings.push({
        id: `${design.id}:goldengate-junction:${junction.junctionIndex}`,
        severity: 'error',
        code: 'goldengate-junction-invalid',
        title: 'Invalid Golden Gate overhang',
        message: junction.validationError
          ? toUserMessage(junction.validationError, 'assembly.failed')
          : userMessageWithValues('assembly.junctionInvalid', {
              junction: userMessageValue(junction.junctionIndex + 1),
            }),
        junctionIndex: junction.junctionIndex,
      });
    }
  }

  if ((design.goldenGateJunctions?.length ?? 0) === 0 && computeJunctionCount(design) > 0) {
    findings.push({
      id: `${design.id}:goldengate-draft-missing`,
      severity: 'info',
      code: 'draft-missing',
      title: 'Draft Golden Gate assembly needed',
      message: userMessage(
        'assembly.finding.compute-golden-gate-overhangs-and-primers-before-editing-offsets'
      ),
      command: { type: 'draftAssembly' },
    });
  }

  findings.push(...buildPrimerFindings(design, selectedJunctionIndex));
  return findings;
}

function buildGoldenGateProposals(
  design: SequenceDesign,
  findings: AssemblyWorkbenchFinding[]
): AssemblyWorkbenchProposal[] {
  const proposals = buildHomologyProposals(design, findings);
  const hasInternalSite = findings.some((finding) => finding.code === 'goldengate-internal-site');
  if (hasInternalSite) {
    const current = design.goldenGateConfig?.enzyme ?? 'BsaI';
    const alternative = GOLDEN_GATE_ENZYMES.find((enzyme) => enzyme !== current) ?? 'BsmBI';
    proposals.push({
      id: `${design.id}:goldengate-alternate-enzyme`,
      title: `Try ${alternative}`,
      rationale: `Switch enzyme and re-draft to check whether ${alternative} avoids the internal site conflict.`,
      command: { type: 'setGoldenGateEnzyme', enzyme: alternative, draft: true },
      fixesFindingIds: findings
        .filter((finding) => finding.code === 'goldengate-internal-site')
        .map((finding) => finding.id),
    });
  }
  return proposals;
}

function resolveSelectedJunctionIndex(
  design: SequenceDesign,
  viewState?: AssemblyWorkbenchViewState
): number | null {
  const junctionCount = computeJunctionCount(design);
  if (junctionCount === 0) return null;
  if (viewState?.selectedJunctionId) {
    const selected = design.assemblyWorkbench?.junctions.find(
      (junction) => junction.id === viewState.selectedJunctionId
    );
    if (selected && selected.slot >= 0 && selected.slot < junctionCount) return selected.slot;
  }
  if (
    typeof viewState?.selectedJunctionIndex === 'number' &&
    viewState.selectedJunctionIndex >= 0 &&
    viewState.selectedJunctionIndex < junctionCount
  ) {
    return viewState.selectedJunctionIndex;
  }
  if (
    typeof design.selectedJunctionIndex === 'number' &&
    design.selectedJunctionIndex >= 0 &&
    design.selectedJunctionIndex < junctionCount
  ) {
    return design.selectedJunctionIndex;
  }
  return 0;
}

function junctionIsInScope(junctionIndex: number, selectedJunctionIndex: number | null): boolean {
  return selectedJunctionIndex === null || junctionIndex === selectedJunctionIndex;
}
