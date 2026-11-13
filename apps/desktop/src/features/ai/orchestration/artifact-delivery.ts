import {
  getCurrentCatalogFileForEntity,
  getCatalogWorkspaceRootForFilePath,
} from '../../../db/workspace-catalog';
import {
  createEntityReference,
  getEntityReferencesByIds,
  linkReferenceToMessage,
  prepareEntityReferenceRow,
  type DBEntityReference,
} from '../../../db/entity-references';
import { getConnection } from '../../../db';
import { platform } from '../../../platform';
import type { ChatMessage } from './chat-types';
import {
  claimsCompletedBiologyArtifact,
  sanitizeAssistantArtifactMetadata,
} from './assistant-artifact-prose';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export { sanitizeAssistantArtifactMetadata } from './assistant-artifact-prose';

const UNVERIFIED_ARTIFACT_MESSAGE =
  "I couldn't verify a saved artifact for that claim, so I can't present the result as complete.";

function appendUnverifiedArtifactMessage(content: string): string {
  const original = sanitizeAssistantArtifactMetadata(content);
  return original.includes(UNVERIFIED_ARTIFACT_MESSAGE)
    ? original
    : [original, UNVERIFIED_ARTIFACT_MESSAGE].filter(Boolean).join('\n\n');
}

export interface CreatedArtifactClaim {
  kind: 'design' | 'sequence' | 'notebook';
  id: string;
  label: string;
  workspaceRoot?: string;
  revision?: string;
}

interface SavedArtifact {
  path: string;
  workspaceRoot: string | null;
}

export interface ArtifactDeliveryDependencies {
  resolveSavedArtifact: (claim: CreatedArtifactClaim) => Promise<SavedArtifact | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function completedToolResult(value: unknown): Record<string, unknown> | null {
  let current = value;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!isRecord(current) || current.ok === false || current.isError === true) return null;
    if (typeof current.error === 'string' && current.error.trim()) return null;
    if (isRecord(current.structuredContent)) {
      current = current.structuredContent;
      continue;
    }
    if (isRecord(current.result)) {
      current = current.result;
      continue;
    }
    return current;
  }
  return isRecord(current) ? current : null;
}

function claimFromTool(
  name: string,
  output: unknown,
  input?: unknown
): CreatedArtifactClaim | null {
  const result = completedToolResult(output);
  if (!result) return null;
  if (name === 'create_notebook' || name === 'update_notebook' || name === 'notebook_document') {
    const native = name === 'notebook_document';
    if (native) {
      const operation = isRecord(input) && isRecord(input.operation) ? input.operation.kind : null;
      if (!['create', 'save', 'rename'].includes(String(operation))) return null;
      if (
        result.ready !== true ||
        result.dirty !== false ||
        result.saving !== false ||
        result.revision !== result.persistedRevision
      )
        return null;
    }
    const id = native ? result.pageId : result.notebookId;
    const revision = native ? result.canonicalFingerprint : result.revision;
    if (
      typeof id !== 'string' ||
      !id.trim() ||
      typeof result.workspaceRoot !== 'string' ||
      !result.workspaceRoot.trim() ||
      typeof revision !== 'string' ||
      !/^[0-9a-f]{16}$/iu.test(revision)
    )
      return null;
    return {
      kind: 'notebook',
      id,
      workspaceRoot: result.workspaceRoot,
      revision,
      label:
        typeof result.title === 'string' && result.title.trim() ? result.title.trim() : 'Notebook',
    };
  }
  if (name === 'create_design') {
    if (
      result.created === false ||
      typeof result.designId !== 'string' ||
      !UUID.test(result.designId)
    ) {
      return null;
    }
    return {
      kind: 'design',
      id: result.designId,
      label: typeof result.name === 'string' && result.name.trim() ? result.name.trim() : 'Design',
    };
  }
  if (name === 'import_sequence') {
    if (
      result.imported !== true ||
      typeof result.documentId !== 'string' ||
      !UUID.test(result.documentId)
    ) {
      return null;
    }
    return {
      kind: 'sequence',
      id: result.documentId,
      label:
        typeof result.name === 'string' && result.name.trim() ? result.name.trim() : 'Sequence',
    };
  }
  return null;
}

function canonicalToolName(name: string): string {
  return name.replace(/^mcp__dnaforge__/u, '');
}

export function collectCreatedArtifactClaims(
  messages: readonly ChatMessage[]
): CreatedArtifactClaim[] {
  const claims = new Map<string, CreatedArtifactClaim>();
  const record = (claim: CreatedArtifactClaim | null): void => {
    if (claim) claims.set(`${claim.kind}:${claim.id}`, claim);
  };
  for (const message of messages) {
    if (message.role === 'tool' && message.toolName) {
      const payload = parseJson(message.content);
      if (isRecord(payload) && payload.isError !== true) {
        record(claimFromTool(canonicalToolName(message.toolName), payload.output, payload.input));
      }
      continue;
    }
    if (message.role !== 'activity') continue;
    const payload = parseJson(message.content);
    if (!isRecord(payload) || payload.type !== 'agent.activity' || !isRecord(payload.event)) {
      continue;
    }
    const toolCalls = payload.event.toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      if (!isRecord(call) || call.status !== 'completed' || typeof call.name !== 'string') {
        continue;
      }
      if (call.mcpServer !== 'dnaforge' && !call.name.startsWith('mcp__dnaforge__')) continue;
      record(claimFromTool(canonicalToolName(call.name), call.output, call.input));
    }
  }
  return [...claims.values()];
}

