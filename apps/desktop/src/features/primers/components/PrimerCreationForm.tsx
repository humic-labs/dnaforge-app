import { reportSaveFailure } from '../../../lib/report-save-failure';
import { useDocumentLifecycle } from '../../../shared/use-document-lifecycle';
import { firstOligoErrorUserMessage, oligoDiagnosticUserMessage } from '../oligo-user-messages';
import { toOptionalUserMessage, toUserMessage } from '@waypoint/user-messages';

import { PrimerFormMetricsStrip } from './PrimerFormMetricsStrip';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { EditIcon } from '../../../components/icons';
import { Button } from '../../../components/ui';
import { SETTINGS_FIELD_CLASS } from '../../../components/SettingsSubsection';
import { calculateGcContent } from '../../design/public/algorithms/tm-calculator';
import { usePrimerTm } from '../hooks/usePrimerTm';
import { useSettingsStore } from '../../junction-workbench/public/settings';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { validatePrimerSequence } from '../primer-validation';
import { LIBRARY_PRIMER_COLOR } from '../types';
import { oligoToPrimerModificationMarkers } from '../adapters';
import { reverseComplement } from '@waypoint/sequence-utils';
import { computeBindingPositions, templateExtensionBase } from '../primer-3prime-extension';
import {
  defaultPrimerArtifactPath,
  primerArtifactPathBesideTarget,
  primerArtifactPathInDir,
  sanitizePrimerArtifactStem,
} from '../primer-artifact';
import { PrimerRenderPreview } from './PrimerRenderPreview';
import { PrimerSequenceInput } from './PrimerSequenceInput';
import { PrimerSaveLocationPicker } from './PrimerSaveLocationPicker';
import { PrimerSchemaFields, type PrimerSchemaFieldDrafts } from './PrimerSchemaFields';
import type { CreatePrimerInput, PrimerDirection } from '../types';
import type { PrimerDisplay, OligoMismatch } from '@waypoint/workspace-editor';
import { manualPrimerCreationServices } from '../primer-services';
import { getLimsSchemas } from '../../lims/public/operations';
import { isLimsFieldType, type LimsFieldDefinition } from '../../../shared/lims';
import { safeFocus } from '../../../shared/utils/safeFocus';
import { findContainingPathBoundary } from '../../../shared/path-boundary';
import {
  builtinPrimerSchemaView,
  editablePrimerSchemaFields,
  primerSchemas,
  parsePrimerSchemaFieldValue,
} from '../primer-entity-schema';
import { primerDraftDisplayName } from '../primer-draft-name';
import {
  parseIdtOligoNotation,
  resizeIdtOligoNotation,
  type OligoOrderType,
} from '../oligo-modifications';
import { preparePrimerSaveInput, type HostPrimerBinding } from '../primer-save-preparation';
import { primerSaveErrorMessage } from '../primer-save-error';
import type { PrimerEntitySchemaSnapshot } from '../primer-artifact';
import type { LimsSchemaDefinitionView } from '../../../shared/lims';
import { metadataValuesEqual } from '../../../shared/metadata-values';
import { MetadataSaveButton } from '../../../shared/components/MetadataSaveButton';
import { useMetadataEditRequest } from '../../canvas/public/use-metadata-edit-request';

const MIN_PRIMER_LENGTH = 10;

const LABEL_CLASS = 'mb-1 block text-xs font-medium text-fg';

function initialPrimerSchemaOptions(
  orderType: OligoOrderType,
  initialSchemaView: LimsSchemaDefinitionView | null
): LimsSchemaDefinitionView[] {
  const builtin = builtinPrimerSchemaView(orderType);
  if (!initialSchemaView) return [builtin];
  return initialSchemaView.schemaId === builtin.schemaId
    ? [initialSchemaView]
    : [initialSchemaView, builtin];
}

function primerWorkspaceRoots(
  workspaceFolders: ReadonlyArray<{ path: string; name: string }>,
  workspaceRoot?: string,
  targetDir?: string
): Array<{ path: string; name: string }> {
  const list = workspaceFolders.map((folder) => ({ path: folder.path, name: folder.name }));
  if (list.length === 0 && workspaceRoot) {
    list.push({
      path: workspaceRoot,
      name: workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? workspaceRoot,
    });
  }

  if (targetDir && !findContainingPathBoundary(list, targetDir)) {
    list.push({
      path: targetDir,
      name: targetDir.split(/[\\/]/).filter(Boolean).pop() ?? targetDir,
    });
  }
  return list;
}

export function resolvePrimerOwningProjectRoot(
  projectRoots: ReadonlyArray<{ path: string }>,
  directory: string
): string | undefined {
  return findContainingPathBoundary(projectRoots, directory)?.path;
}

