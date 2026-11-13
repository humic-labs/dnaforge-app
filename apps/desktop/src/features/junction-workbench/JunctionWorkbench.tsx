import { toUserMessage, userMessage, type UserMessage } from '@waypoint/user-messages';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { type AnnotatedSequence } from '@waypoint/sequence-utils';
import { OpenExternalIcon } from '../../components/icons';
import { UI_DISCLOSURE_SUMMARY_CLASS, UI_PROSE_WRAP_CLASS } from '../../components/ui/styles';
import { Button } from '../../shared/components/Button';
import { safeFocus } from '../../shared/utils/safeFocus';
import { useSequenceStore } from '../sequence/public/store';
import { useDesignStore } from '../design/public/store';
import { selectPhysicalDesignPrimerPairs } from '../design/public/restriction-digest';
import { useCanvasStore } from '../canvas/public/store';
import { useAssemblyColorScheme } from '../design/public/color-scheme-store';
import type { DesignPrimerPair, SequenceDesign } from '../design/public/types';
import { LinkedCameraGroup, type JunctionRowMetricsByRowId } from './LinkedCameraGroup';
import { RegisteredAssemblyViewport, primerTemperaturePayload } from './RegisteredAssemblyViewport';
import {
  applyOverrideToCanonicalModels,
  buildJunctionWorkbenchModels,
  type JunctionWorkbenchModel,
} from './model';
import {
  type AssemblyWorkbenchCommand,
  type AssemblyWorkbenchEditableField,
  type AssemblyWorkbenchFinding,
  type AssemblyWorkbenchJunctionControl,
  type AssemblyWorkbenchPrimerControl,
  type AssemblyWorkbenchViewState,
  createAssemblyWorkbenchSession,
} from './AssemblyWorkbenchSession';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from './AssemblyWorkbenchReducer';
import { sourceRegionDeltas, type SourceRegionDelta } from './JunctionWorkbenchDiagnostics';
import {
  GOLDEN_GATE_OFFSET_LIMIT_MAX_BP,
  GOLDEN_GATE_OFFSET_LIMIT_MIN_BP,
  goldenGateOffsetLimitBp,
  type AssemblyWorkbenchCommandError,
  type AssemblyWorkbenchLiveFieldPreview,
} from './AssemblyWorkbenchContract';
import { GIBSON_MAX_HOMOLOGY_LENGTH } from '../design/public/validation-constants';
import { ensureAssemblyWorkbenchIdentity } from './AssemblyWorkbenchIdentity';
import { useSettingsStore } from './settings';
import {
  SourceContextRegistry,
  createAssemblyWorkbenchSourceContext,
  createJunctionSourceWindowRequests,
  loadAllSourceSequencesFromDb,
  loadSourceSequenceForKey,
  sourceLookupKeys,
} from './SourceContextRegistry';
import { resolveEditableFieldCommand } from './editable-field-command';
import { WorkbenchNumberControl as NumberControl } from './WorkbenchNumberControl';
import {
  FALLBACK_LEFT_SOURCE_COLOR,
  FALLBACK_RIGHT_SOURCE_COLOR,
} from './WorkbenchPaintingContract';
import {
  planGoldenGateAutoOptimization,
  type GoldenGateOptimizationCombination,
  type GoldenGateOptimizationJunctionChoice,
} from './AssemblyWorkbenchAutoOptimizer';
import {
  buildAssemblyOptimizationInput,
  type AssemblyOptimizationInput,
} from '../assembly/public/assembly-optimization-input';
import {
  assemblyProductIdentityOf,
  freshAssemblyDerived,
  tagAssemblyDerived,
  type TaggedAssemblyDerived,
} from '../assembly/public/assembly-product-freshness';
import { assemblyOptimizeSurface, type AssemblyOptimizeSurface } from './assemblyOptimizeSurface';
import { AssemblyPcrTmConfigurator } from '../design/public/components/AssemblyPcrTmConfigurator';
import { AssemblyRecipeStrip } from '../assembly-panel/public/components/AssemblyRecipeStrip';
import {
  goldenGateOverhangLivePreviewForProductRow,
  goldenGateOverhangLivePrimersForRow,
} from './GoldenGateOverhangLivePreviewContract';

interface JunctionWorkbenchProps {
  design: SequenceDesign;
  readOnly?: boolean;
}

interface WorkbenchPreviewState {
  design: SequenceDesign;
  viewState: AssemblyWorkbenchViewState;
  errors: AssemblyWorkbenchCommandError[];
  commandType: AssemblyWorkbenchCommand['type'];
}

interface LiveFieldValueStore {
  schemaVersion: typeof LIVE_FIELD_VALUE_STORE_SCHEMA_VERSION;
  getValue: (fieldId: string) => number | undefined;
  getHomologyTm: (junctionIndex: number) => number | null | undefined;
  getPrimerTm: (
    primer: Pick<AssemblyWorkbenchPrimerControl, 'id' | 'fragmentIndex' | 'direction'>
  ) => number | null | undefined;
  set: (field: AssemblyWorkbenchEditableField, preview: AssemblyWorkbenchLiveFieldPreview) => void;
  setMany: (
    previews: Array<{
      field: AssemblyWorkbenchEditableField;
      preview: AssemblyWorkbenchLiveFieldPreview;
    }>
  ) => void;
  clear: () => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
}

interface GoldenGateOptimizerPreviewState {
  candidateRank: number;
  choices: GoldenGateOptimizationJunctionChoice[];
}

interface WorkbenchInteractionCounters {
  previewFrameCount: number;
  previewCommandCount: number;
  commitCommandCount: number;
  fieldCommitAttemptCount: number;
}

interface WorkbenchFieldCommitDiagnostic {
  fieldId: string;
  value: number;
  resolveStatus: 'resolved' | 'rejected';
  rejectReason?: string;
}

interface WorkbenchCommandTrace {
  commandType: AssemblyWorkbenchCommand['type'];
  status: ReturnType<typeof applyAssemblyWorkbenchCommand>['status'];
  primerDeltas: Array<{
    key: string;
    pbsLengthBefore: number;
    pbsLengthAfter: number;
    sequenceLengthBefore: number;
    sequenceLengthAfter: number;
    overhangLengthBefore: number;
    overhangLengthAfter: number;
    literalExtraLengthBefore: number;
    literalExtraLengthAfter: number;
  }>;
  sourceRegionDeltas: SourceRegionDelta[];
  goldenGateJunctionDeltas: Array<{
    junctionIndex: number;
    offsetBefore: number;
    offsetAfter: number;
    junctionPositionBefore: number;
    junctionPositionAfter: number;
    overhangStartBefore: number;
    overhangStartAfter: number;
    overhangEndBefore: number;
    overhangEndAfter: number;
    overhangBefore: string;
    overhangAfter: string;
  }>;
  primerEditIntentCountBefore: number;
  primerEditIntentCountAfter: number;
}

interface WorkbenchUndoSnapshot {
  design: SequenceDesign;
  viewState: AssemblyWorkbenchViewState;
  commandType: AssemblyWorkbenchCommand['type'];
  coalesceKey: string | null;
}

function workbenchUndoCoalesceKey(command: AssemblyWorkbenchCommand): string | null {
  if (command.type === 'setJunctionSpacer') {
    return `setJunctionSpacer:${command.junctionIndex}`;
  }
  return null;
}

const PREVIEW_COMMAND_THROTTLE_MS = 80;
const MAX_WORKBENCH_UNDO_DEPTH = 20;
export const LIVE_FIELD_VALUE_STORE_SCHEMA_VERSION = 2;
const LIVE_FIELD_VALUE_STORE_REQUIRED_METHODS = [
  'getValue',
  'getHomologyTm',
  'getPrimerTm',
  'set',
  'setMany',
  'clear',
  'subscribe',
  'getSnapshot',
] as const;

