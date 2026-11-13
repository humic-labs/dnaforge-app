import { userMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import type {
  DesignSpacer,
  AssemblyWorkbenchPrimerEditIntent,
  AssemblyMethod,
  DesignAnnotation,
  DesignPrimer,
  DesignPrimerPair,
  GoldenGateEnzyme,
  GoldenGateJunction,
  SequenceDesign,
} from '../design/public/types';
import { getComposedSequence } from '../design/public/types';
import { IUPAC_EXPANSION } from '@waypoint/sequence-utils';
import { parseIdtOligoNotation } from '../primers/public/oligo-modifications';
import { anchorForGap } from '../design/public/spacer-invariants';
import {
  getEffectiveDesignRegions,
  isHomologyAssemblyMethod,
  isRestrictionDigestRegion,
} from '../design/public/restriction-digest';
import { switchAssemblyMethodPreservingDraft } from '../design/public/assembly-method-drafts';
import {
  calculateGcContent,
  calculateNewEncodingForOverhang,
  computeDraftAssembly,
  computeGoldenGatePrimers,
  estimateTm,
  forwardSpacerIsSeparateCargo,
  isGoldenGateJunctionOffsetLocked,
  isPalindrome,
  recomputeHomologyMetadata,
  recomputePrimers,
  primerPbsLengthRange,
  updatePrimerOverhangFromHomology,
  updatePrimerPbsLength,
  updatePrimerPbsWindow,
} from '../design/public/algorithms/draft-assembly';
import { createAppTmCalculator, useSettingsStore } from './settings';

const defaultPcrTm = (): number => useSettingsStore.getState().defaultPcrTm;
const appTm = (design: SequenceDesign) => createAppTmCalculator(design.pcrPolymerase);
import type {
  AssemblyWorkbenchCommand,
  AssemblyWorkbenchCommandError,
  AssemblyWorkbenchCommandResult,
  AssemblyWorkbenchSourceContext,
  AssemblyWorkbenchViewState,
} from './AssemblyWorkbenchContract';
import {
  GOLDEN_GATE_OFFSET_LIMIT_MAX_BP,
  GOLDEN_GATE_OFFSET_LIMIT_MIN_BP,
  goldenGateOffsetLimitBp,
} from './AssemblyWorkbenchContract';
import { buildAssemblyOptimizationInput } from '../assembly/public/assembly-optimization-input';
import {
  applyStablePrimerIds,
  computeJunctionCount,
  ensureAssemblyWorkbenchIdentity,
  getJunctionIdentity,
  getPrimerIdentity,
  reconcileAssemblyWorkbenchState,
} from './AssemblyWorkbenchIdentity';
import { validateHomologyEncodingForJunction } from './HomologyJunctionEditabilityContract';
import { planGoldenGateAutoOptimization } from './AssemblyWorkbenchAutoOptimizer';

const OVERHANG_MIN = 0;
const OVERHANG_MAX = 60;
const SPACER_MAX = 500;

export interface ApplyAssemblyWorkbenchCommandInput {
  design: SequenceDesign;
  viewState: AssemblyWorkbenchViewState;
  sourceContext?: AssemblyWorkbenchSourceContext;
  command: AssemblyWorkbenchCommand;
  now?: Date;
}

export function createAssemblyWorkbenchViewState(
  design: SequenceDesign
): AssemblyWorkbenchViewState {
  const normalized = ensureAssemblyWorkbenchIdentity(design);
  const selectedJunctionIndex = resolveInitialSelectedJunctionIndex(normalized);
  const selectedJunctionId =
    typeof selectedJunctionIndex === 'number'
      ? (normalized.assemblyWorkbench?.junctions.find(
          (junction) => junction.slot === selectedJunctionIndex
        )?.id ?? null)
      : null;

  return {
    selectedJunctionId,
    selectedJunctionIndex,
  };
}

export function applyAssemblyWorkbenchCommand({
  design,
  viewState,
  sourceContext,
  command,
  now = new Date(),
}: ApplyAssemblyWorkbenchCommandInput): AssemblyWorkbenchCommandResult<SequenceDesign> {
  const normalizedDesign = ensureAssemblyWorkbenchIdentity(design);
  const normalizedViewState = normalizeViewState(normalizedDesign, viewState);

  if (command.type === 'selectJunction') {
    return applySelectJunction(normalizedDesign, normalizedViewState, command);
  }

  const versionError = validateExpectedVersion(normalizedDesign, command);
  if (versionError) {
    return rejected(normalizedDesign, normalizedViewState, command, versionError);
  }

  switch (command.type) {
    case 'setAssemblyMode':
      return applied(
        maybeDraftAfterModeChange(
          applyAssemblyMode(normalizedDesign, command.method, command.enzyme, now),
          command.draft,
          now
        ),
        normalizedViewState,
        command
      );
    case 'setGoldenGateEnzyme':
      return applied(
        maybeDraftAfterModeChange(
          applyAssemblyMode(normalizedDesign, 'goldengate', command.enzyme, now),
          command.draft,
          now
        ),
        normalizedViewState,
        command
      );
    case 'draftAssembly':
      return applied(applyDraftAssembly(normalizedDesign, now), normalizedViewState, command);
    case 'setGoldenGateOffsetLimit':
      return applyGoldenGateOffsetLimit(normalizedDesign, normalizedViewState, command, now);
    case 'setGoldenGateOffset':
      return applyGoldenGateOffset(normalizedDesign, normalizedViewState, command, now);
    case 'setHomologyEncoding':
      return applyHomologyEncoding(normalizedDesign, normalizedViewState, command, now);
    case 'setJunctionSpacer':
      return applyJunctionSpacer(normalizedDesign, normalizedViewState, command, now);
    case 'setSourceContributionBoundary':
      return applySourceContributionBoundary(
        normalizedDesign,
        normalizedViewState,
        sourceContext,
        command,
        now
      );
    case 'setPrimerPbsLength':
      return applyPrimerPbsLength(normalizedDesign, normalizedViewState, command, now);
    case 'setPrimerOverhangLength':
      return applyPrimerOverhangLength(normalizedDesign, normalizedViewState, command, now);
    case 'setPrimerContent':
      return applyPrimerContent(normalizedDesign, normalizedViewState, command, now);
    case 'applyProposal':
      if (command.command.type === 'applyProposal' || command.command.type === 'autoOptimize') {
        return rejected(normalizedDesign, normalizedViewState, command, {
          code: 'unsupported-command',
          message: 'Proposal commands cannot recursively apply proposals or run auto optimization.',
          commandType: command.type,
        });
      }
      return applyAssemblyWorkbenchCommand({
        design: normalizedDesign,
        viewState: normalizedViewState,
        sourceContext,
        command: {
          ...command.command,
          expectedDesignVersion: command.expectedDesignVersion,
        } as AssemblyWorkbenchCommand,
        now,
      });
    case 'autoOptimize':
      return applyAutoOptimize(normalizedDesign, normalizedViewState, command, now);
  }
}

function applySelectJunction(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: Extract<AssemblyWorkbenchCommand, { type: 'selectJunction' }>
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  if (command.junctionId === null || command.junctionIndex === null) {
    return applied(design, { selectedJunctionId: null, selectedJunctionIndex: null }, command);
  }

  const junction = getJunctionIdentity(design, command);
  if (!junction) {
    return rejected(design, viewState, command, {
      code: 'invalid-command-target',
      message: 'The selected junction target does not exist.',
      commandType: command.type,
      targetId: command.junctionId ?? undefined,
    });
  }

  return applied(
    design,
    {
      selectedJunctionId: junction.id,
      selectedJunctionIndex: junction.slot,
    },
    command
  );
}

export function restoreAssemblyPrimerEditIntents(
  previous: SequenceDesign,
  computed: SequenceDesign
): SequenceDesign {
  let restored = ensureAssemblyWorkbenchIdentity(computed);
  for (const intent of previous.assemblyWorkbench?.primerEditIntents ?? []) {
    if (intent.field !== 'pbsLength' && !isHomologyAssemblyMethod(restored.assemblyMethod))
      continue;
    const fragmentIndex = restored.regions.findIndex((region) => region.id === intent.regionId);
    if (fragmentIndex < 0) continue;
    const pair = restored.designPrimers.find(
      (candidate) => candidate.fragmentIndex === fragmentIndex
    );
    const primer = pair?.[intent.direction];
    if (!primer || primer.manuallyEdited) continue;
    const homology = restored.homologyRegions.find(
      (candidate) => candidate.junctionIndex === primer.junctionIndex
    );
    if (intent.field === 'homologyLength' && !homology) continue;
    const command: AssemblyWorkbenchCommand =
      intent.field === 'homologyLength' && homology
        ? {
            type: 'setHomologyEncoding',
            junctionIndex: homology.junctionIndex,
            encoding: {
              ...homology.encoding,
              [primer.direction === 'forward' ? 'onLeft' : 'onRight']: intent.length,
            },
            recomputePrimers: true,
            expectedDesignVersion: restored.version,
          }
        : {
            type: intent.field === 'pbsLength' ? 'setPrimerPbsLength' : 'setPrimerOverhangLength',
            primerId: primer.id,
            length: intent.length,
            expectedDesignVersion: restored.version,
          };
    const result = applyAssemblyWorkbenchCommand({
      design: restored,
      viewState: createAssemblyWorkbenchViewState(restored),
      command,
      now: computed.updatedAt,
    });
    if (result.status === 'rejected')
      throw new Error(
        `Cannot preserve ${primer.name} ${intent.field}: ${result.errors.map((error) => error.message).join('; ')}`
      );
    restored = result.nextDesign;
  }
  return {
    ...restored,
    version: computed.version,
    updatedAt: computed.updatedAt,
    assemblyWorkbench: {
      ...restored.assemblyWorkbench!,
      primerEditIntents: previous.assemblyWorkbench?.primerEditIntents ?? [],
    },
  };
}

function applyAssemblyMode(
  design: SequenceDesign,
  method: AssemblyMethod,
  enzyme: GoldenGateEnzyme | undefined,
  now: Date
): SequenceDesign {
  return withWorkbenchIdentity(
    switchAssemblyMethodPreservingDraft({
      design,
      method,
      enzyme,
      version: nextVersion(design),
      now,
    })
  );
}

function applyDraftAssembly(design: SequenceDesign, now: Date): SequenceDesign {
  if (design.regions.length < 2) return design;
  const draft = computeDraftAssembly(design, defaultPcrTm(), appTm(design));
  const nextDesign = withWorkbenchIdentity({
    ...design,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
    goldenGateJunctions:
      design.assemblyMethod === 'goldengate' ? (draft.goldenGateJunctions ?? []) : undefined,
    assemblyState: 'ready',
    status: 'computed',
    validationErrors: [],
    assemblyWorkbench: {
      ...reconcileAssemblyWorkbenchState(design),
      autoDraftPrimers: true,
    },
    version: nextVersion(design),
    updatedAt: now,
  });
  const restored = {
    ...nextDesign,
    designPrimers: restorePrimerPbsLengths(nextDesign, nextDesign.designPrimers, design),
  };
  return refreshHomologyPrimerOverhangs(restored);
}

function maybeDraftAfterModeChange(
  design: SequenceDesign,
  draft: boolean | undefined,
  now: Date
): SequenceDesign {
  if (draft === false || design.assemblyState === 'ready') return design;
  return applyDraftAssembly(design, now);
}

function applyGoldenGateOffset(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: Extract<AssemblyWorkbenchCommand, { type: 'setGoldenGateOffset' }>,
  now: Date
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  if (design.assemblyMethod !== 'goldengate') {
    return rejectedUnsupportedMode(
      design,
      viewState,
      command,
      'Golden Gate offsets require Golden Gate mode.'
    );
  }
  const offsetLimit = goldenGateOffsetLimitBp(design.goldenGateConfig);
  if (!Number.isInteger(command.offset) || Math.abs(command.offset) > offsetLimit) {
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      `Offset must be -${offsetLimit}..${offsetLimit}.`
    );
  }
  if (!design.goldenGateJunctions || !design.goldenGateConfig) {
    return rejectedInvalidTarget(
      design,
      viewState,
      command,
      'No Golden Gate junctions are available.'
    );
  }

  const identity = getJunctionIdentity(design, command);
  const junction = identity
    ? design.goldenGateJunctions.find((item) => item.junctionIndex === identity.slot)
    : null;
  if (!identity || !junction) {
    return rejectedInvalidTarget(
      design,
      viewState,
      command,
      'The Golden Gate junction target does not exist.'
    );
  }
  if (isGoldenGateJunctionOffsetLocked(junction)) {
    return rejected(design, viewState, command, {
      code: 'fixed-goldengate-junction',
      message: 'Restriction-digest fixed Golden Gate overhangs cannot be offset-edited.',
      commandType: command.type,
      targetId: identity.id,
    });
  }
  if (command.offset === junction.offset) return noop(design, viewState);

  const composedSequence = getComposedSequence(design.regions, design.spacers);
  const updatedJunctions = design.goldenGateJunctions.map((item) => {
    if (item.junctionIndex !== identity.slot) return item;
    return withGoldenGateJunctionOffset(item, command.offset, composedSequence);
  });

  const goldenGateJunctions = validateGoldenGateJunctions(updatedJunctions);
  const designPrimers = restorePrimerPbsLengths(
    design,
    computeGoldenGatePrimers(
      design.regions,
      goldenGateJunctions,
      design.topology,
      design.goldenGateConfig.enzyme,
      design.spacers,
      design.primerDesignConstraints?.targetPcrTm ?? defaultPcrTm(),
      appTm(design)
    )
  );

  return applied(
    withWorkbenchIdentity({
      ...design,
      goldenGateJunctions,
      designPrimers,
      version: nextVersion(design),
      updatedAt: now,
    }),
    viewState,
    command
  );
}