function resolvePrimerTargetDir(
  initialSaveDir: string | undefined,
  targetFilePath: string | undefined,
  workspaceRoot: string | undefined
): string {
  if (initialSaveDir) return initialSaveDir;
  if (!targetFilePath) return workspaceRoot ?? '';
  return targetFilePath.slice(
    0,
    Math.max(targetFilePath.lastIndexOf('/'), targetFilePath.lastIndexOf('\\'))
  );
}

function suggestedPrimerArtifactPath({
  fixedArtifactPath,
  trimmedName,
  initialSaveDir,
  targetFilePath,
  workspaceRoot,
}: {
  fixedArtifactPath?: string;
  trimmedName: string;
  initialSaveDir?: string;
  targetFilePath?: string;
  workspaceRoot?: string;
}): string {
  if (fixedArtifactPath) return fixedArtifactPath;
  if (!trimmedName) return '';
  if (initialSaveDir) return primerArtifactPathInDir(initialSaveDir, trimmedName);
  if (targetFilePath) return primerArtifactPathBesideTarget(targetFilePath, trimmedName);
  if (workspaceRoot) return defaultPrimerArtifactPath(workspaceRoot, trimmedName);
  return '';
}

function isPrimerGcOff(gc: number | undefined): boolean {
  return gc != null && (gc < 40 || gc > 60);
}

interface MismatchInfo {
  count: number;

  threePrimeTerminal: boolean;
}

interface PrimerDraftPreviewModel {
  display: PrimerDisplay | null;
  mismatchInfo: MismatchInfo | null;
  mismatchPositions: number[];
  refWindow: { seq: string; primerOffset: number } | null;
}

function buildPrimerDraftPreview({
  computed,
  displayTm,
  trimmedName,
  trimmedSequence,
  modificationMarkers,
  direction,
  threePrimeExt,
  bindingOffset,
  initialBindingStart,
  initialBindingEnd,
  referenceSequence,
  sequenceLength,
  circular,
}: {
  computed: { tm: number | null; gc: number } | null;
  displayTm: number | null;
  trimmedName: string;
  trimmedSequence: string;
  modificationMarkers: PrimerDisplay['modificationMarkers'];
  direction: PrimerDirection;
  threePrimeExt: number;
  bindingOffset: number;
  initialBindingStart?: number;
  initialBindingEnd?: number;
  referenceSequence?: string;
  sequenceLength?: number;
  circular?: boolean;
}): PrimerDraftPreviewModel {
  if (!computed || initialBindingStart == null || initialBindingEnd == null) {
    return { display: null, mismatchInfo: null, mismatchPositions: [], refWindow: null };
  }

  const sequenceSize = trimmedSequence.length;
  const { start, end } = computeBindingPositions({
    direction,
    length: sequenceSize,
    threePrimeExt,
    bindingOffset,
    initialBindingStart,
    initialBindingEnd,
    circular,
    sequenceLength,
  });
  const spansOrigin = start > end;
  const canCompareTemplate =
    Boolean(referenceSequence) &&
    start >= 0 &&
    (end > start || (spansOrigin && Boolean(sequenceLength)));

  let genomicWindow: string | null = null;
  const rawMismatches: OligoMismatch[] = [];
  if (canCompareTemplate && referenceSequence) {
    genomicWindow =
      spansOrigin && sequenceLength
        ? referenceSequence.slice(start, sequenceLength) + referenceSequence.slice(0, end)
        : referenceSequence.slice(start, end);
    const template = direction === 'reverse' ? reverseComplement(genomicWindow) : genomicWindow;
    const comparedLength = Math.min(sequenceSize, template.length);
    for (let index = 0; index < comparedLength; index++) {
      if (trimmedSequence[index].toUpperCase() !== template[index].toUpperCase()) {
        rawMismatches.push({
          position: index,
          oligoBase: trimmedSequence[index],
          templateBase: template[index],
        });
      }
    }
  }

  const canvasMismatches =
    direction === 'reverse' && rawMismatches.length > 0
      ? rawMismatches.map((mismatch) => ({
          ...mismatch,
          position: sequenceSize - 1 - mismatch.position,
        }))
      : rawMismatches;

  let refWindow: PrimerDraftPreviewModel['refWindow'] = null;
  if (genomicWindow != null) {
    if (spansOrigin || !referenceSequence) {
      refWindow = { seq: genomicWindow, primerOffset: 0 };
    } else {
      const flank = 12;
      const windowStart = Math.max(0, start - flank);
      const windowEnd = Math.min(referenceSequence.length, end + flank);
      refWindow = {
        seq: referenceSequence.slice(windowStart, windowEnd),
        primerOffset: start - windowStart,
      };
    }
  }

  return {
    display: {
      id: '__draft_preview__',
      name: trimmedName,
      bases: trimmedSequence,
      ...(modificationMarkers?.length ? { modificationMarkers } : {}),
      start,
      end,
      direction,
      tm: displayTm ?? computed.tm ?? 0,
      gc: computed.gc,
      mismatches: canCompareTemplate ? canvasMismatches : undefined,
      overhangLength: 0,
      pbsColor: LIBRARY_PRIMER_COLOR,
      isDraft: true,
    },
    mismatchInfo: canCompareTemplate
      ? {
          count: canvasMismatches.length,

          threePrimeTerminal: rawMismatches.some(
            (mismatch) => mismatch.position >= sequenceSize - 1
          ),
        }
      : null,
    mismatchPositions: rawMismatches.map((mismatch) => mismatch.position),
    refWindow,
  };
}

