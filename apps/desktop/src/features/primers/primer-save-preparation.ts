import { assertLimsTemporalEdits } from '@waypoint/scientific-artifacts/shared/lims-temporal';
import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  userEntityLabel,
  toUserMessage,
  type UserMessage,
} from '@waypoint/user-messages';
import { firstOligoErrorUserMessage, primerSequenceUserMessage } from './oligo-user-messages';
import type { LimsSchemaDefinitionView } from '../../shared/lims';
import { validateLimsEntityFields } from '../../shared/lims';
import { computeBindingPositions } from './primer-3prime-extension';
import { primerArtifactPathInDir, validatePrimerArtifactPath } from './primer-artifact';
import {
  editablePrimerSchemaFields,
  parsePrimerSchemaFieldValue,
  primerSchemaSnapshot,
} from './primer-entity-schema';
import type { ParsedIdtOligoNotation, OligoOrderType } from './oligo-modifications';
import { validatePrimerSequence } from './primer-validation';
import type { CreatePrimerInput, PrimerDirection } from './types';
import { normalizePathForBoundary } from '../../shared/path-boundary';

type PreparationResult<T> = { ok: true; value: T } | { ok: false; error: UserMessage };

type PrimerSaveDraft = {
  parsedOligo: ParsedIdtOligoNotation;
  orderType: OligoOrderType;
  name: string;
  schema: LimsSchemaDefinitionView;
  schemaFieldDrafts: Readonly<Record<string, string | boolean>>;
  previousFields?: Record<string, unknown>;
};

type PrimerSaveDestination = {
  workspaceRoot?: string;
  fixedArtifactPath?: string;
  artifactDir: string | null;
  suggestedArtifactPath: string;
  ownerWorkspaceRoot: (directory: string) => string | undefined;
};

export type HostPrimerBinding = { start: number; end: number; strand: 1 | -1 };

type PrimerSaveBinding = {
  hostOwned?: boolean;
  direction: PrimerDirection;
  threePrimeExt: number;
  bindingOffset?: number;
  initialBindingStart?: number;
  initialBindingEnd?: number;
  targetFilePath?: string;
  targetDocumentId?: string;
  targetTopology?: 'linear' | 'circular';
  sequenceId?: number;
  sequenceLength?: number;
  circular?: boolean;
};

export type PreparePrimerSaveInput = {
  draft: PrimerSaveDraft;
  destination: PrimerSaveDestination;
  binding: PrimerSaveBinding;
  workspaceId?: number;
};

type ValidatedPrimerDraft = Pick<
  CreatePrimerInput,
  'name' | 'sequence' | 'oligo' | 'entitySchema' | 'entityFields'
>;
type ValidatedPrimerDraftContext = {
  input: ValidatedPrimerDraft;
  workspaceRoot: string;
};

function validatePrimerDraft(
  draft: PrimerSaveDraft,
  workspaceRoot: string | undefined
): PreparationResult<ValidatedPrimerDraftContext> {
  if (draft.parsedOligo.errors.length > 0) {
    return {
      ok: false,
      error:
        firstOligoErrorUserMessage(draft.parsedOligo) ?? userMessage('primer.modification.check'),
    };
  }
  const sequenceValidation = validatePrimerSequence(draft.parsedOligo.bases, {
    orderType: draft.orderType,
  });
  if (!sequenceValidation.valid) {
    return {
      ok: false,
      error: primerSequenceUserMessage(sequenceValidation) ?? userMessage('primer.sequenceInvalid'),
    };
  }
  if (!workspaceRoot) {
    return {
      ok: false,
      error: userMessage('primer.save.open-a-sequence-from-a-project-before-saving-a-primer'),
    };
  }
  const name = draft.name.trim();
  if (!name) return { ok: false, error: userMessage('primer.nameRequired') };

  const editableFields = editablePrimerSchemaFields(draft.schema);
  const missingRequired = editableFields.find(
    (field) =>
      field.required && String(draft.schemaFieldDrafts[field.key] ?? '').trim().length === 0
  );
  if (missingRequired)
    return {
      ok: false,
      error: userMessageWithValues('primer.requiredField', {
        field: userMessageValue(userEntityLabel(missingRequired.label)),
      }),
    };
  const entityFields = Object.fromEntries(
    editableFields
      .map(
        (field) =>
          [
            field.key,
            parsePrimerSchemaFieldValue(
              field,
              draft.schemaFieldDrafts[field.key] ?? '',
              draft.previousFields?.[field.key]
            ),
          ] as const
      )
      .filter(([, value]) => value !== undefined)
  );
  try {
    assertLimsTemporalEdits(entityFields, editableFields, draft.previousFields);
  } catch (error) {
    return { ok: false, error: toUserMessage(error, 'validation.invalid') };
  }
  const schemaErrors = validateLimsEntityFields(
    draft.schema.entityKind,
    entityFields,
    editableFields
  );
  if (schemaErrors.length > 0)
    return { ok: false, error: toUserMessage(schemaErrors[0], 'validation.invalid') };

  return {
    ok: true,
    value: {
      input: {
        name,
        sequence: sequenceValidation.trimmed ?? draft.parsedOligo.bases.trim(),
        ...(draft.parsedOligo.composition ? { oligo: draft.parsedOligo.composition } : {}),
        entitySchema: primerSchemaSnapshot(draft.schema),
        entityFields,
      },
      workspaceRoot,
    },
  };
}