function applyGoldenGateOffsetLimit(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: Extract<AssemblyWorkbenchCommand, { type: 'setGoldenGateOffsetLimit' }>,
  now: Date
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  if (design.assemblyMethod !== 'goldengate') {
    return rejectedUnsupportedMode(
      design,
      viewState,
      command,
      'Golden Gate offset limits require Golden Gate mode.'
    );
  }

  if (
    !Number.isInteger(command.limit) ||
    command.limit < GOLDEN_GATE_OFFSET_LIMIT_MIN_BP ||
    command.limit > GOLDEN_GATE_OFFSET_LIMIT_MAX_BP
  ) {
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      `Offset limit must be ${GOLDEN_GATE_OFFSET_LIMIT_MIN_BP}..${GOLDEN_GATE_OFFSET_LIMIT_MAX_BP} bp.`
    );
  }

  const currentMaxOffset = Math.max(
    0,
    ...(design.goldenGateJunctions ?? []).map((junction) => Math.abs(junction.offset))
  );
  if (command.limit < currentMaxOffset) {
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      `Offset limit must be at least ${currentMaxOffset} bp to preserve the current Golden Gate junction offsets.`
    );
  }

  const currentLimit = goldenGateOffsetLimitBp(design.goldenGateConfig);
  if (command.limit === currentLimit) return noop(design, viewState);

  return applied(
    withWorkbenchIdentity({
      ...design,
      goldenGateConfig: {
        enzyme: design.goldenGateConfig?.enzyme ?? 'BsaI',
        ...design.goldenGateConfig,
        offsetLimitBp: command.limit,
      },
      version: nextVersion(design),
      updatedAt: now,
    }),
    viewState,
    command
  );
}

function applyHomologyEncoding(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: Extract<AssemblyWorkbenchCommand, { type: 'setHomologyEncoding' }>,
  now: Date
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  if (!isHomologyAssemblyMethod(design.assemblyMethod)) {
    return rejectedUnsupportedMode(
      design,
      viewState,
      command,
      'Homology encoding requires a homology assembly mode.'
    );
  }

  const identity = getJunctionIdentity(design, command);
  const homology = identity
    ? design.homologyRegions.find((item) => item.junctionIndex === identity.slot)
    : null;
  if (!identity || !homology) {
    return rejectedInvalidTarget(
      design,
      viewState,
      command,
      'The homology junction target does not exist.'
    );
  }
  if (!Number.isInteger(command.encoding.onLeft) || !Number.isInteger(command.encoding.onRight)) {
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      'Homology encoding values must be integers.'
    );
  }
  if (command.encoding.onLeft + command.encoding.onRight < 0) {
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      'Homology boundaries must define a non-negative product overlap length.'
    );
  }
  const biologicalContractError = validateHomologyEncodingForJunction({
    design,
    junctionIndex: identity.slot,
    encoding: command.encoding,
    currentEncoding: homology.encoding,
  });
  if (biologicalContractError) {
    return rejectedInvalidValue(design, viewState, command, biologicalContractError);
  }

  const assemblyRegions = getEffectiveDesignRegions(design);
  const composedSequence = getComposedSequence(assemblyRegions, design.spacers);
  const homologyRegions = design.homologyRegions.map((item) =>
    item.junctionIndex === identity.slot
      ? recomputeHomologyMetadata(
          { ...item, encoding: command.encoding },
          composedSequence,
          item.encoding
        )
      : item
  );
  let designPrimers = design.designPrimers;
  if (command.recomputePrimers !== false) {
    const restored = restorePrimerPbsLengths(
      { ...design, homologyRegions },
      recomputePrimers(
        assemblyRegions,
        homologyRegions,
        design.topology,
        design.spacers,
        appTm(design),
        design.primerDesignConstraints?.targetPcrTm
      ),
      design
    );
    const pbsAdjusted = applySignedHomologyPrimerPbsWindows({
      ...design,
      homologyRegions,
      designPrimers: restored,
    });
    if (!pbsAdjusted) {
      return rejectedInvalidValue(
        design,
        viewState,
        command,
        'Homology boundary would consume more bases than the current primer binding site provides.'
      );
    }
    designPrimers = refreshHomologyPrimerOverhangs(pbsAdjusted).designPrimers;
  }

  let next = withWorkbenchIdentity({
    ...design,
    homologyRegions,
    designPrimers,
    version: nextVersion(design),
    updatedAt: now,
  });
  for (const pair of next.designPrimers) {
    for (const primer of [pair.forward, pair.reverse]) {
      if (primer.junctionIndex !== identity.slot) continue;
      next = withPrimerEditIntent(
        next,
        primer,
        'homologyLength',
        command.encoding[primer.direction === 'forward' ? 'onLeft' : 'onRight']
      );
    }
  }
  return applied(next, viewState, command);
}