export function JunctionWorkbench({ design, readOnly = false }: JunctionWorkbenchProps) {
  const assemblyColorScheme = useAssemblyColorScheme();
  const [viewState, setViewState] = useState(() => createAssemblyWorkbenchViewState(design));
  const [commandErrors, setCommandErrors] = useState<AssemblyWorkbenchCommandError[]>([]);
  const [previewState, setPreviewState] =
    useState<TaggedAssemblyDerived<WorkbenchPreviewState> | null>(null);
  const [goldenGateOptimizerPreview, setGoldenGateOptimizerPreview] =
    useState<TaggedAssemblyDerived<GoldenGateOptimizerPreviewState> | null>(null);
  const liveFieldValueStoreRef = useRef<LiveFieldValueStore | null>(null);
  liveFieldValueStoreRef.current = ensureLiveFieldValueStore(liveFieldValueStoreRef.current);
  const liveFieldValueStore = liveFieldValueStoreRef.current;

  const [sourceDragOverride, setSourceDragOverride] = useState<{
    junctionIndex: number;
    rowKind: 'left-source' | 'right-source';
    offsetBp: number;
  } | null>(null);
  const [interactionCounters, setInteractionCounters] = useState<WorkbenchInteractionCounters>({
    previewFrameCount: 0,
    previewCommandCount: 0,
    commitCommandCount: 0,
    fieldCommitAttemptCount: 0,
  });
  const [fieldCommitDiagnostic, setFieldCommitDiagnostic] =
    useState<WorkbenchFieldCommitDiagnostic | null>(null);
  const [lastCommandTrace, setLastCommandTrace] = useState<WorkbenchCommandTrace | null>(null);
  const [undoStack, setUndoStack] = useState<WorkbenchUndoSnapshot[]>([]);
  const modelBuildCountRef = useRef(0);
  const pendingPreviewRef = useRef<{
    field: AssemblyWorkbenchEditableField;
    nextValue: number;
  } | null>(null);
  const previewRafRef = useRef<number | null>(null);
  const previewTimeoutRef = useRef<number | null>(null);
  const lastPreviewRunAtRef = useRef(0);
  const sequenceCache = useSequenceStore((state) => state.sequences);
  const commitWorkbenchDesign = useDesignStore((state) => state.commitWorkbenchDesign);
  const navigateToPosition = useDesignStore((state) => state.navigateToPosition);
  const findDesignTab = useCanvasStore((state) => state.findTab);
  const setActiveTab = useCanvasStore((state) => state.setActiveTab);
  const viewportVariant = useSettingsStore((state) => state.junctionWorkbenchViewportVariant);
  const normalizedBaseDesign = useMemo(() => ensureAssemblyWorkbenchIdentity(design), [design]);
  const basePrimerPbsLengths = useMemo(
    () => primerPbsLengthById(normalizedBaseDesign.designPrimers),
    [normalizedBaseDesign.designPrimers]
  );
  const optimizationInput = useMemo(
    () => buildAssemblyOptimizationInput(normalizedBaseDesign),
    [normalizedBaseDesign]
  );
  const productIdentity = assemblyProductIdentityOf(optimizationInput);
  const livePreview = freshAssemblyDerived(productIdentity, previewState);
  const liveOptimizerPreview = freshAssemblyDerived(productIdentity, goldenGateOptimizerPreview);
  const workbenchPreviewActive = Boolean(livePreview || liveOptimizerPreview);
  const workbenchPreviewCommand =
    livePreview?.commandType ?? (liveOptimizerPreview ? 'autoOptimize' : '');
  const renderDesign = livePreview?.design ?? design;
  const viewportRenderer =
    viewportVariant === 'legacy-linked-camera' && renderDesign.assemblyMethod !== 'goldengate'
      ? 'legacy-linked-camera'
      : 'registered-assembly-viewport';
  const normalizedRenderDesign = useMemo(
    () => ensureAssemblyWorkbenchIdentity(renderDesign),
    [renderDesign]
  );
  const renderViewState = livePreview?.viewState ?? viewState;
  const [dbSourceSequences, setDbSourceSequences] = useState<Record<string, AnnotatedSequence>>({});
  const [hasScannedDbSources, setHasScannedDbSources] = useState(false);
  const sourceSequences = useMemo(
    () => (readOnly ? {} : { ...sequenceCache, ...dbSourceSequences }),
    [dbSourceSequences, readOnly, sequenceCache]
  );
  const sourceRegistry = useMemo(
    () => new SourceContextRegistry(sourceSequences),
    [sourceSequences]
  );
  const sourceWindowRequests = useMemo(
    () => createJunctionSourceWindowRequests(normalizedRenderDesign),
    [normalizedRenderDesign]
  );
  const sourceWindows = useMemo(
    () => sourceRegistry.resolveWindows(sourceWindowRequests),
    [sourceRegistry, sourceWindowRequests]
  );
  const sourceContext = useMemo(
    () => createAssemblyWorkbenchSourceContext(sourceWindows),
    [sourceWindows]
  );
  const jumpToJunctionInSequenceViewer = useCallback(
    (position: number) => {
      navigateToPosition(design.id, position);
      const designTab = findDesignTab('design', design.id);
      if (designTab) {
        setActiveTab(designTab.panelId, designTab.tabId);
      }
    },
    [design.id, findDesignTab, navigateToPosition, setActiveTab]
  );

  const canonicalModels = useMemo(() => {
    modelBuildCountRef.current++;
    return buildJunctionWorkbenchModels(normalizedRenderDesign, {
      sourceWindows,
      includeUnannotatedJunctions: readOnly,
    });
  }, [assemblyColorScheme, normalizedRenderDesign, readOnly, sourceWindows]);

  const models = useMemo(
    () =>
      applyOverrideToCanonicalModels(
        canonicalModels,
        sourceWindows,
        sourceDragOverride ?? undefined,
        normalizedRenderDesign
      ),
    [canonicalModels, sourceWindows, sourceDragOverride, normalizedRenderDesign]
  );
  const session = useMemo(
    () =>
      createAssemblyWorkbenchSession(normalizedRenderDesign, renderViewState, {
        sourceContext,
        readOnly,
      }),
    [normalizedRenderDesign, readOnly, renderViewState, sourceContext]
  );
  const hasActualPcrPrimerFragments =
    selectPhysicalDesignPrimerPairs(normalizedRenderDesign).length > 0;

  useEffect(() => {
    if (!liveOptimizerPreview) return;
    const livePreviews = liveOptimizerPreview.choices
      .map((choice) =>
        goldenGateOptimizerLiveFieldPreviewForChoice(
          models,
          session.editableFields,
          choice,
          design.pcrPolymerase
        )
      )
      .filter(
        (
          item
        ): item is {
          field: AssemblyWorkbenchEditableField;
          preview: AssemblyWorkbenchLiveFieldPreview;
        } => item !== null
      );
    liveFieldValueStore.setMany(livePreviews);
  }, [
    design.pcrPolymerase,
    liveFieldValueStore,
    liveOptimizerPreview,
    models,
    session.editableFields,
  ]);

  useEffect(() => {
    setPreviewState(null);
    setGoldenGateOptimizerPreview(null);
    liveFieldValueStore.clear();
  }, [design.id, liveFieldValueStore, productIdentity]);

  useEffect(() => {
    setUndoStack([]);
  }, [design.id]);

  useEffect(() => {
    const testBridge = (
      window as Window & {
        __test?: { lastWorkbenchCommandTrace?: WorkbenchCommandTrace | null };
      }
    ).__test;
    if (testBridge) testBridge.lastWorkbenchCommandTrace = lastCommandTrace;
  }, [lastCommandTrace]);

  const applyWorkbenchCommand = useCallback(
    (
      command: AssemblyWorkbenchCommand,
      options: { commit?: boolean } = {}
    ): ReturnType<typeof applyAssemblyWorkbenchCommand> => {
      if (readOnly)
        return {
          status: 'noop',
          nextDesign: design,
          nextViewState: viewState,
          errors: [],
          warnings: [],
          appliedCommands: [],
          projectionInvalidated: false,
        };
      const shouldCommit = options.commit !== false;
      const commandWithVersion =
        command.type === 'selectJunction'
          ? command
          : ({ ...command, expectedDesignVersion: design.version } as AssemblyWorkbenchCommand);
      const result = applyAssemblyWorkbenchCommand({
        design,
        viewState,
        sourceContext,
        command: commandWithVersion,
      });
      setLastCommandTrace(
        buildWorkbenchCommandTrace(command.type, result.status, design, result.nextDesign)
      );

      if (!shouldCommit) {
        setPreviewState(
          result.status === 'applied'
            ? tagAssemblyDerived(productIdentity, {
                design: result.nextDesign,
                viewState: result.nextViewState,
                errors: result.errors,
                commandType: command.type,
              })
            : null
        );
        return result;
      }

      setCommandErrors(result.errors);
      setPreviewState(null);
      setGoldenGateOptimizerPreview(null);
      setViewState(result.nextViewState);
      if (result.status === 'applied' && result.nextDesign !== design) {
        const committed = commitWorkbenchDesign(design.id, result.nextDesign, design.version);
        if (!committed) {
          setCommandErrors([
            {
              code: 'stale-design-version',
              message: 'The design changed before this workbench command could be committed.',
              commandType: command.type,
              expectedDesignVersion: design.version,
            },
          ]);
        } else {
          setUndoStack((current) => {
            const coalesceKey = workbenchUndoCoalesceKey(command);
            const last = current[current.length - 1];
            if (coalesceKey && last?.coalesceKey === coalesceKey) {
              return current;
            }
            return [
              ...current,
              {
                design,
                viewState,
                commandType: command.type,
                coalesceKey,
              },
            ].slice(-MAX_WORKBENCH_UNDO_DEPTH);
          });
        }
      }
      return result;
    },
    [commitWorkbenchDesign, design, productIdentity, readOnly, sourceContext, viewState]
  );

  const undoLastWorkbenchChange = useCallback(() => {
    if (readOnly) return;
    const snapshot = undoStack[undoStack.length - 1];
    if (!snapshot || snapshot.design.id !== design.id) return;
    const currentDesign = useDesignStore.getState().designs[design.id] ?? design;
    const restoredDesign: SequenceDesign = {
      ...snapshot.design,
      version: currentDesign.version + 1,
      updatedAt: new Date(),
    };
    const committed = commitWorkbenchDesign(design.id, restoredDesign, currentDesign.version);
    if (!committed) {
      setCommandErrors([
        {
          code: 'stale-design-version',
          message: 'The design changed before undo could restore the previous workbench state.',
          commandType: snapshot.commandType,
          expectedDesignVersion: currentDesign.version,
        },
      ]);
      return;
    }
    setUndoStack((current) => current.slice(0, -1));
    setCommandErrors([]);
    setPreviewState(null);
    setGoldenGateOptimizerPreview(null);
    liveFieldValueStore.clear();
    setSourceDragOverride(null);
    setViewState(snapshot.viewState);
  }, [commitWorkbenchDesign, design, liveFieldValueStore, readOnly, undoStack]);

  const autoOptimizeWorkbench = useCallback(
    (candidateRank?: number) => {
      setGoldenGateOptimizerPreview(null);
      applyWorkbenchCommand({
        type: 'autoOptimize',
        scope: 'all',
        candidateRank,
      });
    },
    [applyWorkbenchCommand]
  );

  const previewWorkbenchCommand = useCallback(
    (command: AssemblyWorkbenchCommand) => {
      applyWorkbenchCommand(command, { commit: false });
      setInteractionCounters((current) => ({
        ...current,
        previewCommandCount: current.previewCommandCount + 1,
      }));
    },
    [applyWorkbenchCommand]
  );

  const previewAutoOptimizeWorkbench = useCallback(
    (candidateRank: number, combination: GoldenGateOptimizationCombination) => {
      setPreviewState(null);
      setGoldenGateOptimizerPreview(
        tagAssemblyDerived(productIdentity, {
          candidateRank,
          choices: combination.choices,
        })
      );
      setLastCommandTrace(goldenGateOptimizerPreviewTrace(design, combination));
      setInteractionCounters((current) => ({
        ...current,
        previewCommandCount: current.previewCommandCount + 1,
      }));
    },
    [design, productIdentity]
  );

  const cancelWorkbenchPreview = useCallback(() => {
    setPreviewState(null);
    setGoldenGateOptimizerPreview(null);
    liveFieldValueStore.clear();
  }, [liveFieldValueStore]);

  const setLiveFieldPreview = useCallback(
    (field: AssemblyWorkbenchEditableField, preview: AssemblyWorkbenchLiveFieldPreview) => {
      liveFieldValueStore.set(field, preview);
    },
    [liveFieldValueStore]
  );

  const clearLiveFieldPreview = useCallback(() => {
    liveFieldValueStore.clear();
  }, [liveFieldValueStore]);

  const runPreviewFieldCommand = useCallback(
    (field: AssemblyWorkbenchEditableField, nextValue: number) => {
      if (field.kind === 'sourceContributionBoundary') {
        setInteractionCounters((current) => ({
          ...current,
          previewCommandCount: current.previewCommandCount + 1,
        }));
        return;
      }
      const resolved = resolveEditableFieldCommand(field, nextValue, {
        expectedDesignVersion: design.version,
        recomputePrimers: false,
      });
      if (resolved.status !== 'resolved') return;
      applyWorkbenchCommand(resolved.command, { commit: false });
      setInteractionCounters((current) => ({
        ...current,
        previewCommandCount: current.previewCommandCount + 1,
      }));
    },
    [applyWorkbenchCommand, design.version]
  );

  const previewFieldCommand = useCallback(
    (field: AssemblyWorkbenchEditableField, nextValue: number) => {
      pendingPreviewRef.current = { field, nextValue };
      if (previewRafRef.current !== null || previewTimeoutRef.current !== null) return;

      const runPreviewFrame = () => {
        previewRafRef.current = null;
        const pending = pendingPreviewRef.current;
        pendingPreviewRef.current = null;
        if (!pending) return;
        lastPreviewRunAtRef.current = nowMs();
        setInteractionCounters((current) => ({
          ...current,
          previewFrameCount: current.previewFrameCount + 1,
        }));
        runPreviewFieldCommand(pending.field, pending.nextValue);
      };

      const scheduleRaf = () => {
        previewTimeoutRef.current = null;
        previewRafRef.current = requestAnimationFrame(runPreviewFrame);
      };

      const elapsed = nowMs() - lastPreviewRunAtRef.current;
      if (elapsed >= PREVIEW_COMMAND_THROTTLE_MS) {
        scheduleRaf();
        return;
      }

      previewTimeoutRef.current = window.setTimeout(
        scheduleRaf,
        PREVIEW_COMMAND_THROTTLE_MS - elapsed
      );
    },
    [runPreviewFieldCommand]
  );

  const commitFieldCommand = useCallback(
    (field: AssemblyWorkbenchEditableField, nextValue: number) => {
      setInteractionCounters((current) => ({
        ...current,
        fieldCommitAttemptCount: current.fieldCommitAttemptCount + 1,
      }));
      if (previewRafRef.current !== null) {
        cancelAnimationFrame(previewRafRef.current);
        previewRafRef.current = null;
      }
      if (previewTimeoutRef.current !== null) {
        clearTimeout(previewTimeoutRef.current);
        previewTimeoutRef.current = null;
      }
      pendingPreviewRef.current = null;
      const resolved = resolveEditableFieldCommand(field, nextValue, {
        expectedDesignVersion: design.version,
        recomputePrimers: true,
      });
      if (resolved.status !== 'resolved') {
        setFieldCommitDiagnostic({
          fieldId: field.id,
          value: nextValue,
          resolveStatus: 'rejected',
          rejectReason: resolved.reason,
        });
        setPreviewState(null);
        liveFieldValueStore.clear();
        return;
      }
      setFieldCommitDiagnostic({
        fieldId: field.id,
        value: nextValue,
        resolveStatus: 'resolved',
      });
      setInteractionCounters((current) => ({
        ...current,
        commitCommandCount: current.commitCommandCount + 1,
      }));
      applyWorkbenchCommand(resolved.command);
    },
    [applyWorkbenchCommand, design.version, liveFieldValueStore]
  );

  const cancelFieldPreview = useCallback(() => {
    if (previewRafRef.current !== null) {
      cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = null;
    }
    if (previewTimeoutRef.current !== null) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
    pendingPreviewRef.current = null;
    setPreviewState(null);
    liveFieldValueStore.clear();
  }, [liveFieldValueStore]);

  useEffect(
    () => () => {
      if (previewRafRef.current !== null) cancelAnimationFrame(previewRafRef.current);
      if (previewTimeoutRef.current !== null) clearTimeout(previewTimeoutRef.current);
    },
    []
  );

  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    const missingRequests = sourceRegistry.unresolvedRequests(sourceWindowRequests);
    const missingKeys = Array.from(
      new Set(missingRequests.flatMap(sourceLookupKeys).filter((key) => !sourceSequences[key]))
    );
    const shouldScanDb = missingRequests.length > 0 && !hasScannedDbSources;
    if (missingKeys.length === 0 && !shouldScanDb) return;

    void Promise.all([
      ...missingKeys.map(async (key) => {
        try {
          const sequence = await loadSourceSequenceForKey(key);
          return sequence ? ([[key, sequence]] as Array<readonly [string, AnnotatedSequence]>) : [];
        } catch {
          return [];
        }
      }),
      shouldScanDb
        ? loadAllSourceSequencesFromDb().catch(
            () => [] as Array<readonly [string, AnnotatedSequence]>
          )
        : Promise.resolve([]),
    ]).then((entryGroups) => {
      if (cancelled) return;
      if (shouldScanDb) setHasScannedDbSources(true);
      const found = entryGroups.flat();
      if (found.length === 0) return;
      setDbSourceSequences((prev) => {
        const next = { ...prev };
        for (const [key, sequence] of found) next[key] = sequence;
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [hasScannedDbSources, readOnly, sourceRegistry, sourceSequences, sourceWindowRequests]);

  const optimizeSurface = useMemo(
    () => assemblyOptimizeSurface(normalizedBaseDesign),
    [normalizedBaseDesign]
  );
  const optimizeSlot = (
    <AssemblyOptimizeSlot
      surface={optimizeSurface}
      optimizationInput={optimizationInput}
      onAutoOptimize={autoOptimizeWorkbench}
      onPreviewAutoOptimize={previewAutoOptimizeWorkbench}
    />
  );
  const temperatureReadout = (
    <WorkbenchTemperatureReadout session={session} liveFieldValueStore={liveFieldValueStore} />
  );
  const mixAndViewChrome = readOnly ? (
    temperatureReadout
  ) : (
    <AssemblyRecipeStrip
      design={design}
      mix={
        session.controls.pcrSettingsAvailable ? (
          <AssemblyPcrTmConfigurator
            designId={design.id}
            polymerase={design.pcrPolymerase}
            method={design.assemblyMethod}
          />
        ) : null
      }
      readout={temperatureReadout}
      tools={
        <>
          {optimizeSlot}
          {design.assemblyMethod === 'goldengate' && hasActualPcrPrimerFragments ? (
            <NumberControl
              label="Lim"
              testId="assembly-workbench-goldengate-offset-limit"
              value={goldenGateOffsetLimitBp(design.goldenGateConfig)}
              min={GOLDEN_GATE_OFFSET_LIMIT_MIN_BP}
              max={GOLDEN_GATE_OFFSET_LIMIT_MAX_BP}
              disabled={false}
              onChange={(limit) =>
                applyWorkbenchCommand({
                  type: 'setGoldenGateOffsetLimit',
                  limit,
                })
              }
            />
          ) : null}
        </>
      }
      actions={
        undoStack.length > 0 ? (
          <button
            type="button"
            data-testid="assembly-workbench-undo"
            title="Undo last assembly edit"
            onClick={undoLastWorkbenchChange}
            className="h-6 rounded-[4px] border border-border bg-bg-muted px-2 text-xs leading-5 text-fg hover:bg-bg-emphasis"
          >
            Undo
          </button>
        ) : null
      }
    />
  );
  if (models.length === 0) {
    return (
      <div
        data-testid="junction-workbench"
        data-read-only={readOnly}
        data-workbench-preview-active={workbenchPreviewActive ? 'true' : 'false'}
        data-workbench-preview-command={workbenchPreviewCommand}
        data-workbench-product-identity={productIdentity}
        data-workbench-base-design-version={design.version}
        data-workbench-render-design-version={renderDesign.version}
        data-workbench-preview-frame-count={interactionCounters.previewFrameCount}
        data-workbench-preview-command-count={interactionCounters.previewCommandCount}
        data-workbench-commit-command-count={interactionCounters.commitCommandCount}
        data-workbench-field-commit-attempt-count={interactionCounters.fieldCommitAttemptCount}
        data-workbench-last-field-commit-id={fieldCommitDiagnostic?.fieldId ?? ''}
        data-workbench-last-field-commit-value={fieldCommitDiagnostic?.value ?? ''}
        data-workbench-last-field-commit-resolve-status={fieldCommitDiagnostic?.resolveStatus ?? ''}
        data-workbench-last-field-commit-reject-reason={fieldCommitDiagnostic?.rejectReason ?? ''}
        data-workbench-viewport-variant={viewportVariant}
        data-workbench-viewport-renderer={viewportRenderer}
        data-workbench-preview-throttle-ms={PREVIEW_COMMAND_THROTTLE_MS}
        data-workbench-model-build-count={modelBuildCountRef.current}
        data-workbench-last-command-trace={lastCommandTrace ? JSON.stringify(lastCommandTrace) : ''}
        className="relative min-w-0 max-w-full space-y-1.5 overflow-hidden"
      >
        {mixAndViewChrome}
        <WorkbenchIssueSummary
          issues={workbenchIssueItemsForSummary(session.findings, commandErrors)}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="junction-workbench"
      data-read-only={readOnly}
      data-workbench-preview-active={workbenchPreviewActive ? 'true' : 'false'}
      data-workbench-preview-command={workbenchPreviewCommand}
      data-workbench-product-identity={productIdentity}
      data-workbench-base-design-version={design.version}
      data-workbench-render-design-version={renderDesign.version}
      data-workbench-preview-frame-count={interactionCounters.previewFrameCount}
      data-workbench-preview-command-count={interactionCounters.previewCommandCount}
      data-workbench-commit-command-count={interactionCounters.commitCommandCount}
      data-workbench-field-commit-attempt-count={interactionCounters.fieldCommitAttemptCount}
      data-workbench-last-field-commit-id={fieldCommitDiagnostic?.fieldId ?? ''}
      data-workbench-last-field-commit-value={fieldCommitDiagnostic?.value ?? ''}
      data-workbench-last-field-commit-resolve-status={fieldCommitDiagnostic?.resolveStatus ?? ''}
      data-workbench-last-field-commit-reject-reason={fieldCommitDiagnostic?.rejectReason ?? ''}
      data-workbench-viewport-variant={viewportVariant}
      data-workbench-viewport-renderer={viewportRenderer}
      data-workbench-preview-throttle-ms={PREVIEW_COMMAND_THROTTLE_MS}
      data-workbench-model-build-count={modelBuildCountRef.current}
      data-workbench-last-command-trace={lastCommandTrace ? JSON.stringify(lastCommandTrace) : ''}
      className="relative min-w-0 max-w-full space-y-1.5 overflow-hidden"
    >
      {mixAndViewChrome}

      <div data-testid="assembly-workbench-story" className="min-w-0 space-y-1.5">
        {models.map((model) => {
          const modelEditableFields = editableFieldsForModel(session.editableFields, model);
          const modelHasEnabledFields = modelEditableFields.some((field) => !field.disabled);
          const modelJunction = session.controls.junctions.find(
            (junction) => junction.junctionIndex === model.junctionIndex
          );
          const sequenceViewerPosition = sequenceViewerPositionForJunction(model, modelJunction);
          const junctionIssues = workbenchIssueItemsForJunction(
            session.findings,
            commandErrors,
            model.junctionIndex,
            modelJunction?.id
          );
          const goldenGatePreviewChoice = liveOptimizerPreview?.choices.find(
            (choice) => choice.junctionIndex === model.junctionIndex
          );
          const leftRegionIndex = model.junctionIndex;
          const rightRegionIndex = (leftRegionIndex + 1) % design.regions.length;
          const closesCircle = design.topology === 'circular' && rightRegionIndex === 0;
          return (
            <section
              key={model.id}
              data-testid="junction-workbench-card"
              data-assembly-story-kind="junction"
              data-junction-index={model.junctionIndex}
              data-closes-circle={closesCircle ? 'true' : 'false'}
              data-method={model.method}
              data-window-bp={Math.max(...model.rows.map((row) => row.sequence.length))}
              data-editable={modelHasEnabledFields ? 'true' : 'false'}
              data-issue-severity={highestIssueSeverity(junctionIssues) ?? 'none'}
              title={junctionIssues.map((issue) => issue.message).join('\n') || undefined}
              className={workbenchCardClassName(junctionIssues)}
            >
              <WorkbenchCardAccentRail model={model} />
              {readOnly && !model.homologyRegion && !model.goldenGateJunction && (
                <p className="px-2 py-1 text-xs text-fg-muted">{model.subtitle}</p>
              )}
              {viewportRenderer === 'registered-assembly-viewport' ? (
                <RegisteredAssemblyViewport
                  rows={model.rows}
                  rowMetrics={rowMetricsForModel(model, modelJunction)}
                  editableFields={modelEditableFields}
                  pcrPolymerase={design.pcrPolymerase}
                  goldenGateOptimizerPreviewChoice={goldenGatePreviewChoice}
                  productControls={
                    !readOnly && modelJunction ? (
                      <ProductRowControlPanel
                        session={session}
                        junction={modelJunction}
                        basePrimerPbsLengths={basePrimerPbsLengths}
                        goldenGatePreviewChoice={goldenGatePreviewChoice}
                        liveFieldValueStore={liveFieldValueStore}
                        onJumpToSequenceViewer={
                          sequenceViewerPosition === null
                            ? undefined
                            : () => jumpToJunctionInSequenceViewer(sequenceViewerPosition)
                        }
                        onCommand={applyWorkbenchCommand}
                        onPreviewCommand={previewWorkbenchCommand}
                        onFieldCommit={commitFieldCommand}
                        onCancelPreview={cancelWorkbenchPreview}
                      />
                    ) : null
                  }
                  onFieldPreview={previewFieldCommand}
                  onFieldCommit={commitFieldCommand}
                  onFieldCancel={cancelFieldPreview}
                  onFieldLivePreview={setLiveFieldPreview}
                  onFieldLivePreviewEnd={clearLiveFieldPreview}
                  onSourceDragOverride={(override) =>
                    setSourceDragOverride(
                      override === null ? null : { junctionIndex: model.junctionIndex, ...override }
                    )
                  }
                />
              ) : (
                <LinkedCameraGroup
                  rows={model.rows}
                  mapping={model.mapping}
                  rowMetrics={rowMetricsForModel(model, modelJunction)}
                  editableFields={modelEditableFields}
                  productControls={
                    !readOnly && modelJunction ? (
                      <ProductRowControlPanel
                        session={session}
                        junction={modelJunction}
                        basePrimerPbsLengths={basePrimerPbsLengths}
                        goldenGatePreviewChoice={goldenGatePreviewChoice}
                        liveFieldValueStore={liveFieldValueStore}
                        onJumpToSequenceViewer={
                          sequenceViewerPosition === null
                            ? undefined
                            : () => jumpToJunctionInSequenceViewer(sequenceViewerPosition)
                        }
                        onCommand={applyWorkbenchCommand}
                        onPreviewCommand={previewWorkbenchCommand}
                        onFieldCommit={commitFieldCommand}
                        onCancelPreview={cancelWorkbenchPreview}
                      />
                    ) : null
                  }
                  onFieldPreview={previewFieldCommand}
                  onFieldPreviewImmediate={runPreviewFieldCommand}
                  onFieldCommit={commitFieldCommand}
                  onFieldCancel={cancelFieldPreview}
                />
              )}
            </section>
          );
        })}
      </div>
      <WorkbenchIssueSummary
        issues={workbenchIssueItemsForSummary(session.findings, commandErrors)}
      />
    </div>
  );
}

function rowMetricsForModel(
  model: JunctionWorkbenchModel,
  junction: AssemblyWorkbenchJunctionControl | undefined
): JunctionRowMetricsByRowId {
  const leftRow = model.rows.find((row) => row.kind === 'left-source');
  const rightRow = model.rows.find((row) => row.kind === 'right-source');
  const leftPrimer = junctionPrimerForSide(junction, 'left');
  const rightPrimer = junctionPrimerForSide(junction, 'right');
  return {
    ...(leftRow
      ? {
          [leftRow.id]: {
            primerBindingLength: leftPrimer?.pbsLength ?? null,
            homologyLength: junction?.homology?.onLeft ?? null,
          },
        }
      : {}),
    ...(rightRow
      ? {
          [rightRow.id]: {
            primerBindingLength: rightPrimer?.pbsLength ?? null,
            homologyLength: junction?.homology?.onRight ?? null,
          },
        }
      : {}),
  };
}

function junctionPrimerForSide(
  junction: AssemblyWorkbenchJunctionControl | undefined,
  side: 'left' | 'right'
): AssemblyWorkbenchPrimerControl | undefined {
  const direction = side === 'left' ? 'reverse' : 'forward';
  return junction?.primers.find((primer) => primer.direction === direction);
}

function editableFieldsForModel(
  fields: AssemblyWorkbenchEditableField[],
  model: JunctionWorkbenchModel
): AssemblyWorkbenchEditableField[] {
  return fields.filter((field) => field.target.junctionIndex === model.junctionIndex);
}

function sequenceViewerPositionForJunction(
  model: JunctionWorkbenchModel,
  junction: AssemblyWorkbenchJunctionControl | undefined
): number | null {
  return (
    model.homologyRegion?.junctionPosition ??
    model.goldenGateJunction?.junctionPosition ??
    junction?.goldenGate?.junctionPosition ??
    null
  );
}

function WorkbenchTemperatureReadout({
  session,
  liveFieldValueStore,
}: {
  session: ReturnType<typeof createAssemblyWorkbenchSession>;
  liveFieldValueStore: LiveFieldValueStore;
}) {
  useSyncExternalStore(
    liveFieldValueStore.subscribe,
    liveFieldValueStore.getSnapshot,
    liveFieldValueStore.getSnapshot
  );
  const temperatureSummary = workbenchTemperatureSummary(session, liveFieldValueStore);
  if (temperatureSummary.length === 0) return null;
  return (
    <div
      data-testid="assembly-workbench-temperature-summary"
      className="flex min-w-0 flex-wrap items-center justify-end gap-2 overflow-hidden text-[11px] leading-4 text-fg-muted"
    >
      {temperatureSummary.map((item) => (
        <span key={item.label} className="min-w-0 tabular-nums">
          <span className="mr-1">{shortTemperatureLabel(item.label)}</span>
          <span className="text-fg">{item.value}</span>
        </span>
      ))}
    </div>
  );
}

function shortTemperatureLabel(label: string): string {
  if (label === 'Anneal Tm') return 'anneal';
  if (label === 'Overlap Tm') return 'overlap';
  return label;
}

function AssemblyOptimizeSlot({
  surface,
  optimizationInput,
  onAutoOptimize,
  onPreviewAutoOptimize,
}: {
  surface: AssemblyOptimizeSurface;
  optimizationInput: AssemblyOptimizationInput;
  onAutoOptimize: (candidateRank?: number) => void;
  onPreviewAutoOptimize: (
    candidateRank: number,
    combination: GoldenGateOptimizationCombination
  ) => void;
}) {
  if (surface.kind === 'none') return null;
  return (
    <div data-testid="assembly-workbench-optimize" data-kind={surface.kind}>
      {surface.kind === 'homology-one-click' ? (
        <Button
          type="button"
          size="xs"
          variant="secondary"
          data-testid="assembly-workbench-auto-optimize"
          title="Optimize assembly junctions"
          onClick={() => onAutoOptimize()}
        >
          {surface.label}
        </Button>
      ) : (
        <GoldenGateOptimizerPanel
          optimizationInput={optimizationInput}
          canAutoOptimize
          onPreviewAutoOptimize={onPreviewAutoOptimize}
          onCommitAutoOptimize={onAutoOptimize}
        />
      )}
    </div>
  );
}

function GoldenGateOptimizerPanel({
  optimizationInput,
  canAutoOptimize,
  onPreviewAutoOptimize,
  onCommitAutoOptimize,
}: {
  optimizationInput: AssemblyOptimizationInput;
  canAutoOptimize: boolean;
  onPreviewAutoOptimize: (
    candidateRank: number,
    combination: GoldenGateOptimizationCombination
  ) => void;
  onCommitAutoOptimize: (candidateRank?: number) => void;
}) {
  const optimizerRef = useRef<HTMLDivElement | null>(null);
  const candidateListRef = useRef<HTMLDivElement | null>(null);
  const candidateRowRefs = useRef(new Map<number, HTMLButtonElement>());
  const canOfferAutoOptimize = canAutoOptimize && optimizationInput.method === 'goldengate';

  const [optimizeRequested, setOptimizeRequested] = useState(false);
  const openedForMethodRef = useRef(optimizationInput.method);
  const openedForFingerprintRef = useRef(optimizationInput.optimizationFingerprint);
  useEffect(() => {
    if (openedForMethodRef.current === optimizationInput.method) return;
    openedForMethodRef.current = optimizationInput.method;
    setOptimizeRequested(false);
  }, [optimizationInput.method]);
  useEffect(() => {
    if (openedForFingerprintRef.current === optimizationInput.optimizationFingerprint) return;
    openedForFingerprintRef.current = optimizationInput.optimizationFingerprint;
    setOptimizeRequested(false);
  }, [optimizationInput.optimizationFingerprint]);
  const optimizer = useMemo(
    () =>
      optimizeRequested && canOfferAutoOptimize
        ? planGoldenGateAutoOptimization(optimizationInput, { topCombinationCount: 8 })
        : null,
    [optimizeRequested, canOfferAutoOptimize, optimizationInput]
  );
  const combinations = useMemo(
    () => (optimizer?.status === 'planned' ? optimizer.topCombinations : []),
    [optimizer]
  );
  const [rank, setRank] = useState(0);
  useEffect(() => {
    setRank(0);
  }, [optimizer?.optimizationFingerprint]);
  useEffect(() => {
    if (rank >= combinations.length) {
      setRank(Math.max(0, combinations.length - 1));
    }
  }, [combinations.length, rank]);
  const safeRank =
    combinations.length === 0 ? 0 : Math.max(0, Math.min(combinations.length - 1, rank));
  useEffect(() => {
    const list = candidateListRef.current;
    if (!list) return;
    if (safeRank === 0) {
      list.scrollTop = 0;
      return;
    }
    const row = candidateRowRefs.current.get(safeRank);
    if (!row) return;
    if (typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      });
      return;
    }
    list.scrollTop = row.offsetTop;
  }, [combinations.length, safeRank]);
  const selectRank = useCallback(
    (nextRank: number) => {
      if (combinations.length === 0) return;
      const clamped = Math.max(0, Math.min(combinations.length - 1, nextRank));
      const combination = combinations[clamped];
      if (!combination) return;
      setRank(clamped);
      onPreviewAutoOptimize(clamped, combination);
    },
    [combinations, onPreviewAutoOptimize]
  );
  const commitSelectedRank = useCallback(() => {
    if (combinations.length === 0) return;
    if (safeRank === 0) return;
    onCommitAutoOptimize(safeRank);
    setRank(0);
  }, [combinations.length, onCommitAutoOptimize, safeRank]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        selectRank(rank - 1);
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        selectRank(rank + 1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        commitSelectedRank();
      }
    },
    [commitSelectedRank, rank, selectRank]
  );
  if (optimizer?.status !== 'planned' || combinations.length === 0) {
    if (canOfferAutoOptimize && !optimizeRequested) {
      return (
        <Button
          type="button"
          size="xs"
          variant="secondary"
          data-testid="assembly-workbench-goldengate-optimizer-run"
          onClick={() => setOptimizeRequested(true)}
        >
          Optimize overhangs
        </Button>
      );
    }
    return null;
  }
  const combination = combinations[safeRank];
  if (!combination) return null;
  const previewingCandidate = safeRank !== 0;
  const overhangSummary = goldenGateCombinationSummary(combination);
  const junctionColumns = goldenGateOptimizerJunctionColumns(combinations);
  const gridTemplateColumns = `4.75rem repeat(${junctionColumns.length}, minmax(3.25rem, 1fr)) 3.25rem`;
  return (
    <div
      ref={optimizerRef}
      data-testid="assembly-workbench-goldengate-optimizer"
      data-exhaustive={optimizer.exhaustive ? 'true' : 'false'}
      data-optimization-fingerprint={optimizationInput.optimizationFingerprint}
      data-state={previewingCandidate ? 'preview' : 'current'}
      data-overhangs={overhangSummary}
      tabIndex={0}
      role="listbox"
      aria-label="Golden Gate overhang combinations"
      aria-activedescendant={`assembly-workbench-goldengate-optimizer-row-${safeRank}`}
      onKeyDown={handleKeyDown}
      className="min-w-0 outline-none"
    >
      <div className="mb-1.5 flex justify-end">
        <Button
          type="button"
          size="xs"
          variant="primary"
          data-testid="assembly-workbench-goldengate-optimizer-apply"
          onClick={commitSelectedRank}
          disabled={!previewingCandidate}
        >
          Apply
        </Button>
      </div>
      <div
        className="grid min-w-0 items-center gap-x-1 border-b border-border px-1 py-1 text-xs font-medium uppercase tracking-wider text-fg-muted"
        data-testid="assembly-workbench-goldengate-optimizer-header"
        style={{ gridTemplateColumns }}
      >
        <span>Choice</span>
        {junctionColumns.map((junctionIndex) => (
          <span
            key={junctionIndex}
            data-testid={`assembly-workbench-goldengate-optimizer-header-junction-${junctionIndex}`}
            className="text-center"
          >
            J{junctionIndex + 1}
          </span>
        ))}
        <span className="text-right">Score</span>
      </div>
      <div
        ref={candidateListRef}
        data-testid="assembly-workbench-goldengate-optimizer-list"
        data-row-count={combinations.length}
        className="grid min-w-0"
      >
        {combinations.map((candidate, candidateRank) => {
          const selected = candidateRank === safeRank;
          const currentDesignRow = candidateRank === 0;
          const previewRow = selected && !currentDesignRow;
          const summary = goldenGateCombinationSummary(candidate);
          const choiceLabel = goldenGateOptimizerChoiceLabel(candidateRank);
          const choicesByJunctionIndex = new Map(
            candidate.choices.map((choice) => [choice.junctionIndex, choice])
          );
          return (
            <button
              key={candidate.rank}
              id={`assembly-workbench-goldengate-optimizer-row-${candidateRank}`}
              type="button"
              role="option"
              aria-selected={selected}
              tabIndex={-1}
              data-current-design={currentDesignRow ? 'true' : 'false'}
              data-previewing={previewRow ? 'true' : 'false'}
              data-implicit-best={
                candidateRank !== 0 && candidateRank === optimizer.selectedRank ? 'true' : 'false'
              }
              data-testid={`assembly-workbench-goldengate-optimizer-row-${candidateRank}`}
              ref={(element) => {
                if (element) {
                  candidateRowRefs.current.set(candidateRank, element);
                } else {
                  candidateRowRefs.current.delete(candidateRank);
                }
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                safeFocus(optimizerRef.current, { preventScroll: true });
                selectRank(candidateRank);
              }}
              style={{ gridTemplateColumns }}
              className={`grid min-w-0 items-center gap-x-1 border-0 px-1 py-1 text-left text-xs leading-5 outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 ${
                selected ? 'bg-bg text-fg' : 'text-fg-muted hover:bg-fg/5 hover:text-fg'
              }`}
              title={summary}
            >
              <span
                className="truncate tabular-nums"
                data-testid={selected ? 'assembly-workbench-goldengate-optimizer-rank' : undefined}
              >
                {choiceLabel}
              </span>
              {junctionColumns.map((junctionIndex) => {
                const choice = choicesByJunctionIndex.get(junctionIndex);
                return (
                  <span
                    key={junctionIndex}
                    data-testid={`assembly-workbench-goldengate-optimizer-cell-${candidateRank}-junction-${junctionIndex}`}
                    className="truncate text-center font-mono"
                  >
                    {choice ? `${choice.overhang}${choice.locked ? '*' : ''}` : '-'}
                  </span>
                );
              })}
              <span className="text-right font-mono tabular-nums">
                {formatPercent(candidate.fidelity.fidelity)}
              </span>
            </button>
          );
        })}
      </div>
      <div
        data-testid="assembly-workbench-goldengate-optimizer-search-status"
        data-exhaustive={optimizer.exhaustive ? 'true' : 'false'}
        title={
          optimizer.exhaustive
            ? 'The search finished every allowed combination.'
            : 'The search stopped at its node budget before proving optimality. These are the best combinations found so far.'
        }
        className={optimizer.exhaustive ? 'sr-only' : 'pt-1.5 text-xs text-fg-muted'}
      >
        {goldenGateOptimizerSearchStatusLabel(optimizer.exhaustive)}
      </div>
    </div>
  );
}

function goldenGateCombinationSummary(combination: GoldenGateOptimizationCombination): string {
  return combination.choices
    .map((choice) => `J${choice.junctionIndex + 1} ${choice.overhang}${choice.locked ? '*' : ''}`)
    .join('  ');
}

function goldenGateOptimizerChoiceLabel(rank: number): string {
  if (rank === 0) return 'Manual';
  return String(rank);
}

function goldenGateOptimizerSearchStatusLabel(exhaustive: boolean): string {
  return exhaustive ? 'Search complete' : 'Stopped at budget';
}

function goldenGateOptimizerJunctionColumns(
  combinations: readonly GoldenGateOptimizationCombination[]
): number[] {
  return Array.from(
    new Set(
      combinations.flatMap((combination) =>
        combination.choices.map((choice) => choice.junctionIndex)
      )
    )
  ).sort((left, right) => left - right);
}

export function workbenchTemperatureSummary(
  session: ReturnType<typeof createAssemblyWorkbenchSession>,
  liveFieldValueStore?: LiveFieldValueStore
) {
  const overlapTms = session.controls.junctions
    .map((junction) => {
      const live = liveFieldValueStore?.getHomologyTm(junction.junctionIndex);
      return live === undefined ? junction.homology?.tmEstimate : live;
    })
    .filter(isFiniteNumber);
  const annealingTms = session.controls.junctions
    .flatMap((junction) =>
      junction.primers.map((primer) => {
        const live = liveFieldValueStore?.getPrimerTm(primer);
        return live === undefined ? primer.tm : live;
      })
    )
    .filter(isFiniteNumber)

    .filter((tm) => tm > 0);
  const items: Array<{ label: string; value: string }> = [];
  if (session.controls.junctions.some((junction) => junction.homology)) {
    items.push({ label: 'Overlap Tm', value: formatTemperatureRange(overlapTms) });
  }

  if (annealingTms.length > 0) {
    items.push({ label: 'Anneal Tm', value: formatTemperatureRange(annealingTms) });
  }
  return items;
}

function formatTemperatureRange(values: number[]): string {
  if (values.length === 0) return 'n/a';
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (Math.abs(max - min) < 0.05) return `${min.toFixed(1)}°C`;
  return `${min.toFixed(1)}–${max.toFixed(1)}°C`;
}

function formatTemperature(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)} C`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0.0%';
  return `${(value * 100).toFixed(1)}%`;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function WorkbenchIssueSummary({ issues }: { issues: readonly WorkbenchIssueItem[] }) {
  const severity = highestIssueSeverity(issues);
  if (!severity) return null;

  return (
    <details
      data-testid="assembly-workbench-bottom-warning-summary"
      data-issue-severity={severity}
      className={`sticky bottom-0 z-10 shadow-sm backdrop-blur ${WORKBENCH_ISSUE_CLASS}`}
    >
      <summary className={UI_DISCLOSURE_SUMMARY_CLASS}>{issueCountLabel(issues)}</summary>
      <div className="max-h-48 overflow-y-auto px-2 py-1.5">
        <WorkbenchIssueMessages issues={issues} />
      </div>
    </details>
  );
}

function issueCountLabel(issues: readonly WorkbenchIssueItem[]): string {
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const infoCount = issues.length - errorCount - warningCount;
  const parts = [
    errorCount > 0 ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : null,
    warningCount > 0 ? `${warningCount} warning${warningCount === 1 ? '' : 's'}` : null,
    infoCount > 0 ? `${infoCount} note${infoCount === 1 ? '' : 's'}` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(', ');
}

interface WorkbenchIssueItem {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  message: UserMessage;
}

function WorkbenchIssueMessages({ issues }: { issues: readonly WorkbenchIssueItem[] }) {
  return (
    <ul className="space-y-1.5">
      {issues.map((issue: WorkbenchIssueItem) => (
        <li key={issue.id} className={UI_PROSE_WRAP_CLASS}>
          <p className="font-medium">{issue.title}</p>
          {issue.message && issue.message !== issue.title ? <p>{issue.message}</p> : null}
        </li>
      ))}
    </ul>
  );
}

const WORKBENCH_ISSUE_CLASS =
  'min-w-0 rounded border border-border bg-bg-subtle text-xs text-fg-muted data-[issue-severity=error]:border-error/30 data-[issue-severity=error]:bg-error/10 data-[issue-severity=error]:text-error data-[issue-severity=warning]:border-orange-400 data-[issue-severity=warning]:bg-orange-500/15 data-[issue-severity=warning]:text-orange-700 dark:data-[issue-severity=warning]:text-orange-300';

function workbenchCardClassName(issues: readonly WorkbenchIssueItem[]): string {
  const severity = highestIssueSeverity(issues);
  const base = 'relative min-w-0 max-w-full overflow-hidden rounded border bg-bg py-2 pl-3 pr-2';
  if (severity === 'error') return `${base} border-error/70 ring-1 ring-error/25`;
  if (severity === 'warning') {
    return `${base} border-orange-300/80 ring-1 ring-orange-300/25`;
  }
  return `${base} border-border`;
}

function WorkbenchCardAccentRail({ model }: { model: JunctionWorkbenchModel }) {
  const productRow = model.rows.find((row) => row.kind === 'product');
  const leftColor =
    productRow?.leftFragmentColor ?? productRow?.fragmentColor ?? FALLBACK_LEFT_SOURCE_COLOR;
  const rightColor =
    productRow?.rightFragmentColor ?? productRow?.fragmentColor ?? FALLBACK_RIGHT_SOURCE_COLOR;
  return (
    <div
      data-testid="junction-workbench-card-accent-rail"
      className="absolute inset-y-0 left-0 grid w-1 grid-rows-2 overflow-hidden rounded-l"
      aria-hidden="true"
    >
      <span
        data-testid="junction-workbench-card-accent-left"
        style={{ backgroundColor: leftColor }}
      />
      <span
        data-testid="junction-workbench-card-accent-right"
        style={{ backgroundColor: rightColor }}
      />
    </div>
  );
}

function highestIssueSeverity(
  issues: readonly WorkbenchIssueItem[]
): WorkbenchIssueItem['severity'] | null {
  if (issues.some((issue) => issue.severity === 'error')) return 'error';
  if (issues.some((issue) => issue.severity === 'warning')) return 'warning';
  if (issues.some((issue) => issue.severity === 'info')) return 'info';
  return null;
}

function workbenchIssueItemsForJunction(
  findings: readonly AssemblyWorkbenchFinding[],
  commandErrors: readonly AssemblyWorkbenchCommandError[],
  junctionIndex: number,
  junctionId: string | undefined
): WorkbenchIssueItem[] {
  return [
    ...commandErrors
      .filter((error) => junctionId !== undefined && error.targetId === junctionId)
      .map(commandErrorIssueItem),
    ...findings.filter((finding) => finding.junctionIndex === junctionIndex).map(findingIssueItem),
  ];
}

const FINDINGS_WITH_JUNCTION_LABEL: ReadonlySet<string> = new Set(['goldengate-junction-invalid']);

const PART_SCOPED_FINDING_CODES: ReadonlySet<string> = new Set(['goldengate-internal-site']);

function goldenGateOptimizerLiveFieldPreviewForChoice(
  models: readonly JunctionWorkbenchModel[],
  fields: readonly AssemblyWorkbenchEditableField[],
  choice: GoldenGateOptimizationJunctionChoice,
  polymerase?: string | null
): { field: AssemblyWorkbenchEditableField; preview: AssemblyWorkbenchLiveFieldPreview } | null {
  const model = models.find((item) => item.junctionIndex === choice.junctionIndex);
  const productRow = model?.rows.find((row) => row.kind === 'product');
  const field = fields.find(
    (item) =>
      item.kind === 'goldenGateOverhang' && item.target.junctionIndex === choice.junctionIndex
  );
  if (!field) return null;
  if (!productRow || !Array.isArray((productRow as { points?: unknown }).points)) {
    return { field, preview: { value: choice.offset } };
  }
  const preview = goldenGateOverhangLivePreviewForProductRow(productRow, field, choice.offset);
  if (!preview) return { field, preview: { value: choice.offset } };
  const productLivePrimers = goldenGateOverhangLivePrimersForRow(
    productRow,
    preview,
    choice.junctionIndex
  );
  return {
    field,
    preview: {
      value: choice.offset,
      primerTms: productLivePrimers
        ? primerTemperaturePayload(productLivePrimers, field, polymerase)
        : undefined,
    },
  };
}

function workbenchIssueItemsForSummary(
  findings: readonly AssemblyWorkbenchFinding[],
  commandErrors: readonly AssemblyWorkbenchCommandError[]
): WorkbenchIssueItem[] {
  return [
    ...commandErrors.map(commandErrorIssueItem),
    ...findings
      .filter(
        (finding) => finding.severity !== 'info' && !PART_SCOPED_FINDING_CODES.has(finding.code)
      )
      .map((finding) => {
        const issue = findingIssueItem(finding);
        return finding.junctionIndex !== undefined && FINDINGS_WITH_JUNCTION_LABEL.has(finding.code)
          ? { ...issue, title: `J${finding.junctionIndex + 1}: ${issue.title}` }
          : issue;
      }),
  ];
}

function commandErrorIssueItem(error: AssemblyWorkbenchCommandError): WorkbenchIssueItem {
  return {
    id: `command-${error.commandType}-${error.code}-${error.targetId ?? 'global'}`,
    severity: 'error',
    title: userMessage('assembly.failed'),
    message: toUserMessage(error, 'assembly.failed'),
  };
}

function findingIssueItem(finding: AssemblyWorkbenchFinding): WorkbenchIssueItem {
  return {
    id: finding.id,
    severity: finding.severity,
    title: finding.title,
    message: toUserMessage(finding.message, 'assembly.failed'),
  };
}

function ProductRowControlPanel({
  session,
  junction,
  basePrimerPbsLengths,
  goldenGatePreviewChoice,
  liveFieldValueStore,
  onJumpToSequenceViewer,
  onCommand,
  onPreviewCommand,
  onFieldCommit,
  onCancelPreview,
}: {
  session: ReturnType<typeof createAssemblyWorkbenchSession>;
  junction: AssemblyWorkbenchJunctionControl;
  basePrimerPbsLengths: ReadonlyMap<string, number>;
  goldenGatePreviewChoice?: GoldenGateOptimizationJunctionChoice;
  liveFieldValueStore: LiveFieldValueStore;
  onJumpToSequenceViewer?: () => void;
  onCommand: (command: AssemblyWorkbenchCommand) => void;
  onPreviewCommand: (command: AssemblyWorkbenchCommand) => void;
  onFieldCommit: (field: AssemblyWorkbenchEditableField, nextValue: number) => void;
  onCancelPreview: () => void;
}) {
  const hasPrimaryControls = junction.homology || junction.goldenGate;
  const junctionFindings = session.findings.filter(
    (finding) => finding.junctionIndex === junction.junctionIndex
  );
  const homologyArmFields = session.editableFields.filter(
    (field) => field.kind === 'homologyArm' && field.target.junctionIndex === junction.junctionIndex
  );
  const goldenGateField = session.editableFields.find(
    (field) =>
      field.kind === 'goldenGateOverhang' && field.target.junctionIndex === junction.junctionIndex
  );
  const homologyFindings = controlFindingsForHomology(junctionFindings);
  const goldenGateFindings = controlFindingsForGoldenGate(junctionFindings);

  return (
    <div
      data-testid={`product-row-junction-controls-${junction.junctionIndex}`}
      data-selected={junction.selected ? 'true' : 'false'}
      className="grid gap-0 text-[10px] leading-tight"
    >
      <ProductJunctionHeader
        junction={junction}
        mode={session.mode}
        onJumpToSequenceViewer={onJumpToSequenceViewer}
      />
      {hasPrimaryControls && (
        <div className="grid gap-0">
          {junction.homology && (
            <ProductHomologyControl
              junction={junction}
              findings={homologyFindings}
              leftField={homologyArmFieldForSide(homologyArmFields, 'left')}
              rightField={homologyArmFieldForSide(homologyArmFields, 'right')}
              liveFieldValueStore={liveFieldValueStore}
              onCommand={onCommand}
            />
          )}

          {junction.goldenGate && (
            <ProductGoldenGateControl
              junction={junction}
              findings={goldenGateFindings}
              offsetField={goldenGateField}
              previewChoice={goldenGatePreviewChoice}
              liveFieldValueStore={liveFieldValueStore}
              onCommand={onCommand}
            />
          )}
        </div>
      )}

      {junction.primers.length > 0 && (
        <div className="grid gap-0">
          {junction.primers.map((primer) => (
            <ProductPrimerControl
              key={primer.id}
              primer={primer}
              findings={controlFindingsForPrimer(junctionFindings, primer)}
              pbsField={primerPbsFieldForPrimer(session.editableFields, primer)}
              committedPbsLength={basePrimerPbsLengths.get(primer.id) ?? primer.pbsLength}
              liveFieldValueStore={liveFieldValueStore}
              onCommand={onCommand}
              onPreviewCommand={onPreviewCommand}
              onFieldCommit={onFieldCommit}
              onCancelPreview={onCancelPreview}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function controlFindingsForHomology(
  findings: readonly AssemblyWorkbenchFinding[]
): AssemblyWorkbenchFinding[] {
  return findings.filter((finding) => finding.code.startsWith('homology-'));
}

function controlFindingsForGoldenGate(
  findings: readonly AssemblyWorkbenchFinding[]
): AssemblyWorkbenchFinding[] {
  return findings.filter((finding) => finding.code.startsWith('goldengate-'));
}

function controlFindingsForPrimer(
  findings: readonly AssemblyWorkbenchFinding[],
  primer: AssemblyWorkbenchPrimerControl
): AssemblyWorkbenchFinding[] {
  return findings.filter(
    (finding) =>
      finding.code.startsWith('primer-pbs') &&
      finding.primer?.fragmentIndex === primer.fragmentIndex &&
      finding.primer.direction === primer.direction
  );
}

function homologyArmFieldForSide(
  fields: readonly AssemblyWorkbenchEditableField[],
  side: 'left' | 'right'
): AssemblyWorkbenchEditableField | undefined {
  return fields.find((field) => field.target.side === side);
}

function primerPbsFieldForPrimer(
  fields: readonly AssemblyWorkbenchEditableField[],
  primer: AssemblyWorkbenchPrimerControl
): AssemblyWorkbenchEditableField | undefined {
  return fields.find(
    (field) =>
      field.kind === 'primerPbs' &&
      field.target.primerId === primer.id &&
      field.target.fragmentIndex === primer.fragmentIndex &&
      field.target.direction === primer.direction
  );
}

function primerPbsLengthById(pairs: readonly DesignPrimerPair[]): Map<string, number> {
  const lengths = new Map<string, number>();
  for (const pair of pairs) {
    lengths.set(pair.forward.id, pair.forward.pbs.end - pair.forward.pbs.start);
    lengths.set(pair.reverse.id, pair.reverse.pbs.end - pair.reverse.pbs.start);
  }
  return lengths;
}

function createLiveFieldValueStore(): LiveFieldValueStore {
  const values = new Map<string, number>();
  const homologyTms = new Map<number, number | null>();
  const primerTms = new Map<string, number | null>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const emit = () => {
    revision += 1;
    listeners.forEach((listener) => listener());
  };
  const applyLiveFieldPreviews = (
    previews: Array<{
      field: AssemblyWorkbenchEditableField;
      preview: AssemblyWorkbenchLiveFieldPreview;
    }>
  ) => {
    values.clear();
    homologyTms.clear();
    primerTms.clear();
    for (const { field, preview } of previews) {
      values.set(field.id, preview.value);
      if (preview.homologyTm) {
        homologyTms.set(preview.homologyTm.junctionIndex, preview.homologyTm.tm);
      }
      for (const primer of preview.primerTms ?? []) {
        if (primer.primerId) primerTms.set(primerIdKey(primer.primerId), primer.tm);
        if (primer.sourcePrimerId) primerTms.set(primerIdKey(primer.sourcePrimerId), primer.tm);
        if (primer.fragmentIndex !== undefined) {
          primerTms.set(
            primerFragmentDirectionKey(primer.fragmentIndex, primer.direction),
            primer.tm
          );
        }
      }
    }
  };
  return {
    schemaVersion: LIVE_FIELD_VALUE_STORE_SCHEMA_VERSION,
    getValue: (fieldId) => values.get(fieldId),
    getHomologyTm: (junctionIndex) => homologyTms.get(junctionIndex),
    getPrimerTm: (primer) =>
      primerTms.get(primerIdKey(primer.id)) ??
      primerTms.get(primerFragmentDirectionKey(primer.fragmentIndex, primer.direction)),
    set: (field, preview) => {
      applyLiveFieldPreviews([{ field, preview }]);
      emit();
    },
    setMany: (previews) => {
      applyLiveFieldPreviews(previews);
      emit();
    },
    clear: () => {
      if (values.size === 0 && homologyTms.size === 0 && primerTms.size === 0) return;
      values.clear();
      homologyTms.clear();
      primerTms.clear();
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => revision,
  };
}

function ensureLiveFieldValueStore(current: unknown): LiveFieldValueStore {
  return isCurrentLiveFieldValueStore(current) ? current : createLiveFieldValueStore();
}

function isCurrentLiveFieldValueStore(store: unknown): store is LiveFieldValueStore {
  return liveFieldValueStoreCompatibility(store).compatible;
}

function liveFieldValueStoreCompatibility(store: unknown): {
  compatible: boolean;
  schemaVersion: unknown;
  missingMethods: string[];
} {
  if (!store || typeof store !== 'object') {
    return {
      compatible: false,
      schemaVersion: undefined,
      missingMethods: [...LIVE_FIELD_VALUE_STORE_REQUIRED_METHODS],
    };
  }
  const candidate = store as Record<string, unknown>;
  const missingMethods = LIVE_FIELD_VALUE_STORE_REQUIRED_METHODS.filter(
    (method) => typeof candidate[method] !== 'function'
  );
  const schemaVersion = candidate.schemaVersion;
  return {
    compatible:
      schemaVersion === LIVE_FIELD_VALUE_STORE_SCHEMA_VERSION && missingMethods.length === 0,
    schemaVersion,
    missingMethods,
  };
}

export function liveFieldValueStoreCompatibilityForTesting(store: unknown): {
  compatible: boolean;
  schemaVersion: unknown;
  missingMethods: string[];
} {
  return liveFieldValueStoreCompatibility(store);
}

export function ensureLiveFieldValueStoreForTesting(current: unknown): unknown {
  return ensureLiveFieldValueStore(current);
}

function primerIdKey(id: string): string {
  return `id:${id}`;
}

function primerFragmentDirectionKey(
  fragmentIndex: number,
  direction: AssemblyWorkbenchPrimerControl['direction']
): string {
  return `fragment:${fragmentIndex}:${direction}`;
}

function useLiveFieldValue(
  store: LiveFieldValueStore,
  field: AssemblyWorkbenchEditableField | undefined,
  fallback: number
): number {
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (!field) return fallback;
  return store.getValue(field.id) ?? fallback;
}

function useLiveHomologyTm(
  store: LiveFieldValueStore,
  junctionIndex: number,
  fallback: number | null
): number | null {
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const live = store.getHomologyTm(junctionIndex);
  return live === undefined ? fallback : live;
}

function useLivePrimerTm(
  store: LiveFieldValueStore,
  primer: Pick<AssemblyWorkbenchPrimerControl, 'id' | 'fragmentIndex' | 'direction'>,
  fallback: number | null
): number | null {
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const live = store.getPrimerTm(primer);
  return live === undefined ? fallback : live;
}

function controlIssueSeverity(
  findings: readonly AssemblyWorkbenchFinding[]
): AssemblyWorkbenchFinding['severity'] | null {
  if (findings.some((finding) => finding.severity === 'error')) return 'error';
  if (findings.some((finding) => finding.severity === 'warning')) return 'warning';
  if (findings.some((finding) => finding.severity === 'info')) return 'info';
  return null;
}

function controlIssueTitle(findings: readonly AssemblyWorkbenchFinding[]): string | undefined {
  return findings.length > 0 ? findings.map((finding) => finding.message).join('\n') : undefined;
}

function ProductJunctionHeader({
  junction,
  mode,
  onJumpToSequenceViewer,
}: {
  junction: AssemblyWorkbenchJunctionControl;
  mode: ReturnType<typeof createAssemblyWorkbenchSession>['mode'];
  onJumpToSequenceViewer?: () => void;
}) {
  const modeLabel = mode === 'goldengate' ? 'GG' : mode === 'nebuilder' ? 'NEB' : 'Gibson';
  return (
    <div className="flex h-5 min-w-0 items-center justify-between gap-1 border-b border-border/40 pb-px">
      <div className="flex min-w-0 items-center gap-1">
        {onJumpToSequenceViewer && (
          <button
            type="button"
            data-testid={`assembly-workbench-junction-jump-${junction.junctionIndex}`}
            aria-label={`Jump ${junction.label} in sequence viewer`}
            title={`Jump ${junction.label} in sequence viewer`}
            onClick={onJumpToSequenceViewer}
            className="grid h-4 w-4 shrink-0 place-items-center rounded-[3px] text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            <OpenExternalIcon size={10} />
          </button>
        )}
      </div>
      <span
        data-testid={`assembly-workbench-junction-mode-${junction.junctionIndex}`}
        className="min-w-0 truncate rounded-[3px] bg-bg-muted px-1 text-[8px] uppercase leading-3 tracking-wide text-fg-muted"
      >
        {modeLabel}
      </span>
    </div>
  );
}

function ProductHomologyControl({
  junction,
  findings,
  leftField,
  rightField,
  liveFieldValueStore,
  onCommand,
}: {
  junction: AssemblyWorkbenchJunctionControl;
  findings: readonly AssemblyWorkbenchFinding[];
  leftField: AssemblyWorkbenchEditableField | undefined;
  rightField: AssemblyWorkbenchEditableField | undefined;
  liveFieldValueStore: LiveFieldValueStore;
  onCommand: (command: AssemblyWorkbenchCommand) => void;
}) {
  const homology = junction.homology;
  const leftValue = useLiveFieldValue(liveFieldValueStore, leftField, homology?.onLeft ?? 0);
  const rightValue = useLiveFieldValue(liveFieldValueStore, rightField, homology?.onRight ?? 0);
  const tmEstimate = useLiveHomologyTm(
    liveFieldValueStore,
    junction.junctionIndex,
    homology?.tmEstimate ?? null
  );
  if (!homology) return null;
  return (
    <div
      data-testid={`assembly-workbench-homology-control-${junction.junctionIndex}`}
      data-local-issue-severity={controlIssueSeverity(findings) ?? 'none'}
      title={controlIssueTitle(findings)}
      className={productControlRowClassName('grid-cols-[minmax(0,1fr)_2.45rem_2.45rem]', findings)}
    >
      <div aria-hidden="true" />
      <NumberControl
        label="L"
        testId={`assembly-workbench-homology-left-${junction.junctionIndex}`}
        value={leftValue}
        min={0}
        max={GIBSON_MAX_HOMOLOGY_LENGTH}
        disabled={Boolean(leftField?.disabled)}
        onChange={(onLeft) =>
          onCommand({
            type: 'setHomologyEncoding',
            junctionId: junction.id,
            junctionIndex: junction.junctionIndex,
            encoding: { onLeft, onRight: homology.onRight },
          })
        }
      />
      <NumberControl
        label="R"
        testId={`assembly-workbench-homology-right-${junction.junctionIndex}`}
        value={rightValue}
        min={0}
        max={GIBSON_MAX_HOMOLOGY_LENGTH}
        disabled={Boolean(rightField?.disabled)}
        onChange={(onRight) =>
          onCommand({
            type: 'setHomologyEncoding',
            junctionId: junction.id,
            junctionIndex: junction.junctionIndex,
            encoding: { onLeft: homology.onLeft, onRight },
          })
        }
      />
      <div
        data-testid={`assembly-workbench-homology-summary-${junction.junctionIndex}`}
        className="col-span-3 flex min-w-0 items-center justify-between gap-1"
      >
        <span className="text-[8px] font-medium uppercase leading-3 tracking-wide text-fg-muted">
          Overlap
        </span>
        <span
          data-testid={`assembly-workbench-homology-tm-${junction.junctionIndex}`}
          className="shrink-0 font-mono text-[10px] leading-3 text-fg"
          title={`Overlap Tm ${formatTemperature(tmEstimate)}`}
        >
          Tm {formatTemperature(tmEstimate)}
        </span>
      </div>
    </div>
  );
}

function ProductGoldenGateControl({
  junction,
  findings,
  offsetField,
  previewChoice,
  liveFieldValueStore,
  onCommand,
}: {
  junction: AssemblyWorkbenchJunctionControl;
  findings: readonly AssemblyWorkbenchFinding[];
  offsetField: AssemblyWorkbenchEditableField | undefined;
  previewChoice?: GoldenGateOptimizationJunctionChoice;
  liveFieldValueStore: LiveFieldValueStore;
  onCommand: (command: AssemblyWorkbenchCommand) => void;
}) {
  const goldenGate = junction.goldenGate;
  const offsetValue = useLiveFieldValue(liveFieldValueStore, offsetField, goldenGate?.offset ?? 0);
  if (!goldenGate) return null;
  const displayedOffset = previewChoice?.offset ?? offsetValue;
  const overhangDelta = displayedOffset - goldenGate.offset;
  const displayedOverhang = previewChoice?.overhang ?? goldenGate.overhang;
  const displayedOverhangStart = goldenGate.overhangStart + overhangDelta;
  const displayedOverhangEnd = goldenGate.overhangEnd + overhangDelta;
  return (
    <div
      data-testid={`assembly-workbench-goldengate-control-${junction.junctionIndex}`}
      data-local-issue-severity={controlIssueSeverity(findings) ?? 'none'}
      title={controlIssueTitle(findings)}
      className={productControlRowClassName('grid-cols-[minmax(0,1fr)_2.45rem]', findings)}
    >
      <div className="min-w-0">
        <div className="font-mono text-[11px] font-medium leading-4 text-fg">
          {displayedOverhang}
        </div>
        <div className="truncate text-[8px] leading-3 text-fg-muted">
          {goldenGate.enzyme} {displayedOverhangStart}-{displayedOverhangEnd}
        </div>
      </div>
      <NumberControl
        label="Off"
        testId={`assembly-workbench-goldengate-offset-${junction.junctionIndex}`}
        value={displayedOffset}
        min={-goldenGate.offsetLimit}
        max={goldenGate.offsetLimit}
        disabled={goldenGate.isFixed}
        onChange={(offset) =>
          onCommand({
            type: 'setGoldenGateOffset',
            junctionId: junction.id,
            junctionIndex: junction.junctionIndex,
            offset,
          })
        }
      />
    </div>
  );
}

function ProductPrimerControl({
  primer,
  findings,
  pbsField,
  committedPbsLength,
  liveFieldValueStore,
  onCommand,
  onPreviewCommand,
  onFieldCommit,
  onCancelPreview,
}: {
  primer: AssemblyWorkbenchPrimerControl;
  findings: readonly AssemblyWorkbenchFinding[];
  pbsField: AssemblyWorkbenchEditableField | undefined;
  committedPbsLength: number;
  liveFieldValueStore: LiveFieldValueStore;
  onCommand: (command: AssemblyWorkbenchCommand) => void;
  onPreviewCommand: (command: AssemblyWorkbenchCommand) => void;
  onFieldCommit: (field: AssemblyWorkbenchEditableField, nextValue: number) => void;
  onCancelPreview: () => void;
}) {
  const pbsLength = useLiveFieldValue(liveFieldValueStore, pbsField, primer.pbsLength);
  const primerTm = useLivePrimerTm(liveFieldValueStore, primer, primer.tm);
  const pbsCommand = (length: number): AssemblyWorkbenchCommand => ({
    type: 'setPrimerPbsLength',
    primerId: primer.id,
    fragmentIndex: primer.fragmentIndex,
    direction: primer.direction,
    length,
  });

  return (
    <div
      data-testid={`assembly-workbench-primer-control-${primer.fragmentIndex}-${primer.direction}`}
      data-local-issue-severity={controlIssueSeverity(findings) ?? 'none'}
      title={controlIssueTitle(findings)}
      className={productControlRowClassName('grid-cols-[minmax(0,1fr)_2.45rem]', findings)}
    >
      <div className="min-w-0">
        <div className="truncate text-[9px] font-medium leading-3 text-fg">
          F{primer.fragmentIndex + 1} {primer.direction}
        </div>
        <div
          data-testid={`assembly-workbench-primer-tm-${primer.fragmentIndex}-${primer.direction}`}
          className="truncate font-mono text-[10px] leading-3 text-fg-muted"
          title={`Annealing Tm ${formatTemperature(primerTm)}`}
        >
          Tm {formatTemperature(primerTm)}
        </div>
      </div>
      <NumberControl
        label="PBS"
        testId={`assembly-workbench-primer-pbs-${primer.fragmentIndex}-${primer.direction}`}
        value={pbsLength}
        committedValue={committedPbsLength}
        min={10}
        max={60}
        disabled={!primer.canEditPbs}
        onPreview={(length) => {
          if (!pbsField) {
            onPreviewCommand(pbsCommand(length));
            return;
          }
          liveFieldValueStore.set(pbsField, { value: length });
        }}
        onCommit={(length) => {
          if (pbsField) {
            onFieldCommit(pbsField, length);
            return;
          }
          onCommand(pbsCommand(length));
        }}
        onCancel={onCancelPreview}
      />
    </div>
  );
}

function productControlRowClassName(
  columns: string,
  findings: readonly AssemblyWorkbenchFinding[] = []
): string {
  const severity = controlIssueSeverity(findings);
  const issueClass =
    severity === 'error'
      ? 'bg-error/5 ring-1 ring-inset ring-error/25'
      : severity === 'warning'
        ? 'bg-orange-400/[0.06] ring-1 ring-inset ring-orange-300/35'
        : severity === 'info'
          ? 'bg-sky-400/[0.05] ring-1 ring-inset ring-sky-300/25'
          : '';
  return `grid min-h-7 min-w-0 ${columns} items-center gap-1 border-b border-border/30 px-0.5 py-0.5 last:border-b-0 ${issueClass}`;
}

function buildWorkbenchCommandTrace(
  commandType: AssemblyWorkbenchCommand['type'],
  status: WorkbenchCommandTrace['status'],
  before: SequenceDesign,
  after: SequenceDesign
): WorkbenchCommandTrace {
  return {
    commandType,
    status,
    primerDeltas: primerDeltas(before.designPrimers, after.designPrimers),
    sourceRegionDeltas: sourceRegionDeltas(before, after),
    goldenGateJunctionDeltas: goldenGateJunctionDeltas(before, after),
    primerEditIntentCountBefore: before.assemblyWorkbench?.primerEditIntents?.length ?? 0,
    primerEditIntentCountAfter: after.assemblyWorkbench?.primerEditIntents?.length ?? 0,
  };
}

function goldenGateOptimizerPreviewTrace(
  design: SequenceDesign,
  combination: GoldenGateOptimizationCombination
): WorkbenchCommandTrace {
  const choicesByJunctionIndex = new Map(
    combination.choices.map((choice) => [choice.junctionIndex, choice])
  );
  const goldenGateJunctionDeltas = (design.goldenGateJunctions ?? [])
    .map((junction) => {
      const choice = choicesByJunctionIndex.get(junction.junctionIndex);
      if (!choice) return null;
      const overhangStartAfter = junction.junctionPosition - 2 + choice.offset;
      const overhangEndAfter = overhangStartAfter + 4;
      if (
        junction.offset === choice.offset &&
        junction.overhangStart === overhangStartAfter &&
        junction.overhangEnd === overhangEndAfter &&
        junction.overhang === choice.overhang
      ) {
        return null;
      }
      return {
        junctionIndex: junction.junctionIndex,
        offsetBefore: junction.offset,
        offsetAfter: choice.offset,
        junctionPositionBefore: junction.junctionPosition,
        junctionPositionAfter: junction.junctionPosition,
        overhangStartBefore: junction.overhangStart,
        overhangStartAfter,
        overhangEndBefore: junction.overhangEnd,
        overhangEndAfter,
        overhangBefore: junction.overhang,
        overhangAfter: choice.overhang,
      };
    })
    .filter((delta): delta is NonNullable<typeof delta> => delta !== null);

  return {
    commandType: 'autoOptimize',
    status: 'applied',
    primerDeltas: [],
    sourceRegionDeltas: [],
    goldenGateJunctionDeltas,
    primerEditIntentCountBefore: design.assemblyWorkbench?.primerEditIntents?.length ?? 0,
    primerEditIntentCountAfter: design.assemblyWorkbench?.primerEditIntents?.length ?? 0,
  };
}

function primerDeltas(before: DesignPrimerPair[], after: DesignPrimerPair[]) {
  const beforeByKey = new Map(flattenPrimerTrace(before).map((primer) => [primer.key, primer]));
  return flattenPrimerTrace(after)
    .map((primer) => {
      const previous = beforeByKey.get(primer.key);
      if (!previous) return null;
      if (
        previous.pbsLength === primer.pbsLength &&
        previous.sequenceLength === primer.sequenceLength &&
        previous.overhangLength === primer.overhangLength &&
        previous.literalExtraLength === primer.literalExtraLength
      ) {
        return null;
      }
      return {
        key: primer.key,
        pbsLengthBefore: previous.pbsLength,
        pbsLengthAfter: primer.pbsLength,
        sequenceLengthBefore: previous.sequenceLength,
        sequenceLengthAfter: primer.sequenceLength,
        overhangLengthBefore: previous.overhangLength,
        overhangLengthAfter: primer.overhangLength,
        literalExtraLengthBefore: previous.literalExtraLength,
        literalExtraLengthAfter: primer.literalExtraLength,
      };
    })
    .filter((delta): delta is NonNullable<typeof delta> => delta !== null);
}

function flattenPrimerTrace(primers: DesignPrimerPair[]) {
  return primers.flatMap((pair) => [
    primerTraceItem(pair, 'forward'),
    primerTraceItem(pair, 'reverse'),
  ]);
}

function primerTraceItem(pair: DesignPrimerPair, direction: 'forward' | 'reverse') {
  const primer = pair[direction];
  return {
    key: `${pair.fragmentIndex}:${direction}`,
    pbsLength: primer.pbs.end - primer.pbs.start,
    sequenceLength: primer.sequence.length,
    overhangLength: primer.overhang.tailLength ?? primer.overhang.sequence.length,
    literalExtraLength: primer.goldenGateOverhang?.literalExtra.length ?? 0,
  };
}

function goldenGateJunctionDeltas(before: SequenceDesign, after: SequenceDesign) {
  const beforeByIndex = new Map(
    (before.goldenGateJunctions ?? []).map((junction) => [junction.junctionIndex, junction])
  );
  return (after.goldenGateJunctions ?? [])
    .map((junction) => {
      const previous = beforeByIndex.get(junction.junctionIndex);
      if (!previous) return null;
      if (
        previous.offset === junction.offset &&
        previous.junctionPosition === junction.junctionPosition &&
        previous.overhangStart === junction.overhangStart &&
        previous.overhangEnd === junction.overhangEnd &&
        previous.overhang === junction.overhang
      ) {
        return null;
      }
      return {
        junctionIndex: junction.junctionIndex,
        offsetBefore: previous.offset,
        offsetAfter: junction.offset,
        junctionPositionBefore: previous.junctionPosition,
        junctionPositionAfter: junction.junctionPosition,
        overhangStartBefore: previous.overhangStart,
        overhangStartAfter: junction.overhangStart,
        overhangEndBefore: previous.overhangEnd,
        overhangEndAfter: junction.overhangEnd,
        overhangBefore: previous.overhang,
        overhangAfter: junction.overhang,
      };
    })
    .filter((delta): delta is NonNullable<typeof delta> => delta !== null);
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