export interface PrimerPreview {
  display: PrimerDisplay | null;
}

interface PrimerCreationFormProps {
  initialSequence?: string;
  initialName?: string;
  initialEntitySchema?: PrimerEntitySchemaSnapshot;
  initialEntityFields?: Record<string, unknown>;
  initialOrderType?: OligoOrderType;
  orderType?: OligoOrderType;

  draftKindLabel?: string;

  externalSequenceEditor?: {
    value: string;
    onChange: (sequence: string) => void;
  };
  initialDirection?: PrimerDirection;
  initialBindingStart?: number;
  initialBindingEnd?: number;

  referenceSequence?: string;
  sequenceId?: number;
  sequenceLength?: number;

  bindingCoordinateOffset?: number;
  circular?: boolean;
  workspaceId?: number;

  workspaceRoot?: string;

  initialSaveDir?: string;

  fixedArtifactPath?: string;

  targetFilePath?: string;

  targetDocumentId?: string;
  targetTopology?: 'linear' | 'circular';

  onSave: (input: CreatePrimerInput, hostBinding?: HostPrimerBinding) => Promise<void | false>;

  hostOwnedBinding?: boolean;
  onCancel: () => void;

  saveRequestTargetId?: string;

  onNameChange?: (name: string) => void;
  onDraftChange?: () => void;
  onPreviewChange?: (preview: PrimerPreview) => void;

  onGoToBinding?: (bindingStart: number, bindingEnd: number) => void;
}