function applyJunctionSpacer(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: Extract<AssemblyWorkbenchCommand, { type: 'setJunctionSpacer' }>,
  now: Date
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  const identity = getJunctionIdentity(design, command);
  if (!identity) {
    return rejectedInvalidTarget(
      design,
      viewState,
      command,
      'The spacer junction target does not exist.'
    );
  }

  const normalizedSequence = normalizeSpacerSequence(command.sequence);
  if (normalizedSequence === null) {
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      'Spacer sequence must contain only IUPAC nucleotide bases.'
    );
  }
  if (normalizedSequence.length > SPACER_MAX) {
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      `Spacer sequence must be ${SPACER_MAX} bp or shorter.`
    );
  }

  const existing = design.spacers.find((spacer) => spacer.junctionIndex === identity.slot);
  const otherSpacers = design.spacers.filter((spacer) => spacer.junctionIndex !== identity.slot);
  const requestedName = command.name === null ? undefined : command.name;

  if (normalizedSequence.length === 0) {
    if (!existing) return noop(design, viewState);
    return applied(
      redraftAfterSpacerChange(
        {
          ...design,
          spacers: sortSpacers(otherSpacers),
          assemblyResult: undefined,
          version: nextVersion(design),
          updatedAt: now,
        },
        design
      ),
      viewState,
      command
    );
  }

  const nextSpacer: DesignSpacer = {
    id: existing?.id ?? stableSpacerId(design.id, identity.id),
    junctionIndex: identity.slot,

    ...(anchorForGap(design.regions, identity.slot)
      ? { anchor: anchorForGap(design.regions, identity.slot) }
      : {}),
    sequence: normalizedSequence,
    ...(command.name !== undefined
      ? { name: requestedName }
      : existing?.name
        ? { name: existing.name }
        : {}),
  };

  const nameUnchanged =
    command.name === undefined || (existing?.name ?? undefined) === requestedName;
  if (
    existing &&
    existing.sequence === nextSpacer.sequence &&
    nameUnchanged &&
    otherSpacers.length === design.spacers.length - 1
  ) {
    return noop(design, viewState);
  }

  return applied(
    redraftAfterSpacerChange(
      {
        ...design,
        spacers: sortSpacers([...otherSpacers, nextSpacer]),
        assemblyResult: undefined,
        version: nextVersion(design),
        updatedAt: now,
      },
      design
    ),
    viewState,
    command
  );
}

function applySourceContributionBoundary(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  sourceContext: AssemblyWorkbenchSourceContext | undefined,
  command: Extract<AssemblyWorkbenchCommand, { type: 'setSourceContributionBoundary' }>,
  now: Date
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  if (!Number.isInteger(command.sourcePosition)) {
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      'Source contribution boundary must be an integer source coordinate.'
    );
  }

  const regionIndex = design.regions.findIndex((region) => region.id === command.regionId);
  if (regionIndex === -1) {
    return rejectedInvalidTarget(
      design,
      viewState,
      command,
      'The source contribution region target does not exist.'
    );
  }

  const region = design.regions[regionIndex];
  if (isRestrictionDigestRegion(region)) {
    return rejectedUnsupportedMode(
      design,
      viewState,
      command,
      'Restriction-digest physical ends require method-specific resection edits.'
    );
  }

  const material = resolveSourceMaterial(region, sourceContext);
  if (!material) {
    return rejected(design, viewState, command, {
      code: 'missing-source-context',
      message: 'Source contribution boundary edits require source sequence context.',
      commandType: command.type,
      targetId: command.regionId,
    });
  }

  const nextStart = command.side === 'upstream' ? command.sourcePosition : region.sourceStart;
  const nextEnd = command.side === 'downstream' ? command.sourcePosition : region.sourceEnd;

  if (nextStart === region.sourceStart && nextEnd === region.sourceEnd) {
    return noop(design, viewState);
  }

  const rangeError = validateRequestedSourceRange(material, nextStart, nextEnd);
  if (rangeError) {
    return rejected(design, viewState, command, {
      code: rangeError.code,
      message: rangeError.message,
      commandType: command.type,
      targetId: command.regionId,
    });
  }

  const nextSequence = sliceSourceMaterial(material, nextStart, nextEnd);
  if (nextSequence === null) {
    return rejected(design, viewState, command, {
      code: 'source-window-too-small',
      message: 'Loaded source context does not cover the requested source boundary.',
      commandType: command.type,
      targetId: command.regionId,
    });
  }

  const nextRegion = {
    ...region,
    sourceStart: nextStart,
    sourceEnd: nextEnd,
    sequence: nextSequence,
    annotations: sliceSourceAnnotations(
      sourceAnnotationsForMaterial(region, material),
      nextStart,
      nextEnd
    ),
  };
  const regions = [...design.regions];
  regions[regionIndex] = nextRegion;

  return applied(
    redraftAfterRegionSequenceChange(
      {
        ...design,
        regions,
        assemblyResult: undefined,
        version: nextVersion(design),
        updatedAt: now,
      },
      design
    ),
    viewState,
    command
  );
}

function applyPrimerContent(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: Extract<AssemblyWorkbenchCommand, { type: 'setPrimerContent' }>,
  now: Date
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  const identity = getPrimerIdentity(design, command);
  const current = identity ? findPrimerById(design.designPrimers, identity.id)?.primer : undefined;
  if (!identity || !current) {
    return rejectedInvalidTarget(design, viewState, command, 'The primer target does not exist.');
  }
  if (
    [
      command.name,
      command.pbsSequence,
      command.overhangSequence,
      command.pbsStart,
      command.pbsEnd,
      command.oligo,
    ].every((value) => value === undefined)
  ) {
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      'Provide at least one primer field to change.'
    );
  }
  let pbsSequence = command.pbsSequence ?? current.pbs.sequence;
  let overhangSequence =
    command.overhangSequence ??
    current.goldenGateOverhang?.fullSequence ??
    current.overhang.sequence;
  let composition = current.oligo;
  if (command.oligo) {
    const parsed = parseIdtOligoNotation(command.oligo.notation, {
      orderType: command.oligo.orderType ?? 'dna',
    });
    if (parsed.errors.length > 0)
      return rejectedInvalidValue(design, viewState, command, parsed.errors.join(' '));
    const length =
      command.annealingLength ?? Math.min(current.pbs.sequence.length, parsed.bases.length);
    if (!Number.isInteger(length) || length < 1 || length > parsed.bases.length)
      return rejectedInvalidValue(
        design,
        viewState,
        command,
        'The annealing length must fit within the authored oligo.'
      );
    const split = parsed.bases.length - length;
    pbsSequence = parsed.bases.slice(split);
    overhangSequence = parsed.bases.slice(0, split);
    if (
      (command.pbsSequence !== undefined && command.pbsSequence !== pbsSequence) ||
      (command.overhangSequence !== undefined && command.overhangSequence !== overhangSequence)
    )
      return rejectedInvalidValue(
        design,
        viewState,
        command,
        'The explicit segments disagree with the authored oligo.'
      );
    composition = parsed.composition ?? undefined;
  } else if (command.pbsSequence !== undefined || command.overhangSequence !== undefined) {
    composition = undefined;
  }
  if (
    !/^[ACGTURYSWKMBDHVN]+$/i.test(pbsSequence) ||
    !/^[ACGTURYSWKMBDHVN]*$/i.test(overhangSequence)
  ) {
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      'Primer segments must contain valid IUPAC DNA bases.'
    );
  }
  if (command.name !== undefined && !command.name.trim()) {
    return rejectedInvalidValue(design, viewState, command, 'A primer name cannot be empty.');
  }
  const scientificEdit = [
    command.pbsSequence,
    command.overhangSequence,
    command.pbsStart,
    command.pbsEnd,
    command.oligo,
  ].some((value) => value !== undefined);
  if (!scientificEdit) {
    return applied(
      {
        ...design,
        designPrimers: mapPrimer(design, identity.id, (primer) => ({
          ...primer,
          name: command.name ?? primer.name,
          manuallyNamed: true,
        })),
        version: nextVersion(design),
        updatedAt: now,
      },
      viewState,
      command
    );
  }
  const start =
    command.pbsStart ??
    (current.direction === 'reverse' && command.pbsEnd === undefined
      ? Math.max(0, current.pbs.end - pbsSequence.length)
      : current.pbs.start);
  const end =
    command.pbsEnd ??
    (current.direction === 'reverse' && command.pbsStart === undefined
      ? current.pbs.end
      : start + pbsSequence.length);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      'Binding coordinates must be nonnegative integers with end greater than start.'
    );
  }
  const changed: DesignPrimer = {
    ...current,
    name: command.name ?? current.name,
    sequence: overhangSequence + pbsSequence,
    pbs: { start, end, sequence: pbsSequence },
    overhang: {
      length: overhangSequence.length,
      tailLength: overhangSequence.length,
      sequence: overhangSequence,
    },
    manuallyEdited: true,
    manuallyNamed: command.name !== undefined || current.manuallyNamed,
    tm: composition?.orderType === 'rna' ? undefined : appTm(design).estimate(pbsSequence),
    tmProvenance: undefined,
    goldenGateOverhang: undefined,
    cognate4bpLength: undefined,
    synthetic4bpSpacerLength: undefined,
    oligo: composition,
  };
  return applied(
    {
      ...design,
      designPrimers: mapPrimer(design, identity.id, () => changed),
      assemblyResult: undefined,
      version: nextVersion(design),
      updatedAt: now,
    },
    viewState,
    command
  );
}

