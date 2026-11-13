import {
  assemblyComputeContext,
  assemblyValidationErrorClass,
  observeAssemblyRefusal,
} from './journey-telemetry';
import type { AssemblyResult } from './assembly-result-types';
import {
  emptyDesignRegion,
  normalizeAssemblySlots,
  normalizeRegionInput,
  withAssemblySlotStructure,
} from '../design/public/assembly-slots';
import { computeDraftAssembly } from '../design/public/algorithms/draft-assembly';
import {
  type AssemblyState,
  type AssemblyWorkbenchDesignState,
  type DesignRegion,
  type DesignStatus,
  type GoldenGateEnzyme,
  type SequenceDesign,
  type ValidationError,
} from '../design/public/types';
import { repositionSpacersFromAnchors } from '../design/public/spacer-invariants';
import {
  getComposedSequenceForDesign,
  getEffectiveDesignRegions,
  isHomologyAssemblyMethod,
} from '../design/public/restriction-digest';
import {
  recomputeHomologyMetadata,
  recomputePrimers,
} from '../design/public/algorithms/draft-assembly';
import {
  assemblyCommands,
  isEditorCommand,
  isLifecycleCommand,
  parseAssemblyCommand,
  type AddFragmentCommand,
  type AssemblyCommand,
  type EnzymeStrategy,
} from './commands';
import {
  badInput,
  err,
  ok,
  type DesignChangeSummary,
  type DispatchResult,
  type ProgressEvent,
  type RefusalReason,
  type Result,
} from './refusals';
import { transitionAssemblyState } from './state-machine';
import { createAppTmCalculator, useSettingsStore } from '../junction-workbench/public/settings';
import {
  deriveAssemblyIssues,
  issueBlocksGate,
  issuesToValidationErrors,
} from './issues/assembly-issues';
import { beginToolOperation, type ToolOperation } from '../../lib/analytics-operation';
import { isGoldenGateFixedRegionOrderCompatible } from '../design/public/assembly-rail-reorder';
import { isGoldenGateSchemaStructureLocked } from '../design/public/golden-gate-schema';
import { preserveHistoricalComputedChoices } from './historical-component-composition';
import { restoreAssemblyPrimerEditIntents } from '../junction-workbench/public/AssemblyWorkbenchReducer';
import { ensureAssemblyWorkbenchIdentity } from '../junction-workbench/public/AssemblyWorkbenchIdentity';

export type AssemblyStoreAdapter = {
  getDesign: (designId: string) => SequenceDesign | undefined;
  updateDesign: (designId: string, updater: (design: SequenceDesign) => SequenceDesign) => void;
  setPendingDispatchId: (dispatchId: string | null) => void;
};

export type AssemblySidecarResult = {
  validationErrors: ValidationError[];
  updates?: Partial<SequenceDesign>;
  changedFields?: readonly string[];
};

export type AssemblyServices = {
  validate: (
    design: SequenceDesign,
    signal: AbortSignal,
    emit: (event: ProgressEvent) => void
  ) => AssemblySidecarResult | Promise<AssemblySidecarResult>;
  run: (
    design: SequenceDesign,
    signal: AbortSignal,
    emit: (event: ProgressEvent) => void
  ) => AssemblySidecarResult | Promise<AssemblySidecarResult>;
  createId?: () => string;
};

type ActiveDispatch = {
  commandType: 'validate' | 'run';
  controller: AbortController;
  dispatchId: string;
};

export type AssemblyDispatcher = ReturnType<typeof createAssemblyDispatcher>;

export type AssemblyDispatchOptions = {
  commit?: boolean;
};