function resolvePrimerBinding(
  binding: PrimerSaveBinding,
  primerLength: number
): PreparationResult<{ input: Partial<CreatePrimerInput>; hostBinding?: HostPrimerBinding }> {
  const { initialBindingStart, initialBindingEnd } = binding;
  const hasSelectedRange = initialBindingStart != null && initialBindingEnd != null;
  if (!hasSelectedRange) return { ok: true, value: { input: {} } };
  if (binding.hostOwned) {
    if (binding.sequenceLength == null) {
      return {
        ok: false,
        error: userMessage('primer.save.the-selected-template-region-is-not-available'),
      };
    }
    const position = computeBindingPositions({
      direction: binding.direction,
      length: primerLength,
      threePrimeExt: binding.threePrimeExt,
      bindingOffset: binding.bindingOffset,
      initialBindingStart,
      initialBindingEnd,
      circular: false,
      sequenceLength: binding.sequenceLength,
    });
    if (position.start < 0 || position.end > binding.sequenceLength) {
      return {
        ok: false,
        error: userMessage(
          'primer.save.primer-binding-site-runs-past-the-loaded-template-shorten-the-primer-or-adjust-the-selection'
        ),
      };
    }
    return {
      ok: true,
      value: {
        input: {},
        hostBinding: {
          start: position.start,
          end: position.end,
          strand: binding.direction === 'reverse' ? -1 : 1,
        },
      },
    };
  }
  if (
    !binding.targetFilePath ||
    !binding.targetDocumentId ||
    binding.sequenceId == null ||
    binding.sequenceLength == null
  ) {
    return {
      ok: false,
      error: userMessage('primer.targetUnavailable'),
    };
  }

  const position = computeBindingPositions({
    direction: binding.direction,
    length: primerLength,
    threePrimeExt: binding.threePrimeExt,
    bindingOffset: binding.bindingOffset,
    initialBindingStart,
    initialBindingEnd,
    circular: binding.circular,
    sequenceLength: binding.sequenceLength,
  });
  if (!binding.circular && (position.start < 0 || position.end > binding.sequenceLength)) {
    return {
      ok: false,
      error: userMessage(
        'primer.save.primer-binding-site-runs-past-the-template-shorten-the-primer-or-adjust-the-selection'
      ),
    };
  }
  return {
    ok: true,
    value: {
      input: {
        targetFilePath: binding.targetFilePath,
        targetDocumentId: binding.targetDocumentId,
        targetLength: binding.sequenceLength,
        targetTopology: binding.targetTopology ?? (binding.circular ? 'circular' : 'linear'),
        bindingSequenceId: binding.sequenceId,
        bindingStart: position.start,
        bindingEnd: position.end,
        bindingStrand: binding.direction === 'reverse' ? -1 : 1,
      },
    },
  };
}

export function preparePrimerSaveInput({
  draft,
  destination,
  binding,
  workspaceId,
}: PreparePrimerSaveInput):
  | { ok: true; value: CreatePrimerInput; hostBinding?: HostPrimerBinding }
  | { ok: false; error: UserMessage } {
  const validatedDraft = validatePrimerDraft(draft, destination.workspaceRoot);
  if (!validatedDraft.ok) return validatedDraft;
  const resolvedBinding = resolvePrimerBinding(binding, validatedDraft.value.input.sequence.length);
  if (!resolvedBinding.ok) return resolvedBinding;

  const artifactPath = destination.fixedArtifactPath
    ? destination.fixedArtifactPath
    : destination.artifactDir
      ? primerArtifactPathInDir(destination.artifactDir, validatedDraft.value.input.name)
      : destination.suggestedArtifactPath;

  const artifactDirectory = artifactPath.slice(
    0,
    Math.max(artifactPath.lastIndexOf('/'), artifactPath.lastIndexOf('\\'))
  );
  const workspaceRoot = destination.ownerWorkspaceRoot(artifactDirectory);
  if (!workspaceRoot) {
    return {
      ok: false,
      error: userMessage(
        'primer.save.choose-a-save-folder-in-an-open-project-your-primer-draft-is-still-here'
      ),
    };
  }
  const sameWorkspace =
    normalizePathForBoundary(workspaceRoot) ===
    normalizePathForBoundary(validatedDraft.value.workspaceRoot);
  if (destination.fixedArtifactPath && !sameWorkspace) {
    return {
      ok: false,
      error: userMessage(
        'primer.save.this-primer-belongs-to-a-different-project-now-keep-this-draft-and-reopen-the-primer-from-its-owning-project-b'
      ),
    };
  }
  const pathValidation = validatePrimerArtifactPath(artifactPath, workspaceRoot);
  if (!pathValidation.valid)
    return { ok: false, error: toUserMessage(pathValidation.error, 'primer.saveLocationInvalid') };
  const targetFilePath = resolvedBinding.value.input.targetFilePath;
  if (
    targetFilePath &&
    normalizePathForBoundary(destination.ownerWorkspaceRoot(targetFilePath) ?? '') !==
      normalizePathForBoundary(workspaceRoot)
  ) {
    return {
      ok: false,
      error: userMessage(
        'primer.save.save-this-bound-primer-in-the-same-project-as-its-target-sequence-choose-that-project-in-the-save-location-you'
      ),
    };
  }

  return {
    ok: true,
    value: {
      ...validatedDraft.value.input,
      artifactPath,
      workspaceRoot,
      requireRegistry: true,

      ...(sameWorkspace && workspaceId != null ? { workspaceId } : {}),
      ...resolvedBinding.value.input,
    },
    ...(resolvedBinding.value.hostBinding
      ? { hostBinding: resolvedBinding.value.hostBinding }
      : {}),
  };
}