function applyPrimerPbsLength(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: Extract<AssemblyWorkbenchCommand, { type: 'setPrimerPbsLength' }>,
  now: Date
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  const identity = getPrimerIdentity(design, command);
  if (!identity) {
    return rejectedInvalidTarget(design, viewState, command, 'The primer target does not exist.');
  }
  const current = findPrimerById(design.designPrimers, identity.id);
  if (!current) {
    return rejectedInvalidTarget(design, viewState, command, 'The primer target does not exist.');
  }

  const assemblyRegions = getEffectiveDesignRegions(design);
  const pbsRange = primerPbsLengthRange(current.primer, assemblyRegions, design.spacers);
  if (
    !Number.isInteger(command.length) ||
    command.length < pbsRange.min ||
    command.length > pbsRange.max
  ) {
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      `PBS length must be ${pbsRange.min}..${pbsRange.max} bp for this primer's available template.`
    );
  }
  const designPrimers = mapPrimer(design, identity.id, (primer) =>
    updatePrimerPbsLength(primer, command.length, assemblyRegions, design.spacers, appTm(design))
  );

  return applied(
    withPrimerEditIntent(
      withWorkbenchIdentity({
        ...design,
        designPrimers,
        version: nextVersion(design),
        updatedAt: now,
      }),
      current.primer,
      'pbsLength',
      command.length
    ),
    viewState,
    command
  );
}

function applyPrimerOverhangLength(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: Extract<AssemblyWorkbenchCommand, { type: 'setPrimerOverhangLength' }>,
  now: Date
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  if (!isHomologyAssemblyMethod(design.assemblyMethod)) {
    return rejectedUnsupportedMode(
      design,
      viewState,
      command,
      'Primer tail length edits require a homology assembly mode.'
    );
  }
  if (
    !Number.isInteger(command.length) ||
    command.length < OVERHANG_MIN ||
    command.length > OVERHANG_MAX
  ) {
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      `Primer tail length must be ${OVERHANG_MIN}..${OVERHANG_MAX} bp.`
    );
  }

  const identity = getPrimerIdentity(design, command);
  if (!identity) {
    return rejectedInvalidTarget(design, viewState, command, 'The primer target does not exist.');
  }

  const current = findPrimerById(design.designPrimers, identity.id);
  if (!current || current.primer.junctionIndex === null) {
    return rejectedInvalidTarget(
      design,
      viewState,
      command,
      'The primer has no editable junction tail.'
    );
  }

  const junctionIndex = current.primer.junctionIndex;
  const homologyIndex = design.homologyRegions.findIndex(
    (homology) => homology.junctionIndex === junctionIndex
  );
  if (homologyIndex === -1) {
    return rejectedInvalidTarget(
      design,
      viewState,
      command,
      'The primer junction has no homology region.'
    );
  }

  const homologyRegion = design.homologyRegions[homologyIndex];
  const assemblyRegions = getEffectiveDesignRegions(design);
  const composedSequence = getComposedSequence(assemblyRegions, design.spacers);
  const spacerSeq =
    design.spacers.find((spacer) => spacer.junctionIndex === junctionIndex)?.sequence ?? '';
  const spacerLen = spacerSeq.length;
  const naturalTailLength = naturalHomologyTailLength(
    current.primer.direction,
    homologyRegion,
    spacerLen
  );
  const extendsIntoOwnPbs = command.length > naturalTailLength;
  const { adjustedLength, shouldIncludeSpacer } = adjustedOverhangInput(
    current.primer.direction,
    command.length,
    spacerLen,
    homologyRegion
  );
  const newEncoding = calculateNewEncodingForOverhang(
    homologyRegion.encoding,
    current.primer.direction,
    extendsIntoOwnPbs
      ? homologyEncodingLengthForDirection(current.primer.direction, homologyRegion)
      : adjustedLength
  );
  const updatedHomologyRegion = recomputeHomologyMetadata(
    { ...homologyRegion, encoding: newEncoding },
    composedSequence,
    homologyRegion.encoding
  );
  const homologyRegions = [...design.homologyRegions];
  homologyRegions[homologyIndex] = updatedHomologyRegion;
  const targetPrimerWithPbsEdge = primerWithPbsEdgeForTailLength(
    current.primer,
    updatedHomologyRegion,
    command.length,
    spacerLen,
    assemblyRegions,
    design.spacers,
    appTm(design)
  );
  if (!targetPrimerWithPbsEdge) {
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      'Primer tail length would consume more bases than the current primer binding site provides.'
    );
  }

  const designPrimers = design.designPrimers.map((pair) => {
    const fwdNeedsUpdate = pair.forward.junctionIndex === junctionIndex;
    const revNeedsUpdate = pair.reverse.junctionIndex === junctionIndex;
    if (!fwdNeedsUpdate && !revNeedsUpdate) return pair;

    const forwardForUpdate =
      pair.forward.id === identity.id ? targetPrimerWithPbsEdge : pair.forward;
    const reverseForUpdate =
      pair.reverse.id === identity.id ? targetPrimerWithPbsEdge : pair.reverse;
    const updatedForward = fwdNeedsUpdate
      ? updatePrimerOverhangFromHomology(
          forwardForUpdate,
          updatedHomologyRegion,
          pair.forward.id === identity.id ? shouldIncludeSpacer : true,
          spacerSeq,
          composedSequence,
          pair.forward.id === identity.id
            ? command.length
            : (pair.forward.overhang.tailLength ?? pair.forward.overhang.sequence.length)
        )
      : pair.forward;
    const updatedReverse = revNeedsUpdate
      ? updatePrimerOverhangFromHomology(
          reverseForUpdate,
          updatedHomologyRegion,
          pair.reverse.id === identity.id ? shouldIncludeSpacer : true,
          spacerSeq,
          composedSequence,
          pair.reverse.id === identity.id
            ? command.length
            : (pair.reverse.overhang.tailLength ?? pair.reverse.overhang.sequence.length)
        )
      : pair.reverse;

    return { ...pair, forward: updatedForward, reverse: updatedReverse };
  });

  return applied(
    withPrimerEditIntent(
      withWorkbenchIdentity({
        ...design,
        homologyRegions,
        designPrimers,
        version: nextVersion(design),
        updatedAt: now,
      }),
      current.primer,
      'tailLength',
      command.length
    ),
    viewState,
    command
  );
}

function applyAutoOptimize(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: Extract<AssemblyWorkbenchCommand, { type: 'autoOptimize' }>,
  now: Date
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  const scopedJunctionIndex = autoOptimizeScopeJunctionIndex(viewState, command);
  if (command.scope === 'selected-junction' && scopedJunctionIndex === null) {
    return rejectedInvalidTarget(design, viewState, command, 'No selected junction is available.');
  }

  if (design.assemblyMethod === 'goldengate') {
    return applyGoldenGateAutoOptimize(design, viewState, command, scopedJunctionIndex, now);
  }

  if (isHomologyAssemblyMethod(design.assemblyMethod)) {
    return applyHomologyAutoOptimize(design, viewState, command, scopedJunctionIndex, now);
  }

  return rejectedUnsupportedMode(
    design,
    viewState,
    command,
    'Auto optimization is not available for this assembly mode.'
  );
}

function applyGoldenGateAutoOptimize(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: Extract<AssemblyWorkbenchCommand, { type: 'autoOptimize' }>,
  scopedJunctionIndex: number | null,
  now: Date
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  const baseDesign = ensureGoldenGateDraftForAutoOptimize(design);
  const plan = planGoldenGateAutoOptimization(buildAssemblyOptimizationInput(baseDesign), {
    scopeJunctionIndex: scopedJunctionIndex,
    maxExactSearchNodes: command.maxIterations,
    candidateRank: command.candidateRank,
  });
  if (plan.status === 'unavailable') {
    return rejected(baseDesign, viewState, command, {
      code:
        plan.reason === 'no-four-base-dataset'
          ? 'optimizer-data-unavailable'
          : 'optimizer-search-limit',
      message: plan.message,
      commandType: command.type,
    });
  }
  if (plan.offsetsByJunctionIndex.size === 0 && baseDesign === design) {
    return noop(design, viewState);
  }

  const composedSequence = getComposedSequence(baseDesign.regions, baseDesign.spacers);
  const goldenGateJunctions = validateGoldenGateJunctions(
    (baseDesign.goldenGateJunctions ?? []).map((junction) => {
      const offset = plan.offsetsByJunctionIndex.get(junction.junctionIndex);
      return offset === undefined
        ? junction
        : withGoldenGateJunctionOffset(junction, offset, composedSequence);
    })
  );
  const designPrimers = restorePrimerPbsLengths(
    baseDesign,
    computeGoldenGatePrimers(
      baseDesign.regions,
      goldenGateJunctions,
      baseDesign.topology,
      baseDesign.goldenGateConfig?.enzyme ?? 'BsaI',
      baseDesign.spacers,
      baseDesign.primerDesignConstraints?.targetPcrTm ?? defaultPcrTm(),
      appTm(baseDesign)
    ),
    design
  );
  const pbsMismatch = firstPrimerPbsLengthMismatch(design.designPrimers, designPrimers);
  if (pbsMismatch) {
    const actual =
      pbsMismatch.actualLength === null
        ? 'the primer is missing from the candidate'
        : `only ${pbsMismatch.actualLength} bp fit`;
    return rejectedInvalidValue(
      design,
      viewState,
      command,
      `Golden Gate auto optimization cannot preserve ${pbsMismatch.direction} primer ` +
        `${pbsMismatch.primerId}'s ${pbsMismatch.expectedLength} bp PBS within the shifted ` +
        `fragment boundary (${actual}). Choose another candidate or shorten the PBS.`
    );
  }

  return applied(
    withWorkbenchIdentity({
      ...baseDesign,
      homologyRegions: [],
      goldenGateJunctions,
      designPrimers,
      assemblyState: 'ready',
      status: 'computed',
      validationErrors: [],
      version: nextVersion(design),
      updatedAt: now,
    }),
    viewState,
    command
  );
}