export function createAssemblyDispatcher(
  adapter: AssemblyStoreAdapter,
  services: Partial<AssemblyServices> = {}
) {
  const resolvedServices: AssemblyServices = {
    validate: defaultValidateAssembly,
    run: defaultRunAssembly,
    createId: createDispatchId,
    ...services,
  };
  const chains = new Map<string, Promise<unknown>>();
  const activeDispatches = new Map<string, ActiveDispatch>();
  const idempotentResults = new Map<string, Promise<Result<DesignChangeSummary, RefusalReason>>>();

  function dispatch(
    input: AssemblyCommand,
    options: AssemblyDispatchOptions = {}
  ): DispatchResult<DesignChangeSummary> {
    const commit = options.commit !== false;
    const progress = new ProgressStream();
    const parsed = parseAssemblyCommand(input);
    if (!parsed.ok) {
      progress.close();
      return {
        result: Promise.resolve(err(parsed.error)),
        progress,
        abort: () => {},
      };
    }

    const command = parsed.value;
    const dispatchId = resolvedServices.createId?.() ?? createDispatchId();
    const idempotencyKey = command.idempotencyKey
      ? `${command.designId}:${command.idempotencyKey}`
      : null;

    if (idempotencyKey && commit) {
      const existing = idempotentResults.get(idempotencyKey);
      if (existing) {
        progress.close();
        return { result: existing, progress, abort: () => {} };
      }
    }

    const active = activeDispatches.get(command.designId);
    if (isLifecycleCommand(command) && active) {
      const design = adapter.getDesign(command.designId);
      const refusal = err<RefusalReason>({
        kind: 'state_conflict',
        message: `${active.commandType} is already in progress for this design.`,
        currentState: design?.assemblyState ?? 'drafting',
      });
      if (commit)
        observeAssemblyRefusal({
          designId: command.designId,
          operationId: dispatchId,
          action: 'compute',
          reason: 'state_conflict',
          computeContext: assemblyComputeContext(design, command.type),
        });
      progress.close();
      return {
        result: Promise.resolve(refusal),
        progress,
        abort: () => {},
      };
    }

    if (commit && (isEditorCommand(command) || command.type === 'reset') && active) {
      active.controller.abort();
      activeDispatches.delete(command.designId);
    }

    const controller = commit && isLifecycleCommand(command) ? new AbortController() : null;
    if (controller && isLifecycleCommand(command)) {
      activeDispatches.set(command.designId, {
        commandType: command.type,
        controller,
        dispatchId,
      });
    }

    progress.push({ phase: 'queued' });
    const result = enqueue(command.designId, () =>
      execute(command, dispatchId, controller, progress, commit)
    );

    if (idempotencyKey && commit) {
      idempotentResults.set(idempotencyKey, result);
    }

    return {
      result,
      progress,
      abort: () => controller?.abort(),
    };
  }

  function enqueue(
    designId: string,
    task: () => Promise<Result<DesignChangeSummary, RefusalReason>>
  ) {
    const previous = chains.get(designId);
    const next = (previous ? previous.catch(() => undefined).then(task) : task()).finally(() => {
      if (chains.get(designId) === next) {
        chains.delete(designId);
      }
    });
    chains.set(designId, next);
    return next;
  }

  async function execute(
    command: AssemblyCommand,
    dispatchId: string,
    controller: AbortController | null,
    progress: ProgressStream,
    commit: boolean
  ): Promise<Result<DesignChangeSummary, RefusalReason>> {
    let computeOperation: ToolOperation | null = null;
    try {
      const design = normalizeAssemblyDesign(adapter.getDesign(command.designId));
      const observeRefusal = (reason: 'bad_input' | 'stale_state' | 'state_conflict') => {
        if (commit && isLifecycleCommand(command))
          observeAssemblyRefusal({
            designId: command.designId,
            operationId: dispatchId,
            action: 'compute',
            reason,
            computeContext: assemblyComputeContext(design, command.type),
          });
      };
      if (!design) {
        observeRefusal('bad_input');
        return err(badInput('Unknown design.', 'designId'));
      }

      const stale = checkStaleState(command, design);
      if (stale) {
        observeRefusal('stale_state');
        return err(stale);
      }

      const currentState = design.assemblyState;
      const transition = transitionAssemblyState(currentState, command, {
        pendingDispatchId: null,
      });
      if (!transition.ok) {
        observeRefusal('state_conflict');
        return transition;
      }

      if (command.type === 'reset') {
        const version = design.version + 1;
        const resetDesign = (current: SequenceDesign): SequenceDesign => ({
          ...normalizeExistingAssemblyDesign(current),
          backboneSequenceId: null,
          homologyRegions: [],
          goldenGateJunctions:
            current.assemblyMethod === 'goldengate' ? [] : current.goldenGateJunctions,
          designPrimers: [],
          selectedJunctionIndex: null,
          scrollToPosition: null,
          highlightRange: null,
          assemblyWorkbench: clearAssemblyWorkbenchDraftState(current),
          assemblyResult: undefined,
          validationErrors: [],
          proposedPlans: [],
          assemblyState: 'preflight',
          status: 'draft',
          version,
          updatedAt: new Date(),
        });
        if (commit) {
          adapter.updateDesign(command.designId, resetDesign);
        }
        return ok({
          designId: command.designId,
          version: commit ? version : design.version,
          changedFields: [
            'assemblyState',
            'validationErrors',
            'homologyRegions',
            'goldenGateJunctions',
            'designPrimers',
            'assemblyResult',
          ],
        });
      }

      if (isEditorCommand(command)) {
        const applied = applyEditorCommand(design, command);
        if (!applied.ok) return applied;

        if (commit) {
          adapter.updateDesign(command.designId, () => applied.value.design);
        }
        return ok({
          designId: command.designId,
          version: commit ? applied.value.design.version : design.version,
          changedFields: applied.value.changedFields,
        });
      }

      if (!controller) {
        return ok({
          designId: command.designId,
          version: design.version,
          changedFields: [],
        });
      }

      const sideEffect =
        command.type === 'validate' ? resolvedServices.validate : resolvedServices.run;
      const transientState = transition.value.next;
      adapter.setPendingDispatchId(dispatchId);
      adapter.updateDesign(command.designId, (current) => ({
        ...normalizeExistingAssemblyDesign(current),
        assemblyState: transientState,
        status: assemblyStateToLegacyStatus(transientState),
        updatedAt: new Date(),
      }));

      computeOperation = beginToolOperation({
        toolId: 'assembly',
        surface: 'tab',
        action: 'computed',
        workflowMetadata: {
          operationId: dispatchId,
          artifactCorrelationId: design.id,
          ...assemblyComputeContext(design, command.type === 'validate' ? 'validate' : 'run'),
        },
      });

      progress.push({ phase: 'sidecar', step: command.type });
      const sidecarCandidate = sideEffect(design, controller.signal, (event) =>
        progress.push(event)
      );
      const sidecar = isPromiseLike(sidecarCandidate) ? await sidecarCandidate : sidecarCandidate;

      if (controller.signal.aborted) {
        computeOperation?.cancel();
        adapter.updateDesign(command.designId, (current) => ({
          ...normalizeExistingAssemblyDesign(current),
          assemblyState: 'drafting',
          status: 'draft',
          updatedAt: new Date(),
        }));
        return err({
          kind: 'state_conflict',
          message: `${command.type} was aborted.`,
          currentState: transientState,
        });
      }

      progress.push({ phase: 'finalizing' });
      const clean =
        sidecar.validationErrors.filter((item) => item.severity === 'error').length === 0;
      const nextState: AssemblyState =
        command.type === 'run' && clean ? 'assembled' : clean ? 'ready' : 'drafting';
      const version = design.version + 1;
      const changedFields = [
        'assemblyState',
        'validationErrors',
        'version',
        ...(sidecar.changedFields ?? []),
      ];

      adapter.updateDesign(command.designId, (current) => ({
        ...normalizeExistingAssemblyDesign(current),
        ...sidecar.updates,
        assemblyWorkbench: current.assemblyWorkbench
          ? { ...current.assemblyWorkbench, autoDraftPrimers: true }
          : undefined,
        validationErrors: sidecar.validationErrors,
        assemblyState: nextState,
        status: assemblyStateToLegacyStatus(nextState),
        version,
        updatedAt: new Date(),
      }));

      if (clean)
        computeOperation?.complete(undefined, {
          status: command.type === 'validate' ? 'ready' : 'completed',
          ...(command.type === 'validate' ? { outcomeKind: 'inspection_ready' as const } : {}),
          resultCount:
            command.type === 'validate'
              ? (sidecar.updates?.designPrimers?.length ?? 0)
              : sidecar.updates?.assemblyResult?.assembled.sequence
                ? 1
                : 0,
          valueDelivered: false,
          usableResult: false,
        });
      else
        computeOperation?.fail(
          'validation',
          undefined,
          undefined,
          assemblyValidationErrorClass(sidecar.validationErrors)
        );

      return ok({
        designId: command.designId,
        version,
        changedFields,
      });
    } catch (error) {
      const currentState = adapter.getDesign(command.designId)?.assemblyState ?? 'drafting';
      const message = error instanceof Error ? error.message : 'Assembly sidecar failed.';
      if (controller?.signal.aborted) {
        computeOperation?.cancel();
        adapter.updateDesign(command.designId, (current) => ({
          ...normalizeExistingAssemblyDesign(current),
          assemblyState: 'drafting',
          status: 'draft',
          updatedAt: new Date(),
        }));
        return err({
          kind: 'state_conflict',
          message: `${command.type} was aborted.`,
          currentState,
        });
      }

      adapter.updateDesign(command.designId, (current) => ({
        ...normalizeExistingAssemblyDesign(current),
        assemblyState: 'drafting',
        status: 'draft',
        validationErrors: [
          {
            code: 'sidecar_failure',
            severity: 'error',
            message,
          },
        ],
        updatedAt: new Date(),
      }));
      computeOperation?.fail('sidecar');

      return err({
        kind: 'sidecar_failure',
        message,
        upstreamCode: error instanceof Error ? error.name : undefined,
        retryable: true,
      });
    } finally {
      if (controller) {
        const active = activeDispatches.get(command.designId);
        if (active?.dispatchId === dispatchId) {
          activeDispatches.delete(command.designId);
          adapter.setPendingDispatchId(null);
        }
      }
      progress.close();
    }
  }

  return {
    dispatch,
    commands: assemblyCommands,
  };
}

