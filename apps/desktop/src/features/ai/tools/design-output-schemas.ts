



import { z } from 'zod';
import type { AssemblyWorkbenchCommand } from '../../junction-workbench/public/AssemblyWorkbenchContract';
import { jsonObjectSchema } from '../../../shared/json-value';
import { acceptedLineageSchema } from './accepted-lineage-output-schema';
import { scientificAcceptedRevisionSchema } from './scientific-output-schemas';
import { PRIMER_ARTIFACT_SCHEMA_VERSION } from '../../primers/public/primer-artifact';

const setJunctionSpacerAppliedCommandsItemsSelectJunctionSchema = z
  .object({
    type: z.literal('selectJunction'),
    junctionId: z.union([z.null(), z.string()]).optional(),
    junctionIndex: z.union([z.null(), z.number()]).optional(),
  })
  .strict();

const setJunctionSpacerAppliedCommandsItemsSetAssemblyModeSchema = z
  .object({
    type: z.literal('setAssemblyMode'),
    method: z.union([z.literal('gibson'), z.literal('nebuilder'), z.literal('goldengate')]),
    enzyme: z
      .union([z.literal('BsaI'), z.literal('BbsI'), z.literal('BsmBI'), z.literal('SapI')])
      .optional(),
    draft: z.boolean().optional(),
    expectedDesignVersion: z.number().optional(),
  })
  .strict();

const setJunctionSpacerAppliedCommandsItemsSetGoldenGateEnzymeSchema = z
  .object({
    type: z.literal('setGoldenGateEnzyme'),
    enzyme: z.union([z.literal('BsaI'), z.literal('BbsI'), z.literal('BsmBI'), z.literal('SapI')]),
    draft: z.boolean().optional(),
    expectedDesignVersion: z.number().optional(),
  })
  .strict();

const setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetLimitSchema = z
  .object({
    type: z.literal('setGoldenGateOffsetLimit'),
    limit: z.number(),
    expectedDesignVersion: z.number().optional(),
  })
  .strict();

const setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetSchema = z
  .object({
    type: z.literal('setGoldenGateOffset'),
    offset: z.number(),
    expectedDesignVersion: z.number().optional(),
    junctionId: z.string().optional(),
    junctionIndex: z.number().optional(),
  })
  .strict();

const homologyEncodingSchema = z
  .object({
    onLeft: z.number(),
    onRight: z.number(),
  })
  .strict();

const setJunctionSpacerAppliedCommandsItemsSetHomologyEncodingSchema = z
  .object({
    type: z.literal('setHomologyEncoding'),
    encoding: homologyEncodingSchema,
    recomputePrimers: z.boolean().optional(),
    expectedDesignVersion: z.number().optional(),
    junctionId: z.string().optional(),
    junctionIndex: z.number().optional(),
  })
  .strict();

const setJunctionSpacerAppliedCommandsItemsSetJunctionSpacerSchema = z
  .object({
    type: z.literal('setJunctionSpacer'),
    sequence: z.string(),
    name: z.union([z.null(), z.string()]).optional(),
    expectedDesignVersion: z.number().optional(),
    junctionId: z.string().optional(),
    junctionIndex: z.number().optional(),
  })
  .strict();

const setJunctionSpacerAppliedCommandsItemsSetSourceContributionBoundarySchema = z
  .object({
    type: z.literal('setSourceContributionBoundary'),
    regionId: z.string(),
    side: z.union([z.literal('upstream'), z.literal('downstream')]),
    sourcePosition: z.number(),
    expectedDesignVersion: z.number().optional(),
  })
  .strict();

const setJunctionSpacerAppliedCommandsItemsSetPrimerPbsLengthSchema = z
  .object({
    type: z.literal('setPrimerPbsLength'),
    length: z.number(),
    expectedDesignVersion: z.number().optional(),
    primerId: z.string().optional(),
    fragmentIndex: z.number().optional(),
    direction: z.union([z.literal('reverse'), z.literal('forward')]).optional(),
  })
  .strict();

const setJunctionSpacerAppliedCommandsItemsSetPrimerOverhangLengthSchema = z
  .object({
    type: z.literal('setPrimerOverhangLength'),
    length: z.number(),
    expectedDesignVersion: z.number().optional(),
    primerId: z.string().optional(),
    fragmentIndex: z.number().optional(),
    direction: z.union([z.literal('reverse'), z.literal('forward')]).optional(),
  })
  .strict();

const setJunctionSpacerAppliedCommandsItemsDraftAssemblySchema = z
  .object({
    type: z.literal('draftAssembly'),
    expectedDesignVersion: z.number().optional(),
  })
  .strict();

const setJunctionSpacerAppliedCommandsItemsCommandAutoOptimizeSchema = z
  .object({
    type: z.literal('autoOptimize'),
    scope: z.union([z.literal('selected-junction'), z.literal('all')]),
    maxIterations: z.number().optional(),
    candidateRank: z.number().optional(),
    expectedDesignVersion: z.number().optional(),
  })
  .strict();

const setJunctionSpacerAppliedCommandsItemsApplyProposalSchema: z.ZodType<
  Extract<AssemblyWorkbenchCommand, { type: 'applyProposal' }>
> = z
  .object({
    type: z.literal('applyProposal'),
    proposalId: z.string(),
    command: z.union([
      setJunctionSpacerAppliedCommandsItemsSelectJunctionSchema,
      setJunctionSpacerAppliedCommandsItemsSetAssemblyModeSchema,
      setJunctionSpacerAppliedCommandsItemsSetGoldenGateEnzymeSchema,
      setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetLimitSchema,
      setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetSchema,
      setJunctionSpacerAppliedCommandsItemsSetHomologyEncodingSchema,
      setJunctionSpacerAppliedCommandsItemsSetJunctionSpacerSchema,
      setJunctionSpacerAppliedCommandsItemsSetSourceContributionBoundarySchema,
      setJunctionSpacerAppliedCommandsItemsSetPrimerPbsLengthSchema,
      setJunctionSpacerAppliedCommandsItemsSetPrimerOverhangLengthSchema,
      setJunctionSpacerAppliedCommandsItemsDraftAssemblySchema,
      z.lazy(() => setJunctionSpacerAppliedCommandsItemsApplyProposalSchema),
      setJunctionSpacerAppliedCommandsItemsCommandAutoOptimizeSchema,
    ]),
    expectedDesignVersion: z.number().optional(),
  })
  .strict();

const assemblyWorkbenchCommandWarningSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    commandType: z.union([
      z.literal('setJunctionSpacer'),
      z.literal('draftAssembly'),
      z.literal('selectJunction'),
      z.literal('setAssemblyMode'),
      z.literal('setGoldenGateEnzyme'),
      z.literal('setGoldenGateOffsetLimit'),
      z.literal('setGoldenGateOffset'),
      z.literal('setHomologyEncoding'),
      z.literal('setSourceContributionBoundary'),
      z.literal('setPrimerPbsLength'),
      z.literal('setPrimerOverhangLength'),
      z.literal('applyProposal'),
      z.literal('autoOptimize'),
    ]),
    targetId: z.string().optional(),
  })
  .strict();

const assemblySetEditableFieldAppliedSchema = z
  .object({
    status: z.literal('applied'),
    designId: z.string(),
    designVersion: z.number(),
    appliedCommands: z.array(
      z.union([
        setJunctionSpacerAppliedCommandsItemsSelectJunctionSchema,
        setJunctionSpacerAppliedCommandsItemsSetAssemblyModeSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateEnzymeSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetLimitSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetSchema,
        setJunctionSpacerAppliedCommandsItemsSetHomologyEncodingSchema,
        setJunctionSpacerAppliedCommandsItemsSetJunctionSpacerSchema,
        setJunctionSpacerAppliedCommandsItemsSetSourceContributionBoundarySchema,
        setJunctionSpacerAppliedCommandsItemsSetPrimerPbsLengthSchema,
        setJunctionSpacerAppliedCommandsItemsSetPrimerOverhangLengthSchema,
        setJunctionSpacerAppliedCommandsItemsDraftAssemblySchema,
        setJunctionSpacerAppliedCommandsItemsApplyProposalSchema,
        setJunctionSpacerAppliedCommandsItemsCommandAutoOptimizeSchema,
      ])
    ),
    warnings: z.array(assemblyWorkbenchCommandWarningSchema),
    ok: z.literal(true),
  })
  .strict();

const assemblyWorkbenchCommandErrorSchema = z
  .object({
    code: z.union([
      z.literal('invalid-command-target'),
      z.literal('stale-design-version'),
      z.literal('unsupported-command'),
      z.literal('unsupported-mode-command'),
      z.literal('invalid-command-value'),
      z.literal('fixed-goldengate-junction'),
      z.literal('optimizer-data-unavailable'),
      z.literal('optimizer-search-limit'),
      z.literal('missing-source-context'),
      z.literal('source-window-too-small'),
    ]),
    message: z.string(),
    commandType: z.union([
      z.literal('setJunctionSpacer'),
      z.literal('draftAssembly'),
      z.literal('selectJunction'),
      z.literal('setAssemblyMode'),
      z.literal('setGoldenGateEnzyme'),
      z.literal('setGoldenGateOffsetLimit'),
      z.literal('setGoldenGateOffset'),
      z.literal('setHomologyEncoding'),
      z.literal('setSourceContributionBoundary'),
      z.literal('setPrimerPbsLength'),
      z.literal('setPrimerOverhangLength'),
      z.literal('applyProposal'),
      z.literal('autoOptimize'),
    ]),
    expectedDesignVersion: z.number().optional(),
    actualDesignVersion: z.number().optional(),
    targetId: z.string().optional(),
  })
  .strict();

const assemblySetEditableFieldNoopSchema = z
  .object({
    status: z.literal('noop'),
    errors: z.array(assemblyWorkbenchCommandErrorSchema),
    warnings: z.array(assemblyWorkbenchCommandWarningSchema),
    designId: z.string(),
    designVersion: z.number(),
    ok: z.literal(true),
  })
  .strict();

const assemblyListEditableFieldsFieldsItemsConstraintsItemsSchema = z
  .object({
    code: z.string(),
    severity: z.union([z.literal('error'), z.literal('warning'), z.literal('info')]),
    message: z.string(),
  })
  .strict();


const assemblyListEditableFieldsFieldsItemsCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('setJunctionSpacer'),
      payload: z
        .object({
          junctionId: z.string(),
          junctionIndex: z.number(),
          sequence: z.string(),
          expectedDesignVersion: z.number(),
        })
        .strict(),
      valueKey: z.literal('sequence'),
    })
    .strict(),
  z
    .object({
      type: z.literal('setSourceContributionBoundary'),
      payload: z
        .object({
          regionId: z.string(),
          side: z.enum(['upstream', 'downstream']),
          sourcePosition: z.number(),
          expectedDesignVersion: z.number(),
        })
        .strict(),
      valueKey: z.literal('sourcePosition'),
    })
    .strict(),
  z
    .object({
      type: z.literal('setHomologyEncoding'),
      payload: z
        .object({
          junctionId: z.string(),
          junctionIndex: z.number(),
          encoding: z.object({ onLeft: z.number(), onRight: z.number() }).strict(),
          expectedDesignVersion: z.number(),
        })
        .strict(),
      valueKey: z.enum(['encoding.onLeft', 'encoding.onRight']),
    })
    .strict(),
  z
    .object({
      type: z.literal('setPrimerPbsLength'),
      payload: z
        .object({ primerId: z.string(), length: z.number(), expectedDesignVersion: z.number() })
        .strict(),
      valueKey: z.literal('length'),
    })
    .strict(),
  z
    .object({
      type: z.literal('setPrimerOverhangLength'),
      payload: z
        .object({ primerId: z.string(), length: z.number(), expectedDesignVersion: z.number() })
        .strict(),
      valueKey: z.literal('length'),
    })
    .strict(),
  z
    .object({
      type: z.literal('setGoldenGateOffset'),
      payload: z
        .object({
          junctionId: z.string(),
          junctionIndex: z.number(),
          offset: z.number(),
          previewRange: z
            .object({ startBioCol: z.number(), endBioCol: z.number(), spacerLength: z.number() })
            .strict(),
          expectedDesignVersion: z.number(),
        })
        .strict(),
      valueKey: z.literal('offset'),
    })
    .strict(),
]);

const assemblyListEditableFieldsFieldsItemsAnchorsItemsSchema = z
  .object({
    rowId: z.string(),
    rowKind: z.union([z.literal('product'), z.literal('left-source'), z.literal('right-source')]),
    bioCol: z.number(),
    role: z.union([
      z.literal('boundary'),
      z.literal('pbs-start'),
      z.literal('pbs-end'),
      z.literal('tail-start'),
      z.literal('tail-end'),
    ]),
  })
  .strict();

const assemblyListEditableFieldsFieldsItemsRangeSchema = z
  .object({
    min: z.number(),
    max: z.number(),
    step: z.number(),
    largeStep: z.number(),
  })
  .strict();

const assemblyListEditableFieldsFieldsItemsTargetSchema = z
  .object({
    junctionId: z.string().optional(),
    junctionIndex: z.number().optional(),
    regionId: z.string().optional(),
    primerId: z.string().optional(),
    fragmentIndex: z.number().optional(),
    direction: z.union([z.literal('reverse'), z.literal('forward')]).optional(),
    side: z
      .union([
        z.literal('upstream'),
        z.literal('downstream'),
        z.literal('left'),
        z.literal('right'),
      ])
      .optional(),
  })
  .strict();

const assemblyWorkbenchEditableFieldSchema = z
  .object({
    id: z.string(),
    kind: z.union([
      z.literal('goldenGateOverhang'),
      z.literal('sourceContributionBoundary'),
      z.literal('junctionSpacer'),
      z.literal('primerPbs'),
      z.literal('primerTail'),
      z.literal('homologyArm'),
      z.literal('rdResection'),
    ]),
    label: z.string(),
    target: assemblyListEditableFieldsFieldsItemsTargetSchema,
    value: z.union([z.string(), z.number()]),
    units: z.union([z.literal('sequence'), z.literal('bp')]),
    range: assemblyListEditableFieldsFieldsItemsRangeSchema.optional(),
    anchors: z.array(assemblyListEditableFieldsFieldsItemsAnchorsItemsSchema),
    command: assemblyListEditableFieldsFieldsItemsCommandSchema,
    constraints: z.array(assemblyListEditableFieldsFieldsItemsConstraintsItemsSchema),
    disabled: z.boolean().optional(),
  })
  .strict();

const assemblyListEditableFieldsSchema = z
  .object({
    designId: z.string(),
    designVersion: z.number(),
    selectedJunctionIndex: z.union([z.null(), z.number()]),
    fields: z.array(assemblyWorkbenchEditableFieldSchema),
    ok: z.literal(true),
  })
  .strict();

const applyOverhangOptimizationChangedJunctionsItemsSchema = z
  .object({
    junctionIndex: z.number(),
    previousOffset: z.number(),
    offset: z.number(),
    previousOverhang: z.string(),
    overhang: z.string(),
  })
  .strict();

const planOverhangOptimizationCurrentFidelityConflictsItemsSchema = z
  .object({
    type: z.union([
      z.literal('invalid-overhang'),
      z.literal('duplicate-overhang'),
      z.literal('reverse-complement-duplicate'),
      z.literal('self-complementary-overhang'),
    ]),
    overhang: z.string(),
    otherOverhang: z.union([z.null(), z.string()]),
  })
  .strict();

const planOverhangOptimizationCurrentFidelitySchema = z
  .object({
    predictedFidelity: z.union([z.null(), z.number()]),
    logFidelity: z.union([z.null(), z.number()]),
    onTargetCount: z.number(),
    valid: z.boolean(),
    conflicts: z.array(planOverhangOptimizationCurrentFidelityConflictsItemsSchema),
  })
  .strict();

const applyOverhangOptimizationJunctionsItemsSchema = z
  .object({
    junctionIndex: z.number(),
    offset: z.number(),
    overhang: z.string(),
    overhangSource: z.union([
      z.literal('rd-fixed'),
      z.literal('pcr-designed'),
      z.literal('pcr-matched-rd'),
    ]),
    offsetEditable: z.boolean(),
    isValid: z.boolean(),
  })
  .strict();

const createDesignMutationTargetDesignSchema = z
  .object({
    type: z.literal('design'),
    id: z.string(),
  })
  .strict();

export const agentMutationClaimSchema = z
  .object({
    operationId: z.string(),
    toolName: z.string(),
    effect: z.union([
      z.literal('created_design'),
      z.literal('added_design_region'),
      z.literal('drafted_design_assembly'),
      z.literal('set_junction_spacer'),
      z.literal('set_primer_pbs_length'),
      z.literal('updated_assembly_primer'),
      z.literal('set_primer_overhang_length'),
      z.literal('set_golden_gate_offset'),
      z.literal('set_golden_gate_schema'),
      z.literal('set_moclo_factory_stage'),
      z.literal('set_pcr_polymerase'),
      z.literal('placed_digest_fragment'),
      z.literal('removed_design_region'),
      z.literal('reordered_design_regions'),
      z.literal('applied_overhang_optimization'),
    ]),
    target: createDesignMutationTargetDesignSchema,
    resourceUri: z.string(),
    beforeVersion: z.union([z.null(), z.number()]),
    afterVersion: z.union([z.null(), z.number()]),
    changed: z.boolean(),
    expected: jsonObjectSchema.optional(),
  })
  .strict();