export function PrimerCreationForm({
  initialSequence = '',
  initialName = '',
  initialEntitySchema,
  initialEntityFields,
  initialOrderType = 'dna',
  orderType: controlledOrderType,
  draftKindLabel,
  externalSequenceEditor,
  initialDirection = 'forward',
  initialBindingStart,
  initialBindingEnd,
  referenceSequence,
  sequenceId,
  sequenceLength,
  bindingCoordinateOffset = 0,
  circular,
  workspaceId,
  workspaceRoot,
  initialSaveDir,
  fixedArtifactPath,
  targetFilePath,
  targetDocumentId,
  targetTopology,
  onSave,
  hostOwnedBinding = false,
  onCancel,
  saveRequestTargetId,
  onNameChange,
  onDraftChange,
  onPreviewChange,
  onGoToBinding,
}: PrimerCreationFormProps) {
  const [name, setName] = useState(initialName);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [localSequence, setLocalSequence] = useState(initialSequence);
  const [localOrderType] = useState<OligoOrderType>(initialOrderType);
  const orderType = controlledOrderType ?? localOrderType;
  const sequence = externalSequenceEditor?.value ?? localSequence;
  const updateSequence = useCallback(
    (next: string) => {
      if (!externalSequenceEditor) setLocalSequence(next);
      externalSequenceEditor?.onChange(next);
      onDraftChange?.();
    },
    [externalSequenceEditor, onDraftChange]
  );
  const [direction, setDirection] = useState<PrimerDirection>(initialDirection);

  const [threePrimeExt, setThreePrimeExt] = useState(0);

  const [bindingOffset, setBindingOffset] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [artifactDir, setArtifactDir] = useState<string | null>(null);
  const initialSchemaView = useMemo(
    () => (initialEntitySchema ? primerSchemaViewFromSnapshot(initialEntitySchema) : null),
    [initialEntitySchema]
  );
  const [schemaOptions, setSchemaOptions] = useState(() =>
    initialPrimerSchemaOptions(orderType, initialSchemaView)
  );
  const [selectedSchemaId, setSelectedSchemaId] = useState(
    initialSchemaView?.schemaId ?? schemaOptions[0].schemaId
  );
  const [schemaFieldDrafts, setSchemaFieldDrafts] = useState<PrimerSchemaFieldDrafts>(() =>
    primerSchemaDrafts(initialEntityFields)
  );

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => getLimsSchemas())
      .then((schemas) => {
        if (!active) return;
        const discovered = primerSchemas(schemas, orderType);
        const next = initialSchemaView
          ? [
              initialSchemaView,
              ...discovered.filter((schema) => schema.schemaId !== initialSchemaView.schemaId),
            ]
          : discovered;
        setSchemaOptions(next);
        setSelectedSchemaId((current) =>
          next.some((schema) => schema.schemaId === current) ? current : next[0].schemaId
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [initialSchemaView, orderType]);

  const selectedSchema =
    schemaOptions.find((schema) => schema.schemaId === selectedSchemaId) ?? schemaOptions[0];
  useMetadataEditRequest(
    saveRequestTargetId,
    'primer',
    () => {
      if (!safeFocus(nameInputRef.current)) return false;
      nameInputRef.current?.select();
    },
    !isSaving
  );

  const parsedOligo = useMemo(
    () => parseIdtOligoNotation(sequence, { orderType }),
    [orderType, sequence]
  );
  const naturalSequence = parsedOligo.bases;
  const metadataDraft = useMemo(
    () => ({
      name: name.trim(),
      bases: parsedOligo.bases,
      oligo: parsedOligo.composition,
      orderType,
      schemaId: selectedSchema.schemaId,
      schemaRevisionId: selectedSchema.currentRevisionId,
      fields: Object.fromEntries(
        editablePrimerSchemaFields(selectedSchema).map((field) => [
          field.key,
          parsePrimerSchemaFieldValue(field, schemaFieldDrafts[field.key] ?? ''),
        ])
      ),
      direction,
      threePrimeExt,
      bindingOffset,
    }),
    [
      name,
      parsedOligo.bases,
      parsedOligo.composition,
      orderType,
      selectedSchema,
      schemaFieldDrafts,
      direction,
      threePrimeExt,
      bindingOffset,
    ]
  );
  const [savedMetadata, setSavedMetadata] = useState(() => structuredClone(metadataDraft));
  const hasMetadataChanges = !metadataValuesEqual(metadataDraft, savedMetadata);
  const displayedError = error ?? firstOligoErrorUserMessage(parsedOligo);
  const warningDiagnostic = parsedOligo.diagnostics.find(
    (diagnostic) => diagnostic.severity === 'warning'
  );
  const displayedWarning = warningDiagnostic
    ? oligoDiagnosticUserMessage(warningDiagnostic)
    : undefined;

  const primerTm = usePrimerTm(orderType === 'dna' ? naturalSequence : '');
  const tmModel = useSettingsStore((s) => s.tmModel);
  const setTmModel = useSettingsStore((s) => s.setTmModel);
  const primerConcNm = useSettingsStore((s) => s.primerConcNm);
  const tmConditions = useSettingsStore((s) => s.tmConditions);
  const setTmConditions = useSettingsStore((s) => s.setTmConditions);

  const workspaceFolders = useWorkspaceStore((s) => s.folders);
  const targetDir = resolvePrimerTargetDir(initialSaveDir, targetFilePath, workspaceRoot);
  const roots = useMemo(
    () => primerWorkspaceRoots(workspaceFolders, workspaceRoot, targetDir),
    [workspaceFolders, workspaceRoot, targetDir]
  );

  const ownerWorkspaceRoot = useCallback(
    (dir: string): string | undefined =>
      resolvePrimerOwningProjectRoot(
        workspaceFolders.length > 0
          ? workspaceFolders
          : workspaceRoot
            ? [{ path: workspaceRoot }]
            : [],
        dir
      ),
    [workspaceFolders, workspaceRoot]
  );

  const trimmedName = name.trim();
  const hasTemplateContext = initialBindingStart != null && initialBindingEnd != null;
  const focusNameField = useCallback(() => {
    if (safeFocus(nameInputRef.current)) nameInputRef.current?.select();
  }, []);
  const updateName = useCallback(
    (nextName: string) => {
      setName(nextName);
      onNameChange?.(nextName);
    },
    [onNameChange]
  );

  const suggestedName = useMemo(() => {
    if (targetFilePath == null || initialBindingStart == null || initialBindingEnd == null)
      return '';

    const base = (targetFilePath.split(/[\\/]/).pop() ?? '')
      .replace(/\.[^.]+$/, '')
      .replace(/[-_ ]?region$/i, '');
    if (!base) return '';
    return sanitizePrimerArtifactStem(`${base}_${initialBindingStart + 1}_${initialBindingEnd}`);
  }, [targetFilePath, initialBindingStart, initialBindingEnd]);

  const suggestedArtifactPath = suggestedPrimerArtifactPath({
    fixedArtifactPath,
    trimmedName,
    initialSaveDir,
    targetFilePath,
    workspaceRoot,
  });

  const computed = useMemo(() => {
    if (naturalSequence.trim().length < MIN_PRIMER_LENGTH) return null;
    const validation = validatePrimerSequence(naturalSequence, { orderType });
    if (!validation.valid) return null;
    const seq = validation.trimmed ?? naturalSequence.trim();
    return {
      tm: orderType === 'rna' ? null : manualPrimerCreationServices.tmCalculation.estimate(seq).tm,
      gc: calculateGcContent(seq),
      length: seq.length,
    };
  }, [orderType, naturalSequence, tmModel, primerConcNm, tmConditions]);
  const displayTm = orderType === 'rna' ? null : (primerTm.tm ?? computed?.tm ?? null);

  const trimmedSeqLength = naturalSequence.trim().length;

  const maxBindingLength = circular ? 500 : (referenceSequence?.length ?? 500);

  const canPull3Prime =
    referenceSequence != null && initialBindingStart != null && initialBindingEnd != null;

  const setBindingLength = useCallback(
    (newLen: number) => {
      if (!referenceSequence || initialBindingStart == null || initialBindingEnd == null) return;
      if (parsedOligo.errors.length > 0) return;
      const cur = naturalSequence.length;
      if (newLen === cur) return;
      if (newLen > cur) {
        let ext = threePrimeExt;
        let extension = '';
        for (let i = 0; i < newLen - cur; i++) {
          const base = templateExtensionBase({
            direction,
            threePrimeExt: ext,
            bindingOffset,
            initialBindingStart,
            initialBindingEnd,
            reference: referenceSequence,
            circular,
            sequenceLength,
          });
          if (!base) break;
          extension += base;
          ext += 1;
        }
        if (ext !== threePrimeExt) {
          updateSequence(
            resizeIdtOligoNotation(sequence, cur + extension.length, extension, orderType)
          );
          setThreePrimeExt(ext);
        }
      } else {
        const remove = cur - Math.max(MIN_PRIMER_LENGTH, newLen);
        if (remove > 0) {
          updateSequence(resizeIdtOligoNotation(sequence, cur - remove, '', orderType));
          setThreePrimeExt((ext) => ext - remove);
        }
      }
    },
    [
      sequence,
      orderType,
      naturalSequence,
      parsedOligo.errors.length,
      updateSequence,
      threePrimeExt,
      bindingOffset,
      direction,
      referenceSequence,
      initialBindingStart,
      initialBindingEnd,
      circular,
      sequenceLength,
    ]
  );

  const changeDirection = useCallback(
    (next: PrimerDirection) => {
      if (next === direction || parsedOligo.errors.length > 0) return;

      if (canPull3Prime && threePrimeExt > 0) {
        updateSequence(
          resizeIdtOligoNotation(
            sequence,
            Math.max(0, naturalSequence.length - threePrimeExt),
            '',
            orderType
          )
        );
        setThreePrimeExt(0);
      }
      setDirection(next);
    },
    [
      direction,
      threePrimeExt,
      canPull3Prime,
      sequence,
      orderType,
      naturalSequence.length,
      parsedOligo.errors.length,
      updateSequence,
    ]
  );

  const {
    display: draftDisplay,
    mismatchInfo,
    mismatchPositions,
    refWindow,
  } = useMemo(
    () =>
      buildPrimerDraftPreview({
        computed,
        displayTm,
        trimmedName,
        trimmedSequence: naturalSequence.trim(),
        modificationMarkers: oligoToPrimerModificationMarkers(parsedOligo),
        direction,
        threePrimeExt,
        bindingOffset,
        initialBindingStart,
        initialBindingEnd,
        referenceSequence,
        sequenceLength,
        circular,
      }),
    [
      computed,
      displayTm,
      trimmedName,
      naturalSequence,
      parsedOligo,
      direction,
      threePrimeExt,
      bindingOffset,
      initialBindingStart,
      initialBindingEnd,
      referenceSequence,
      sequenceLength,
      circular,
    ]
  );

  const templateLength = sequenceLength ?? referenceSequence?.length ?? 0;
  const bindingPosition = draftDisplay
    ? (direction === 'reverse' ? draftDisplay.start + 1 : draftDisplay.end || templateLength) +
      bindingCoordinateOffset
    : null;
  const minBindingPosition =
    (circular || direction === 'reverse' ? 1 : trimmedSeqLength) + bindingCoordinateOffset;
  const maxBindingPosition =
    (circular || direction === 'forward' ? templateLength : templateLength - trimmedSeqLength + 1) +
    bindingCoordinateOffset;
  const canMoveBinding =
    canPull3Prime &&
    parsedOligo.errors.length === 0 &&
    trimmedSeqLength > 0 &&
    trimmedSeqLength <= templateLength;
  const setBindingPosition = (next: number) => {
    if (!canMoveBinding || bindingPosition == null) return;

    const originalPosition =
      direction === 'reverse'
        ? initialBindingStart! - threePrimeExt + 1
        : initialBindingEnd! + threePrimeExt;
    setBindingOffset(next - bindingCoordinateOffset - originalPosition);
  };

  useEffect(() => {
    onPreviewChange?.({ display: draftDisplay });
  }, [draftDisplay, onPreviewChange]);

  useEffect(() => {
    return () => onPreviewChange?.({ display: null });
  }, [onPreviewChange]);

  const submit = useCallback(async (): Promise<boolean> => {
    if (isSaving) return false;
    if (fixedArtifactPath && !hasMetadataChanges) return true;
    setError(null);
    const prepared = preparePrimerSaveInput({
      draft: {
        parsedOligo,
        orderType,
        name,
        schema: selectedSchema,
        schemaFieldDrafts,
      },
      destination: {
        workspaceRoot,
        fixedArtifactPath,
        artifactDir,
        suggestedArtifactPath,
        ownerWorkspaceRoot,
      },
      binding: {
        hostOwned: hostOwnedBinding,
        direction,
        threePrimeExt,
        bindingOffset,
        initialBindingStart,
        initialBindingEnd,
        targetFilePath,
        targetDocumentId,
        targetTopology,
        sequenceId,
        sequenceLength,
        circular,
      },
      workspaceId,
    });
    if (!prepared.ok) {
      setError(toUserMessage(prepared.error, 'primer.failed'));
      return false;
    }

    setIsSaving(true);
    try {
      const result = prepared.hostBinding
        ? await onSave(prepared.value, prepared.hostBinding)
        : await onSave(prepared.value);
      if (result !== false) setSavedMetadata(structuredClone(metadataDraft));
      return result !== false;
    } catch (err) {
      reportSaveFailure('[PrimerCreationForm] Save failed:', { tabId: saveRequestTargetId }, err);
      setError(toUserMessage(primerSaveErrorMessage(err), 'primer.failed'));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [
    isSaving,
    hasMetadataChanges,
    metadataDraft,
    hostOwnedBinding,
    parsedOligo,
    orderType,
    name,
    selectedSchema,
    schemaFieldDrafts,
    workspaceRoot,
    fixedArtifactPath,
    artifactDir,
    suggestedArtifactPath,
    ownerWorkspaceRoot,
    direction,
    threePrimeExt,
    bindingOffset,
    initialBindingStart,
    initialBindingEnd,
    targetFilePath,
    targetDocumentId,
    targetTopology,
    sequenceId,
    sequenceLength,
    circular,
    workspaceId,
    onSave,
    saveRequestTargetId,
  ]);

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      void submit();
    },
    [submit]
  );

  useDocumentLifecycle(
    saveRequestTargetId
      ? {
          target: { kind: 'tab', tabId: saveRequestTargetId },
          tabId: saveRequestTargetId,
          isDirty: () => Boolean(name.trim() || sequence.trim()),
          save: submit,
          discard: () => undefined,
        }
      : null
  );

  const gcOff = isPrimerGcOff(computed?.gc);

  return (
    <form
      data-testid="primer-creation-form"
      onSubmit={handleSubmit}
      className="relative flex h-full min-h-0 flex-col"
    >
      {}
      <div
        data-testid="primer-form-content"
        className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3"
      >
        {}
        <div className="group flex min-w-0 items-center gap-1">
          <h2
            data-testid="primer-form-title"
            onDoubleClick={focusNameField}
            className={`min-w-0 cursor-text truncate text-base font-semibold ${
              trimmedName ? 'text-fg' : 'text-fg-muted'
            }`}
            title={`${primerDraftDisplayName(name, draftKindLabel)} — double-click to edit`}
          >
            {primerDraftDisplayName(name, draftKindLabel)}
          </h2>
          <button
            type="button"
            data-testid="primer-title-edit"
            aria-label="Edit primer name"
            title="Edit primer name"
            onClick={focusNameField}
            disabled={isSaving}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-bg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
          >
            <EditIcon size={12} />
          </button>
        </div>

        {}
        {hasTemplateContext && (
          <div
            data-testid="primer-preview-box"
            className="relative flex shrink-0 items-center rounded-md bg-bg-muted/60 py-2"
          >
            {onGoToBinding && draftDisplay && (
              <button
                type="button"
                data-testid="primer-goto-binding"
                aria-label="Go to primer binding site on the sequence"
                title="Go to primer binding site on the sequence"
                onClick={() => onGoToBinding(draftDisplay.start, draftDisplay.end)}
                className={`absolute right-1 ${direction === 'reverse' ? 'bottom-1.5' : 'top-1.5'} z-10 inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors duration-150 hover:bg-accent/10 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent`}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  aria-hidden="true"
                >
                  <circle cx="8" cy="8" r="5.5" />
                  <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
                  <path d="M8 0.5v2.5M8 13v2.5M0.5 8h2.5M13 8h2.5" strokeLinecap="round" />
                </svg>
              </button>
            )}
            <PrimerRenderPreview display={draftDisplay} referenceWindow={refWindow} />
          </div>
        )}

        {}
        {!externalSequenceEditor && (
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label htmlFor="primer-sequence-input" className={LABEL_CLASS + ' mb-0'}>
                Sequence <span className="font-normal text-fg-muted">(5′→3′)</span> *
              </label>
            </div>
            <PrimerSequenceInput
              value={sequence}
              onChange={updateSequence}
              mismatchPositions={mismatchPositions}
              placeholder="Type or paste bases · / for modifications"
              orderType={orderType}
            />
          </div>
        )}

        <PrimerFormMetricsStrip
          bindingPositionControl={
            bindingPosition == null
              ? undefined
              : {
                  value: bindingPosition,
                  min: minBindingPosition,
                  max: maxBindingPosition,
                  editable: canMoveBinding,
                  wrap: Boolean(circular),
                  onChange: setBindingPosition,
                }
          }
          hasTemplateContext={hasTemplateContext}
          direction={direction}
          onDirectionChange={changeDirection}
          trimmedSeqLength={trimmedSeqLength}
          maxBindingLength={maxBindingLength}
          onBindingLengthChange={setBindingLength}
          canPull3Prime={canPull3Prime}
          computed={computed}
          displayTm={displayTm}
          primerTm={primerTm}
          orderType={orderType}
          tmModel={tmModel}
          onTmModelChange={setTmModel}
          tmConditions={tmConditions}
          onTmConditionsChange={setTmConditions}
          gcOff={gcOff}
        />
        <PrimerMismatchSummary mismatchInfo={mismatchInfo} />

        {}
        <div>
          <label htmlFor="primer-name-input" className={LABEL_CLASS}>
            Name <span className="font-normal text-error">*</span>
            {!trimmedName && suggestedName && (
              <span className="ml-2 font-normal text-[10px] text-fg-muted">
                press <kbd className="rounded bg-bg-muted px-1">Tab</kbd> to use suggestion
              </span>
            )}
          </label>
          <input
            ref={nameInputRef}
            id="primer-name-input"
            data-testid="primer-name-input"
            type="text"
            required
            value={name}
            onChange={(e) => updateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && !name && suggestedName) {
                e.preventDefault();
                updateName(suggestedName);
              }
            }}
            placeholder={suggestedName}
            className={`${SETTINGS_FIELD_CLASS} placeholder:text-fg-muted/50`}
          />
        </div>

        <PrimerSchemaFields
          schemas={schemaOptions}
          selectedSchemaId={selectedSchema.schemaId}
          values={schemaFieldDrafts}
          onSelectSchema={(schemaId) => {
            const nextSchema = schemaOptions.find((schema) => schema.schemaId === schemaId);
            if (!nextSchema) return;
            const nextKeys = new Set(
              editablePrimerSchemaFields(nextSchema).map((field) => field.key)
            );
            setSchemaFieldDrafts((current) =>
              Object.fromEntries(Object.entries(current).filter(([key]) => nextKeys.has(key)))
            );
            setSelectedSchemaId(schemaId);
            setError(null);
            onDraftChange?.();
          }}
          onValuesChange={(values) => {
            setSchemaFieldDrafts(values);
            onDraftChange?.();
          }}
        />

        <PrimerSaveLocationSection
          fixedArtifactPath={fixedArtifactPath}
          workspaceRoot={workspaceRoot}
          roots={roots}
          targetDir={targetDir}
          artifactDir={artifactDir}
          onSelectFolder={(dir) => {
            setArtifactDir(dir);
            setError(null);
          }}
        />
        <PrimerFormMessages
          error={displayedError}
          warning={toOptionalUserMessage(displayedWarning)}
        />
      </div>
      <PrimerFormActions
        saveError={parsedOligo.errors[0]}
        isSaving={isSaving}
        canSave={
          Boolean(naturalSequence.trim()) &&
          parsedOligo.errors.length === 0 &&
          Boolean(name.trim()) &&
          Boolean(workspaceRoot)
        }
        fixedArtifactPath={fixedArtifactPath}
        hasChanges={!fixedArtifactPath || hasMetadataChanges}
        onCancel={onCancel}
      />
    </form>
  );
}