export function normalizeAssemblyDesign(
  design: SequenceDesign | undefined
): SequenceDesign | undefined {
  if (!design) return undefined;
  design = normalizeAssemblySlots(design);
  const assemblyState = design.assemblyState ?? legacyStatusToAssemblyState(design.status);
  return {
    ...design,
    version: design.version ?? 0,
    assemblyState,
    validationErrors: design.validationErrors ?? [],
    proposedPlans: design.proposedPlans ?? [],
    status: design.status ?? assemblyStateToLegacyStatus(assemblyState),
  };
}

function normalizeExistingAssemblyDesign(design: SequenceDesign): SequenceDesign {
  return normalizeAssemblyDesign(design) ?? design;
}

function clearAssemblyWorkbenchDraftState(
  design: SequenceDesign
): AssemblyWorkbenchDesignState | undefined {
  if (!design.assemblyWorkbench) return undefined;
  return {
    ...design.assemblyWorkbench,
    primerEditIntents: [],
  };
}

export function legacyStatusToAssemblyState(status?: DesignStatus): AssemblyState {
  if (status === 'computed') return 'ready';
  if (status === 'assembled') return 'assembled';
  return 'drafting';
}

export function assemblyStateToLegacyStatus(state: AssemblyState): DesignStatus {
  if (state === 'ready') return 'computed';
  if (state === 'assembled') return 'assembled';
  return 'draft';
}