function applyHomologyAutoOptimize(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: Extract<AssemblyWorkbenchCommand, { type: 'autoOptimize' }>,
  scopedJunctionIndex: number | null,
  now: Date
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  const baseDesign = ensureHomologyDraftForAutoOptimize(design);
  const draft = computeDraftAssembly(baseDesign, defaultPcrTm(), appTm(baseDesign));
  const draftByJunction = new Map(
    draft.homologyRegions.map((homology) => [homology.junctionIndex, homology])
  );
  const assemblyRegions = getEffectiveDesignRegions(baseDesign);
  const composedSequence = getComposedSequence(assemblyRegions, baseDesign.spacers);
  let changed = baseDesign !== design;
  const homologyRegions = baseDesign.homologyRegions.map((homology) => {
    if (scopedJunctionIndex !== null && homology.junctionIndex !== scopedJunctionIndex) {
      return homology;
    }
    const optimized = draftByJunction.get(homology.junctionIndex);
    if (!optimized) return homology;
    if (
      homology.encoding.onLeft === optimized.encoding.onLeft &&
      homology.encoding.onRight === optimized.encoding.onRight &&
      homology.metadata?.sequence === optimized.metadata?.sequence
    ) {
      return homology;
    }
    changed = true;
    return recomputeHomologyMetadata(
      {
        ...homology,
        junctionPosition: optimized.junctionPosition,
        templateBasis: optimized.templateBasis,
        encoding: optimized.encoding,
      },
      composedSequence,
      homology.encoding
    );
  });

  if (!changed) return noop(design, viewState);

  const redrafted = withWorkbenchIdentity({
    ...baseDesign,
    homologyRegions,
    goldenGateJunctions: undefined,
    designPrimers: restorePrimerPbsLengths(
      baseDesign,
      recomputePrimers(
        assemblyRegions,
        homologyRegions,
        baseDesign.topology,
        baseDesign.spacers,
        appTm(baseDesign),
        baseDesign.primerDesignConstraints?.targetPcrTm
      ),
      design
    ),
    assemblyState: 'ready',
    status: 'computed',
    validationErrors: [],
    version: nextVersion(design),
    updatedAt: now,
  });

  return applied(refreshHomologyPrimerOverhangs(redrafted), viewState, command);
}

function autoOptimizeScopeJunctionIndex(
  viewState: AssemblyWorkbenchViewState,
  command: Extract<AssemblyWorkbenchCommand, { type: 'autoOptimize' }>
): number | null {
  if (command.scope !== 'selected-junction') return null;
  return typeof viewState.selectedJunctionIndex === 'number'
    ? viewState.selectedJunctionIndex
    : null;
}

function ensureGoldenGateDraftForAutoOptimize(design: SequenceDesign): SequenceDesign {
  if ((design.goldenGateJunctions?.length ?? 0) > 0 && design.designPrimers.length > 0) {
    return design;
  }
  const draft = computeDraftAssembly(design, defaultPcrTm(), appTm(design));
  return withWorkbenchIdentity({
    ...design,
    homologyRegions: [],
    goldenGateJunctions: draft.goldenGateJunctions ?? [],
    designPrimers: draft.designPrimers,
    assemblyState: 'ready',
    status: 'computed',
    validationErrors: [],
  });
}

function ensureHomologyDraftForAutoOptimize(design: SequenceDesign): SequenceDesign {
  if (design.homologyRegions.length > 0 && design.designPrimers.length > 0) {
    return design;
  }
  const draft = computeDraftAssembly(design, defaultPcrTm(), appTm(design));
  return withWorkbenchIdentity({
    ...design,
    homologyRegions: draft.homologyRegions,
    goldenGateJunctions: undefined,
    designPrimers: draft.designPrimers,
    assemblyState: 'ready',
    status: 'computed',
    validationErrors: [],
  });
}

function redraftAfterSpacerChange(
  design: SequenceDesign,
  previousDesign: SequenceDesign
): SequenceDesign {
  if (previousDesign.assemblyWorkbench?.autoDraftPrimers === false) {
    return withWorkbenchIdentity({
      ...design,
      homologyRegions: [],
      goldenGateJunctions: design.assemblyMethod === 'goldengate' ? [] : undefined,
      designPrimers: [],
      assemblyState: 'drafting',
      status: 'draft',
      validationErrors: [],
    });
  }

  const draft = computeDraftAssembly(design, defaultPcrTm(), appTm(design));

  if (design.assemblyMethod === 'goldengate') {
    const goldenGateJunctions = preserveGoldenGateOffsetsAcrossRedraft(
      draft.goldenGateJunctions ?? [],
      design,
      previousDesign
    );
    const designPrimers = computeGoldenGatePrimers(
      design.regions,
      goldenGateJunctions,
      design.topology,
      design.goldenGateConfig?.enzyme ?? 'BsaI',
      design.spacers,
      design.primerDesignConstraints?.targetPcrTm ?? defaultPcrTm(),
      appTm(design)
    );
    return withWorkbenchIdentity({
      ...design,
      homologyRegions: [],
      goldenGateJunctions,
      designPrimers: restorePrimerPbsLengths(design, designPrimers, previousDesign),
      assemblyState: 'ready',
      status: 'computed',
      validationErrors: [],
    });
  }

  const assemblyRegions = getEffectiveDesignRegions(design);
  const composedSequence = getComposedSequence(assemblyRegions, design.spacers);
  const previousHomologyByJunction = new Map(
    previousDesign.homologyRegions.map((homology) => [homology.junctionIndex, homology])
  );
  const homologyRegions = draft.homologyRegions.map((homology) => {
    const previous = previousHomologyByJunction.get(homology.junctionIndex);
    if (!previous) return homology;
    return recomputeHomologyMetadata(
      { ...homology, encoding: previous.encoding },
      composedSequence,
      homology.encoding
    );
  });

  const redrafted = withWorkbenchIdentity({
    ...design,
    homologyRegions,
    goldenGateJunctions: undefined,
    designPrimers: restorePrimerPbsLengths(
      design,
      recomputePrimers(
        assemblyRegions,
        homologyRegions,
        design.topology,
        design.spacers,
        appTm(design),
        design.primerDesignConstraints?.targetPcrTm
      ),
      previousDesign
    ),
    assemblyState: 'ready',
    status: 'computed',
    validationErrors: [],
  });
  return refreshHomologyPrimerOverhangs(redrafted);
}

function redraftAfterRegionSequenceChange(
  design: SequenceDesign,
  previousDesign: SequenceDesign
): SequenceDesign {
  return redraftAfterSpacerChange(design, previousDesign);
}

function refreshHomologyPrimerOverhangs(design: SequenceDesign): SequenceDesign {
  if (!isHomologyAssemblyMethod(design.assemblyMethod) || design.homologyRegions.length === 0) {
    return design;
  }
  const pbsAdjusted = applySignedHomologyPrimerPbsWindows(design) ?? design;
  const assemblyRegions = getEffectiveDesignRegions(design);
  const composedSequence = getComposedSequence(assemblyRegions, pbsAdjusted.spacers);
  const homologyByJunction = new Map(
    pbsAdjusted.homologyRegions.map((homology) => [homology.junctionIndex, homology])
  );
  const spacerByJunction = new Map(
    pbsAdjusted.spacers.map((spacer) => [spacer.junctionIndex, spacer.sequence])
  );

  return {
    ...pbsAdjusted,
    designPrimers: pbsAdjusted.designPrimers.map((pair) => ({
      ...pair,
      forward: refreshHomologyPrimerOverhang(
        pair.forward,
        homologyByJunction,
        spacerByJunction,
        composedSequence
      ),
      reverse: refreshHomologyPrimerOverhang(
        pair.reverse,
        homologyByJunction,
        spacerByJunction,
        composedSequence
      ),
    })),
  };
}

function refreshHomologyPrimerOverhang(
  primer: DesignPrimer,
  homologyByJunction: Map<number, SequenceDesign['homologyRegions'][number]>,
  spacerByJunction: Map<number, string>,
  composedSequence: string
): DesignPrimer {
  if (primer.manuallyEdited) return primer;
  if (primer.junctionIndex === null) return primer;
  const homology = homologyByJunction.get(primer.junctionIndex);
  if (!homology) return primer;
  return updatePrimerOverhangFromHomology(
    primer,
    homology,
    true,
    spacerByJunction.get(primer.junctionIndex) ?? '',
    composedSequence
  );
}