const applyOverhangOptimizationAppliedSchema = z
  .object({
    status: z.literal('applied'),
    planId: z.string(),
    appliedRank: z.number(),
    planAgreement: z.literal('exact'),
    planDisagreements: z.array(z.never()).max(0),
    beforeFidelity: planOverhangOptimizationCurrentFidelitySchema,
    afterFidelity: planOverhangOptimizationCurrentFidelitySchema,
    changedJunctionCount: z.number(),
    totalMovementBp: z.number(),
    changedJunctions: z.array(applyOverhangOptimizationChangedJunctionsItemsSchema),
    junctionsBefore: z.array(applyOverhangOptimizationJunctionsItemsSchema),
    junctions: z.array(applyOverhangOptimizationJunctionsItemsSchema),
    previousVersion: z.number(),
    designVersion: z.number(),
    appliedCommands: z.array(
      z.union([
        setJunctionSpacerAppliedCommandsItemsSelectJunctionSchema,
        setJunctionSpacerAppliedCommandsItemsSetAssemblyModeSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateEnzymeSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetLimitSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetSchema,
        setJunctionSpacerAppliedCommandsItemsSetHomologyEncodingSchema,
        setJunctionSpacerAppliedCommandsItemsSetJunctionSpacerSchema,
        setJunctionSpacerAppliedCommandsItemsSetSourceContributionBoundarySchema,
        setJunctionSpacerAppliedCommandsItemsSetPrimerPbsLengthSchema,
        setJunctionSpacerAppliedCommandsItemsSetPrimerOverhangLengthSchema,
        setJunctionSpacerAppliedCommandsItemsDraftAssemblySchema,
        setJunctionSpacerAppliedCommandsItemsApplyProposalSchema,
        setJunctionSpacerAppliedCommandsItemsCommandAutoOptimizeSchema,
      ])
    ),
    warnings: z.array(assemblyWorkbenchCommandWarningSchema),
    revalidationRequired: z.boolean(),
    primersChanged: z.boolean(),
    mutation: agentMutationClaimSchema,
    designId: z.string(),
    requestedRank: z.number(),
    versionGuardApplied: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const applyOverhangOptimizationNoopSchema = z
  .object({
    status: z.literal('noop'),
    planId: z.string(),
    appliedRank: z.number(),
    message: z.string(),
    designVersion: z.number(),
    previousVersion: z.number(),
    junctions: z.array(applyOverhangOptimizationJunctionsItemsSchema),
    fidelity: planOverhangOptimizationCurrentFidelitySchema,
    designId: z.string(),
    requestedRank: z.number(),
    versionGuardApplied: z.boolean(),
    revalidationRequired: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const planOverhangOptimizationCombinationsItemsJunctionsItemsSchema = z
  .object({
    junctionIndex: z.number(),
    offset: z.number(),
    overhang: z.string(),
    previousOffset: z.union([z.null(), z.number()]),
    previousOverhang: z.union([z.null(), z.string()]),
    changed: z.boolean(),
    movementBp: z.number(),
    locked: z.boolean(),
    correctLigationProbability: z.union([z.null(), z.number()]),
  })
  .strict();

const planOverhangOptimizationCombinationsItemsOffsetsToApplySchema = z.record(z.number());

const planOverhangOptimizationCombinationsItemsSchema = z
  .object({
    changedJunctionCount: z.number(),
    totalMovementBp: z.number(),
    offsetsToApply: planOverhangOptimizationCombinationsItemsOffsetsToApplySchema,
    junctions: z.array(planOverhangOptimizationCombinationsItemsJunctionsItemsSchema),
    predictedFidelity: z.union([z.null(), z.number()]),
    logFidelity: z.union([z.null(), z.number()]),
    onTargetCount: z.number(),
    valid: z.boolean(),
    conflicts: z.array(planOverhangOptimizationCurrentFidelityConflictsItemsSchema),
    rank: z.number(),
    isCurrentDesign: z.boolean(),
  })
  .strict();

const planOverhangOptimizationFidelityDatasetSchema = z
  .object({
    key: z.union([
      z.literal('Esp3I'),
      z.literal('BsaI-HFv2'),
      z.literal('BsmBI-v2'),
      z.literal('BbsI-HF'),
    ]),
    paper: z.string(),
    doi: z.string(),
    license: z.string(),
    overhangLengthBp: z.number(),
  })
  .strict();

const planOverhangOptimizationLockedJunctionsItemsSchema = z
  .object({
    junctionIndex: z.number(),
    overhang: z.string(),
    overhangSource: z.union([
      z.literal('rd-fixed'),
      z.literal('pcr-designed'),
      z.literal('pcr-matched-rd'),
    ]),
    reason: z.string(),
  })
  .strict();

const planOverhangOptimizationOkSchema = z
  .object({
    status: z.literal('ok'),
    planId: z.string(),
    designId: z.string(),
    designVersion: z.number(),
    enzyme: z.union([z.literal('BsaI'), z.literal('BbsI'), z.literal('BsmBI'), z.literal('SapI')]),
    offsetLimitBp: z.number(),
    scope: z.union([z.literal('all-junctions'), z.string().regex(/^junction-[0-9]+$/)]),
    scopeJunctionIndex: z.union([z.null(), z.number()]),
    editableJunctionIndexes: z.array(z.number()),
    lockedJunctions: z.array(planOverhangOptimizationLockedJunctionsItemsSchema),
    optimizable: z.boolean(),
    notOptimizableReason: z.union([z.null(), z.string()]),
    currentFidelity: planOverhangOptimizationCurrentFidelitySchema,
    recommendedRank: z.number(),
    searchProvedOptimal: z.boolean(),
    evaluatedNodes: z.number(),
    fidelityDataset: planOverhangOptimizationFidelityDatasetSchema,
    combinations: z.array(planOverhangOptimizationCombinationsItemsSchema),
    nextStep: z.string(),
    ok: z.literal(true),
  })
  .strict();

const assemblySlotViewSchema = z
  .object({
    slotIndex: z.number(),
    regionId: z.string(),
    schemaSlotId: z.union([z.null(), z.string()]),
    isEmpty: z.boolean(),
    label: z.string(),
    length: z.number(),
    sourceType: z.union([z.null(), z.string()]),
    ggType: z.union([z.null(), z.string()]),
    rdSourceEnzyme: z.union([z.null(), z.string()]),
    occupantFingerprint: z.string(),
  })
  .strict();

const getDesignGapsItemsSpacerSchema = z
  .object({
    id: z.string(),
    sequence: z.string(),
    name: z.union([z.null(), z.string()]),
    length: z.number(),
  })
  .strict();

const assemblyGapViewSchema = z
  .object({
    junctionIndex: z.number(),
    spacer: z.union([z.null(), getDesignGapsItemsSpacerSchema]),
    duplicateSpacerIds: z.array(z.string()),
  })
  .strict();

const removeDesignRegionMovedSpacersItemsSchema = z
  .object({
    spacerId: z.string(),
    sequence: z.string(),
    wasBetween: z.string(),
    nowBetween: z.string(),
    wasJunctionIndex: z.number(),
    nowJunctionIndex: z.number(),
  })
  .strict();

const removeDesignRegionDroppedSpacersItemsSchema = z
  .object({
    spacerId: z.string(),
    sequence: z.string(),
    name: z.union([z.null(), z.string()]),
    wasBetween: z.string(),
    wasBetweenLabels: z.string(),
    wasJunctionIndex: z.number(),
  })
  .strict();

const removeDesignRegionDiscardedDraftSchema = z
  .object({
    homologyRegions: z.number(),
    designPrimers: z.number(),
    goldenGateJunctions: z.number(),
  })
  .strict();

const reorderDesignRegionsAppliedSchema = z
  .object({
    status: z.literal('applied'),
    orderBefore: z.array(z.string()),
    order: z.array(z.string()),
    labelsBefore: z.array(z.string()),
    labels: z.array(z.string()),
    slotsBefore: z.array(assemblySlotViewSchema),
    slots: z.array(assemblySlotViewSchema),
    gapsBefore: z.array(assemblyGapViewSchema),
    gaps: z.array(assemblyGapViewSchema),
    composedLengthBefore: z.number(),
    composedLength: z.number(),
    movedSpacers: z.array(removeDesignRegionMovedSpacersItemsSchema),
    droppedSpacers: z.array(removeDesignRegionDroppedSpacersItemsSchema),
    orphanedSpacerIds: z.array(z.string()),
    discardedDraft: removeDesignRegionDiscardedDraftSchema,
    previousVersion: z.number(),
    designVersion: z.number(),
    changedFields: z.array(z.string()),
    revalidationRequired: z.boolean(),
    mutation: agentMutationClaimSchema,
    designId: z.string(),
    versionGuardApplied: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const removeDesignRegionRemovedVariant12Schema = z
  .object({
    sequencePreview: z.string(),
    sequencePreviewLength: z.number(),
    recovery: z.string(),
    regionId: z.string(),
    slotIndex: z.number(),
    label: z.string(),
    wasEmpty: z.boolean(),
    length: z.number(),
    sourceSequenceId: z.string(),
    sourceStart: z.number(),
    sourceEnd: z.number(),
    sourceType: z.union([z.null(), z.literal('pcr'), z.literal('rd')]),
    ggType: z.union([
      z.null(),
      z.literal('rd'),
      z.literal('insert'),
      z.literal('backbone'),
      z.literal('unusable'),
    ]),
    rdSourceEnzyme: z.union([
      z.null(),
      z.literal('BsaI'),
      z.literal('BbsI'),
      z.literal('BsmBI'),
      z.literal('SapI'),
    ]),
    sequenceIncluded: z.boolean(),
  })
  .strict();

const removeDesignRegionRemovedSchema = z
  .object({
    sequence: z.string(),
    regionId: z.string(),
    slotIndex: z.number(),
    label: z.string(),
    wasEmpty: z.boolean(),
    length: z.number(),
    sourceSequenceId: z.string(),
    sourceStart: z.number(),
    sourceEnd: z.number(),
    sourceType: z.union([z.null(), z.literal('pcr'), z.literal('rd')]),
    ggType: z.union([
      z.null(),
      z.literal('rd'),
      z.literal('insert'),
      z.literal('backbone'),
      z.literal('unusable'),
    ]),
    rdSourceEnzyme: z.union([
      z.null(),
      z.literal('BsaI'),
      z.literal('BbsI'),
      z.literal('BsmBI'),
      z.literal('SapI'),
    ]),
    sequenceIncluded: z.boolean(),
  })
  .strict();

const removeDesignRegionAppliedSchema = z
  .object({
    status: z.literal('applied'),
    removed: z.union([removeDesignRegionRemovedSchema, removeDesignRegionRemovedVariant12Schema]),
    slotsBefore: z.array(assemblySlotViewSchema),
    slots: z.array(assemblySlotViewSchema),
    gapsBefore: z.array(assemblyGapViewSchema),
    gaps: z.array(assemblyGapViewSchema),
    slotCountBefore: z.number(),
    slotCount: z.number(),
    composedLengthBefore: z.number(),
    composedLength: z.number(),
    movedSpacers: z.array(removeDesignRegionMovedSpacersItemsSchema),
    droppedSpacers: z.array(removeDesignRegionDroppedSpacersItemsSchema),
    orphanedSpacerIds: z.array(z.string()),
    discardedDraft: removeDesignRegionDiscardedDraftSchema,
    previousVersion: z.number(),
    designVersion: z.number(),
    changedFields: z.array(z.string()),
    revalidationRequired: z.boolean(),
    mutation: agentMutationClaimSchema,
    designId: z.string(),
    regionId: z.string(),
    versionGuardApplied: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const setPcrPolymeraseWarningsItemsSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .strict();

const polymeraseProjectionSchema = z
  .object({
    prodcode: z.string(),
    family: z.union([
      z.null(),
      z.literal('q5'),
      z.literal('phusion'),
      z.literal('onetaq'),
      z.literal('taq'),
      z.literal('longamp'),
    ]),
    label: z.union([z.null(), z.string()]),
  })
  .strict();

const configurePrimerTmModelLocalSchema = z
  .object({
    kind: z.literal('local'),
    algorithm: z.union([z.literal('santalucia98'), z.literal('santalucia-owczarzy')]),
  })
  .strict();

const configurePrimerTmModelNebSchema = z
  .object({
    kind: z.literal('neb'),
    prodcode: z.string(),
    polymerase: z.union([
      z.literal('q5'),
      z.literal('phusion'),
      z.literal('onetaq'),
      z.literal('taq'),
      z.literal('longamp'),
    ]),
  })
  .strict();

const setPcrPolymeraseAppliedSchema = z
  .object({
    status: z.literal('applied'),
    polymerase: z.union([z.null(), polymeraseProjectionSchema]),
    previousPolymerase: z.union([z.null(), polymeraseProjectionSchema]),
    tmModel: z.union([
      z.null(),
      configurePrimerTmModelLocalSchema,
      configurePrimerTmModelNebSchema,
    ]),
    resolvedFrom: z.union([z.literal('prodcode'), z.literal('family'), z.literal('cleared')]),
    familyOptions: z.array(z.string()),
    previousVersion: z.number(),
    designVersion: z.number(),
    warnings: z.array(setPcrPolymeraseWarningsItemsSchema),
    revalidationRequired: z.boolean(),
    mutation: agentMutationClaimSchema,
    designId: z.string(),
    versionGuardApplied: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const setPcrPolymeraseNoopSchema = z
  .object({
    status: z.literal('noop'),
    polymerase: z.union([z.null(), polymeraseProjectionSchema]),
    previousPolymerase: z.union([z.null(), polymeraseProjectionSchema]),
    tmModel: z.union([
      z.null(),
      configurePrimerTmModelLocalSchema,
      configurePrimerTmModelNebSchema,
    ]),
    resolvedFrom: z.union([z.literal('prodcode'), z.literal('family'), z.literal('cleared')]),
    familyOptions: z.array(z.string()),
    previousVersion: z.number(),
    designVersion: z.number(),
    note: z.string(),
    designId: z.string(),
    revalidationRequired: z.boolean(),
    versionGuardApplied: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const setGoldenGateOffsetJunctionSchema = z
  .object({
    junctionId: z.union([z.null(), z.string()]),
    junctionIndex: z.number(),
    offset: z.number(),
    overhang: z.string(),
    overhangStart: z.number(),
    overhangEnd: z.number(),
    overhangSource: z.union([
      z.literal('rd-fixed'),
      z.literal('pcr-designed'),
      z.literal('pcr-matched-rd'),
    ]),
    offsetEditable: z.boolean(),
    isValid: z.boolean(),
    validationError: z.union([z.null(), z.string()]),
  })
  .strict();

const setGoldenGateOffsetAppliedSchema = z
  .object({
    status: z.literal('applied'),
    junctionIndex: z.number(),
    junctionId: z.string(),
    junctionCount: z.number(),
    offset: z.number(),
    previousOffset: z.number(),
    previousOverhang: z.string(),
    overhangChanged: z.boolean(),
    offsetLimitBp: z.number(),
    junction: setGoldenGateOffsetJunctionSchema,
    junctions: z.array(setGoldenGateOffsetJunctionSchema),
    duplicateOverhangs: z.array(z.string()),
    previousVersion: z.number(),
    designVersion: z.number(),
    appliedCommands: z.array(
      z.union([
        setJunctionSpacerAppliedCommandsItemsSelectJunctionSchema,
        setJunctionSpacerAppliedCommandsItemsSetAssemblyModeSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateEnzymeSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetLimitSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetSchema,
        setJunctionSpacerAppliedCommandsItemsSetHomologyEncodingSchema,
        setJunctionSpacerAppliedCommandsItemsSetJunctionSpacerSchema,
        setJunctionSpacerAppliedCommandsItemsSetSourceContributionBoundarySchema,
        setJunctionSpacerAppliedCommandsItemsSetPrimerPbsLengthSchema,
        setJunctionSpacerAppliedCommandsItemsSetPrimerOverhangLengthSchema,
        setJunctionSpacerAppliedCommandsItemsDraftAssemblySchema,
        setJunctionSpacerAppliedCommandsItemsApplyProposalSchema,
        setJunctionSpacerAppliedCommandsItemsCommandAutoOptimizeSchema,
      ])
    ),
    warnings: z.array(assemblyWorkbenchCommandWarningSchema),
    revalidationRequired: z.boolean(),
    mutation: agentMutationClaimSchema,
    designId: z.string(),
    versionGuardApplied: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const setGoldenGateOffsetNoopSchema = z
  .object({
    status: z.literal('noop'),
    junctionIndex: z.number(),
    junctionId: z.string(),
    junctionCount: z.number(),
    offset: z.number(),
    previousOffset: z.number(),
    overhangChanged: z.boolean(),
    offsetLimitBp: z.number(),
    junction: setGoldenGateOffsetJunctionSchema,
    junctions: z.array(setGoldenGateOffsetJunctionSchema),
    duplicateOverhangs: z.array(z.string()),
    designVersion: z.number(),
    previousVersion: z.number(),
    designId: z.string(),
    revalidationRequired: z.boolean(),
    versionGuardApplied: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const setPrimerOverhangLengthMutationExpectedSchema = z
  .object({
    primerId: z.string(),
    junctionIndex: z.number(),
    overhangLength: z.number(),
  })
  .strict();

const setPrimerOverhangLengthMutationTargetSchema = z
  .object({
    type: z.string(),
    id: z.string(),
  })
  .strict();

const setPrimerOverhangLengthMutationSchema = z
  .object({
    operationId: z.string(),
    toolName: z.string(),
    effect: z.string(),
    target: setPrimerOverhangLengthMutationTargetSchema,
    resourceUri: z.string(),
    beforeVersion: z.number(),
    afterVersion: z.number(),
    changed: z.boolean(),
    expected: setPrimerOverhangLengthMutationExpectedSchema,
  })
  .strict();

const setPrimerOverhangLengthWarningsItemsSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .strict();

const setPrimerOverhangLengthHomologySchema = z
  .object({
    junctionIndex: z.number(),
    onLeft: z.number(),
    onRight: z.number(),
    tmEstimate: z.union([z.null(), z.number()]),
    gcContent: z.union([z.null(), z.number()]),
  })
  .strict();

const setPrimerOverhangLengthPrimerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    direction: z.union([z.literal('reverse'), z.literal('forward')]),
    fragmentIndex: z.number(),
    junctionIndex: z.union([z.null(), z.number()]),
    overhangLength: z.number(),
    annealingLength: z.number(),
    overhangSequence: z.string(),
    pbsLength: z.number(),
    pbsSequence: z.string(),
    sequence: z.string(),
    tm: z.union([z.null(), z.number()]),
  })
  .strict();

const setPrimerOverhangLengthAppliedSchema = z
  .object({
    status: z.literal('applied'),
    junctionIndex: z.number(),
    requestedLength: z.number(),
    previousOverhangLength: z.number(),
    primer: z.union([z.null(), setPrimerOverhangLengthPrimerSchema]),
    partnerPrimer: z.union([z.null(), setPrimerOverhangLengthPrimerSchema]),
    homology: z.union([z.null(), setPrimerOverhangLengthHomologySchema]),
    previousHomology: z.union([z.null(), setPrimerOverhangLengthHomologySchema]),
    previousVersion: z.number(),
    designVersion: z.number(),
    appliedCommands: z.array(
      z.union([
        setJunctionSpacerAppliedCommandsItemsSelectJunctionSchema,
        setJunctionSpacerAppliedCommandsItemsSetAssemblyModeSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateEnzymeSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetLimitSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetSchema,
        setJunctionSpacerAppliedCommandsItemsSetHomologyEncodingSchema,
        setJunctionSpacerAppliedCommandsItemsSetJunctionSpacerSchema,
        setJunctionSpacerAppliedCommandsItemsSetSourceContributionBoundarySchema,
        setJunctionSpacerAppliedCommandsItemsSetPrimerPbsLengthSchema,
        setJunctionSpacerAppliedCommandsItemsSetPrimerOverhangLengthSchema,
        setJunctionSpacerAppliedCommandsItemsDraftAssemblySchema,
        setJunctionSpacerAppliedCommandsItemsApplyProposalSchema,
        setJunctionSpacerAppliedCommandsItemsCommandAutoOptimizeSchema,
      ])
    ),
    warnings: z.array(setPrimerOverhangLengthWarningsItemsSchema),
    revalidationRequired: z.boolean(),
    mutation: setPrimerOverhangLengthMutationSchema,
    designId: z.string(),
    versionGuardApplied: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const setPrimerPbsLengthPrimerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    fragmentIndex: z.number(),
    direction: z.union([z.literal('reverse'), z.literal('forward')]),
    junctionIndex: z.union([z.null(), z.number()]),
    pbsLength: z.number(),
    pbsSequence: z.string(),
    sequence: z.string(),
    tm: z.union([z.null(), z.number()]),
  })
  .strict();

const setPrimerPbsLengthAppliedSchema = z
  .object({
    status: z.literal('applied'),
    primer: z.union([z.null(), setPrimerPbsLengthPrimerSchema]),
    previousPbsLength: z.number(),
    appliedLength: z.number(),
    changed: z.boolean(),
    fragmentCount: z.number(),
    previousVersion: z.number(),
    designVersion: z.number(),
    appliedCommands: z.array(
      z.union([
        setJunctionSpacerAppliedCommandsItemsSelectJunctionSchema,
        setJunctionSpacerAppliedCommandsItemsSetAssemblyModeSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateEnzymeSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetLimitSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetSchema,
        setJunctionSpacerAppliedCommandsItemsSetHomologyEncodingSchema,
        setJunctionSpacerAppliedCommandsItemsSetJunctionSpacerSchema,
        setJunctionSpacerAppliedCommandsItemsSetSourceContributionBoundarySchema,
        setJunctionSpacerAppliedCommandsItemsSetPrimerPbsLengthSchema,
        setJunctionSpacerAppliedCommandsItemsSetPrimerOverhangLengthSchema,
        setJunctionSpacerAppliedCommandsItemsDraftAssemblySchema,
        setJunctionSpacerAppliedCommandsItemsApplyProposalSchema,
        setJunctionSpacerAppliedCommandsItemsCommandAutoOptimizeSchema,
      ])
    ),
    warnings: z.array(assemblyWorkbenchCommandWarningSchema),
    revalidationRequired: z.boolean(),
    mutation: agentMutationClaimSchema,
    validLengthRange: z.tuple([z.number(), z.number()]).optional(),
    designId: z.string(),
    requestedLength: z.number(),
    versionGuardApplied: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const virtualDigestFragmentsItemsInternalSitesItemsSchema = z
  .object({
    position: z.number(),
    orientation: z.union([z.literal('reverse'), z.literal('forward')]),
  })
  .strict();

const virtualDigestFragmentsItemsUpstreamRdEndSchema = z
  .object({
    overhang: z.union([z.null(), z.string()]),
    overhangType: z.union([
      z.null(),
      z.literal('blunt'),
      z.literal('5_prime'),
      z.literal('3_prime'),
    ]),
    recognitionSequence: z.union([z.null(), z.string()]),
    recognitionStart: z.union([z.null(), z.number()]),
    recognitionEnd: z.union([z.null(), z.number()]),
    cutPositionTop: z.union([z.null(), z.number()]),
    cutPositionBottom: z.union([z.null(), z.number()]),
    strand: z.union([z.null(), z.literal('reverse'), z.literal('forward')]),
    retainedScarSequence: z.union([z.null(), z.string()]),
  })
  .strict();

const virtualDigestFragmentsItemsUpstreamSchema = z
  .object({
    overhang: z.string(),
    enzymeName: z.string(),
    enzymeNames: z.array(z.string()),
    sitePosition: z.union([z.null(), z.number()]),
    siteOrientation: z.union([z.null(), z.literal('reverse'), z.literal('forward')]),
    rdEnd: z.union([z.null(), virtualDigestFragmentsItemsUpstreamRdEndSchema]),
  })
  .strict();

const virtualDigestFragmentsItemsSchema = z
  .object({
    fragmentIndex: z.number(),
    fragmentCandidateId: z.string(),
    startPosition: z.number(),
    endPosition: z.number(),
    start1: z.number(),
    end1: z.number(),
    length: z.number(),
    wrapsOrigin: z.boolean(),
    ggType: z.union([
      z.literal('rd'),
      z.literal('insert'),
      z.literal('backbone'),
      z.literal('unusable'),
    ]),
    upstream: virtualDigestFragmentsItemsUpstreamSchema,
    downstream: virtualDigestFragmentsItemsUpstreamSchema,
    annotations: z.array(z.string()),
    primaryAnnotation: z.union([z.null(), z.string()]),
    internalSites: z.array(virtualDigestFragmentsItemsInternalSitesItemsSchema),
    hasInternalSites: z.boolean(),
  })
  .strict();

const virtualDigestDiagnosticAffectedEndSchema = z
  .object({
    fragmentIndex: z.number(),
    end: z.union([z.literal('upstream'), z.literal('downstream')]),
  })
  .strict();

const virtualDigestDiagnosticSchema = z
  .object({
    id: z.string(),
    scope: z.union([z.literal('goldengate'), z.literal('physical-digest')]),
    kind: z.union([
      z.literal('no-cut-sites'),
      z.literal('goldengate-invalid-pair'),
      z.literal('goldengate-extra-sites'),
      z.literal('goldengate-duplicate-overhang'),
    ]),
    severity: z.union([z.literal('error'), z.literal('warning'), z.literal('info')]),
    message: z.string(),
    overhang: z.string().optional(),
    junctionIndices: z.array(z.number()).optional(),
    fragmentIndices: z.array(z.number()).optional(),
    affectedEnds: z.array(virtualDigestDiagnosticAffectedEndSchema).optional(),
  })
  .strict();

const virtualDigestSchema = z
  .object({
    digestSnapshotId: z.string(),
    sequenceName: z.string(),
    sequenceLength: z.number(),
    topology: z.string(),
    topologyAssumed: z.boolean(),
    enzymeNames: z.array(z.string()),
    digestKind: z.union([z.literal('goldengate'), z.literal('restriction')]),
    cutSiteCount: z.number(),
    overhangLength: z.number(),
    ggStatus: z.union([
      z.literal('ready'),
      z.literal('ready-with-warning'),
      z.literal('not-ready'),
    ]),
    warning: z.union([z.null(), z.string()]),
    diagnostics: z.array(virtualDigestDiagnosticSchema),
    fragmentCount: z.number(),
    fragments: z.array(virtualDigestFragmentsItemsSchema),
    documentId: z.string(),
    resourceUri: z.string(),
    ok: z.literal(true),
  })
  .strict();

const goldenGateRoleTermSchema = z
  .object({
    id: z.string().optional(),
    label: z.string(),
  })
  .strict();

const goldenGateRoleEvidenceSchema = z
  .object({
    source: z.string(),
    id: z.string().optional(),
    label: z.string(),
  })
  .strict();

const searchMocloPartsCandidatesItemsCompatibilityRoleMismatchSchema = z
  .object({
    type: z.literal('mismatch'),
    preferredRoles: z.array(goldenGateRoleTermSchema),
    observedRoles: z.array(goldenGateRoleEvidenceSchema),
  })
  .strict();

const searchMocloPartsCandidatesItemsCompatibilityRoleUnknownSchema = z
  .object({
    type: z.literal('unknown'),
    preferredRoles: z.array(goldenGateRoleTermSchema),
  })
  .strict();

const searchMocloPartsCandidatesItemsCompatibilityRoleMatchSchema = z
  .object({
    type: z.literal('match'),
    matchedPreferredRole: goldenGateRoleTermSchema,
    matchedEvidence: goldenGateRoleEvidenceSchema,
  })
  .strict();

const searchMocloPartsCandidatesItemsCompatibilityRoleUnconstrainedSchema = z
  .object({
    type: z.literal('unconstrained'),
  })
  .strict();

const searchMocloPartsCandidatesItemsCompatibilityPhysicalMismatchesItemsSchema = z
  .object({
    end: z.union([z.literal('upstream'), z.literal('downstream')]),
    expected: z.string(),
    actual: z.union([z.null(), z.string()]),
  })
  .strict();

const searchMocloPartsCandidatesItemsCompatibilityPhysicalIncompatibleSchema = z
  .object({
    type: z.literal('incompatible'),
    mismatches: z.array(searchMocloPartsCandidatesItemsCompatibilityPhysicalMismatchesItemsSchema),
  })
  .strict();

const searchMocloPartsCandidatesItemsCompatibilityPhysicalPcrAdaptableSchema = z
  .object({
    type: z.literal('pcr-adaptable'),
    requiredUpstreamOverhang: z.union([z.null(), z.string()]),
    requiredDownstreamOverhang: z.union([z.null(), z.string()]),
  })
  .strict();

const searchMocloPartsCandidatesItemsCompatibilityPhysicalExactSchema = z
  .object({
    type: z.literal('exact'),
  })
  .strict();

const goldenGateCandidateCompatibilitySchema = z
  .object({
    physical: z.union([
      searchMocloPartsCandidatesItemsCompatibilityPhysicalExactSchema,
      searchMocloPartsCandidatesItemsCompatibilityPhysicalPcrAdaptableSchema,
      searchMocloPartsCandidatesItemsCompatibilityPhysicalIncompatibleSchema,
    ]),
    role: z.union([
      searchMocloPartsCandidatesItemsCompatibilityRoleUnconstrainedSchema,
      searchMocloPartsCandidatesItemsCompatibilityRoleMatchSchema,
      searchMocloPartsCandidatesItemsCompatibilityRoleUnknownSchema,
      searchMocloPartsCandidatesItemsCompatibilityRoleMismatchSchema,
    ]),
  })
  .strict();

const searchMocloPartsCandidatesItemsFragmentSchema = z
  .object({
    index: z.number(),
    length: z.number(),
    upstreamOverhang: z.union([z.null(), z.string()]),
    downstreamOverhang: z.union([z.null(), z.string()]),
    hasInternalSites: z.boolean(),
  })
  .strict();

const searchMocloPartsCandidatesItemsKitSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();

const searchMocloPartsCandidatesItemsComponentLabelSchema = z
  .object({
    text: z.string(),
    source: z.union([z.literal('annotation'), z.literal('record-description')]),
  })
  .strict();

const searchMocloPartsCandidatesItemsSchema = z
  .object({
    candidateId: z.string(),
    name: z.string(),
    componentLabel: z.union([z.null(), searchMocloPartsCandidatesItemsComponentLabelSchema]),
    documentId: z.string(),
    resourceUri: z.string(),
    kit: z.union([z.null(), searchMocloPartsCandidatesItemsKitSchema]),
    kitMemberId: z.union([z.null(), z.string()]),
    kitPartTypeId: z.union([z.null(), z.string()]),
    fragment: searchMocloPartsCandidatesItemsFragmentSchema,
    roleEvidence: z.array(goldenGateRoleEvidenceSchema),
    compatibility: goldenGateCandidateCompatibilitySchema,
  })
  .strict();

const searchMocloPartsSlotSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    preferredRoles: z.array(goldenGateRoleTermSchema),
  })
  .strict();

const mocloFactoryStageInputSchema = z
  .object({
    slotId: z.string(),
    sourceStageId: z.string(),
  })
  .strict();

const mocloFactoryDesignContextSchema = z
  .object({
    runId: z.string(),
    kitId: z.string(),
    kitRevision: z.number(),
    recipeId: z.string(),
    stageId: z.string(),
    stageInputs: z.array(mocloFactoryStageInputSchema),
  })
  .strict();

const searchMocloPartsReadySchema = z
  .object({
    status: z.literal('ready'),
    designId: z.string(),
    designVersion: z.number(),
    factory: mocloFactoryDesignContextSchema.optional(),
    enzyme: z.union([z.literal('BsaI'), z.literal('BbsI'), z.literal('BsmBI'), z.literal('SapI')]),
    slot: searchMocloPartsSlotSchema,
    targetSlot: assemblySlotViewSchema,
    resultCount: z.number(),
    totalMatched: z.number(),
    skippedSourceCount: z.number(),
    candidates: z.array(searchMocloPartsCandidatesItemsSchema),
    nextAction: z.string(),
    ok: z.literal(true),
  })
  .strict();

const getDesignGoldenGateSchemaOriginCustomSchema = z
  .object({
    type: z.literal('custom'),
  })
  .strict();

const getDesignGoldenGateSchemaOriginKitSchema = z
  .object({
    type: z.literal('kit'),
    kitId: z.string(),
    kitName: z.string(),
    schemaId: z.string().optional(),
  })
  .strict();

const getDesignGoldenGateSchemaOriginImportedSchema = z
  .object({
    type: z.literal('imported'),
    sourceLabel: z.string(),
  })
  .strict();

const goldenGateSchemaSlotSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    outgoingOverhang: z.union([z.null(), z.string()]),
    preferredRoles: z.array(goldenGateRoleTermSchema),
  })
  .strict();

const goldenGateAssemblySchemaSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    revision: z.number(),
    origin: z.union([
      getDesignGoldenGateSchemaOriginCustomSchema,
      getDesignGoldenGateSchemaOriginKitSchema,
      getDesignGoldenGateSchemaOriginImportedSchema,
    ]),
    enzyme: z.union([z.literal('BsaI'), z.literal('BbsI'), z.literal('BsmBI'), z.literal('SapI')]),
    slots: z.array(goldenGateSchemaSlotSchema),
  })
  .strict();

const applyMocloSchemaSchema = z
  .object({
    status: z.union([z.literal('applied'), z.literal('no-op')]),
    designId: z.string(),
    previousVersion: z.number(),
    designVersion: z.number(),
    schema: goldenGateAssemblySchemaSchema,
    slotCount: z.number(),
    mutation: agentMutationClaimSchema,
    ok: z.literal(true),
  })
  .strict();

const setMocloFactoryStageStageSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    enzyme: z.union([z.literal('BsaI'), z.literal('BbsI'), z.literal('BsmBI'), z.literal('SapI')]),
    slotCount: z.number(),
    inputsFromStages: z.array(z.string()),
  })
  .strict();

const setMocloFactoryStageRecipeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();

const setMocloFactoryStageKitSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    revision: z.number(),
  })
  .strict();

const setMocloFactoryStageSchema = z
  .object({
    status: z.union([z.literal('applied'), z.literal('no-op')]),
    designId: z.string(),
    previousVersion: z.number(),
    designVersion: z.number(),
    runId: z.string(),
    kit: setMocloFactoryStageKitSchema,
    recipe: setMocloFactoryStageRecipeSchema,
    stage: setMocloFactoryStageStageSchema,
    mutation: agentMutationClaimSchema,
    ok: z.literal(true),
  })
  .strict();

const saveMocloKitSavedSchema = z
  .object({
    status: z.literal('saved'),
    kitId: z.string(),
    kitRevision: z.number(),
    contentHash: z.string(),
    ok: z.literal(true),
  })
  .strict();

const getMocloKitKitsItemsSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    revision: z.number(),
    description: z.string(),
    memberCount: z.number(),
    schemaCount: z.number(),
  })
  .strict();

const getMocloKitReadyVariant11Schema = z
  .object({
    status: z.literal('ready'),
    kits: z.array(getMocloKitKitsItemsSchema),
    ok: z.literal(true),
  })
  .strict();

const mocloKitAssemblySchemaSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    enzyme: z.union([z.literal('BsaI'), z.literal('BbsI'), z.literal('BsmBI'), z.literal('SapI')]),
    topology: z.union([z.literal('circular'), z.literal('linear')]),
    slots: z.array(goldenGateSchemaSlotSchema),
  })
  .strict();

const getMocloFactoryKitsItemsRecipesItemsStagesItemsSlotsItemsInputKitPartSchema = z
  .object({
    kind: z.literal('kit-part'),
  })
  .strict();

const getMocloFactoryKitsItemsRecipesItemsStagesItemsSlotsItemsInputStageOutputSchema = z
  .object({
    kind: z.literal('stage-output'),
    stageId: z.string(),
  })
  .strict();

const mocloKitStageSlotSchema = z
  .object({
    input: z.union([
      getMocloFactoryKitsItemsRecipesItemsStagesItemsSlotsItemsInputKitPartSchema,
      getMocloFactoryKitsItemsRecipesItemsStagesItemsSlotsItemsInputStageOutputSchema,
    ]),
    id: z.string(),
    label: z.string(),
    outgoingOverhang: z.union([z.null(), z.string()]),
    preferredRoles: z.array(goldenGateRoleTermSchema),
  })
  .strict();

const mocloKitStageDefinitionSchema = z
  .object({
    outputRole: goldenGateRoleTermSchema,
    slots: z.array(mocloKitStageSlotSchema),
    description: z.string(),
    id: z.string(),
    name: z.string(),
    topology: z.union([z.literal('circular'), z.literal('linear')]),
    enzyme: z.union([z.literal('BsaI'), z.literal('BbsI'), z.literal('BsmBI'), z.literal('SapI')]),
  })
  .strict();

const mocloKitRecipeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    stages: z.array(mocloKitStageDefinitionSchema),
  })
  .strict();

const mocloKitMemberSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    sequencePackageId: z.string(),
    partTypeId: z.string().optional(),
  })
  .strict();

const mocloKitPartTypeSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    roleTerms: z.array(goldenGateRoleTermSchema),
  })
  .strict();

const mocloKitCitationSchema = z
  .object({
    label: z.string(),
    doi: z.string().optional(),
    pmid: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

const mocloKitDefinitionSchema = z
  .object({
    schema: z.literal('dnaforge.moclo-kit'),
    formatVersion: z.literal(3),
    id: z.string(),
    name: z.string(),
    revision: z.number(),
    description: z.string(),
    citations: z.array(mocloKitCitationSchema),
    partTypes: z.array(mocloKitPartTypeSchema),
    members: z.array(mocloKitMemberSchema),
    recipes: z.array(mocloKitRecipeSchema),
    assemblySchemas: z.array(mocloKitAssemblySchemaSchema),
  })
  .strict();

const getMocloKitReadySchema = z
  .object({
    status: z.literal('ready'),
    kit: mocloKitDefinitionSchema,
    ok: z.literal(true),
  })
  .strict();

const saveMocloSchemaSavedSchema = z
  .object({
    path: z.string(),
    contentHash: z.string(),
    cleanupWarning: z.string().optional(),
    kitId: z.string(),
    kitRevision: z.number(),
    schemaId: z.string(),
    status: z.literal('saved'),
    designId: z.string(),
    designVersion: z.number(),
    ok: z.literal(true),
  })
  .strict();

const listMocloSchemasSchemasItemsSchema = z
  .object({
    kitId: z.string(),
    kitName: z.string(),
    kitRevision: z.number(),
    schemaId: z.string(),
    recipeId: z.string().optional(),
    recipeName: z.string().optional(),
    stageId: z.string().optional(),
    name: z.string(),
    enzyme: z.union([z.literal('BsaI'), z.literal('BbsI'), z.literal('BsmBI'), z.literal('SapI')]),
    topology: z.union([z.literal('circular'), z.literal('linear')]),
    slotCount: z.number(),
    slots: z.array(goldenGateSchemaSlotSchema),
  })
  .strict();

const listMocloSchemasKitsItemsSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    revision: z.number(),
  })
  .strict();