function withSpacersFollowingRegions(
  design: SequenceDesign,
  regions: DesignRegion[]
): Pick<SequenceDesign, 'regions' | 'goldenGateSchema' | 'spacers'> {
  const repositioned = repositionSpacersFromAnchors(
    design.spacers,
    regions,
    design.topology === 'circular'
  );
  return { ...withAssemblySlotStructure(design, regions), spacers: repositioned.spacers };
}

function applyEditorCommand(
  design: SequenceDesign,
  command: AssemblyCommand
): Result<{ design: SequenceDesign; changedFields: readonly string[] }, RefusalReason> {
  const version = design.version + 1;
  const base = {
    ...design,
    assemblyState: 'drafting' as AssemblyState,
    status: 'draft' as DesignStatus,
    validationErrors: [],
    assemblyResult: undefined,
    version,
    updatedAt: new Date(),
  };

  if (
    isGoldenGateSchemaStructureLocked(design.goldenGateSchema) &&
    (command.type === 'addFragment' ||
      command.type === 'removeFragment' ||
      command.type === 'reorderFragments')
  ) {
    return err(
      badInput(
        'This assembly is using a reusable Golden Gate schema, so its slot count and order are fixed. Clear the schema to edit the structure.',
        'goldenGateSchema'
      )
    );
  }

  switch (command.type) {
    case 'setBackbone':
      return ok({
        design: {
          ...base,
          backboneSequenceId: command.sequenceId,
        },
        changedFields: ['backboneSequenceId', 'assemblyState', 'validationErrors', 'version'],
      });

    case 'addFragment': {
      const fragment = createFragmentFromCommand(command);
      const regions = [...design.regions];
      const slot = command.slot ?? regions.length;
      if (slot < 0 || slot > regions.length) {
        return err(badInput('slot is outside the fragment list.', 'slot'));
      }
      regions.splice(slot, 0, fragment);
      return ok({
        design: {
          ...base,
          ...withSpacersFollowingRegions(design, regions),
          homologyRegions: [],
          designPrimers: [],
          goldenGateJunctions:
            design.assemblyMethod === 'goldengate' ? [] : design.goldenGateJunctions,
        },
        changedFields: [
          'regions',
          'spacers',
          ...(design.goldenGateSchema ? ['goldenGateSchema'] : []),
          'homologyRegions',
          'designPrimers',
          'goldenGateJunctions',
          'assemblyState',
          'validationErrors',
          'version',
        ],
      });
    }

    case 'removeFragment': {
      if (!design.regions.some((region) => region.id === command.fragmentId)) {
        return err({
          kind: 'state_conflict',
          message: 'Fragment does not exist in this design.',
          currentState: design.assemblyState,
          conflictWith: { entityId: command.fragmentId, reason: 'missing_fragment' },
        });
      }

      return ok({
        design: {
          ...base,
          ...withSpacersFollowingRegions(
            design,
            design.regions.filter((region) => region.id !== command.fragmentId)
          ),
          homologyRegions: [],
          designPrimers: [],
          goldenGateJunctions:
            design.assemblyMethod === 'goldengate' ? [] : design.goldenGateJunctions,
        },
        changedFields: [
          'regions',
          'spacers',
          ...(design.goldenGateSchema ? ['goldenGateSchema'] : []),
          'homologyRegions',
          'designPrimers',
          'goldenGateJunctions',
          'assemblyState',
          'validationErrors',
          'version',
        ],
      });
    }

    case 'reorderFragments': {
      const regionMap = new Map(design.regions.map((region) => [region.id, region]));
      const uniqueIds = new Set(command.order);
      if (
        uniqueIds.size !== design.regions.length ||
        command.order.length !== design.regions.length
      ) {
        return err(badInput('order must include every fragment exactly once.', 'order'));
      }

      const regions = command.order.map((id) => regionMap.get(id));
      if (regions.some((region) => !region)) {
        return err(badInput('order includes a fragment id not present in the design.', 'order'));
      }

      const reorderedRegions = regions.filter(
        (region): region is DesignRegion => region !== undefined
      );
      if (!isGoldenGateFixedRegionOrderCompatible(design, reorderedRegions)) {
        return err(
          badInput(
            'This order does not preserve the fixed Golden Gate overhangs between restriction digest fragments.',
            'order'
          )
        );
      }

      return ok({
        design: {
          ...base,
          ...withSpacersFollowingRegions(design, reorderedRegions),
          homologyRegions: [],
          designPrimers: [],
          goldenGateJunctions:
            design.assemblyMethod === 'goldengate' ? [] : design.goldenGateJunctions,
        },
        changedFields: [
          'regions',
          'spacers',
          ...(design.goldenGateSchema ? ['goldenGateSchema'] : []),
          'homologyRegions',
          'designPrimers',
          'goldenGateJunctions',
          'assemblyState',
          'validationErrors',
          'version',
        ],
      });
    }

    case 'setEnzymeStrategy': {
      const method = command.strategy.method;
      return ok({
        design: {
          ...base,
          assemblyMethod: method,
          homologyRegions: isHomologyAssemblyMethod(method) ? [] : design.homologyRegions,
          goldenGateConfig:
            method === 'goldengate' ? { enzyme: command.strategy.enzyme ?? 'BsaI' } : undefined,
          goldenGateJunctions: method === 'goldengate' ? [] : undefined,
          designPrimers: [],
        },
        changedFields: [
          'assemblyMethod',
          'goldenGateConfig',
          'goldenGateJunctions',
          'homologyRegions',
          'designPrimers',
          'assemblyState',
          'validationErrors',
          'version',
        ],
      });
    }

    case 'updateHomologyEncoding': {
      if (!isHomologyAssemblyMethod(design.assemblyMethod)) {
        return err(badInput('Homology encoding edits require Gibson or NEBuilder.', 'type'));
      }

      const homologyIndex = design.homologyRegions.findIndex(
        (region) => region.junctionIndex === command.junctionIndex
      );
      if (homologyIndex === -1) {
        return err({
          kind: 'state_conflict',
          message: 'Homology region does not exist for this junction.',
          currentState: design.assemblyState,
          conflictWith: {
            entityId: String(command.junctionIndex),
            reason: 'missing_homology_region',
          },
        });
      }

      const assemblyRegions = getEffectiveDesignRegions(design);
      const composedSequence = getComposedSequenceForDesign(design);
      const currentRegion = design.homologyRegions[homologyIndex];
      const updatedRegion = recomputeHomologyMetadata(
        { ...currentRegion, encoding: command.encoding },
        composedSequence,
        currentRegion.encoding
      );
      const homologyRegions = [...design.homologyRegions];
      homologyRegions[homologyIndex] = updatedRegion;
      const shouldRecomputePrimers = command.recomputePrimers !== false;

      return ok({
        design: {
          ...base,
          homologyRegions,
          designPrimers: shouldRecomputePrimers
            ? recomputePrimers(
                assemblyRegions,
                homologyRegions,
                design.topology,
                design.spacers,
                createAppTmCalculator(design.pcrPolymerase),
                design.primerDesignConstraints?.targetPcrTm
              )
            : design.designPrimers,
        },
        changedFields: shouldRecomputePrimers
          ? ['homologyRegions', 'designPrimers', 'assemblyState', 'validationErrors', 'version']
          : ['homologyRegions', 'assemblyState', 'validationErrors', 'version'],
      });
    }

    default:
      return err(badInput(`Unsupported editor command: ${command.type}`, 'type'));
  }
}