async function resolveSavedArtifact(claim: CreatedArtifactClaim): Promise<SavedArtifact | null> {
  const file = await getCurrentCatalogFileForEntity(claim.id);
  if (!file || !(await platform().fs.exists(file.path))) return null;
  if (claim.kind === 'design' && file.file_kind !== 'waypoint-design') return null;
  if (claim.kind === 'sequence' && file.file_kind !== 'waypoint-sequence') return null;
  const workspaceRoot = await getCatalogWorkspaceRootForFilePath(file.path);
  if (claim.kind === 'notebook') {
    if (
      file.file_kind !== 'waypoint-notebook' ||
      !workspaceRoot ||
      claim.workspaceRoot !== workspaceRoot ||
      !claim.revision
    )
      return null;
    const saved = await platform().notebook.execute({
      documentId: claim.id,
      operation: { kind: 'inspect', offset: 0, limit: 1 },
    });
    if (
      saved.documentId !== claim.id ||
      saved.workspaceRoot !== workspaceRoot ||
      saved.path !== file.path ||
      saved.canonicalFingerprint !== claim.revision ||
      !saved.ready ||
      saved.dirty ||
      saved.saving ||
      saved.revision !== saved.persistedRevision ||
      saved.publication?.status !== 'settled'
    )
      return null;
  }
  return {
    path: file.path,
    workspaceRoot,
  };
}

function artifactLocator(claim: CreatedArtifactClaim): string {
  return `entity://${claim.kind === 'design' ? 'assembly' : claim.kind === 'notebook' ? 'page' : 'sequence'}/${claim.id}`;
}

const defaultDependencies: ArtifactDeliveryDependencies = { resolveSavedArtifact };

export async function prepareAgentArtifactDelivery(
  claims: readonly CreatedArtifactClaim[],
  dependencies: ArtifactDeliveryDependencies = defaultDependencies
): Promise<{ references: DBEntityReference[]; failedClaims: CreatedArtifactClaim[] }> {
  const references: DBEntityReference[] = [];
  const failedClaims: CreatedArtifactClaim[] = [];
  for (const claim of claims) {
    try {
      const saved = await dependencies.resolveSavedArtifact(claim);
      if (!saved) {
        failedClaims.push(claim);
        continue;
      }
      const entityType =
        claim.kind === 'design' ? 'assembly' : claim.kind === 'notebook' ? 'notebook' : 'sequence';
      references.push(
        prepareEntityReferenceRow({
          entityType,
          displayLabel: claim.label,
          locator: artifactLocator(claim),
          deepLinkParams: null,
          data: claim.kind === 'sequence' ? { documentId: claim.id } : null,
          source: 'ai',
          workspaceScope: null,
          workspaceRootPath: saved.workspaceRoot,
        })
      );
    } catch {
      failedClaims.push(claim);
    }
  }
  return { references, failedClaims };
}

export async function repairHistoricalArtifactDelivery(
  messages: ChatMessage[]
): Promise<ChatMessage[]> {
  const artifactIds = new Set(
    collectCreatedArtifactClaims(messages).map((claim) => claim.id.toLowerCase())
  );
  const messagesByTurn = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    if (!message.turnId) continue;
    const turnMessages = messagesByTurn.get(message.turnId) ?? [];
    turnMessages.push(message);
    messagesByTurn.set(message.turnId, turnMessages);
  }
  const additionalIds = new Map<string, string[]>();
  const contentOverrides = new Map<string, string>();
  for (const turnMessages of messagesByTurn.values()) {
    const claims = collectCreatedArtifactClaims(turnMessages);
    const assistant = [...turnMessages].reverse().find((message) => message.role === 'assistant');
    if (!assistant) continue;
    if (claims.length === 0) {
      if (claimsCompletedBiologyArtifact(assistant.content)) {
        contentOverrides.set(assistant.id, appendUnverifiedArtifactMessage(assistant.content));
      }
      continue;
    }
    try {
      const linked = await getConnection().select<Array<{ reference_id: string }>>(
        'SELECT reference_id FROM message_references WHERE message_id = ? ORDER BY position',
        [assistant.id]
      );
      const existingIds = linked.map((row) => row.reference_id);
      const existing = await getEntityReferencesByIds(existingIds);
      const existingLocators = new Set(existing.map((reference) => reference.locator));
      const missing = claims.filter((claim) => !existingLocators.has(artifactLocator(claim)));
      const prepared = await prepareAgentArtifactDelivery(missing);
      const addedIds: string[] = [];
      for (const reference of prepared.references) {
        const created = await createEntityReference({
          entityType: reference.entity_type,
          displayLabel: reference.display_label,
          locator: reference.locator,
          deepLinkParams: null,
          data: reference.data ? (JSON.parse(reference.data) as Record<string, unknown>) : null,
          source: reference.source,
          workspaceScope: reference.workspace_scope ?? null,
          workspaceRootPath: reference.workspace_root_path ?? null,
        });
        await linkReferenceToMessage(
          assistant.id,
          created.id,
          existingIds.length + addedIds.length
        );
        addedIds.push(created.id);
      }
      if (addedIds.length > 0) additionalIds.set(assistant.id, [...existingIds, ...addedIds]);
      if (prepared.failedClaims.length > 0) {
        contentOverrides.set(assistant.id, appendUnverifiedArtifactMessage(assistant.content));
      }
    } catch (error) {
      console.warn('[ArtifactDelivery] Could not repair saved artifact references:', error);
      contentOverrides.set(assistant.id, appendUnverifiedArtifactMessage(assistant.content));
    }
  }
  return messages.map((message) => {
    const content =
      message.role === 'assistant'
        ? (contentOverrides.get(message.id) ??
          sanitizeAssistantArtifactMetadata(message.content, artifactIds))
        : message.content;
    const referenceIds = additionalIds.get(message.id);
    return content !== message.content || referenceIds
      ? { ...message, content, ...(referenceIds ? { referenceIds } : {}) }
      : message;
  });
}