const listMocloSchemasReadySchema = z
  .object({
    status: z.literal('ready'),
    designId: z.string(),
    designVersion: z.number(),
    currentSchema: z.union([z.null(), goldenGateAssemblySchemaSchema]),
    kits: z.array(listMocloSchemasKitsItemsSchema),
    schemas: z.array(listMocloSchemasSchemasItemsSchema),
    ok: z.literal(true),
  })
  .strict();

const getMocloFactoryKitsItemsRecipesItemsStagesItemsSlotsItemsSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    outgoingOverhang: z.union([z.null(), z.string()]),
    preferredRoles: z.array(goldenGateRoleTermSchema),
    input: z.union([
      getMocloFactoryKitsItemsRecipesItemsStagesItemsSlotsItemsInputKitPartSchema,
      getMocloFactoryKitsItemsRecipesItemsStagesItemsSlotsItemsInputStageOutputSchema,
    ]),
  })
  .strict();

const getMocloFactoryKitsItemsRecipesItemsStagesItemsSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    stageNumber: z.number(),
    enzyme: z.union([z.literal('BsaI'), z.literal('BbsI'), z.literal('BsmBI'), z.literal('SapI')]),
    topology: z.union([z.literal('circular'), z.literal('linear')]),
    outputRole: goldenGateRoleTermSchema,
    slotCount: z.number(),
    inputsFromStages: z.array(z.string()),
    slots: z.array(getMocloFactoryKitsItemsRecipesItemsStagesItemsSlotsItemsSchema),
  })
  .strict();

const getMocloFactoryKitsItemsRecipesItemsSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    stages: z.array(getMocloFactoryKitsItemsRecipesItemsStagesItemsSchema),
  })
  .strict();

const getMocloFactoryKitsItemsPartTypesItemsSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    roleTerms: z.array(goldenGateRoleTermSchema),
  })
  .strict();

const getMocloFactoryKitsItemsSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    revision: z.number(),
    description: z.string(),
    memberCount: z.number(),
    partTypes: z.array(getMocloFactoryKitsItemsPartTypesItemsSchema),
    citations: z.array(mocloKitCitationSchema),
    recipes: z.array(getMocloFactoryKitsItemsRecipesItemsSchema),
  })
  .strict();

const getMocloFactoryReadySchema = z
  .object({
    status: z.literal('ready'),
    designId: z.string(),
    designVersion: z.number(),
    workspaceRoot: z.string(),
    current: z.union([z.null(), mocloFactoryDesignContextSchema]),
    kits: z.array(getMocloFactoryKitsItemsSchema),
    ok: z.literal(true),
  })
  .strict();

const setGoldenGateSchemaSchema = z
  .object({
    status: z.union([z.literal('applied'), z.literal('no-op')]),
    designId: z.string(),
    previousVersion: z.number(),
    designVersion: z.number(),
    schema: goldenGateAssemblySchemaSchema,
    slotCount: z.number(),
    revalidationRequired: z.boolean(),
    mutation: agentMutationClaimSchema,
    ok: z.literal(true),
  })
  .strict();

const setJunctionSpacerReplacedSchema = z
  .object({
    previousSequence: z.string(),
    previousName: z.union([z.null(), z.string()]),
  })
  .strict();

const setJunctionSpacerSpacerSchema = z
  .object({
    id: z.string(),
    junctionIndex: z.number(),
    sequence: z.string(),
    name: z.union([z.null(), z.string()]),
  })
  .strict();