function applySignedHomologyPrimerPbsWindows(design: SequenceDesign): SequenceDesign | null {
  if (!isHomologyAssemblyMethod(design.assemblyMethod) || design.homologyRegions.length === 0) {
    return design;
  }
  const assemblyRegions = getEffectiveDesignRegions(design);
  const regionPositions = composedRegionPositions(assemblyRegions, design.spacers);
  const homologyByJunction = new Map(
    design.homologyRegions.map((homology) => [homology.junctionIndex, homology])
  );
  const spacerLengthByJunction = new Map(
    design.spacers.map((spacer) => [spacer.junctionIndex, spacer.sequence.length])
  );

  const designPrimers: DesignPrimerPair[] = [];
  for (const pair of design.designPrimers) {
    const forwardHomology =
      pair.forward.junctionIndex === null
        ? null
        : homologyByJunction.get(pair.forward.junctionIndex);
    const reverseHomology =
      pair.reverse.junctionIndex === null
        ? null
        : homologyByJunction.get(pair.reverse.junctionIndex);
    let forward = pair.forward;
    let reverse = pair.reverse;

    if (!forward.manuallyEdited && forwardHomology && forwardHomology.encoding.onLeft < 0) {
      const regionPosition = regionPositions[forward.fragmentIndex];
      if (!regionPosition) return null;
      const pbsStart = regionPosition.start - forwardHomology.encoding.onLeft;
      if (pbsStart > forward.pbs.end) return null;
      forward = updatePrimerPbsWindow(
        forward,
        pbsStart,
        forward.pbs.end,
        assemblyRegions,
        design.spacers,
        appTm(design)
      );
    }

    if (!reverse.manuallyEdited && reverseHomology) {
      const spacerLength = spacerLengthByJunction.get(reverseHomology.junctionIndex) ?? 0;
      const productEndBioCol = spacerLength + reverseHomology.encoding.onRight;
      if (productEndBioCol < 0) {
        const regionPosition = regionPositions[reverse.fragmentIndex];
        if (!regionPosition) return null;
        const pbsEnd = regionPosition.end + productEndBioCol;
        if (pbsEnd < reverse.pbs.start) return null;
        reverse = updatePrimerPbsWindow(
          reverse,
          reverse.pbs.start,
          pbsEnd,
          assemblyRegions,
          design.spacers,
          appTm(design)
        );
      }
    }

    designPrimers.push({ ...pair, forward, reverse });
  }

  return { ...design, designPrimers };
}

interface SourceMaterial {
  sequence: string;
  annotations: DesignAnnotation[];
  circular: boolean;
  windowStart: number;
  windowEnd: number;
  sourceLength: number;
  fullSource: boolean;
}

function resolveSourceMaterial(
  region: SequenceDesign['regions'][number],
  sourceContext: AssemblyWorkbenchSourceContext | undefined
): SourceMaterial | null {
  if (region.sourceSequence) {
    return {
      sequence: region.sourceSequence,
      annotations: region.sourceAnnotations ?? shiftedRegionAnnotations(region),
      circular: Boolean(region.sourceIsCircular),
      windowStart: 0,
      windowEnd: region.sourceSequence.length,
      sourceLength: region.sourceSequence.length,
      fullSource: true,
    };
  }

  const context =
    sourceContext?.regions?.[region.id] ?? sourceContext?.sources?.[region.sourceSequenceId];
  if (context?.sequence) {
    const windowStart = context.sourceStart ?? 0;
    const windowEnd = context.sourceEnd ?? windowStart + context.sequence.length;
    const sourceLength = context.sourceLength ?? windowEnd;
    return {
      sequence: context.sequence,
      annotations: context.annotations ?? [],
      circular: Boolean(context.circular),
      windowStart,
      windowEnd,
      sourceLength,
      fullSource: windowStart === 0 && windowEnd >= sourceLength,
    };
  }

  if (!sourceContext || sourceContext.ready === false) return null;

  return {
    sequence: region.sequence,
    annotations: shiftedRegionAnnotations(region),
    circular: false,
    windowStart: region.sourceStart,
    windowEnd: region.sourceEnd,
    sourceLength: region.sourceEnd,
    fullSource: false,
  };
}

function validateRequestedSourceRange(
  material: SourceMaterial,
  start: number,
  end: number
): { code: 'invalid-command-value' | 'source-window-too-small'; message: string } | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0) {
    return {
      code: 'invalid-command-value',
      message: 'Source coordinates must be non-negative integers.',
    };
  }
  if (material.circular && start >= end) {
    return {
      code: 'invalid-command-value',
      message: 'Source boundary edits that wrap around the circular origin are not supported yet.',
    };
  }
  if (!material.circular && start >= end) {
    return {
      code: 'invalid-command-value',
      message: 'Source boundary edits must leave at least one base in the copied region.',
    };
  }

  if (end > material.sourceLength) {
    return {
      code: 'invalid-command-value',
      message: `Source boundary must be within 0..${material.sourceLength}.`,
    };
  }

  if (material.fullSource) {
    if (end > material.sourceLength) {
      return {
        code: 'invalid-command-value',
        message: `Source boundary must be within 0..${material.sourceLength}.`,
      };
    }
    return null;
  }

  if (start < material.windowStart || end > material.windowEnd) {
    return {
      code: 'source-window-too-small',
      message: 'Loaded source context does not cover the requested source boundary.',
    };
  }
  return null;
}

function sliceSourceMaterial(material: SourceMaterial, start: number, end: number): string | null {
  if (material.fullSource) {
    return material.sequence.slice(start, end);
  }
  if (start < material.windowStart || end > material.windowEnd) return null;
  return material.sequence.slice(start - material.windowStart, end - material.windowStart);
}

function sourceAnnotationsForMaterial(
  region: SequenceDesign['regions'][number],
  material: SourceMaterial
): DesignAnnotation[] {
  return material.annotations.length > 0 ? material.annotations : shiftedRegionAnnotations(region);
}

function shiftedRegionAnnotations(region: SequenceDesign['regions'][number]): DesignAnnotation[] {
  return region.annotations.map((annotation) => ({
    ...annotation,
    start: region.sourceStart + annotation.start,
    end: region.sourceStart + annotation.end,
  }));
}

function sliceSourceAnnotations(
  annotations: DesignAnnotation[],
  sourceStart: number,
  sourceEnd: number
): DesignAnnotation[] {
  return annotations.flatMap((annotation) => {
    const start = Math.max(annotation.start, sourceStart);
    const end = Math.min(annotation.end, sourceEnd);
    if (end <= start) return [];
    return [
      {
        ...annotation,
        start: start - sourceStart,
        end: end - sourceStart,
      },
    ];
  });
}

function validateExpectedVersion(
  design: SequenceDesign,
  command: Extract<AssemblyWorkbenchCommand, { expectedDesignVersion?: number }>
): AssemblyWorkbenchCommandError | null {
  if (command.expectedDesignVersion === undefined) {
    return {
      code: 'stale-design-version',
      message: 'Design-mutating workbench commands must include expectedDesignVersion.',
      commandType: command.type,
      actualDesignVersion: design.version,
    };
  }
  if (command.expectedDesignVersion !== design.version) {
    return {
      code: 'stale-design-version',
      message: `Command expected design version ${command.expectedDesignVersion}, but current version is ${design.version}.`,
      commandType: command.type,
      expectedDesignVersion: command.expectedDesignVersion,
      actualDesignVersion: design.version,
    };
  }
  return null;
}

function normalizeViewState(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState
): AssemblyWorkbenchViewState {
  const junctions = design.assemblyWorkbench?.junctions ?? [];
  const byId = viewState.selectedJunctionId
    ? junctions.find((junction) => junction.id === viewState.selectedJunctionId)
    : null;
  if (byId) return { selectedJunctionId: byId.id, selectedJunctionIndex: byId.slot };
  const byIndex =
    typeof viewState.selectedJunctionIndex === 'number'
      ? junctions.find((junction) => junction.slot === viewState.selectedJunctionIndex)
      : null;
  if (byIndex) return { selectedJunctionId: byIndex.id, selectedJunctionIndex: byIndex.slot };
  return createAssemblyWorkbenchViewState(design);
}

function resolveInitialSelectedJunctionIndex(design: SequenceDesign): number | null {
  const junctionCount = computeJunctionCount(design);
  if (junctionCount === 0) return null;
  if (
    typeof design.selectedJunctionIndex === 'number' &&
    design.selectedJunctionIndex >= 0 &&
    design.selectedJunctionIndex < junctionCount
  ) {
    return design.selectedJunctionIndex;
  }
  return 0;
}

function applied(
  nextDesign: SequenceDesign,
  nextViewState: AssemblyWorkbenchViewState,
  command: AssemblyWorkbenchCommand
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  return {
    status: 'applied',
    nextDesign,
    nextViewState,
    errors: [],
    warnings: [],
    appliedCommands: [command],
    projectionInvalidated: true,
  };
}

function noop(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  return {
    status: 'noop',
    nextDesign: design,
    nextViewState: viewState,
    errors: [],
    warnings: [],
    appliedCommands: [],
    projectionInvalidated: false,
  };
}

function rejected(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: AssemblyWorkbenchCommand,
  error: AssemblyWorkbenchCommandError
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  return {
    status: 'rejected',
    nextDesign: design,
    nextViewState: viewState,
    errors: [error],
    warnings: [],
    appliedCommands: [],
    projectionInvalidated: false,
  };
}