function primerMismatchLabel(mismatchInfo: MismatchInfo): string {
  const noun = mismatchInfo.count === 1 ? 'mismatch' : 'mismatches';
  if (mismatchInfo.threePrimeTerminal)
    return `${mismatchInfo.count} ${noun} — one at the 3' terminus`;
  return `${mismatchInfo.count} ${noun} vs template`;
}

function PrimerMismatchSummary({ mismatchInfo }: { mismatchInfo: MismatchInfo | null }) {
  if (!mismatchInfo || mismatchInfo.count === 0) return null;
  return (
    <div data-testid="primer-mismatch-summary" className="min-w-0 text-xs">
      {mismatchInfo.threePrimeTerminal ? (
        <span className="text-error">{primerMismatchLabel(mismatchInfo)}</span>
      ) : (
        <span className="text-warning">{primerMismatchLabel(mismatchInfo)}</span>
      )}
    </div>
  );
}

function PrimerSaveLocationSection({
  fixedArtifactPath,
  workspaceRoot,
  roots,
  targetDir,
  artifactDir,
  onSelectFolder,
}: {
  fixedArtifactPath?: string;
  workspaceRoot?: string;
  roots: Array<{ path: string; name: string }>;
  targetDir: string;
  artifactDir: string | null;
  onSelectFolder: (dir: string) => void;
}) {
  if (fixedArtifactPath) {
    return (
      <div data-testid="primer-fixed-location" className="border-t border-border pt-3">
        <div className={LABEL_CLASS}>File location</div>
        <div className="truncate font-mono text-xs text-fg-muted" title={fixedArtifactPath}>
          {displayArtifactLocation(fixedArtifactPath, workspaceRoot)}
        </div>
      </div>
    );
  }
  if (roots.length === 0) return null;
  return (
    <div data-testid="primer-save-location-section" className="flex min-h-[280px] flex-1 flex-col">
      <div className={`${LABEL_CLASS} shrink-0`}>Save location</div>
      <PrimerSaveLocationPicker
        roots={roots}
        initialDir={targetDir || workspaceRoot || ''}
        selectedDir={artifactDir ?? targetDir ?? workspaceRoot ?? ''}
        onSelectFolder={onSelectFolder}
        className="min-h-0 flex-1"
      />
    </div>
  );
}

