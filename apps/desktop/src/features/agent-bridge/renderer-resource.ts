import { getEntityReference } from '../../db/entity-references';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { hasCompleteStructureResidueIdentities } from '../ai/public/selection-descriptor/structure';
import { resolveWorkspaceBinding } from './workspace-binding';

export interface RendererResourceReference {
  id: string;
  entityType: string;
  displayLabel: string;
  locator: string;
  deepLinkParams: unknown;
  data: unknown;
}

export type RendererResourceReadResponse =
  | { ok: true; reference: RendererResourceReference }
  | {
      ok: false;
      error: { code: string; message: string; retriable: boolean };
    };

export interface RendererResourceReadContext {
  expectedSessionToken: string;
  providedSessionToken: string;
  agentCapabilities: readonly string[];
  boundWorkspaceId: string | null;
  currentWorkspaceId: string | null;
  folders?: WorkspaceFolder[];
}

function resourceError(
  code: string,
  message: string,
  retriable = false
): RendererResourceReadResponse {
  return { ok: false, error: { code, message, retriable } };
}

function safeParseJson(value: string | null): { ok: true; value: unknown } | { ok: false } {
  if (value === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

export async function readSelectionResource(
  referenceId: string,
  context: RendererResourceReadContext
): Promise<RendererResourceReadResponse> {
  if (typeof referenceId !== 'string' || referenceId.length === 0) {
    return {
      ok: false,
      error: {
        code: 'BAD_INPUT',
        message: 'Resource read requires a non-empty reference id.',
        retriable: false,
      },
    };
  }

  if (context.expectedSessionToken !== context.providedSessionToken) {
    return resourceError('BAD_SESSION', 'Renderer resource session token is invalid.', true);
  }
  if (
    !context.agentCapabilities.includes('*') &&
    !context.agentCapabilities.includes('read-workspace')
  ) {
    return resourceError(
      'INSUFFICIENT_SCOPE',
      'Selection resources require the read-workspace capability.'
    );
  }
  const workspaceBinding = resolveWorkspaceBinding({
    boundWorkspaceId: context.boundWorkspaceId,
    currentWorkspaceId: context.currentWorkspaceId,
    folders: context.folders ?? [],
  });
  if (!workspaceBinding.ok) {
    return resourceError(
      'WRONG_WORKSPACE',
      'Renderer resource session is bound to a different workspace.',
      true
    );
  }

  const row = await getEntityReference(referenceId);
  if (!row) {
    return {
      ok: false,
      error: {
        code: 'SELECTION_NOT_FOUND',
        message: `No selection reference found for id: ${referenceId}`,
        retriable: false,
      },
    };
  }

  if (row.workspace_scope === null) {
    return resourceError(
      'REFERENCE_UNSCOPED',
      'Legacy selection reference has no workspace ownership and cannot be exposed to an agent.'
    );
  }
  if (
    workspaceBinding.workspaceId === null ||
    row.workspace_scope !== workspaceBinding.workspaceId
  ) {
    return resourceError(
      'REFERENCE_SCOPE_MISMATCH',
      'Selection reference belongs to a different workspace.'
    );
  }

  const parsedDescriptor = safeParseJson(row.data);
  if (!parsedDescriptor.ok) {
    return {
      ok: false,
      error: {
        code: 'SELECTION_NO_DESCRIPTOR',
        message: `Selection reference ${referenceId} has no stored descriptor.`,
        retriable: false,
      },
    };
  }

  if (
    parsedDescriptor.value === null ||
    typeof parsedDescriptor.value !== 'object' ||
    Array.isArray(parsedDescriptor.value) ||
    (parsedDescriptor.value as Record<string, unknown>).schemaVersion !== 2
  ) {
    return resourceError(
      'SELECTION_INVALID_DESCRIPTOR',
      `Selection reference ${referenceId} does not contain a SELDESC v2 descriptor.`
    );
  }
  const descriptor = parsedDescriptor.value as Record<string, unknown>;
  const expectedKind = expectedDescriptorKind(row.entity_type);
  if (expectedKind === null || descriptor.kind !== expectedKind) {
    return resourceError(
      'SELECTION_KIND_MISMATCH',
      `Selection reference ${referenceId} descriptor kind does not match its entity type.`
    );
  }
  if (expectedKind === 'structure' && !hasCompleteStructureResidueIdentities(descriptor)) {
    return resourceError(
      'STRUCTURE_RESIDUE_IDENTITIES_INCOMPLETE',
      `Structure selection reference ${referenceId} does not contain complete residue identities.`
    );
  }

  const parsedDeepLink = safeParseJson(row.deep_link_params);
  return {
    ok: true,
    reference: {
      id: row.id,
      entityType: row.entity_type,
      displayLabel: row.display_label,
      locator: row.locator,
      deepLinkParams: parsedDeepLink.ok ? parsedDeepLink.value : null,
      data: descriptor,
    },
  };
}

function expectedDescriptorKind(entityType: string): string | null {
  switch (entityType) {
    case 'sequence_region':
    case 'annotation':
    case 'structure':
      return entityType;
    case 'sequence':
      return 'whole_entity';
    default:
      return null;
  }
}