function createFragmentFromCommand(command: AddFragmentCommand): DesignRegion {
  if (command.region) {
    return normalizeRegionInput({
      ...command.region,
      id: createDispatchId(),
    });
  }

  return {
    ...emptyDesignRegion(command.sequenceId),
    id: createDispatchId(),
  };
}

function checkStaleState(command: AssemblyCommand, design: SequenceDesign): RefusalReason | null {
  if (command.expectedVersion === undefined || command.expectedVersion === design.version) {
    return null;
  }

  return {
    kind: 'stale_state',
    message: 'Design version changed before dispatch.',
    expectedVersion: command.expectedVersion,
    actualVersion: design.version,
  };
}

async function defaultValidateAssembly(
  design: SequenceDesign,
  signal: AbortSignal
): Promise<AssemblySidecarResult> {
  throwIfAborted(signal);
  const validationErrors = validateInputs(design);
  if (validationErrors.some((item) => item.severity === 'error')) {
    return { validationErrors, changedFields: ['validationErrors'] };
  }

  const draft = computeDraftAssembly(
    design,
    useSettingsStore.getState().defaultPcrTm,
    createAppTmCalculator(design.pcrPolymerase)
  );
  throwIfAborted(signal);
  const restored = restoreAssemblyPrimerEditIntents(design, { ...design, ...draft });
  let retained: Awaited<ReturnType<typeof preserveHistoricalComputedChoices>>;
  try {
    retained = await preserveHistoricalComputedChoices(design, {
      homologyRegions: restored.homologyRegions,
      designPrimers: restored.designPrimers,
      goldenGateJunctions: restored.goldenGateJunctions,
    });
  } catch (error) {
    return {
      validationErrors: [
        {
          code: 'historical_component_incompatible',
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      changedFields: ['validationErrors'],
    };
  }
  throwIfAborted(signal);
  const normalized = ensureAssemblyWorkbenchIdentity({
    ...design,
    designPrimers: retained.designPrimers,
  });
  return {
    validationErrors: [
      ...issuesToValidationErrors(
        deriveAssemblyIssues({
          design: {
            ...design,
            homologyRegions: retained.homologyRegions,
            designPrimers: normalized.designPrimers,
          },
        })
      ),
      ...retained.designPrimers
        .flatMap((pair) => [pair.forward, pair.reverse])
        .filter((primer) => primer.manuallyEdited)
        .map((primer) => ({
          code: 'authored_primer_unverified',
          severity: 'warning' as const,
          message: `Authored primer ${primer.name} is preserved; its binding and assembly compatibility have not been verified.`,
        })),
    ],
    updates: {
      homologyRegions: retained.homologyRegions,
      designPrimers: normalized.designPrimers,
      assemblyWorkbench: normalized.assemblyWorkbench,
      goldenGateJunctions: retained.goldenGateJunctions ?? design.goldenGateJunctions,
      historicalComponentValidatedVersion: design.historicalComponentSources?.length
        ? design.version + 1
        : undefined,
    },
    changedFields: [
      'homologyRegions',
      'designPrimers',
      'assemblyWorkbench',
      'goldenGateJunctions',
      'historicalComponentValidatedVersion',
    ],
  };
}

async function defaultRunAssembly(
  design: SequenceDesign,
  signal: AbortSignal
): Promise<AssemblySidecarResult> {
  const validated = await defaultValidateAssembly(design, signal);
  if (validated.validationErrors.some((item) => item.severity === 'error')) {
    return validated;
  }

  const sequence = getComposedSequenceForDesign(design);
  const assemblyResult: AssemblyResult = {
    junctions: [],
    primerPairs: [],
    pcrProducts: [],
    assembled: {
      id: `assembled-${design.id}`,
      name: design.name,
      sequence,
      topology: design.topology,
      length: sequence.length,
    },
    validation: {
      valid: true,
      errors: [],
    },
  };

  return {
    ...validated,
    updates: {
      ...validated.updates,
      assemblyResult,
    },
    changedFields: [...(validated.changedFields ?? []), 'assemblyResult'],
  };
}

export function validateInputs(design: SequenceDesign): ValidationError[] {
  return issuesToValidationErrors(
    deriveAssemblyIssues({ design }).filter((issue) => issueBlocksGate(issue, 'run'))
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Assembly dispatch aborted.', 'AbortError');
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>).then === 'function';
}

function createDispatchId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `assembly-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

class ProgressStream implements AsyncIterable<ProgressEvent> {
  private queue: ProgressEvent[] = [];
  private pending: ((value: IteratorResult<ProgressEvent>) => void)[] = [];
  private done = false;

  push(event: ProgressEvent): void {
    if (this.done) return;
    const resolve = this.pending.shift();
    if (resolve) {
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    for (const resolve of this.pending.splice(0)) {
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ProgressEvent> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) {
          return Promise.resolve({ value, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<ProgressEvent>>((resolve) => {
          this.pending.push(resolve);
        });
      },
    };
  }
}

export type { EnzymeStrategy, GoldenGateEnzyme };