function rejectedInvalidTarget(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: AssemblyWorkbenchCommand,
  message: string
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  return rejected(design, viewState, command, {
    code: 'invalid-command-target',
    message,
    commandType: command.type,
  });
}

function rejectedInvalidValue(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: AssemblyWorkbenchCommand,
  message: string
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  return rejected(design, viewState, command, {
    code: 'invalid-command-value',
    message,
    commandType: command.type,
  });
}

function rejectedUnsupportedMode(
  design: SequenceDesign,
  viewState: AssemblyWorkbenchViewState,
  command: AssemblyWorkbenchCommand,
  message: string
): AssemblyWorkbenchCommandResult<SequenceDesign> {
  return rejected(design, viewState, command, {
    code: 'unsupported-mode-command',
    message,
    commandType: command.type,
  });
}

function nextVersion(design: SequenceDesign): number {
  return (design.version ?? 0) + 1;
}

function withWorkbenchIdentity(design: SequenceDesign): SequenceDesign {
  const assemblyWorkbench = reconcileAssemblyWorkbenchState(design);
  const next = { ...design, assemblyWorkbench };
  return {
    ...next,
    designPrimers: applyStablePrimerIds(next, next.designPrimers),
  };
}

function isGoldenGateSetValidationError(validationError: string | undefined): boolean {
  return (
    validationError?.startsWith('Duplicate overhang:') === true ||
    validationError?.startsWith('Palindromic overhang:') === true
  );
}

function validateGoldenGateJunctions(junctions: GoldenGateJunction[]): GoldenGateJunction[] {
  const usedOverhangs = new Set<string>();
  return junctions.map((junction) => {
    let validationError: string | undefined;
    let isValid = true;
    const intrinsicValidationError = isGoldenGateSetValidationError(junction.validationError)
      ? undefined
      : junction.validationError;
    if (intrinsicValidationError) {
      validationError = intrinsicValidationError;
      isValid = false;
    } else if (usedOverhangs.has(junction.overhang)) {
      validationError = userMessageWithValues('assembly.overhang.duplicate-overhang-value0', {
        value0: userMessageValue(junction.overhang),
      });
      isValid = false;
    } else if (isPalindrome(junction.overhang)) {
      validationError = userMessageWithValues(
        'assembly.overhang.palindromic-overhang-value0-risk-of-self-ligation',
        { value0: userMessageValue(junction.overhang) }
      );
      isValid = false;
    }
    usedOverhangs.add(junction.overhang);
    return { ...junction, isValid, validationError };
  });
}

function preserveGoldenGateOffsetsAcrossRedraft(
  draftJunctions: GoldenGateJunction[],
  design: SequenceDesign,
  previousDesign: SequenceDesign
): GoldenGateJunction[] {
  if (draftJunctions.length === 0) return draftJunctions;
  const previousByIndex = new Map(
    (previousDesign.goldenGateJunctions ?? []).map((junction) => [junction.junctionIndex, junction])
  );
  const offsetLimit = goldenGateOffsetLimitBp(design.goldenGateConfig);
  const composedSequence = getComposedSequence(design.regions, design.spacers);
  const restored = draftJunctions.map((junction) => {
    const previous = previousByIndex.get(junction.junctionIndex);
    if (!previous || isGoldenGateJunctionOffsetLocked(junction)) return junction;
    if (!Number.isInteger(previous.offset) || Math.abs(previous.offset) > offsetLimit) {
      return junction;
    }
    return withGoldenGateJunctionOffset(junction, previous.offset, composedSequence);
  });
  return validateGoldenGateJunctions(restored);
}

function withGoldenGateJunctionOffset(
  junction: GoldenGateJunction,
  offset: number,
  composedSequence: string
): GoldenGateJunction {
  const overhangStart = junction.junctionPosition - 2 + offset;
  const overhangEnd = overhangStart + 4;
  return {
    ...junction,
    offset,
    overhangStart,
    overhangEnd,
    overhang: circularSequenceSlice(composedSequence, overhangStart, 4),
  };
}

function circularSequenceSlice(sequence: string, start: number, length: number): string {
  if (sequence.length === 0 || length <= 0) return '';
  let result = '';
  for (let index = 0; index < length; index++) {
    const pos = (((start + index) % sequence.length) + sequence.length) % sequence.length;
    result += sequence[pos];
  }
  return result;
}

function restorePrimerPbsLengths(
  design: SequenceDesign,
  newPrimers: DesignPrimerPair[],
  previousDesign: SequenceDesign = design
): DesignPrimerPair[] {
  const existingPbsWindows = new Map<string, { start: number; end: number }>();
  const existingPbsLengths = new Map<string, number>();
  const tailIntentKeys = primerTailIntentKeys(design, previousDesign);
  for (const pair of previousDesign.designPrimers) {
    const forwardKey = primerIntentKeyForPrimer(previousDesign, pair.forward);
    const forwardIntrusionLength = signedHomologyPbsIntrusionLength(previousDesign, pair.forward);
    if (
      forwardKey &&
      tailIntentKeys.has(forwardKey) &&
      forwardIntrusionLength === null &&
      hasCustomHomologyPbsFivePrimeEdge(previousDesign, pair.forward)
    ) {
      existingPbsWindows.set(pair.forward.id, {
        start: pair.forward.pbs.start,
        end: pair.forward.pbs.end,
      });
    }
    const reverseKey = primerIntentKeyForPrimer(previousDesign, pair.reverse);
    const reverseIntrusionLength = signedHomologyPbsIntrusionLength(previousDesign, pair.reverse);
    if (
      reverseKey &&
      tailIntentKeys.has(reverseKey) &&
      reverseIntrusionLength === null &&
      hasCustomHomologyPbsFivePrimeEdge(previousDesign, pair.reverse)
    ) {
      existingPbsWindows.set(pair.reverse.id, {
        start: pair.reverse.pbs.start,
        end: pair.reverse.pbs.end,
      });
    }
    existingPbsLengths.set(
      pair.forward.id,
      pair.forward.pbs.end - pair.forward.pbs.start + (forwardIntrusionLength ?? 0)
    );
    existingPbsLengths.set(
      pair.reverse.id,
      pair.reverse.pbs.end - pair.reverse.pbs.start + (reverseIntrusionLength ?? 0)
    );
  }
  const pbsIntentLengths = primerPbsIntentLengths(design, previousDesign);
  const previousPrimers = new Map(
    previousDesign.designPrimers.flatMap((pair) =>
      [pair.forward, pair.reverse].map((primer) => [primer.id, primer] as const)
    )
  );
  const restore = (primer: DesignPrimer): DesignPrimer => {
    const previous = previousPrimers.get(primer.id);
    if (previous?.manuallyEdited) {
      return {
        ...previous,
        fragmentIndex: primer.fragmentIndex,
        junctionIndex: primer.junctionIndex,
      };
    }
    const restored = restorePrimerPbsLength(
      design,
      primer,
      existingPbsWindows,
      existingPbsLengths,
      pbsIntentLengths
    );
    return previous?.manuallyNamed
      ? { ...restored, name: previous.name, manuallyNamed: true }
      : restored;
  };

  const withStableIds = applyStablePrimerIds(design, newPrimers);
  return withStableIds.map((pair) => ({
    ...pair,
    forward: restore(pair.forward),
    reverse: restore(pair.reverse),
  }));
}

function firstPrimerPbsLengthMismatch(
  previousPairs: DesignPrimerPair[],
  nextPairs: DesignPrimerPair[]
): {
  primerId: string;
  direction: DesignPrimer['direction'];
  expectedLength: number;
  actualLength: number | null;
} | null {
  const nextById = new Map(
    nextPairs.flatMap((pair) => [
      [pair.forward.id, pair.forward] as const,
      [pair.reverse.id, pair.reverse] as const,
    ])
  );
  for (const pair of previousPairs) {
    for (const primer of [pair.forward, pair.reverse]) {
      const expectedLength = primer.pbs.end - primer.pbs.start;
      const nextPrimer = nextById.get(primer.id);
      const actualLength = nextPrimer ? nextPrimer.pbs.end - nextPrimer.pbs.start : null;
      if (actualLength !== expectedLength) {
        return {
          primerId: primer.id,
          direction: primer.direction,
          expectedLength,
          actualLength,
        };
      }
    }
  }
  return null;
}

function primerTailIntentKeys(design: SequenceDesign, previousDesign: SequenceDesign): Set<string> {
  const keys = new Set<string>();
  const intents = [
    ...(previousDesign.assemblyWorkbench?.primerEditIntents ?? []),
    ...(design.assemblyWorkbench?.primerEditIntents ?? []),
  ];
  for (const intent of intents) {
    if (intent.field !== 'tailLength') continue;
    keys.add(primerIntentKey(intent.regionId, intent.direction));
  }
  return keys;
}

function primerIntentKeyForPrimer(design: SequenceDesign, primer: DesignPrimer): string | null {
  const regionId = design.regions[primer.fragmentIndex]?.id;
  return regionId ? primerIntentKey(regionId, primer.direction) : null;
}