const setJunctionSpacerAppliedSchema = z
  .object({
    status: z.literal('applied'),
    junctionIndex: z.number(),
    junctionCount: z.number(),
    spacer: z.union([z.null(), setJunctionSpacerSpacerSchema]),
    replaced: z.union([z.null(), setJunctionSpacerReplacedSchema]),
    replacedSpacers: z.array(z.union([z.null(), setJunctionSpacerSpacerSchema])),
    previousVersion: z.number(),
    designVersion: z.number(),
    appliedCommands: z.array(
      z.union([
        setJunctionSpacerAppliedCommandsItemsSelectJunctionSchema,
        setJunctionSpacerAppliedCommandsItemsSetAssemblyModeSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateEnzymeSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetLimitSchema,
        setJunctionSpacerAppliedCommandsItemsSetGoldenGateOffsetSchema,
        setJunctionSpacerAppliedCommandsItemsSetHomologyEncodingSchema,
        setJunctionSpacerAppliedCommandsItemsSetJunctionSpacerSchema,
        setJunctionSpacerAppliedCommandsItemsSetSourceContributionBoundarySchema,
        setJunctionSpacerAppliedCommandsItemsSetPrimerPbsLengthSchema,
        setJunctionSpacerAppliedCommandsItemsSetPrimerOverhangLengthSchema,
        setJunctionSpacerAppliedCommandsItemsDraftAssemblySchema,
        setJunctionSpacerAppliedCommandsItemsApplyProposalSchema,
        setJunctionSpacerAppliedCommandsItemsCommandAutoOptimizeSchema,
      ])
    ),
    warnings: z.array(assemblyWorkbenchCommandWarningSchema),
    revalidationRequired: z.boolean(),
    mutation: agentMutationClaimSchema,
    designId: z.string(),
    versionGuardApplied: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const setJunctionSpacerNoopSchema = z
  .object({
    status: z.literal('noop'),
    junctionIndex: z.number(),
    junctionCount: z.number(),
    spacer: z.union([z.null(), setJunctionSpacerSpacerSchema]),
    replacedSpacers: z.array(z.never()).max(0),
    previousVersion: z.number(),
    designVersion: z.number(),
    warnings: z.array(assemblyWorkbenchCommandWarningSchema),
    revalidationRequired: z.boolean(),
    designId: z.string(),
    replaced: z.null(),
    versionGuardApplied: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const reopenAcceptedAssemblyCompletedSchema = z
  .object({
    status: z.literal('completed'),
    idempotentReplay: z.boolean(),
    constructId: z.string(),
    parentAcceptedAssemblyVersionId: z.string(),
    designId: z.string(),
    draftPath: z.string(),
    resourceUri: z.string(),
    openTabRequired: z.literal(true),
    ok: z.literal(true),
  })
  .strict();

const finalizeDesignAssemblySchema = z
  .object({
    status: z.string(),
    idempotentReplay: z.boolean(),
    constructId: z.string(),
    acceptedAssemblyVersionId: z.string(),
    canonicalDraftChecksum: z.string(),
    productSequenceVersionId: z.string(),
    productSequenceChecksum: z.string(),
    productGenBankChecksum: z.union([z.null(), z.string()]),
    historyState: z.string(),
    gitCommitSha: z.union([z.null(), z.string()]),
    openTabRequired: z.boolean(),
    acceptedRevision: scientificAcceptedRevisionSchema.optional(),
    acceptedAssemblyResourceId: z.string().optional(),
    ok: z.literal(true),
  })
  .strict();

const previewFinalizeDesignAssemblyBlockersItemsSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .strict();

const previewFinalizeDesignAssemblyVariant10Schema = z
  .object({
    canFinalize: z.boolean(),
    designId: z.string(),
    expectedDesignVersion: z.number(),
    blockers: z.array(previewFinalizeDesignAssemblyBlockersItemsSchema),
    warnings: z.array(z.never()).max(0),
    ok: z.literal(true),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsInternalSitesItemsSchema = z
  .object({
    start: z.number(),
    end: z.number(),
    strand: z.union([z.literal('reverse'), z.literal('forward')]),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsSchema = z
  .object({
    surface: z.literal('design-drawer'),
    refId: z.string(),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant4Schema = z
  .object({
    surface: z.literal('part-card'),
    regionId: z.string(),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant5Schema = z
  .object({
    surface: z.literal('junction-card'),
    junctionIndex: z.number(),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant6Schema = z
  .object({
    surface: z.literal('workbench-junction-card'),
    junctionIndex: z.number(),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant7Schema = z
  .object({
    surface: z.literal('primer-row'),
    primerId: z.string().optional(),
    fragmentIndex: z.number(),
    direction: z.union([z.literal('reverse'), z.literal('forward')]),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant8Schema = z
  .object({
    surface: z.literal('digest-panel'),
    fragmentId: z.string().optional(),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant9Schema = z
  .object({
    surface: z.literal('export-card'),
    refId: z.string(),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsActionsItemsSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    anchor: z
      .union([
        previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsSchema,
        previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant4Schema,
        previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant5Schema,
        previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant6Schema,
        previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant7Schema,
        previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant8Schema,
        previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant9Schema,
      ])
      .optional(),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsScopeExportSchema = z
  .object({
    type: z.literal('export'),
    designId: z.string(),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsScopeDigestPreviewSchema = z
  .object({
    type: z.literal('digest-preview'),
    sequenceId: z.string(),
    fragmentId: z.string().optional(),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsScopePrimerSchema = z
  .object({
    type: z.literal('primer'),
    designId: z.string(),
    primerId: z.string().optional(),
    fragmentIndex: z.number(),
    direction: z.union([z.literal('reverse'), z.literal('forward')]),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsScopeJunctionSchema = z
  .object({
    type: z.literal('junction'),
    designId: z.string(),
    junctionIndex: z.number(),
    leftRegionId: z.string().optional(),
    rightRegionId: z.string().optional(),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsScopePartSchema = z
  .object({
    type: z.literal('part'),
    designId: z.string(),
    regionId: z.string(),
    fragmentIndex: z.number(),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsScopeAssemblySchema = z
  .object({
    type: z.literal('assembly'),
    designId: z.string(),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsGatesSchema = z
  .object({
    run: z.boolean(),
    finalize: z.boolean(),
    export: z.boolean(),
  })
  .strict();

const previewFinalizeDesignAssemblyWarningsItemsSchema = z
  .object({
    id: z.string(),
    dedupeKey: z.string(),
    kind: z.union([
      z.literal('assembly-topology-unsupported'),
      z.literal('assembly-min-fragments'),
      z.literal('assembly-empty-part'),
      z.literal('spacer-duplicate-junction'),
      z.literal('gibson-rd-rd-junction'),
      z.literal('gg-internal-site'),
      z.literal('gg-overhang-mismatch'),
      z.literal('gg-self-ligation'),
      z.literal('gg-duplicate-overhang'),
      z.literal('gg-rd-enzyme-mismatch'),
      z.literal('gg-rd-enzyme-unknown'),
      z.literal('gg-rd-polarity-unsupported'),
      z.literal('gg-rd-cut-site-mismatch'),
      z.literal('gg-rd-spacer-unsupported'),
      z.literal('gg-junction-invalid'),
      z.literal('gg-invalid-pair'),
      z.literal('gg-extra-sites'),
      z.literal('homology-length-out-of-range'),
      z.literal('homology-length-suboptimal'),
      z.literal('homology-tm-suboptimal'),
      z.literal('homology-gc-suboptimal'),
      z.literal('primer-pbs-out-of-range'),
      z.literal('primer-pbs-suboptimal'),
      z.literal('digest-no-cut-sites'),
      z.literal('digest-duplicate-overhang'),
      z.literal('export-missing-workspace'),
      z.literal('export-not-validated'),
      z.literal('export-finalize-failed'),
    ]),
    legacyCode: z.string(),
    severity: z.union([z.literal('error'), z.literal('warning'), z.literal('info')]),
    gates: previewFinalizeDesignAssemblyWarningsItemsGatesSchema,
    source: z.union([
      z.literal('finalize'),
      z.literal('dispatcher-validation'),
      z.literal('workbench-finding'),
      z.literal('workbench-command'),
      z.literal('virtual-digest'),
      z.literal('accepted-assembly'),
    ]),
    lifecycle: z.union([z.literal('committed'), z.literal('provisional')]),
    scope: z.union([
      previewFinalizeDesignAssemblyWarningsItemsScopeAssemblySchema,
      previewFinalizeDesignAssemblyWarningsItemsScopePartSchema,
      previewFinalizeDesignAssemblyWarningsItemsScopeJunctionSchema,
      previewFinalizeDesignAssemblyWarningsItemsScopePrimerSchema,
      previewFinalizeDesignAssemblyWarningsItemsScopeDigestPreviewSchema,
      previewFinalizeDesignAssemblyWarningsItemsScopeExportSchema,
    ]),
    anchors: z.array(
      z.union([
        previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsSchema,
        previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant4Schema,
        previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant5Schema,
        previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant6Schema,
        previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant7Schema,
        previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant8Schema,
        previewFinalizeDesignAssemblyWarningsItemsAnchorsItemsVariant9Schema,
      ])
    ),
    title: z.string(),
    shortMessage: z.string(),
    detail: z.string(),
    actions: z.array(previewFinalizeDesignAssemblyWarningsItemsActionsItemsSchema),
    sortKey: z.string(),
    internalSites: z
      .array(previewFinalizeDesignAssemblyWarningsItemsInternalSitesItemsSchema)
      .optional(),
  })
  .strict();

const previewFinalizeDesignAssemblySourcesItemsSchema = z
  .object({
    regionId: z.string(),
    sourceSequenceId: z.string(),
    sourceConstructId: z.union([z.null(), z.string()]),
    sourceSequenceVersionId: z.union([z.null(), z.string()]),
    checksum: z.union([z.null(), z.string()]),
  })
  .strict();

const previewFinalizeDesignAssemblySchema = z
  .object({
    createsNewConstruct: z.boolean().optional(),
    designId: z.string(),
    expectedDesignVersion: z.number(),
    constructId: z.string(),
    previewFingerprint: z.string(),
    issuedAt: z.string(),
    expiresAt: z.string(),
    canonicalDraftChecksum: z.string(),
    productSequenceChecksum: z.string(),
    productGenBankChecksum: z.string(),
    sources: z.array(previewFinalizeDesignAssemblySourcesItemsSchema),
    blockers: z.array(z.never()).max(0),
    warnings: z.array(previewFinalizeDesignAssemblyWarningsItemsSchema),
    canFinalize: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const stageHistoricalAssemblyComponentsSchema = z
  .object({
    constructId: z.string(),
    designId: z.string(),
    designVersion: z.number(),
    stagedCount: z.number(),
    ok: z.literal(true),
  })
  .strict();

const inspectHistoricalAssemblyStageTargetTargetsItemsRegionSchema = z
  .object({
    kind: z.literal('region'),
    regionId: z.string(),
  })
  .strict();

const inspectHistoricalAssemblyStageTargetTargetsItemsSchema = z
  .object({
    kind: z.union([z.literal('join'), z.literal('spacer')]),
    leftRegionId: z.string(),
    rightRegionId: z.string(),
  })
  .strict();

const inspectHistoricalAssemblyStageTargetTargetsItemsPrimerPairSchema = z
  .object({
    kind: z.literal('primer-pair'),
    regionId: z.string(),
  })
  .strict();

const publicTargetSchema = z
  .object({
    constructId: z.string(),
    baseAcceptedAssemblyVersionId: z.string(),
    exists: z.boolean(),
    designId: z.string(),
    designVersion: z.number(),
    draftDigest: z.string(),
    targets: z.array(
      z.union([
        inspectHistoricalAssemblyStageTargetTargetsItemsRegionSchema,
        inspectHistoricalAssemblyStageTargetTargetsItemsSchema,
        inspectHistoricalAssemblyStageTargetTargetsItemsPrimerPairSchema,
      ])
    ),
  })
  .strict();

const previewHistoricalAssemblyComponentStageReadySchema = z
  .object({
    target: publicTargetSchema,
    status: z.literal('ready'),
    nextDesignVersion: z.number(),
    ok: z.literal(true),
  })
  .strict();

const previewHistoricalAssemblyComponentStageBlockedSchema = z
  .object({
    status: z.literal('blocked'),
    reason: z.string(),
    ok: z.literal(true),
  })
  .strict();

const inspectHistoricalAssemblyStageTargetSchema = z
  .object({
    constructId: z.string(),
    baseAcceptedAssemblyVersionId: z.string(),
    exists: z.boolean(),
    designId: z.string(),
    designVersion: z.number(),
    draftDigest: z.string(),
    targets: z.array(
      z.union([
        inspectHistoricalAssemblyStageTargetTargetsItemsRegionSchema,
        inspectHistoricalAssemblyStageTargetTargetsItemsSchema,
        inspectHistoricalAssemblyStageTargetTargetsItemsPrimerPairSchema,
      ])
    ),
    ok: z.literal(true),
  })
  .strict();

const listHistoricalAssemblyComponentsUnavailableItemsSchema = z
  .object({
    acceptedAssemblyVersionId: z.string(),
    reason: z.string(),
  })
  .strict();

const listHistoricalAssemblyComponentsComponentsItemsPrimerPairSchema = z
  .object({
    acceptedAssemblyVersionId: z.string(),
    canonicalDraftChecksum: z.string(),
    componentId: z.string(),
    componentDigest: z.string(),
    kind: z.literal('primer-pair'),
    regionId: z.string(),
    directions: z.tuple([z.literal('forward'), z.literal('reverse')]),
  })
  .strict();

const listHistoricalAssemblyComponentsComponentsItemsJoinSchema = z
  .object({
    acceptedAssemblyVersionId: z.string(),
    canonicalDraftChecksum: z.string(),
    componentId: z.string(),
    componentDigest: z.string(),
    kind: z.literal('join'),
    method: z.union([z.literal('gibson'), z.literal('goldengate')]),
    leftRegionId: z.string(),
    rightRegionId: z.string(),
  })
  .strict();

const listHistoricalAssemblyComponentsComponentsItemsSpacerSchema = z
  .object({
    acceptedAssemblyVersionId: z.string(),
    canonicalDraftChecksum: z.string(),
    componentId: z.string(),
    componentDigest: z.string(),
    kind: z.literal('spacer'),
    spacerId: z.string(),
    leftRegionId: z.string(),
    rightRegionId: z.string(),
  })
  .strict();

const listHistoricalAssemblyComponentsComponentsItemsRegionSchema = z
  .object({
    acceptedAssemblyVersionId: z.string(),
    canonicalDraftChecksum: z.string(),
    componentId: z.string(),
    componentDigest: z.string(),
    kind: z.literal('region'),
    regionId: z.string(),
  })
  .strict();

const listHistoricalAssemblyComponentsSchema = z
  .object({
    constructId: z.string(),
    total: z.number(),
    offset: z.number(),
    components: z.array(
      z.union([
        listHistoricalAssemblyComponentsComponentsItemsRegionSchema,
        listHistoricalAssemblyComponentsComponentsItemsSpacerSchema,
        listHistoricalAssemblyComponentsComponentsItemsJoinSchema,
        listHistoricalAssemblyComponentsComponentsItemsPrimerPairSchema,
      ])
    ),
    nextOffset: z.union([z.null(), z.number()]),
    unavailable: z.array(listHistoricalAssemblyComponentsUnavailableItemsSchema),
    ok: z.literal(true),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyArtifactsSchema = z
  .object({
    productSequenceChecksum: z.string(),
    productGenBankChecksum: z.string().optional(),
    primerCsvChecksum: z.string(),
    primerFastaChecksum: z.string(),
    canonicalDraftChecksum: z.string(),
    sidecarChecksum: z.string().optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyValidationSnapshotIssuesItemsSchema = z
  .object({
    code: z.string(),
    severity: z.union([z.literal('error'), z.literal('warning')]),
    message: z.string(),
    field: z.string().optional(),
    fragmentIndex: z.number().optional(),
    junctionIndex: z.number().optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyValidationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    designId: z.string(),
    designVersion: z.number(),
    assemblyMethod: z.union([z.literal('gibson'), z.literal('nebuilder'), z.literal('goldengate')]),
    projectionInputChecksum: z.string(),
    validatedAt: z.string(),
    clean: z.boolean(),
    issues: z.array(getAcceptedAssemblyAcceptedAssemblyValidationSnapshotIssuesItemsSchema),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputSourceProvenanceItemsSelectedSourceRangeSchema =
  z
    .object({
      start: z.number(),
      end: z.number(),
      wraps: z.boolean().optional(),
    })
    .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputSourceProvenanceItemsIncludedSourceSegmentsItemsSchema =
  z
    .object({
      start: z.number(),
      end: z.number(),
      wraps: z.boolean().optional(),
      strand: z.union([z.literal('reverse'), z.literal('forward'), z.literal('none')]).optional(),
      role: z.union([
        z.literal('included-template'),
        z.literal('included-spacer'),
        z.literal('source-flank'),
        z.literal('restriction-scar'),
        z.literal('primer-tail'),
        z.literal('primer-binding-site'),
      ]),
    })
    .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsAnnotationsItemsQualifiersSchema =
  z.record(z.union([z.string(), z.array(z.string())]));

const getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsAnnotationsItemsSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    start: z.number(),
    end: z.number(),
    strand: z.union([z.literal('reverse'), z.literal('forward'), z.literal('none')]),
    color: z.string().optional(),
    qualifiers:
      getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsAnnotationsItemsQualifiersSchema.optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsRdEndsUpstreamSchema = z
  .object({
    overhang: z.string().optional(),
    overhangType: z
      .union([z.literal('blunt'), z.literal('5_prime'), z.literal('3_prime')])
      .optional(),
    recognitionSequence: z.string().optional(),
    recognitionStart: z.number().optional(),
    recognitionEnd: z.number().optional(),
    cutPositionTop: z.number().optional(),
    cutPositionBottom: z.number().optional(),
    strand: z.union([z.literal('reverse'), z.literal('forward')]).optional(),
    retainedScarSequence: z.string().optional(),
    retainedScarLength: z.number().optional(),
    nebuilderResectionBases: z.number().optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsRdEndsSchema = z
  .object({
    upstream:
      getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsRdEndsUpstreamSchema.optional(),
    downstream:
      getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsRdEndsUpstreamSchema.optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputSourceProvenanceItemsSchema = z
  .object({
    regionId: z.string(),
    sourceType: z.union([z.literal('pcr'), z.literal('restriction-digest')]),
    sourceSequenceId: z.string(),
    sourceSequenceName: z.string(),
    sourceConstructId: z.string().optional(),
    sourceSequenceVersionId: z.string().optional(),
    sourceSequenceChecksum: z.string().optional(),
    sourceLength: z.number().optional(),
    sourceIsCircular: z.boolean().optional(),
    copiedDirection: z.union([z.literal('forward'), z.literal('reverse-complement')]),
    selectedSourceRange:
      getAcceptedAssemblyAcceptedAssemblyProjectionInputSourceProvenanceItemsSelectedSourceRangeSchema,
    includedSourceSegments: z.array(
      getAcceptedAssemblyAcceptedAssemblyProjectionInputSourceProvenanceItemsIncludedSourceSegmentsItemsSchema
    ),
    sourceAnnotations: z.array(
      getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsAnnotationsItemsSchema
    ),
    copiedAnnotations: z.array(
      getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsAnnotationsItemsSchema
    ),
    rdEnds: getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsRdEndsSchema.optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputHistoricalComponentSourcesItemsSchema = z
  .object({
    kind: z.union([
      z.literal('join'),
      z.literal('region'),
      z.literal('spacer'),
      z.literal('primer-pair'),
    ]),
    sourceAcceptedAssemblyVersionId: z.string(),
    sourceCanonicalDraftChecksum: z.string(),
    sourceComponentId: z.string(),
    sourceComponentDigest: z.string(),
    targetComponentId: z.string(),
    stagedComponentDigest: z.string(),
    sourceProvenance:
      getAcceptedAssemblyAcceptedAssemblyProjectionInputSourceProvenanceItemsSchema.optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputAssemblyWorkbenchPrimerEditIntentsItemsSchema =
  z
    .object({
      id: z.string(),
      regionId: z.string(),
      direction: z.union([z.literal('reverse'), z.literal('forward')]),
      junctionIndex: z.union([z.null(), z.number()]),
      field: z.union([z.literal('tailLength'), z.literal('pbsLength')]),
      length: z.number(),
      updatedAtVersion: z.number().optional(),
    })
    .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputAssemblyWorkbenchPrimersItemsSchema = z
  .object({
    id: z.string(),
    regionId: z.string(),
    direction: z.union([z.literal('reverse'), z.literal('forward')]),
    createdAtVersion: z.number().optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputAssemblyWorkbenchJunctionsItemsSchema = z
  .object({
    id: z.string(),
    slot: z.number(),
    leftRegionId: z.union([z.null(), z.string()]),
    rightRegionId: z.union([z.null(), z.string()]),
    createdAtVersion: z.number().optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputAssemblyWorkbenchSchema = z
  .object({
    junctions: z.array(
      getAcceptedAssemblyAcceptedAssemblyProjectionInputAssemblyWorkbenchJunctionsItemsSchema
    ),
    primers: z.array(
      getAcceptedAssemblyAcceptedAssemblyProjectionInputAssemblyWorkbenchPrimersItemsSchema
    ),
    primerEditIntents: z
      .array(
        getAcceptedAssemblyAcceptedAssemblyProjectionInputAssemblyWorkbenchPrimerEditIntentsItemsSchema
      )
      .optional(),
    autoDraftPrimers: z.boolean().optional(),
  })
  .strict();


const thermodynamicsProviderMetadataSchema = jsonObjectSchema;

const getAcceptedAssemblyAcceptedAssemblyProjectionInputDesignPrimersItemsForwardTmProvenanceModelNebSchema =
  z
    .object({
      kind: z.literal('neb'),
      prodcode: z.string(),
      polymerase: z.union([
        z.literal('q5'),
        z.literal('phusion'),
        z.literal('onetaq'),
        z.literal('taq'),
        z.literal('longamp'),
      ]),
    })
    .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputDesignPrimersItemsForwardTmProvenanceModelLocalSchema =
  z
    .object({
      kind: z.literal('local'),
      algorithm: z.union([z.literal('santalucia98'), z.literal('santalucia-owczarzy')]),
    })
    .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputDesignPrimersItemsForwardTmProvenanceSchema =
  z
    .object({
      source: z.string(),
      verified: z.boolean(),
      model: z
        .union([
          getAcceptedAssemblyAcceptedAssemblyProjectionInputDesignPrimersItemsForwardTmProvenanceModelLocalSchema,
          getAcceptedAssemblyAcceptedAssemblyProjectionInputDesignPrimersItemsForwardTmProvenanceModelNebSchema,
        ])
        .optional(),
      concNm: z.number().optional(),
      pending: z.boolean().optional(),
      ta: z.number().optional(),
      meta: thermodynamicsProviderMetadataSchema.optional(),
    })
    .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputDesignPrimersItemsForwardGoldenGateOverhangSchema =
  z
    .object({
      padding5prime: z.string(),
      enzymeSite: z.string(),
      spacer: z.string(),
      overhang: z.string(),
      literalExtra: z.string(),
      literalSpacerLength: z.number().optional(),
      fullSequence: z.string(),
    })
    .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputDesignPrimersItemsForwardOverhangSchema = z
  .object({
    length: z.number(),
    sequence: z.string(),
    tailLength: z.number().optional(),
    spacerSequence: z.string().optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputDesignPrimersItemsForwardPbsSchema = z
  .object({
    start: z.number(),
    end: z.number(),
    sequence: z.string(),
  })
  .strict();

export const assemblyPrimerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    manuallyEdited: z.boolean().optional(),
    manuallyNamed: z.boolean().optional(),
    oligo: z.lazy(() => primerOligoCompositionV1Schema).optional(),
    sequence: z.string(),
    pbs: getAcceptedAssemblyAcceptedAssemblyProjectionInputDesignPrimersItemsForwardPbsSchema,
    overhang:
      getAcceptedAssemblyAcceptedAssemblyProjectionInputDesignPrimersItemsForwardOverhangSchema,
    goldenGateOverhang:
      getAcceptedAssemblyAcceptedAssemblyProjectionInputDesignPrimersItemsForwardGoldenGateOverhangSchema.optional(),
    direction: z.union([z.literal('reverse'), z.literal('forward')]),
    fragmentIndex: z.number(),
    junctionIndex: z.union([z.null(), z.number()]),
    tm: z.number().optional(),
    cognate4bpLength: z.number().optional(),
    synthetic4bpSpacerLength: z.number().optional(),
    tmProvenance:
      getAcceptedAssemblyAcceptedAssemblyProjectionInputDesignPrimersItemsForwardTmProvenanceSchema.optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputDesignPrimersItemsSchema = z
  .object({
    forward: assemblyPrimerSchema,
    reverse: assemblyPrimerSchema,
    fragmentIndex: z.number(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputGoldenGateJunctionsItemsSourcePcrMatchedRdSchema =
  z
    .object({
      type: z.literal('pcr-matched-rd'),
      matchedRegionIndex: z.number(),
    })
    .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputGoldenGateJunctionsItemsSourcePcrDesignedSchema =
  z
    .object({
      type: z.literal('pcr-designed'),
    })
    .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputGoldenGateJunctionsItemsSourceRdFixedSchema =
  z
    .object({
      type: z.literal('rd-fixed'),
      fromRegionIndex: z.number(),
    })
    .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputGoldenGateJunctionsItemsSchema = z
  .object({
    junctionIndex: z.number(),
    junctionPosition: z.number(),
    offset: z.number(),
    overhangStart: z.number(),
    overhangEnd: z.number(),
    overhang: z.string(),
    source: z.union([
      getAcceptedAssemblyAcceptedAssemblyProjectionInputGoldenGateJunctionsItemsSourceRdFixedSchema,
      getAcceptedAssemblyAcceptedAssemblyProjectionInputGoldenGateJunctionsItemsSourcePcrDesignedSchema,
      getAcceptedAssemblyAcceptedAssemblyProjectionInputGoldenGateJunctionsItemsSourcePcrMatchedRdSchema,
    ]),
    isValid: z.boolean(),
    validationError: z.string().optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputGoldenGateConfigSchema = z
  .object({
    enzyme: z.union([z.literal('BsaI'), z.literal('BbsI'), z.literal('BsmBI'), z.literal('SapI')]),
    offsetLimitBp: z.number().optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputHomologyRegionsItemsMetadataSchema = z
  .object({
    sequence: z.string().optional(),
    tmEstimate: z.number().optional(),
    gcContent: z.number().optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputHomologyRegionsItemsTemplateBasisSchema = z
  .object({
    leftHomologyEnd: z.number(),
    rightHomologyStart: z.number(),
    spacerLength: z.number(),
    spacerContributesToAnnealing: z.boolean(),
    leftSpacerIncludedInHomology: z.boolean(),
    leftHomologyAllowed: z.boolean().optional(),
    rightHomologyAllowed: z.boolean().optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputHomologyRegionsItemsEncodingSchema = z
  .object({
    onLeft: z.number(),
    onRight: z.number(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputHomologyRegionsItemsSchema = z
  .object({
    id: z.string(),
    junctionIndex: z.number(),
    junctionPosition: z.number(),
    start: z.number(),
    end: z.number(),
    encoding: getAcceptedAssemblyAcceptedAssemblyProjectionInputHomologyRegionsItemsEncodingSchema,
    templateBasis:
      getAcceptedAssemblyAcceptedAssemblyProjectionInputHomologyRegionsItemsTemplateBasisSchema.optional(),
    metadata:
      getAcceptedAssemblyAcceptedAssemblyProjectionInputHomologyRegionsItemsMetadataSchema.optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputSpacersItemsSchema = z
  .object({
    id: z.string(),
    junctionIndex: z.number(),
    sequence: z.string(),
    name: z.string().optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsRdOverhangsSchema = z
  .object({
    upstream: z.string(),
    downstream: z.string(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsSchema = z
  .object({
    id: z.string(),
    colorIndex: z.number().optional(),
    sourceSequenceId: z.string(),
    sourceSequenceName: z.string(),
    sourceType: z.union([z.literal('pcr'), z.literal('rd')]),
    sourceStart: z.number(),
    sourceEnd: z.number(),
    sequence: z.string(),
    annotations: z.array(
      getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsAnnotationsItemsSchema
    ),
    ggType: z
      .union([z.literal('rd'), z.literal('insert'), z.literal('backbone'), z.literal('unusable')])
      .optional(),
    rdOverhangs:
      getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsRdOverhangsSchema.optional(),
    rdSourceEnzyme: z.string().optional(),
    rdSourceEnzymeName: z.string().optional(),
    rdEnds: getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsRdEndsSchema.optional(),
    rdSiblingOverhangs: z.array(z.string()).optional(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyProjectionInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    designId: z.string(),
    constructId: z.string().optional(),
    parentAcceptedAssemblyVersionId: z.string().optional(),
    designName: z.string(),
    topology: z.union([z.literal('circular'), z.literal('linear')]),
    assemblyMethod: z.union([z.literal('gibson'), z.literal('nebuilder'), z.literal('goldengate')]),
    backboneSequenceId: z.union([z.null(), z.string()]),
    defaultHomologyLength: z.number(),
    productSequence: z.string(),
    regions: z.array(getAcceptedAssemblyAcceptedAssemblyProjectionInputRegionsItemsSchema),
    spacers: z.array(getAcceptedAssemblyAcceptedAssemblyProjectionInputSpacersItemsSchema),
    homologyRegions: z.array(
      getAcceptedAssemblyAcceptedAssemblyProjectionInputHomologyRegionsItemsSchema
    ),
    goldenGateConfig:
      getAcceptedAssemblyAcceptedAssemblyProjectionInputGoldenGateConfigSchema.optional(),
    goldenGateJunctions: z
      .array(getAcceptedAssemblyAcceptedAssemblyProjectionInputGoldenGateJunctionsItemsSchema)
      .optional(),
    designPrimers: z.array(
      getAcceptedAssemblyAcceptedAssemblyProjectionInputDesignPrimersItemsSchema
    ),
    optimizationFingerprint: z.string().optional(),
    assemblyWorkbench:
      getAcceptedAssemblyAcceptedAssemblyProjectionInputAssemblyWorkbenchSchema.optional(),
    sourceProvenance: z.array(
      getAcceptedAssemblyAcceptedAssemblyProjectionInputSourceProvenanceItemsSchema
    ),
    historicalComponentSources: z
      .array(
        getAcceptedAssemblyAcceptedAssemblyProjectionInputHistoricalComponentSourcesItemsSchema
      )
      .optional(),
    canonicalDraftChecksum: z.string(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyConstructionSchema = z
  .object({
    method: z.union([z.literal('gibson'), z.literal('nebuilder'), z.literal('goldengate')]),
    topology: z.union([z.literal('circular'), z.literal('linear')]),
    canonicalDraftChecksum: z.string(),
    optimizationFingerprint: z.string().optional(),
    regionCount: z.number(),
    spacerCount: z.number(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyAgentOperationSchema = z
  .object({
    idempotencyKey: z.string(),
    previewFingerprint: z.string(),
  })
  .strict();

const getAcceptedAssemblyAcceptedAssemblyAcceptedAssemblySchema = z
  .object({
    type: z.literal('accepted_assembly'),
    schemaVersion: z.literal(1),
    acceptedAssemblyVersionId: z.string().optional(),
    acceptedVersionId: z.string().optional(),
    lifecycleState: z
      .union([
        z.literal('draft'),
        z.literal('accepted'),
        z.literal('writing'),
        z.literal('written'),
        z.literal('write_failed'),
        z.literal('reopen_conflict'),
      ])
      .optional(),
    acceptedAt: z.string(),
    acceptedBy: z.string().optional(),
    designId: z.string(),
    constructId: z.string().optional(),
    agentOperation: getAcceptedAssemblyAcceptedAssemblyAgentOperationSchema.optional(),
    designName: z.string(),
    construction: getAcceptedAssemblyAcceptedAssemblyConstructionSchema,
    projectionInput: getAcceptedAssemblyAcceptedAssemblyProjectionInputSchema,
    validationSnapshot: getAcceptedAssemblyAcceptedAssemblyValidationSnapshotSchema,
    artifacts: getAcceptedAssemblyAcceptedAssemblyArtifactsSchema,
  })
  .strict();

const getConstructLineageIntegritySchema = z
  .object({
    productGenBank: z.union([
      z.literal('verified'),
      z.literal('drifted'),
      z.literal('historical'),
      z.literal('unavailable'),
    ]),
    expectedChecksum: z.union([z.null(), z.string()]),
    actualChecksum: z.union([z.null(), z.string()]),
  })
  .strict();

const getAcceptedAssemblySchema = z
  .object({
    exists: z.boolean(),
    immutable: z.boolean(),
    constructId: z.string(),
    packageId: z.string(),
    acceptedAssemblyVersionId: z.string(),
    integrity: getConstructLineageIntegritySchema,
    acceptedAssembly: getAcceptedAssemblyAcceptedAssemblyAcceptedAssemblySchema,
    ok: z.literal(true),
  })
  .strict();

const getConstructLineageSchema = z
  .object({
    exists: z.boolean(),
    constructId: z.string(),
    acceptedAssemblyVersionId: z.string(),
    integrity: getConstructLineageIntegritySchema,
    lineage: acceptedLineageSchema,
    ok: z.literal(true),
  })
  .strict();

const getDesignGoldenGateJunctionsItemsSourcePcrMatchedRdSchema = z
  .object({
    type: z.literal('pcr-matched-rd'),
    matchedRegionIndex: z.number(),
  })
  .strict();

const getDesignGoldenGateJunctionsItemsSourcePcrDesignedSchema = z
  .object({
    type: z.literal('pcr-designed'),
  })
  .strict();

const getDesignGoldenGateJunctionsItemsSourceRdFixedSchema = z
  .object({
    type: z.literal('rd-fixed'),
    fromRegionIndex: z.number(),
  })
  .strict();

const getDesignGoldenGateJunctionsItemsSchema = z
  .object({
    junctionIndex: z.number(),
    junctionPosition: z.number(),
    offset: z.number(),
    overhangStart: z.number(),
    overhangEnd: z.number(),
    overhang: z.string(),
    source: z.union([
      getDesignGoldenGateJunctionsItemsSourceRdFixedSchema,
      getDesignGoldenGateJunctionsItemsSourcePcrDesignedSchema,
      getDesignGoldenGateJunctionsItemsSourcePcrMatchedRdSchema,
    ]),
    isValid: z.boolean(),
    validationError: z.union([z.null(), z.string()]),
  })
  .strict();

const getDesignPrimersItemsForwardTmProvenanceSchema = z
  .object({
    source: z.string(),
    verified: z.boolean(),
    model: z.union([configurePrimerTmModelLocalSchema, configurePrimerTmModelNebSchema]).optional(),
    concNm: z.number().optional(),
    pending: z.boolean().optional(),
    ta: z.number().optional(),
    meta: jsonObjectSchema.optional(),
  })
  .strict();

const getDesignPrimersItemsForwardGoldenGateOverhangSchema = z
  .object({
    padding5prime: z.string(),
    enzymeSite: z.string(),
    spacer: z.string(),
    overhang: z.string(),
    literalExtra: z.string(),
    literalSpacerLength: z.union([z.null(), z.number()]),
    fullSequence: z.string(),
  })
  .strict();

const getDesignPrimersItemsForwardOverhangSchema = z
  .object({
    length: z.number(),
    tailLength: z.number(),
    sequence: z.string(),
    spacerSequence: z.union([z.null(), z.string()]),
  })
  .strict();

const getDesignPrimersItemsForwardPbsSchema = z
  .object({
    start: z.number(),
    end: z.number(),
    sequence: z.string(),
    length: z.number(),
  })
  .strict();

export const savedPrimerLinkOriginSchema = z.enum(['saved-from-assembly', 'matched-existing']);

export const assemblyPrimerSourceSiteSchema = z
  .object({
    documentId: z.string(),
    name: z.string(),
    coordinateSystem: z.literal('zero_based_half_open'),
    start: z.number(),
    end: z.number(),
    strand: z.union([z.literal(1), z.literal(-1)]),
    wraps: z.boolean(),
    sourceLength: z.union([z.null(), z.number()]),
    circular: z.boolean(),
  })
  .strict();

export const assemblyTmContextSchema = z
  .object({
    evaluates: z.literal('binding-part'),
    modelLabel: z.string(),
    primerConcNm: z.number(),
  })
  .strict();

const getDesignPrimersItemsSavedOligoSchema = z
  .object({
    oligoId: z.string(),
    artifactRevision: z.number(),
    sequenceContentHash: z.string(),
    linkedAtDesignVersion: z.number(),
    linkedAt: z.string(),
    via: savedPrimerLinkOriginSchema,
  })
  .strict();

const getDesignPrimersItemsForwardSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    savedOligo: z.union([z.null(), getDesignPrimersItemsSavedOligoSchema]),
    oligo: z.lazy(() => primerOligoCompositionV1Schema).nullable(),
    manuallyEdited: z.boolean(),
    manuallyNamed: z.boolean(),
    direction: z.union([z.literal('reverse'), z.literal('forward')]),
    fragmentIndex: z.number(),
    junctionIndex: z.union([z.null(), z.number()]),
    sequence: z.string(),
    pbs: getDesignPrimersItemsForwardPbsSchema,
    overhang: getDesignPrimersItemsForwardOverhangSchema,
    goldenGateOverhang: z.union([z.null(), getDesignPrimersItemsForwardGoldenGateOverhangSchema]),
    tm: z.union([z.null(), z.number()]),
    tmProvenance: z.union([z.null(), getDesignPrimersItemsForwardTmProvenanceSchema]),
    cognate4bpLength: z.union([z.null(), z.number()]),
    synthetic4bpSpacerLength: z.union([z.null(), z.number()]),
  })
  .strict();

const getDesignPrimersItemsSchema = z
  .object({
    fragmentIndex: z.number(),
    forward: getDesignPrimersItemsForwardSchema,
    reverse: getDesignPrimersItemsForwardSchema,
  })
  .strict();

const getDesignRegionsItemsRdEndsUpstreamSchema = z
  .object({
    overhang: z.union([z.null(), z.string()]),
    overhangType: z.union([
      z.null(),
      z.literal('blunt'),
      z.literal('5_prime'),
      z.literal('3_prime'),
    ]),
    recognitionSequence: z.union([z.null(), z.string()]),
    recognitionStart: z.union([z.null(), z.number()]),
    recognitionEnd: z.union([z.null(), z.number()]),
    cutPositionTop: z.union([z.null(), z.number()]),
    cutPositionBottom: z.union([z.null(), z.number()]),
    strand: z.union([z.null(), z.literal('reverse'), z.literal('forward')]),
    retainedScarSequence: z.union([z.null(), z.string()]),
    retainedScarLength: z.union([z.null(), z.number()]),
    nebuilderResectionBases: z.union([z.null(), z.number()]),
  })
  .strict();

const getDesignRegionsItemsRdEndsSchema = z
  .object({
    upstream: z.union([z.null(), getDesignRegionsItemsRdEndsUpstreamSchema]),
    downstream: z.union([z.null(), getDesignRegionsItemsRdEndsUpstreamSchema]),
  })
  .strict();

const getDesignRegionsItemsRdOverhangsSchema = z
  .object({
    upstream: z.string(),
    downstream: z.string(),
  })
  .strict();

const getDesignRegionsItemsMocloStageOutputLiveSchema = z
  .object({
    status: z.literal('live'),
    runId: z.string(),
    kitId: z.string(),
    kitRevision: z.number(),
    recipeId: z.string(),
    sourceStageId: z.string(),
    sourceDesignId: z.string(),
  })
  .strict();

const getDesignRegionsItemsMocloStageOutputUnresolvedSchema = z
  .object({
    status: z.literal('unresolved'),
    runId: z.string(),
    kitId: z.string(),
    kitRevision: z.number(),
    recipeId: z.string(),
    sourceStageId: z.string(),
  })
  .strict();

const getDesignRegionsItemsSchema = z
  .object({
    id: z.string(),
    sourceSequenceId: z.string(),
    sourceSequenceName: z.string(),
    sourceStart: z.number(),
    sourceEnd: z.number(),
    length: z.number(),
    annotationCount: z.number(),
    isPlaceholder: z.boolean(),
    mocloStageOutput: z.union([
      z.null(),
      getDesignRegionsItemsMocloStageOutputUnresolvedSchema,
      getDesignRegionsItemsMocloStageOutputLiveSchema,
    ]),
    sourceType: z.union([z.null(), z.literal('pcr'), z.literal('rd')]),
    ggType: z.union([
      z.null(),
      z.literal('rd'),
      z.literal('insert'),
      z.literal('backbone'),
      z.literal('unusable'),
    ]),
    rdOverhangs: z.union([z.null(), getDesignRegionsItemsRdOverhangsSchema]),
    rdSourceEnzyme: z.union([
      z.null(),
      z.literal('BsaI'),
      z.literal('BbsI'),
      z.literal('BsmBI'),
      z.literal('SapI'),
    ]),
    rdSourceEnzymeName: z.union([z.null(), z.string()]),
    rdEnds: z.union([z.null(), getDesignRegionsItemsRdEndsSchema]),
  })
  .strict();

const getDesignSpacerIntegrityWarningsItemsVariant3Schema = z
  .object({
    code: z.literal('ORPHANED_SPACER'),
    spacerId: z.string(),
    junctionIndex: z.number(),
  })
  .strict();

const getDesignSpacerIntegrityWarningsItemsSchema = z
  .object({
    code: z.literal('DUPLICATE_SPACERS_AT_JUNCTION'),
    junctionIndex: z.number(),
    spacerIds: z.array(z.string()),
  })
  .strict();

const getDesignOrphanedSpacersItemsSchema = z
  .object({
    id: z.string(),
    junctionIndex: z.number(),
    sequence: z.string(),
  })
  .strict();

const getDesignSpacersItemsAnchorSchema = z
  .object({
    leftRegionId: z.string(),
    rightRegionId: z.string(),
  })
  .strict();

const getDesignSpacersItemsSchema = z
  .object({
    id: z.string(),
    junctionIndex: z.number(),
    anchor: z.union([z.null(), getDesignSpacersItemsAnchorSchema]),
    sequence: z.string(),
    name: z.union([z.null(), z.string()]),
    length: z.number(),
  })
  .strict();

const internalCutSiteSchema = z
  .object({
    start: z.number(),
    end: z.number(),
    strand: z.union([z.literal('reverse'), z.literal('forward')]),
  })
  .strict();

const getDesignAssemblyIssuesItemsScopeExportSchema = z
  .object({
    type: z.literal('export'),
    designId: z.string(),
  })
  .strict();

const getDesignAssemblyIssuesItemsScopeDigestPreviewSchema = z
  .object({
    type: z.literal('digest-preview'),
    sequenceId: z.string(),
    fragmentId: z.string().optional(),
  })
  .strict();

const getDesignAssemblyIssuesItemsScopePrimerSchema = z
  .object({
    type: z.literal('primer'),
    designId: z.string(),
    primerId: z.string().optional(),
    fragmentIndex: z.number(),
    direction: z.union([z.literal('reverse'), z.literal('forward')]),
  })
  .strict();

const getDesignAssemblyIssuesItemsScopeJunctionSchema = z
  .object({
    type: z.literal('junction'),
    designId: z.string(),
    junctionIndex: z.number(),
    leftRegionId: z.string().optional(),
    rightRegionId: z.string().optional(),
  })
  .strict();

const getDesignAssemblyIssuesItemsScopePartSchema = z
  .object({
    type: z.literal('part'),
    designId: z.string(),
    regionId: z.string(),
    fragmentIndex: z.number(),
  })
  .strict();

const getDesignAssemblyIssuesItemsScopeAssemblySchema = z
  .object({
    type: z.literal('assembly'),
    designId: z.string(),
  })
  .strict();

const getDesignAssemblyIssuesItemsGatesSchema = z
  .object({
    run: z.boolean(),
    finalize: z.boolean(),
    export: z.boolean(),
  })
  .strict();

const getDesignAssemblyIssuesItemsSchema = z
  .object({
    kind: z.union([
      z.literal('assembly-topology-unsupported'),
      z.literal('assembly-min-fragments'),
      z.literal('assembly-empty-part'),
      z.literal('spacer-duplicate-junction'),
      z.literal('gibson-rd-rd-junction'),
      z.literal('gg-internal-site'),
      z.literal('gg-overhang-mismatch'),
      z.literal('gg-self-ligation'),
      z.literal('gg-duplicate-overhang'),
      z.literal('gg-rd-enzyme-mismatch'),
      z.literal('gg-rd-enzyme-unknown'),
      z.literal('gg-rd-polarity-unsupported'),
      z.literal('gg-rd-cut-site-mismatch'),
      z.literal('gg-rd-spacer-unsupported'),
      z.literal('gg-junction-invalid'),
      z.literal('gg-invalid-pair'),
      z.literal('gg-extra-sites'),
      z.literal('homology-length-out-of-range'),
      z.literal('homology-length-suboptimal'),
      z.literal('homology-tm-suboptimal'),
      z.literal('homology-gc-suboptimal'),
      z.literal('primer-pbs-out-of-range'),
      z.literal('primer-pbs-suboptimal'),
      z.literal('digest-no-cut-sites'),
      z.literal('digest-duplicate-overhang'),
      z.literal('export-missing-workspace'),
      z.literal('export-not-validated'),
      z.literal('export-finalize-failed'),
    ]),
    severity: z.union([z.literal('error'), z.literal('warning'), z.literal('info')]),
    lifecycle: z.union([z.literal('committed'), z.literal('provisional')]),
    gates: getDesignAssemblyIssuesItemsGatesSchema,
    title: z.string(),
    detail: z.string(),
    scope: z.union([
      getDesignAssemblyIssuesItemsScopeAssemblySchema,
      getDesignAssemblyIssuesItemsScopePartSchema,
      getDesignAssemblyIssuesItemsScopeJunctionSchema,
      getDesignAssemblyIssuesItemsScopePrimerSchema,
      getDesignAssemblyIssuesItemsScopeDigestPreviewSchema,
      getDesignAssemblyIssuesItemsScopeExportSchema,
    ]),
    internalSites: z.union([z.null(), z.array(internalCutSiteSchema)]),
  })
  .strict();

const getDesignValidationErrorsItemsSchema = z
  .object({
    code: z.string(),
    severity: z.union([z.literal('error'), z.literal('warning')]),
    message: z.string(),
    field: z.union([z.null(), z.string()]),
    fragmentIndex: z.union([z.null(), z.number()]),
  })
  .strict();

const getDesignMocloFactoryStageInputsItemsSchema = z
  .object({
    slotId: z.string(),
    sourceStageId: z.string(),
  })
  .strict();

const getDesignMocloFactorySchema = z
  .object({
    runId: z.string(),
    kitId: z.string(),
    kitRevision: z.number(),
    recipeId: z.string(),
    stageId: z.string(),
    stageInputs: z.array(getDesignMocloFactoryStageInputsItemsSchema),
  })
  .strict();

const getDesignGoldenGateSchemaSlotsItemsPreferredRolesItemsSchema = z
  .object({
    label: z.string(),
    id: z.string().optional(),
  })
  .strict();

const getDesignGoldenGateSchemaSlotsItemsSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    outgoingOverhang: z.union([z.null(), z.string()]),
    preferredRoles: z.array(getDesignGoldenGateSchemaSlotsItemsPreferredRolesItemsSchema),
  })
  .strict();

const getDesignGoldenGateSchemaSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    revision: z.number(),
    origin: z.union([
      getDesignGoldenGateSchemaOriginCustomSchema,
      getDesignGoldenGateSchemaOriginKitSchema,
      getDesignGoldenGateSchemaOriginImportedSchema,
    ]),
    enzyme: z.union([z.literal('BsaI'), z.literal('BbsI'), z.literal('BsmBI'), z.literal('SapI')]),
    slots: z.array(getDesignGoldenGateSchemaSlotsItemsSchema),
  })
  .strict();

const draftDesignAssemblyTmResolutionSchema = z
  .object({
    pendingNebVerification: z.boolean(),
    primerCount: z.number(),
    verifiedPrimerCount: z.number(),
    model: z.union([configurePrimerTmModelLocalSchema, configurePrimerTmModelNebSchema]),
    source: z.union([
      z.literal('default'),
      z.literal('call-override'),
      z.literal('reaction'),
      z.literal('user-setting'),
    ]),
    reason: z.string(),
  })
  .strict();

const getDesignDetailSchema = z
  .object({
    goldenGateEnzyme: z.union([
      z.null(),
      z.literal('BsaI'),
      z.literal('BbsI'),
      z.literal('BsmBI'),
      z.literal('SapI'),
    ]),
    goldenGateSchema: z.union([z.null(), getDesignGoldenGateSchemaSchema]),
    mocloFactory: z.union([z.null(), getDesignMocloFactorySchema]),
    pcrPolymerase: z.union([z.null(), z.string()]),
    tmResolution: draftDesignAssemblyTmResolutionSchema,
    validationErrors: z.array(getDesignValidationErrorsItemsSchema),
    assemblyIssues: z.array(getDesignAssemblyIssuesItemsSchema),
    assemblyIssueErrorCount: z.number(),
    blocksRun: z.boolean(),
    blocksFinalize: z.boolean(),
    blocksExport: z.boolean(),
    slots: z.array(assemblySlotViewSchema),
    slotCount: z.number(),
    emptySlotCount: z.number(),
    gaps: z.array(assemblyGapViewSchema),
    junctionCount: z.number(),
    spacers: z.array(getDesignSpacersItemsSchema),
    orphanedSpacers: z.array(getDesignOrphanedSpacersItemsSchema),
    spacerIntegrityWarnings: z.array(
      z.union([
        getDesignSpacerIntegrityWarningsItemsSchema,
        getDesignSpacerIntegrityWarningsItemsVariant3Schema,
      ])
    ),
    composedSequenceLength: z.number(),
    composedSequenceIncluded: z.boolean(),
    composedSequence: z.union([z.null(), z.string()]),
    composedSequencePreview: z.union([z.null(), z.string()]),
    regions: z.array(getDesignRegionsItemsSchema),
    primers: z.array(getDesignPrimersItemsSchema),
    goldenGateJunctions: z.array(getDesignGoldenGateJunctionsItemsSchema),
    id: z.string(),
    name: z.string(),
    topology: z.union([z.literal('circular'), z.literal('linear')]),
    assemblyMethod: z.union([z.literal('gibson'), z.literal('nebuilder'), z.literal('goldengate')]),
    assemblyState: z.union([
      z.literal('assembled'),
      z.literal('preflight'),
      z.literal('drafting'),
      z.literal('validating'),
      z.literal('ready'),
      z.literal('running'),
    ]),
    status: z.union([z.literal('draft'), z.literal('computed'), z.literal('assembled')]).optional(),
    version: z.number(),
    regionCount: z.number(),
    homologyRegionCount: z.number(),
    goldenGateJunctionCount: z.number(),
    primerPairCount: z.number(),
    validationErrorCount: z.number(),
    level: z.literal('detail'),
    designId: z.string(),
    exists: z.literal(true),
    resourceUri: z.string(),
    ok: z.literal(true),
  })
  .strict();

const getDesignHeaderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    topology: z.union([z.literal('circular'), z.literal('linear')]),
    assemblyMethod: z.union([z.literal('gibson'), z.literal('nebuilder'), z.literal('goldengate')]),
    assemblyState: z.union([
      z.literal('assembled'),
      z.literal('preflight'),
      z.literal('drafting'),
      z.literal('validating'),
      z.literal('ready'),
      z.literal('running'),
    ]),
    status: z.union([z.literal('draft'), z.literal('computed'), z.literal('assembled')]).optional(),
    version: z.number(),
    regionCount: z.number(),
    homologyRegionCount: z.number(),
    goldenGateJunctionCount: z.number(),
    primerPairCount: z.number(),
    validationErrorCount: z.number(),
    level: z.literal('header'),
    designId: z.string(),
    exists: z.literal(true),
    resourceUri: z.string(),
    ok: z.literal(true),
  })
  .strict();

const getPrimerRegistryCatalogFileSchema = z
  .object({
    entityId: z.string(),
    path: z.string(),
    relativePath: z.union([z.null(), z.string()]),
    fileKind: z.string(),
    status: z.union([
      z.literal('missing'),
      z.literal('current'),
      z.literal('historical'),
      z.literal('conflict'),
    ]),
    contentHash: z.union([z.null(), z.string()]),
  })
  .strict();

const getPrimerRegistryLimsEntitySchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    registrationStatus: z.union([
      z.literal('tracked'),
      z.literal('registered'),
      z.literal('drifted'),
      z.literal('unresolved'),
    ]),
    domainStatus: z.union([z.null(), z.string()]),
    fields: jsonObjectSchema,
  })
  .strict();

const getPrimerRegistrySchema = z
  .object({
    limsEntity: z.union([z.null(), getPrimerRegistryLimsEntitySchema]),
    catalogFile: z.union([z.null(), getPrimerRegistryCatalogFileSchema]),
  })
  .strict();

const getPrimerArtifactSchema = z
  .object({
    path: z.string(),
    checksum: z.string(),
    schema: z.literal('dnaforge.primer'),
    schemaVersion: z.union([z.literal(2), z.literal(PRIMER_ARTIFACT_SCHEMA_VERSION)]),
  })
  .strict();

const recordVariant1Schema = z.record(
  z.union([z.null(), z.string(), z.number(), z.literal(false), z.literal(true)])
);

const getPrimerDesignProvenancePrimer3Schema = z
  .object({
    application: z.union([
      z.literal('gibson'),
      z.literal('pcr'),
      z.literal('sequencing'),
      z.literal('qpcr'),
      z.literal('colony_pcr'),
      z.literal('golden_gate'),
      z.literal('sdm'),
      z.literal('re_cloning'),
    ]),
    parameters: recordVariant1Schema,
    warnings: z.array(z.string()),
  })
  .strict();

const targetSchema = z
  .object({
    documentId: z.string(),
    projectId: z.string().optional(),
    topology: z.union([z.literal('circular'), z.literal('linear')]),
    length: z.number(),
    fileContentHash: z.string(),
    normalizedSequenceHash: z.string(),
    start: z.number(),
    end: z.number(),
    wrapsOrigin: z.boolean(),
  })
  .strict();

const primerTmProvenanceSchema = z
  .object({
    source: z.union([z.literal('local'), z.literal('neb-api'), z.literal('neb-q5-offline')]),
    tm: z.number(),
    ta: z.number().optional(),
    conc_nM: z.number(),
    verified: z.boolean(),
    pendingNebVerification: z.boolean().optional(),
    polymerase: z.string().optional(),
    prodcode: z.string().optional(),
    nebApiVersion: z.string().optional(),
    fetchedAt: z.string().optional(),
  })
  .strict();

const primerTmCalculationV1Schema = z
  .object({
    model: z.union([configurePrimerTmModelLocalSchema, configurePrimerTmModelNebSchema]),
    source: z.union([
      z.literal('default'),
      z.literal('call-override'),
      z.literal('reaction'),
      z.literal('user-setting'),
    ]),
    reason: z.string(),
    valueC: z.number(),
    status: z.union([z.literal('local'), z.literal('verified'), z.literal('fallback')]),
    provider: primerTmProvenanceSchema,
  })
  .strict();

const getPrimerDesignProvenanceSchema = z
  .object({
    target: targetSchema,
    designId: z.string(),
    candidateId: z.string(),
    candidateRank: z.number(),
    role: z.union([z.literal('reverse'), z.literal('forward')]),
    pbsSequence: z.string(),
    overhangSequence: z.string(),
    primer3: getPrimerDesignProvenancePrimer3Schema,
    tm: primerTmCalculationV1Schema,
  })
  .strict();

const getPrimerComputedSchema = z
  .object({
    tmC: z.union([z.null(), z.number()]),
    gcPercent: z.number(),
    tmCalculation: primerTmCalculationV1Schema.optional(),
  })
  .strict();

const createPrimerSequenceSchema = z
  .object({
    bases: z.string(),
    topology: z.literal('linear'),
    length: z.number(),
    contentHash: z.string(),
  })
  .strict();

const createPrimerOligoModificationsItemsAnchorTerminusSchema = z
  .object({
    kind: z.literal('terminus'),
    end: z.union([z.literal('five-prime'), z.literal('three-prime')]),
  })
  .strict();

const createPrimerOligoModificationsItemsAnchorBetweenBasesSchema = z
  .object({
    kind: z.literal('between-bases'),
    offset: z.number(),
  })
  .strict();

const createPrimerOligoModificationsItemsAnchorBaseSchema = z
  .object({
    kind: z.literal('base'),
    index: z.number(),
  })
  .strict();

const appliedOligoModificationV1Schema = z
  .object({
    chemistryId: z.string(),
    vendor: z.string(),
    vendorCode: z.string(),
    placement: z.union([z.literal('five-prime'), z.literal('internal'), z.literal('three-prime')]),
    behavior: z.union([
      z.literal('modified-base'),
      z.literal('linkage'),
      z.literal('terminal-attachment'),
      z.literal('between-bases'),
    ]),
    anchor: z.union([
      createPrimerOligoModificationsItemsAnchorTerminusSchema,
      createPrimerOligoModificationsItemsAnchorBetweenBasesSchema,
      createPrimerOligoModificationsItemsAnchorBaseSchema,
    ]),
    naturalBase: z
      .union([
        z.literal('A'),
        z.literal('C'),
        z.literal('G'),
        z.literal('T'),
        z.literal('U'),
        z.literal('N'),
      ])
      .optional(),
  })
  .strict();

const primerOligoCompositionV1Schema = z
  .object({
    vendor: z.string(),
    orderType: z.union([z.literal('dna'), z.literal('rna')]).optional(),
    notation: z.string(),
    modifications: z.array(appliedOligoModificationV1Schema),
  })
  .strict();

const addPrimerBindingBindingTargetSchema = z
  .object({
    documentId: z.string(),
    projectId: z.string().optional(),
    topology: z.union([z.literal('circular'), z.literal('linear')]),
    length: z.number(),
    fileContentHash: z.string(),
    normalizedSequenceHash: z.string(),
  })
  .strict();

const addPrimerBindingBindingCoordinatesSchema = z
  .object({
    system: z.literal('zero_based_half_open'),
    start: z.number(),
    end: z.number(),
    strand: z.union([z.literal(1), z.literal(-1)]),
  })
  .strict();

const addPrimerBindingBindingAlignmentSchema = z
  .object({
    identity: z.number(),
    editDistance: z.number(),
    mismatchPositions: z.array(z.number()),
    threePrimeMatchLength: z.number(),
    effectiveTmC: z.number(),
  })
  .strict();

const addPrimerBindingBindingSchema = z
  .object({
    id: z.string(),
    relation: z.literal('binds_to_sequence'),
    sequenceId: z.union([z.null(), z.number()]),
    target: addPrimerBindingBindingTargetSchema,
    coordinates: addPrimerBindingBindingCoordinatesSchema,
    source: z.union([
      z.literal('agent-design'),
      z.literal('drag-selection'),
      z.literal('manual'),
      z.literal('reconciled'),
    ]),
    alignment: z.union([z.null(), addPrimerBindingBindingAlignmentSchema]),
  })
  .strict();

const getPrimerAssemblyUsesItemsSchema = z
  .object({
    designId: z.string(),
    designUri: z.string(),
    designName: z.string(),
    designVersion: z.number(),
    primerId: z.string(),
    primerName: z.string(),
    partNumber: z.number(),
    direction: z.enum(['forward', 'reverse']),
    bindingSequence: z.string(),
    tailSequence: z.string(),
    tmC: z.union([z.null(), z.number()]),
    tm: assemblyTmContextSchema,
    sourceSite: z.union([z.null(), assemblyPrimerSourceSiteSchema]),
    state: z.enum(['current', 'draft-primer-changed', 'oligo-bases-changed']),
    linkedAtDesignVersion: z.number(),
    linkedArtifactRevision: z.number(),
    sourceAttachment: z.enum(['agrees', 'differs', 'none']),
  })
  .strict();

const getPrimerSchema = z
  .object({
    found: z.literal(true),
    workspaceRoot: z.string(),
    annealing: z.object({ pbsSequence: z.string(), overhangSequence: z.string() }).strict().nullable(),
    primerId: z.string(),
    artifactRevision: z.number(),
    name: z.string(),
    catalogNumber: z.string(),
    sequence: createPrimerSequenceSchema,
    oligo: z.union([z.null(), primerOligoCompositionV1Schema]),
    idtNotation: z.string(),
    computed: getPrimerComputedSchema,
    designProvenance: z.union([z.null(), getPrimerDesignProvenanceSchema]),
    artifact: getPrimerArtifactSchema,
    bindings: z.array(z.union([z.null(), addPrimerBindingBindingSchema])),
    assemblyUses: z.array(getPrimerAssemblyUsesItemsSchema),
    registry: getPrimerRegistrySchema,
    ok: z.literal(true),
  })
  .strict();

const addPrimerBindingSchema = z
  .object({
    changed: z.boolean(),
    status: z.union([
      z.literal('created'),
      z.literal('added'),
      z.literal('duplicate'),
      z.literal('updated'),
    ]),
    bindingConfirmed: z.boolean(),
    warnings: z.array(z.string()),
    primerId: z.string(),
    bindingId: z.string(),
    artifactRevision: z.number(),
    binding: z.union([z.null(), addPrimerBindingBindingSchema]),
    gitCommitted: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const createPrimerSchema = z
  .object({
    changed: z.boolean(),
    primerId: z.string(),
    artifactRevision: z.number(),
    name: z.string(),
    sequence: createPrimerSequenceSchema,
    oligo: z.union([z.null(), primerOligoCompositionV1Schema]),
    idtNotation: z.string(),
    artifactPath: z.string(),
    registryEntityId: z.string(),
    bindingCount: z.number(),
    gitCommitted: z.boolean(),
    ok: z.literal(true),
  })
  .strict();

const listOligoModificationsModificationsItemsSchema = z
  .object({
    code: z.string(),
    token: z.string(),
    label: z.string(),
    category: z.union([
      z.literal('attachment'),
      z.literal('fluorophore'),
      z.literal('modified-base'),
      z.literal('quencher'),
      z.literal('spacer'),
      z.literal('linkage'),
      z.literal('other'),
    ]),
    categoryLabel: z.string(),
    categoryLabels: z.array(z.string()),
    placement: z.union([z.literal('five-prime'), z.literal('internal'), z.literal('three-prime')]),
    allowedPlacements: z.array(
      z.union([z.literal('five-prime'), z.literal('internal'), z.literal('three-prime')])
    ),
    behavior: z.union([
      z.literal('modified-base'),
      z.literal('linkage'),
      z.literal('terminal-attachment'),
      z.literal('between-bases'),
    ]),
    naturalBase: z.union([
      z.null(),
      z.literal('A'),
      z.literal('C'),
      z.literal('G'),
      z.literal('T'),
      z.literal('U'),
      z.literal('N'),
    ]),
    supportedOrderTypes: z.array(z.union([z.literal('dna'), z.literal('rna')])),
    productUrl: z.union([z.null(), z.string()]),
  })
  .strict();

const listOligoModificationsConstraintsItemsRequiredAnyOfItemsSchema = z
  .object({
    chemistryId: z.string(),
    placement: z
      .union([z.literal('five-prime'), z.literal('internal'), z.literal('three-prime')])
      .optional(),
  })
  .strict();

const oligoVendorRequiresCompanionRuleSchema = z
  .object({
    id: z.string(),
    kind: z.literal('requires-companion'),
    enforcement: z.literal('hard'),
    triggerChemistryIds: z.array(z.string()),
    requiredAnyOf: z.array(listOligoModificationsConstraintsItemsRequiredAnyOfItemsSchema),
    severity: z.literal('error'),
    message: z.string(),
    sourceUrl: z.string(),
  })
  .strict();

const oligoVendorIncompatibleChemistriesRuleSchema = z
  .object({
    id: z.string(),
    kind: z.literal('incompatible-chemistries'),
    enforcement: z.literal('hard'),
    leftChemistryIds: z.array(z.string()),
    rightChemistryIds: z.array(z.string()),
    severity: z.literal('error'),
    message: z.string(),
    sourceUrl: z.string(),
  })
  .strict();

const oligoVendorMaxTotalRuleSchema = z
  .object({
    id: z.string(),
    kind: z.literal('max-total'),
    enforcement: z.literal('hard'),
    chemistryIds: z.array(z.string()),
    maximum: z.number(),
    productClasses: z.array(z.union([z.literal('dna-rna-oligo'), z.literal('qpcr-probe')])),
    severity: z.literal('error'),
    message: z.string(),
    sourceUrl: z.string(),
  })
  .strict();

const listOligoModificationsConstraintsItemsAppliesWhenSchema = z
  .object({
    adjacentChemistryId: z.string(),
    terminalPlacements: z.array(z.union([z.literal('five-prime'), z.literal('three-prime')])),
  })
  .strict();

const oligoVendorContextualMaxConsecutiveRuleSchema = z
  .object({
    id: z.string(),
    kind: z.literal('contextual-max-consecutive'),
    enforcement: z.literal('hard'),
    chemistryId: z.string(),
    maximum: z.number(),
    appliesWhen: listOligoModificationsConstraintsItemsAppliesWhenSchema,
    severity: z.literal('error'),
    message: z.string(),
    sourceUrl: z.string(),
  })
  .strict();

const oligoVendorDocumentedAdjacentSeriesRuleSchema = z
  .object({
    id: z.string(),
    kind: z.literal('documented-adjacent-series'),
    enforcement: z.literal('informational'),
    chemistryId: z.string(),
    minimumDocumented: z.number(),
    maximumDocumented: z.number(),
    severity: z.literal('warning'),
    message: z.string(),
    sourceUrl: z.string(),
  })
  .strict();

const oligoVendorMaxConsecutiveRuleSchema = z
  .object({
    id: z.string(),
    kind: z.literal('max-consecutive'),
    enforcement: z.literal('hard'),
    chemistryId: z.string(),
    maximum: z.number(),
    severity: z.literal('error'),
    message: z.string(),
    sourceUrl: z.string(),
  })
  .strict();

const listOligoModificationsSchema = z
  .object({
    vendor: z.string(),
    orderType: z.union([z.literal('dna'), z.literal('rna')]),
    notation: z.string(),
    catalogSourceUrl: z.string().optional(),
    catalogRetrievedAt: z.string().optional(),
    catalogEntryCount: z.number(),
    constraints: z.array(
      z.union([
        oligoVendorMaxConsecutiveRuleSchema,
        oligoVendorDocumentedAdjacentSeriesRuleSchema,
        oligoVendorContextualMaxConsecutiveRuleSchema,
        oligoVendorMaxTotalRuleSchema,
        oligoVendorIncompatibleChemistriesRuleSchema,
        oligoVendorRequiresCompanionRuleSchema,
      ])
    ),
    count: z.number(),
    modifications: z.array(listOligoModificationsModificationsItemsSchema),
    ok: z.literal(true),
  })
  .strict();

const saveDesignedPrimerSchema = z
  .object({
    workspaceRoot: z.string(),
    candidateEdited: z.boolean(),
    saved: z.literal(true),
    primerId: z.string(),
    artifactRevision: z.number(),
    artifactPath: z.string(),
    artifactChecksum: z.string(),
    registryEntityId: z.string(),
    gitCommitted: z.boolean(),
    candidateId: z.string(),
    bindingCount: z.number(),
    idtNotation: z.string(),
    ok: z.literal(true),
  })
  .strict();

const designPrimersPairsItemsForwardSelfComplementaritySchema = z
  .object({
    anyTh: z.number(),
    endTh: z.number(),
    hairpinTh: z.number(),
  })
  .strict();

const designPrimersPairsItemsForwardBindingSchema = z
  .object({
    coordinateSystem: z.literal('zero_based_half_open'),
    start: z.number(),
    end: z.number(),
    strand: z.union([z.literal(1), z.literal(-1)]),
  })
  .strict();

const designPrimersPairsItemsForwardSchema = z
  .object({
    candidateId: z.string(),
    role: z.union([z.literal('reverse'), z.literal('forward')]),
    pbsSequence: z.string(),
    overhangSequence: z.string(),
    sequence: z.string(),
    binding: designPrimersPairsItemsForwardBindingSchema,
    tm: primerTmCalculationV1Schema,
    primer3TmC: z.number(),
    gcPercent: z.number(),
    selfComplementarity: designPrimersPairsItemsForwardSelfComplementaritySchema,
  })
  .strict();

const designPrimersPairsItemsSchema = z
  .object({
    rank: z.number(),
    forward: designPrimersPairsItemsForwardSchema,
    reverse: designPrimersPairsItemsForwardSchema,
    productSize: z.number(),
    pairAnyTh: z.number(),
    pairEndTh: z.number(),
    penalty: z.number(),
  })
  .strict();

const designPrimersTargetSchema = z
  .object({
    projectId: z.string().optional(),
    documentId: z.string(),
    sequenceId: z.number(),
    length: z.number(),
    topology: z.union([z.literal('circular'), z.literal('linear')]),
    fileContentHash: z.string(),
    normalizedSequenceHash: z.string(),
    start: z.number(),
    end: z.number(),
    wrapsOrigin: z.boolean(),
    coordinateSystem: z.string(),
  })
  .strict();

const designPrimersVariant2Schema = z
  .object({
    designed: z.literal(true),
    designId: z.string(),
    target: designPrimersTargetSchema,
    application: z.union([
      z.literal('gibson'),
      z.literal('pcr'),
      z.literal('sequencing'),
      z.literal('qpcr'),
      z.literal('colony_pcr'),
      z.literal('golden_gate'),
      z.literal('sdm'),
      z.literal('re_cloning'),
    ]),
    warnings: z.array(z.string()),
    parameters: recordVariant1Schema,
    pairs: z.array(designPrimersPairsItemsSchema),
    ok: z.literal(true),
  })
  .strict();

const designPrimersSchema = z
  .object({
    designed: z.literal(false),
    code: z.string(),
    message: z.string(),
    warnings: z.array(z.string()),
    parameters: recordVariant1Schema,
    ok: z.literal(true),
  })
  .strict();

const planDesignRegionsRegionsItemsReplacementRetainedRangeSchema = z
  .object({
    start: z.number(),
    end: z.number(),
    wraps: z.boolean(),
    length: z.number(),
  })
  .strict();

const plannedRegionSchema = z
  .object({
    label: z.string(),
    start: z.number(),
    end: z.number(),
    length: z.number(),
    source: z.union([z.literal('feature'), z.literal('window')]),
    reason: z.string(),
    featureType: z.string().optional(),
    featureName: z.string().optional(),
    replacementRetainedRange:
      planDesignRegionsRegionsItemsReplacementRetainedRangeSchema.optional(),
  })
  .strict();

const planDesignRegionsSchema = z
  .object({
    planned: z.literal(true),
    documentId: z.string(),
    resourceUri: z.string(),
    name: z.string(),
    format: z.union([z.literal('fasta'), z.literal('genbank'), z.literal('gff3')]),
    circular: z.boolean().optional(),
    length: z.number(),
    featureCount: z.number(),
    requestedRegionCount: z.number(),
    regionCount: z.number(),
    strategy: z.string(),
    regions: z.array(plannedRegionSchema),
    ok: z.literal(true),
  })
  .strict();

const validationErrorSchema = z
  .object({
    code: z.string(),
    severity: z.union([z.literal('error'), z.literal('warning')]),
    message: z.string(),
    field: z.string().optional(),
    fragmentIndex: z.number().optional(),
  })
  .strict();

const draftDesignAssemblySchema = z
  .object({
    designId: z.string(),
    drafted: z.literal(true),
    designName: z.string(),
    assemblyMethod: z.union([z.literal('gibson'), z.literal('nebuilder'), z.literal('goldengate')]),
    assemblyState: z.union([
      z.literal('assembled'),
      z.literal('preflight'),
      z.literal('drafting'),
      z.literal('validating'),
      z.literal('ready'),
      z.literal('running'),
    ]),
    status: z.union([z.literal('draft'), z.literal('computed'), z.literal('assembled')]).optional(),
    version: z.number(),
    previousVersion: z.number(),
    regionCount: z.number(),
    homologyRegionCount: z.number(),
    goldenGateJunctionCount: z.number(),
    primerPairCount: z.number(),
    tmResolution: draftDesignAssemblyTmResolutionSchema,
    validationErrorCount: z.number(),
    validationErrors: z.array(validationErrorSchema),
    changedFields: z.array(z.string()),
    mutation: agentMutationClaimSchema,
    ok: z.literal(true),
  })
  .strict();

const addDesignRegionSchema = z
  .object({
    designId: z.string(),
    regionId: z.string(),
    designName: z.string(),
    sourceDocumentId: z.string(),
    sourceSequenceName: z.string(),
    sourceStart: z.number(),
    sourceEnd: z.number(),
    sourceStart1Indexed: z.number(),
    sourceEnd1Indexed: z.number(),
    wraps: z.boolean(),
    length: z.number(),
    sourceLength: z.number(),
    sourceIsCircular: z.boolean(),
    annotationCount: z.number(),
    regionCount: z.number(),
    assemblyState: z.union([
      z.literal('assembled'),
      z.literal('preflight'),
      z.literal('drafting'),
      z.literal('validating'),
      z.literal('ready'),
      z.literal('running'),
    ]),
    version: z.number(),
    previousVersion: z.number(),
    mutation: agentMutationClaimSchema,
    ok: z.literal(true),
  })
  .strict();

const createDesignArtifactOpenActionSchema = z
  .object({
    tool: z.string(),
    type: z.string(),
    entityId: z.string(),
    label: z.string(),
  })
  .strict();

const createDesignArtifactSchema = z
  .object({
    type: z.string(),
    designId: z.string(),
    name: z.string(),
    resourceUri: z.string(),
    openAction: createDesignArtifactOpenActionSchema,
  })
  .strict();

const createDesignSchema = z
  .object({
    designId: z.string(),
    destinationProject: z.union([z.null(), z.string()]),
    name: z.string(),
    assemblyMethod: z.union([z.literal('gibson'), z.literal('nebuilder'), z.literal('goldengate')]),
    goldenGateEnzyme: z.union([
      z.null(),
      z.literal('BsaI'),
      z.literal('BbsI'),
      z.literal('BsmBI'),
      z.literal('SapI'),
    ]),
    opened: z.boolean(),
    tabId: z.union([z.null(), z.string()]),
    resourceUri: z.string(),
    artifact: createDesignArtifactSchema,
    mutation: agentMutationClaimSchema,
    ok: z.literal(true),
  })
  .strict();

const getPrimerTmConfigSchema = z
  .object({
    modelId: z.string(),
    model: z.union([configurePrimerTmModelLocalSchema, configurePrimerTmModelNebSchema]),
    ok: z.literal(true),
  })
  .strict();

const configurePrimerTmSchema = z
  .object({
    modelId: z.string(),
    model: z.union([configurePrimerTmModelLocalSchema, configurePrimerTmModelNebSchema]),
    configured: z.literal(true),
    ok: z.literal(true),
  })
  .strict();

export const configurePrimerTmOutputSchema = configurePrimerTmSchema;

export const getPrimerTmConfigOutputSchema = getPrimerTmConfigSchema;

export const createDesignOutputSchema = createDesignSchema;

export const addDesignRegionOutputSchema = addDesignRegionSchema;

export const draftDesignAssemblyOutputSchema = draftDesignAssemblySchema;

export const planDesignRegionsOutputSchema = planDesignRegionsSchema;

export const designPrimersOutputSchema = z.union([
  designPrimersSchema,
  designPrimersVariant2Schema,
]);

export const saveDesignedPrimerOutputSchema = saveDesignedPrimerSchema;

export const listOligoModificationsOutputSchema = listOligoModificationsSchema;

export const createPrimerOutputSchema = createPrimerSchema;

export const updatePrimerOutputSchema = createPrimerSchema;

export const addPrimerBindingOutputSchema = addPrimerBindingSchema;

export const updatePrimerBindingOutputSchema = addPrimerBindingSchema;

export const getPrimerOutputSchema = getPrimerSchema;

export const getDesignOutputSchema = z.union([getDesignHeaderSchema, getDesignDetailSchema]);

export const getConstructLineageOutputSchema = getConstructLineageSchema;

export const getAcceptedAssemblyOutputSchema = getAcceptedAssemblySchema;

export const listHistoricalAssemblyComponentsOutputSchema = listHistoricalAssemblyComponentsSchema;

export const inspectHistoricalAssemblyStageTargetOutputSchema =
  inspectHistoricalAssemblyStageTargetSchema;

export const previewHistoricalAssemblyComponentStageOutputSchema = z.union([
  previewHistoricalAssemblyComponentStageBlockedSchema,
  previewHistoricalAssemblyComponentStageReadySchema,
]);

export const stageHistoricalAssemblyComponentsOutputSchema =
  stageHistoricalAssemblyComponentsSchema;

export const previewFinalizeDesignAssemblyOutputSchema = z.union([
  previewFinalizeDesignAssemblySchema,
  previewFinalizeDesignAssemblyVariant10Schema,
]);

export const finalizeDesignAssemblyOutputSchema = finalizeDesignAssemblySchema;

export const reopenAcceptedAssemblyOutputSchema = reopenAcceptedAssemblyCompletedSchema;

export const setJunctionSpacerOutputSchema = z.union([
  setJunctionSpacerNoopSchema,
  setJunctionSpacerAppliedSchema,
]);

export const setGoldenGateSchemaOutputSchema = setGoldenGateSchemaSchema;

export const getMocloFactoryOutputSchema = getMocloFactoryReadySchema;

export const listMocloSchemasOutputSchema = listMocloSchemasReadySchema;

export const saveMocloSchemaOutputSchema = saveMocloSchemaSavedSchema;

export const getMocloKitOutputSchema = z.union([
  getMocloKitReadySchema,
  getMocloKitReadyVariant11Schema,
]);

export const saveMocloKitOutputSchema = saveMocloKitSavedSchema;

export const setMocloFactoryStageOutputSchema = setMocloFactoryStageSchema;

export const applyMocloSchemaOutputSchema = applyMocloSchemaSchema;

export const searchMocloPartsOutputSchema = searchMocloPartsReadySchema;

export const virtualDigestOutputSchema = virtualDigestSchema;

export const setPrimerPbsLengthOutputSchema = setPrimerPbsLengthAppliedSchema;

export const setPrimerOverhangLengthOutputSchema = setPrimerOverhangLengthAppliedSchema;

export const setGoldenGateOffsetOutputSchema = z.union([
  setGoldenGateOffsetNoopSchema,
  setGoldenGateOffsetAppliedSchema,
]);

export const setPcrPolymeraseOutputSchema = z.union([
  setPcrPolymeraseNoopSchema,
  setPcrPolymeraseAppliedSchema,
]);

export const removeDesignRegionOutputSchema = removeDesignRegionAppliedSchema;

export const reorderDesignRegionsOutputSchema = reorderDesignRegionsAppliedSchema;

export const planOverhangOptimizationOutputSchema = planOverhangOptimizationOkSchema;

export const applyOverhangOptimizationOutputSchema = z.union([
  applyOverhangOptimizationNoopSchema,
  applyOverhangOptimizationAppliedSchema,
]);

export const assemblyListEditableFieldsOutputSchema = assemblyListEditableFieldsSchema;

export const assemblySetEditableFieldOutputSchema = z.union([
  assemblySetEditableFieldNoopSchema,
  assemblySetEditableFieldAppliedSchema,
]);

const placementFields = {
  ok: z.literal(true),
  designId: z.string(),
  mode: z.enum(['fill_empty', 'replace', 'insert_before', 'insert_after']),
  idempotencyKey: z.string(),
  placedRegionId: z.string(),
  placedOccupantFingerprint: z.string(),
  slotsBefore: z.array(assemblySlotViewSchema),
  slots: z.array(assemblySlotViewSchema),
  gapsBefore: z.array(assemblyGapViewSchema),
  gaps: z.array(assemblyGapViewSchema),
  movedSpacers: z.array(
    z.object({ spacerId: z.string(), wasBetween: z.string(), nowBetween: z.string() }).strict()
  ),
  replaced: z
    .object({
      regionId: z.string(),
      label: z.string(),
      length: z.number(),
      ggType: z.string().nullable(),
      rdSourceEnzyme: z.string().nullable(),
    })
    .strict()
    .nullable(),
  previousVersion: z.number(),
  designVersion: z.number(),
  versionGuardApplied: z.boolean(),
  revalidationRequired: z.boolean(),
  adoptedGoldenGateEnzyme: z.string().nullable(),
  mutation: agentMutationClaimSchema,
};

export const placeDigestFragmentOutputSchema = z.union([
  z.object({ ...placementFields, status: z.literal('applied'), applied: z.literal(true) }).strict(),
  z
    .object({
      ...placementFields,
      status: z.literal('noop'),
      applied: z.literal(false),
      idempotentReplay: z.literal(true),
      existingRegionId: z.string().nullable(),
    })
    .strict(),
]);