function PrimerFormMessages({ error, warning }: { error: string | null; warning?: string }) {
  if (error) {
    return (
      <div
        data-testid="primer-form-error"
        role="alert"
        aria-live="assertive"
        className="text-xs text-error"
      >
        {toUserMessage(error, 'primer.failed')}
      </div>
    );
  }
  if (!warning) return null;
  return (
    <div
      data-testid="primer-form-warning"
      role="status"
      aria-live="polite"
      className="text-xs text-warning"
    >
      {warning}
    </div>
  );
}

function PrimerFormActions({
  saveError,
  isSaving,
  canSave,
  fixedArtifactPath,
  onCancel,
  hasChanges,
}: {
  saveError?: string;
  isSaving: boolean;
  canSave: boolean;
  fixedArtifactPath?: string;
  onCancel: () => void;
  hasChanges: boolean;
}) {
  return (
    <div
      data-testid="primer-form-actions"
      className="flex gap-2 border-t border-border bg-bg px-3 py-2.5"
    >
      <div className="grid flex-1">
        <MetadataSaveButton
          hasChanges={hasChanges}
          type="submit"
          title={toUserMessage(saveError, 'primer.failed')}
          disabled={isSaving || !canSave}
        >
          {isSaving ? 'Saving…' : fixedArtifactPath ? 'Save Changes' : 'Save Primer'}
        </MetadataSaveButton>
      </div>
      <Button type="button" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function primerSchemaViewFromSnapshot(
  snapshot: PrimerEntitySchemaSnapshot
): LimsSchemaDefinitionView {
  return {
    schemaId: snapshot.schemaId,
    currentRevisionId: snapshot.schemaRevisionId,
    entityKind: snapshot.name,
    baseKind: 'primer',
    displayName: snapshot.displayName,
    description: snapshot.description ?? null,
    version: snapshot.version,
    builtin: snapshot.schemaId === 'schema-entity-oligo',
    fields: snapshot.fields
      .filter((field): field is typeof field & LimsFieldDefinition => isLimsFieldType(field.type))
      .map((field) => ({
        ...field,
        ...(field.enumOptions ? { enumOptions: [...field.enumOptions] } : {}),
      })),
  };
}

function primerSchemaDrafts(fields: Record<string, unknown> | undefined): PrimerSchemaFieldDrafts {
  if (!fields) return {};
  const drafts: PrimerSchemaFieldDrafts = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'boolean') drafts[key] = value;
    else if (typeof value === 'string' || typeof value === 'number') drafts[key] = String(value);
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      drafts[key] = value.join(', ');
    }
  }
  return drafts;
}

function displayArtifactLocation(path: string, workspaceRoot?: string): string {
  const normalized = path.replace(/\\/g, '/');
  const root = workspaceRoot?.replace(/\\/g, '/').replace(/\/$/, '');
  const relative =
    root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
  return relative.replace(/\.primer\.json$/i, '');
}