function signedHomologyPbsIntrusionLength(
  design: SequenceDesign,
  primer: DesignPrimer
): number | null {
  if (!isHomologyAssemblyMethod(design.assemblyMethod) || primer.junctionIndex === null) {
    return null;
  }
  const homology = design.homologyRegions.find(
    (item) => item.junctionIndex === primer.junctionIndex
  );
  if (!homology) return null;
  const assemblyRegions = getEffectiveDesignRegions(design);
  const regionPosition = composedRegionPositions(assemblyRegions, design.spacers)[
    primer.fragmentIndex
  ];
  if (!regionPosition) return null;

  if (primer.direction === 'forward' && homology.encoding.onLeft < 0) {
    return primer.pbs.start === regionPosition.start - homology.encoding.onLeft
      ? -homology.encoding.onLeft
      : null;
  }

  if (primer.direction === 'reverse') {
    const spacerLength =
      design.spacers.find((spacer) => spacer.junctionIndex === homology.junctionIndex)?.sequence
        .length ?? 0;
    const productEndBioCol = spacerLength + homology.encoding.onRight;
    if (productEndBioCol < 0) {
      return primer.pbs.end === regionPosition.end + productEndBioCol ? -productEndBioCol : null;
    }
  }

  return null;
}

function restorePrimerPbsLength(
  design: SequenceDesign,
  primer: DesignPrimer,
  existingPbsWindows: Map<string, { start: number; end: number }>,
  existingPbsLengths: Map<string, number>,
  pbsIntentLengths: Map<string, number>
): DesignPrimer {
  const existingWindow = existingPbsWindows.get(primer.id);
  if (
    existingWindow &&
    (existingWindow.start !== primer.pbs.start || existingWindow.end !== primer.pbs.end)
  ) {
    return updatePrimerPbsWindow(
      primer,
      existingWindow.start,
      existingWindow.end,
      getEffectiveDesignRegions(design),
      design.spacers,
      appTm(design)
    );
  }

  const regionId = design.regions[primer.fragmentIndex]?.id;

  const pbsLength =
    existingPbsLengths.get(primer.id) ??
    (regionId ? pbsIntentLengths.get(primerIntentKey(regionId, primer.direction)) : undefined);
  if (!pbsLength || pbsLength === primer.pbs.end - primer.pbs.start) return primer;
  return updatePrimerPbsLength(
    primer,
    pbsLength,
    getEffectiveDesignRegions(design),
    design.spacers,
    appTm(design)
  );
}

function hasCustomHomologyPbsFivePrimeEdge(design: SequenceDesign, primer: DesignPrimer): boolean {
  if (!isHomologyAssemblyMethod(design.assemblyMethod)) return false;
  const regions = getEffectiveDesignRegions(design);
  const regionPosition = composedRegionPositions(regions, design.spacers)[primer.fragmentIndex];
  if (!regionPosition) return false;
  return primer.direction === 'forward'
    ? primer.pbs.start !== regionPosition.start
    : primer.pbs.end !== regionPosition.end;
}

function composedRegionPositions(
  regions: SequenceDesign['regions'],
  spacers: DesignSpacer[]
): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = [];
  let position = 0;
  for (let index = 0; index < regions.length; index++) {
    const region = regions[index];
    positions.push({ start: position, end: position + region.sequence.length });
    position += region.sequence.length;
    position += spacers.find((spacer) => spacer.junctionIndex === index)?.sequence.length ?? 0;
  }
  return positions;
}

function primerPbsIntentLengths(
  design: SequenceDesign,
  previousDesign: SequenceDesign
): Map<string, number> {
  const lengths = new Map<string, number>();
  const intents = [
    ...(previousDesign.assemblyWorkbench?.primerEditIntents ?? []),
    ...(design.assemblyWorkbench?.primerEditIntents ?? []),
  ];
  for (const intent of intents) {
    if (intent.field !== 'pbsLength') continue;
    lengths.set(primerIntentKey(intent.regionId, intent.direction), intent.length);
  }
  return lengths;
}

function withPrimerEditIntent(
  design: SequenceDesign,
  primer: DesignPrimer,
  field: AssemblyWorkbenchPrimerEditIntent['field'],
  length: number
): SequenceDesign {
  const regionId = design.regions[primer.fragmentIndex]?.id;
  if (!regionId) return design;
  const assemblyWorkbench = reconcileAssemblyWorkbenchState(design);
  const intent: AssemblyWorkbenchPrimerEditIntent = {
    id: stableId('primer-intent', design.id, regionId, primer.direction, field),
    regionId,
    direction: primer.direction,
    junctionIndex: primer.junctionIndex,
    field,
    length,
    updatedAtVersion: design.version,
  };
  const existing = assemblyWorkbench.primerEditIntents ?? [];
  const nextIntents = [
    ...existing.filter(
      (item) =>
        !(
          item.regionId === intent.regionId &&
          item.direction === intent.direction &&
          item.field === intent.field
        )
    ),
    intent,
  ];
  return {
    ...design,
    assemblyWorkbench: {
      ...assemblyWorkbench,
      primerEditIntents: nextIntents,
    },
  };
}

function primerIntentKey(regionId: string, direction: 'forward' | 'reverse'): string {
  return `${regionId}:${direction}`;
}

function mapPrimer(
  design: SequenceDesign,
  primerId: string,
  updater: (primer: DesignPrimer) => DesignPrimer
): DesignPrimerPair[] {
  return design.designPrimers.map((pair) => ({
    ...pair,
    forward: pair.forward.id === primerId ? updater(pair.forward) : pair.forward,
    reverse: pair.reverse.id === primerId ? updater(pair.reverse) : pair.reverse,
  }));
}

function findPrimerById(
  pairs: DesignPrimerPair[],
  primerId: string
): { pair: DesignPrimerPair; primer: DesignPrimer } | null {
  for (const pair of pairs) {
    if (pair.forward.id === primerId) return { pair, primer: pair.forward };
    if (pair.reverse.id === primerId) return { pair, primer: pair.reverse };
  }
  return null;
}

function adjustedOverhangInput(
  direction: 'forward' | 'reverse',
  requestedLength: number,
  spacerLength: number,
  homologyRegion: SequenceDesign['homologyRegions'][number]
): { adjustedLength: number; shouldIncludeSpacer: boolean } {
  const spacerIsSeparate =
    direction === 'reverse' || forwardSpacerIsSeparateCargo(homologyRegion, spacerLength);
  if (spacerIsSeparate && requestedLength >= spacerLength && spacerLength > 0) {
    return { adjustedLength: requestedLength - spacerLength, shouldIncludeSpacer: true };
  }
  if (spacerLength > 0 && requestedLength < spacerLength) {
    return { adjustedLength: 0, shouldIncludeSpacer: true };
  }
  return { adjustedLength: requestedLength, shouldIncludeSpacer: true };
}

function naturalHomologyTailLength(
  direction: 'forward' | 'reverse',
  homologyRegion: SequenceDesign['homologyRegions'][number],
  spacerLength: number
): number {
  if (direction === 'forward') {
    return (
      homologyRegion.encoding.onLeft +
      (forwardSpacerIsSeparateCargo(homologyRegion, spacerLength) ? spacerLength : 0)
    );
  }
  return spacerLength + homologyRegion.encoding.onRight;
}

function homologyEncodingLengthForDirection(
  direction: 'forward' | 'reverse',
  homologyRegion: SequenceDesign['homologyRegions'][number]
): number {
  return direction === 'forward' ? homologyRegion.encoding.onLeft : homologyRegion.encoding.onRight;
}

function primerWithPbsEdgeForTailLength(
  primer: DesignPrimer,
  homologyRegion: SequenceDesign['homologyRegions'][number],
  requestedTailLength: number,
  spacerLength: number,
  regions: SequenceDesign['regions'],
  spacers: DesignSpacer[],
  tm: ReturnType<typeof appTm>
): DesignPrimer | null {
  const regionPosition = composedRegionPositions(regions, spacers)[primer.fragmentIndex];
  if (!regionPosition) return primer;
  const naturalTail = naturalHomologyTailLength(primer.direction, homologyRegion, spacerLength);
  const overflowIntoOwnPbs = Math.max(0, requestedTailLength - naturalTail);

  if (primer.direction === 'forward') {
    const nextPbsStart = regionPosition.start + overflowIntoOwnPbs;
    if (nextPbsStart > primer.pbs.end) return null;
    if (nextPbsStart === primer.pbs.start) return primer;
    return updatePrimerPbsWindow(primer, nextPbsStart, primer.pbs.end, regions, spacers, tm);
  }

  const nextPbsEnd = regionPosition.end - overflowIntoOwnPbs;
  if (nextPbsEnd < primer.pbs.start) return null;
  if (nextPbsEnd === primer.pbs.end) return primer;
  return updatePrimerPbsWindow(primer, primer.pbs.start, nextPbsEnd, regions, spacers, tm);
}

function normalizeSpacerSequence(sequence: string): string | null {
  const normalized = sequence.replace(/\s+/g, '');
  return [...normalized].every((base) => IUPAC_EXPANSION[base.toUpperCase()] !== undefined)
    ? normalized
    : null;
}

function sortSpacers(spacers: DesignSpacer[]): DesignSpacer[] {
  return [...spacers].sort((a, b) => a.junctionIndex - b.junctionIndex || a.id.localeCompare(b.id));
}

function stableSpacerId(designId: string, junctionId: string): string {
  return stableId('spacer', designId, junctionId);
}

function stableId(...parts: string[]): string {
  return parts.map((part) => part.replace(/[^a-zA-Z0-9_-]/g, '_')).join(':');
}

void estimateTm;
void calculateGcContent;
