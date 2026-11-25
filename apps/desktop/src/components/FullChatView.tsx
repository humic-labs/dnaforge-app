import { CHAT_FIRST_INPUT } from '../lib/chat-first-input';
import {
  type UserMessage,
  renderUserMessage,
  renderUserMessagePayload,
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { AgentTraceRow } from './chat/AgentTraceActivity';
import { useHistoryPaneObservation } from './chat/useHistoryPaneObservation';
import { COMMAND_IDS, useCommandRegistry } from '../commands';
import { useCommandHandler } from '../commands/useCommandHandler';
import { AISettingsBoundary } from '../features/ai/AISettingsBoundary';
import { useWorkspaceVisibility } from '../features/canvas/workspace-visibility';

import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  memo,
} from 'react';
import {
  useChatStore,
  EMPTY_CONV_STATE,
  type ChatMessage,
  type ChatTurnSummary,
  type ContentBlock,
} from '../features/ai/hooks/useChat';
import { useChatRouteControls } from '../features/ai/hooks/useChatRouteControls';
import type { AssistantHostId } from '../features/ai/assistant-hosts';
import { decodeAgentActivityMessage } from '../features/ai/agent-activity-message';
import { isChatVisibleAgentTraceEvent } from '../features/ai/trace-display';
import { projectTraceItems } from '../features/ai/trace-view-projection';
import {
  serializeTextThreadMarkdown,
  serializeThreadMarkdown,
} from '../features/ai/export-thread-markdown';
import { platform } from '../platform';
import { safeFocus, scheduleFocus } from '../shared/utils/safeFocus';
import { usePresentationScope } from '../presentation/PresentationSurface';
import { findContainingPathBoundary, pathRelativeToBoundary } from '../shared/path-boundary';
import type {
  InlineReferenceTargetType,
  ResolveInlineReferenceTargetRequest,
  ResolveInlineReferenceTargetResult,
} from '../shared/inline-reference-ipc';
import {
  AGENT_ATTACHMENT_MAX_COUNT,
  AGENT_ATTACHMENT_MAX_TOTAL_BYTES,
} from '../shared/agent-attachments';
import {
  createEntityReference,
  getEntityReferencesByIds,
  setEntityReferenceWorkspaceRootPathIfMissing,
  type DBEntityReference,
} from '../db/entity-references';
import { getMessageReferences, getMessageReferencesForMessages } from '../db';
import { getCurrentWorkspaceScope, useWorkspaceStore } from '../stores/workspaceStore';
import { useCanvasStore } from '../features/canvas/store';
import { REF_TOKEN_PATTERN, isReferenceCreationTool } from '../features/ai/references/constants';
import { getFilename, stripDisplayExtension } from '../utils/fileTypes';
import { navigateToReference } from '../features/ai/references/navigate';
import { useToastStore } from '../stores/toast-store';
import { InlineAgentConfirmationHost } from '../features/ai/agent-confirm/InlineAgentConfirmation';
import {
  AgentActionsPalette,
  type AgentCapabilityChoice,
} from '../features/ai/agent-actions/AgentActionsPalette';

import { ChevronRightIcon, StopIcon } from './icons';
import {
  ChatPermissionPickers,
  CopyButton,
  CopyThreadButton,
  ThinkingLabel,
  StreamingCursor,
  FilePill,
  FormattedMessage,
  sanitizeAssistantArtifactMetadata,
  ToolResultDisplay,
  type AttachedFile,
} from './chat';
import {
  ReferenceChip,
  QueuedMessageStack,
  StructuredOutputCard,
  ChatEntityReferenceChip,
  ProjectResourceChatChip,
} from './chat/message-parts';
import { CHAT_COMPOSER_SURFACE_CLASS, formatChatTurnRouteLabel } from './chat/composer-controls';
import { ChatComposerToolbar } from './chat/ChatComposerToolbar';
import { EmptyStateChatComposer } from './chat/EmptyStateChatComposer';
import { ChatHistorySurface } from './chat/ChatHistorySurface';
import { extractMessageReferences } from '../features/ai/references/extract-message-references';
import {
  useComposerSequencePaste,
  useConversationComposerDraft,
} from './chat/useConversationComposerDraft';
import { useChatConversationOwnership } from './chat/useChatConversationOwnership';
import { useChatHistoryPinned } from '../features/ai/chat-history-pinning';
import {
  activateInlineReference,
  inlineReferenceActivationErrorMessage,
  inlinePathDeclarationFromReference,
  inlineWorkspaceDeclarationFromReference,
  type InlineReferenceActivationInput,
  type InlinePathDeclaration,
} from '../features/ai/references/inline/activate';
import {
  gitLocatorParts,
  resolveInlineReferenceOrigin,
} from '../features/ai/references/inline/origin';
import {
  bindPersistedMolecularDocumentReferences,
  projectPersistedInlineTextDocument,
} from '../features/ai/references/inline/document';
import {
  persistedWorkspaceTargetKey,
  persistedWorkspaceTargetResolutionKey,
  persistedWorkspaceTargetTypesEqual,
  resolvePersistedWorkspaceTargetTypes,
} from '../features/ai/references/inline/persisted-workspace-targets';
import type { InlineReferencePart } from '../features/ai/references/inline/types';
import { openProjectResourceReference } from '../services/notebook-resource-navigation';
import { entityIconKindForWorkspaceTarget } from './icons/entity-icon-registry';

const MAX_REFERENCE_LOAD_ATTEMPTS = 3;
const RESOLVED_REFERENCE_ROOT_CACHE_MAX_ENTRIES = 256;
const INLINE_REFERENCE_TARGET_TIMEOUT_MS = 15_000;
const INLINE_REFERENCE_ORIGIN_PERSISTENCE_TIMEOUT_MS = 15_000;

let holdNextReferenceTargetResolution = false;

function formatAgentCapabilityKind(kind: AgentCapabilityChoice['control']['kind']): string {
  return kind
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function holdNextFullChatViewReferenceTargetResolutionForTest(): void {
  if (holdNextReferenceTargetResolution) {
    throw new Error('A FullChatView target resolution is already held.');
  }
  holdNextReferenceTargetResolution = true;
}

interface ReferenceActivationOwner {
  activationId: string;
  ownerId: number;
  controller: AbortController;
  signal: AbortSignal;
}

function updateReferenceTargetResolutionDiagnostic(
  ownerId: number,
  phase: 'start' | 'complete' | 'abort'
): void {
  const owner = resolvedReferenceRootCacheOwners.get(ownerId);
  if (!owner) return;
  if (phase === 'start') {
    owner.targetResolutionsStarted += 1;
    owner.activeTargetResolutions += 1;
    return;
  }
  owner.activeTargetResolutions = Math.max(0, owner.activeTargetResolutions - 1);
  owner.completedTargetResolutions += phase === 'complete' ? 1 : 0;
  owner.abortedTargetResolutions += phase === 'abort' ? 1 : 0;
}

function resolveInlineReferenceTargetBounded(
  request: ResolveInlineReferenceTargetRequest,
  activation: ReferenceActivationOwner | null = null
): Promise<ResolveInlineReferenceTargetResult> {
  if (activation?.signal.aborted) {
    return Promise.resolve({ ok: false, code: 'target-unavailable' });
  }
  const rawResolution = platform().fs.resolveInlineReferenceTarget(request);
  if (activation) updateReferenceTargetResolutionDiagnostic(activation.ownerId, 'start');
  const holdDelivery = activation !== null && holdNextReferenceTargetResolution;
  if (holdDelivery) holdNextReferenceTargetResolution = false;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (
      result: ResolveInlineReferenceTargetResult,
      phase: 'complete' | 'abort'
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activation?.signal.removeEventListener('abort', abort);
      if (activation) updateReferenceTargetResolutionDiagnostic(activation.ownerId, phase);
      resolve(result);
    };
    const timeout = setTimeout(
      () => settle({ ok: false, code: 'target-unavailable' }, 'complete'),
      INLINE_REFERENCE_TARGET_TIMEOUT_MS
    );
    const abort = (): void => settle({ ok: false, code: 'target-unavailable' }, 'abort');
    activation?.signal.addEventListener('abort', abort, { once: true });
    if (activation?.signal.aborted) {
      abort();
      return;
    }
    void rawResolution.then(
      (result) => {
        if (!holdDelivery) settle(result, 'complete');
      },
      () => {
        if (!holdDelivery) settle({ ok: false, code: 'target-unavailable' }, 'complete');
      }
    );
  });
}

function updateReferenceEntityOpenDiagnostic(
  ownerId: number,
  operationId: string,
  phase: 'start' | 'complete' | 'abort'
): void {
  const owner = resolvedReferenceRootCacheOwners.get(ownerId);
  if (!owner) return;
  if (phase === 'start') {
    owner.entityOpensStarted += 1;
    owner.activeEntityOpens += 1;
    owner.activeEntityOpenOperationIds.push(operationId);
    return;
  }
  owner.activeEntityOpens = Math.max(0, owner.activeEntityOpens - 1);
  owner.activeEntityOpenOperationIds = owner.activeEntityOpenOperationIds.filter(
    (candidate) => candidate !== operationId
  );
  owner.completedEntityOpens += phase === 'complete' ? 1 : 0;
  owner.abortedEntityOpens += phase === 'abort' ? 1 : 0;
  if (phase === 'complete') owner.completedEntityOpenOperationIds = [operationId];
  else owner.abortedEntityOpenOperationIds = [operationId];
}

function trackReferenceEntityOpen<T>(
  activation: ReferenceActivationOwner,
  operation: () => Promise<T>
): Promise<T | null> {
  if (activation.signal.aborted) return Promise.resolve(null);
  updateReferenceEntityOpenDiagnostic(activation.ownerId, activation.activationId, 'start');
  let rawOperation: Promise<T>;
  try {
    rawOperation = operation();
  } catch (error) {
    updateReferenceEntityOpenDiagnostic(activation.ownerId, activation.activationId, 'complete');
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (phase: 'complete' | 'abort', callback: () => void): void => {
      if (settled) return;
      settled = true;
      activation.signal.removeEventListener('abort', abort);
      updateReferenceEntityOpenDiagnostic(activation.ownerId, activation.activationId, phase);
      callback();
    };
    const abort = (): void => settle('abort', () => resolve(null));
    activation.signal.addEventListener('abort', abort, { once: true });
    if (activation.signal.aborted) {
      abort();
      return;
    }
    rawOperation.then(
      (value) => settle('complete', () => resolve(value)),
      (error: unknown) => settle('complete', () => reject(error))
    );
  });
}

async function openSavedEntityBesideChat(
  tabType: 'sequence' | 'structure',
  entityId: string | null,
  sourceConversationId: string | null,
  signal: AbortSignal,
  open: (
    strategy: { kind: 'focused' } | { kind: 'panel'; panelId: string }
  ) => Promise<string | null>
): Promise<string | null> {
  if (signal.aborted) return null;
  const canvas = useCanvasStore.getState();
  const chatPanel = sourceConversationId ? canvas.findTab('chat', sourceConversationId) : null;
  if (!chatPanel) {
    const openedTabId = await open({ kind: 'focused' });
    return signal.aborted ? null : openedTabId;
  }

  const existing = entityId ? canvas.findTab(tabType, entityId) : null;
  if (existing) {
    if (signal.aborted) return null;
    const placement = canvas.agentContentPlacement(chatPanel.panelId);
    if (existing.panelId !== placement.targetPanelId) {
      canvas.moveTab(existing.panelId, placement.targetPanelId, existing.tabId);
    }
    const current = useCanvasStore.getState();
    current.setActiveTab(placement.targetPanelId, existing.tabId);
    current.focusPanel(placement.workingPanelId);
    return existing.tabId;
  }

  const openedTabId = await open({ kind: 'panel', panelId: chatPanel.panelId });
  if (!openedTabId || signal.aborted) return null;

  const current = useCanvasStore.getState();
  const openedPanelId = Object.values(current.panels).find((panel) =>
    panel.tabs.some((tab) => tab.id === openedTabId)
  )?.id;
  const currentChatPanel = sourceConversationId
    ? current.findTab('chat', sourceConversationId)
    : null;
  if (!openedPanelId || !currentChatPanel) return openedTabId;

  const placement = current.agentContentPlacement(currentChatPanel.panelId);
  if (openedPanelId !== placement.targetPanelId) {
    current.moveTab(openedPanelId, placement.targetPanelId, openedTabId);
  }
  const placed = useCanvasStore
    .getState()
    .panels[placement.targetPanelId]?.tabs.some((tab) => tab.id === openedTabId);
  if (!placed) {
    const afterMove = useCanvasStore.getState();
    if (placement.createdPanelId && afterMove.panels[placement.createdPanelId]?.tabs.length === 0) {
      afterMove.closePanel(placement.createdPanelId);
    }
    return null;
  }
  current.setActiveTab(placement.targetPanelId, openedTabId);
  current.focusPanel(placement.workingPanelId);
  return openedTabId;
}

async function resolveSequencePackageProductForReference(packageRoot: string): Promise<string> {
  const { resolveSequencePackageProductPath } =
    await import('../features/sequence/sequence-package-product');
  return resolveSequencePackageProductPath(packageRoot);
}

function openSequenceReference(
  input: { sourcePath: string; label: string },
  sourceConversationId: string | null,
  activation: ReferenceActivationOwner
): Promise<{ tabId: string; documentId: string } | null> {
  return trackReferenceEntityOpen(activation, async () => {
    const { openSequenceFile } = await import('../features/document-opening/compat');
    if (activation.signal.aborted) return null;
    const tabId = await openSequenceFile({
      filePath: input.sourcePath,
      label: input.label,
      strategy: { kind: 'smart' },
      signal: activation.signal,
    });
    if (!tabId || activation.signal.aborted) return null;
    const tab = Object.values(useCanvasStore.getState().panels)
      .flatMap((panel) => panel.tabs)
      .find((candidate) => candidate.id === tabId && candidate.type === 'sequence');
    if (!tab) return null;
    const placedTabId = await openSavedEntityBesideChat(
      'sequence',
      tab.entityId,
      sourceConversationId,
      activation.signal,
      async () => tabId
    );
    return placedTabId ? { tabId: placedTabId, documentId: tab.entityId } : null;
  });
}

function openStructureReference(
  input: { filePath: string; label: string },
  sourceConversationId: string | null,
  activation: ReferenceActivationOwner
): Promise<string | null> {
  return trackReferenceEntityOpen(activation, async () => {
    const { openStructureFile } = await import('../features/document-opening/compat');
    if (activation.signal.aborted) return null;
    return openSavedEntityBesideChat(
      'structure',
      null,
      sourceConversationId,
      activation.signal,
      (strategy) =>
        openStructureFile({
          ...input,
          strategy,
          signal: activation.signal,
          operationId: activation.activationId,
        })
    );
  });
}

interface ResolvedReferenceRootCacheEvent {
  kind: 'insert' | 'hit';
  evictions: number;
  size: number;
}

interface ResolvedReferenceRootCacheOwnerDiagnostic {
  ownerId: number;
  mounted: boolean;
  size: number;
  insertions: number;
  hits: number;
  evictions: number;
  peakSize: number;
  startedActivations: number;
  activeActivations: number;
  completedActivations: number;
  successfulActivations: number;
  failedActivations: number;
  activationProtocolErrors: number;
  targetResolutionsStarted: number;
  activeTargetResolutions: number;
  completedTargetResolutions: number;
  abortedTargetResolutions: number;
  entityOpensStarted: number;
  activeEntityOpens: number;
  completedEntityOpens: number;
  abortedEntityOpens: number;
  activeEntityOpenOperationIds: string[];
  completedEntityOpenOperationIds: string[];
  abortedEntityOpenOperationIds: string[];
  originPersistencesStarted: number;
  activeOriginPersistences: number;
  completedOriginPersistences: number;
  abortedOriginPersistences: number;
}

const resolvedReferenceRootCacheOwners = new Map<
  number,
  ResolvedReferenceRootCacheOwnerDiagnostic
>();
let nextResolvedReferenceRootCacheOwnerId = 0;
let lastReleasedReferenceRootCacheOwner: ResolvedReferenceRootCacheOwnerDiagnostic | null = null;

function cloneReferenceRootCacheOwnerDiagnostic(
  owner: ResolvedReferenceRootCacheOwnerDiagnostic
): ResolvedReferenceRootCacheOwnerDiagnostic {
  return {
    ...owner,
    activeEntityOpenOperationIds: [...owner.activeEntityOpenOperationIds],
    completedEntityOpenOperationIds: [...owner.completedEntityOpenOperationIds],
    abortedEntityOpenOperationIds: [...owner.abortedEntityOpenOperationIds],
  };
}

export function getFullChatViewReferenceRootCacheDiagnostics(): {
  activeOwners: number;
  totalSize: number;
  insertions: number;
  hits: number;
  evictions: number;
  peakSize: number;
  startedActivations: number;
  activeActivations: number;
  completedActivations: number;
  successfulActivations: number;
  failedActivations: number;
  activationProtocolErrors: number;
  targetResolutionsStarted: number;
  activeTargetResolutions: number;
  completedTargetResolutions: number;
  abortedTargetResolutions: number;
  entityOpensStarted: number;
  activeEntityOpens: number;
  completedEntityOpens: number;
  abortedEntityOpens: number;
  originPersistencesStarted: number;
  activeOriginPersistences: number;
  completedOriginPersistences: number;
  abortedOriginPersistences: number;
  owners: ResolvedReferenceRootCacheOwnerDiagnostic[];
  lastReleasedOwner: ResolvedReferenceRootCacheOwnerDiagnostic | null;
} {
  const diagnostics = {
    activeOwners: resolvedReferenceRootCacheOwners.size,
    totalSize: 0,
    insertions: 0,
    hits: 0,
    evictions: 0,
    peakSize: 0,
    startedActivations: 0,
    activeActivations: 0,
    completedActivations: 0,
    successfulActivations: 0,
    failedActivations: 0,
    activationProtocolErrors: 0,
    targetResolutionsStarted: 0,
    activeTargetResolutions: 0,
    completedTargetResolutions: 0,
    abortedTargetResolutions: 0,
    entityOpensStarted: 0,
    activeEntityOpens: 0,
    completedEntityOpens: 0,
    abortedEntityOpens: 0,
    originPersistencesStarted: 0,
    activeOriginPersistences: 0,
    completedOriginPersistences: 0,
    abortedOriginPersistences: 0,
    owners: [] as ResolvedReferenceRootCacheOwnerDiagnostic[],
    lastReleasedOwner: lastReleasedReferenceRootCacheOwner
      ? cloneReferenceRootCacheOwnerDiagnostic(lastReleasedReferenceRootCacheOwner)
      : null,
  };
  for (const owner of resolvedReferenceRootCacheOwners.values()) {
    diagnostics.totalSize += owner.size;
    diagnostics.insertions += owner.insertions;
    diagnostics.hits += owner.hits;
    diagnostics.evictions += owner.evictions;
    diagnostics.peakSize = Math.max(diagnostics.peakSize, owner.peakSize);
    diagnostics.startedActivations += owner.startedActivations;
    diagnostics.activeActivations += owner.activeActivations;
    diagnostics.completedActivations += owner.completedActivations;
    diagnostics.successfulActivations += owner.successfulActivations;
    diagnostics.failedActivations += owner.failedActivations;
    diagnostics.activationProtocolErrors += owner.activationProtocolErrors;
    diagnostics.targetResolutionsStarted += owner.targetResolutionsStarted;
    diagnostics.activeTargetResolutions += owner.activeTargetResolutions;
    diagnostics.completedTargetResolutions += owner.completedTargetResolutions;
    diagnostics.abortedTargetResolutions += owner.abortedTargetResolutions;
    diagnostics.entityOpensStarted += owner.entityOpensStarted;
    diagnostics.activeEntityOpens += owner.activeEntityOpens;
    diagnostics.completedEntityOpens += owner.completedEntityOpens;
    diagnostics.abortedEntityOpens += owner.abortedEntityOpens;
    diagnostics.originPersistencesStarted += owner.originPersistencesStarted;
    diagnostics.activeOriginPersistences += owner.activeOriginPersistences;
    diagnostics.completedOriginPersistences += owner.completedOriginPersistences;
    diagnostics.abortedOriginPersistences += owner.abortedOriginPersistences;
    diagnostics.owners.push(cloneReferenceRootCacheOwnerDiagnostic(owner));
  }
  return diagnostics;
}

export function registerResolvedReferenceRootCacheOwner(): number {
  const ownerId = ++nextResolvedReferenceRootCacheOwnerId;
  resolvedReferenceRootCacheOwners.set(ownerId, {
    ownerId,
    mounted: true,
    size: 0,
    insertions: 0,
    hits: 0,
    evictions: 0,
    peakSize: 0,
    startedActivations: 0,
    activeActivations: 0,
    completedActivations: 0,
    successfulActivations: 0,
    failedActivations: 0,
    activationProtocolErrors: 0,
    targetResolutionsStarted: 0,
    activeTargetResolutions: 0,
    completedTargetResolutions: 0,
    abortedTargetResolutions: 0,
    entityOpensStarted: 0,
    activeEntityOpens: 0,
    completedEntityOpens: 0,
    abortedEntityOpens: 0,
    activeEntityOpenOperationIds: [],
    completedEntityOpenOperationIds: [],
    abortedEntityOpenOperationIds: [],
    originPersistencesStarted: 0,
    activeOriginPersistences: 0,
    completedOriginPersistences: 0,
    abortedOriginPersistences: 0,
  });
  return ownerId;
}

export function beginResolvedReferenceRootActivation(ownerId: number): void {
  const owner = resolvedReferenceRootCacheOwners.get(ownerId);
  if (!owner) return;
  owner.startedActivations += 1;
  owner.activeActivations += 1;
}

export function completeResolvedReferenceRootActivation(ownerId: number, succeeded: boolean): void {
  const owner = resolvedReferenceRootCacheOwners.get(ownerId);
  if (!owner) return;
  if (owner.activeActivations <= 0) {
    owner.activationProtocolErrors += 1;
    return;
  }
  owner.activeActivations -= 1;
  owner.completedActivations += 1;
  owner.successfulActivations += succeeded ? 1 : 0;
  owner.failedActivations += succeeded ? 0 : 1;
  if (!owner.mounted && owner.activeActivations === 0) {
    lastReleasedReferenceRootCacheOwner = cloneReferenceRootCacheOwnerDiagnostic(owner);
    resolvedReferenceRootCacheOwners.delete(ownerId);
  }
}

export function releaseResolvedReferenceRootCacheOwner(ownerId: number): void {
  const owner = resolvedReferenceRootCacheOwners.get(ownerId);
  if (!owner) return;
  owner.mounted = false;
  owner.size = 0;
  if (owner.activeActivations === 0) {
    lastReleasedReferenceRootCacheOwner = cloneReferenceRootCacheOwnerDiagnostic(owner);
    resolvedReferenceRootCacheOwners.delete(ownerId);
  }
}

export function resetFullChatViewReferenceRootCacheDiagnosticsForTest(): void {
  resolvedReferenceRootCacheOwners.clear();
  nextResolvedReferenceRootCacheOwnerId = 0;
  lastReleasedReferenceRootCacheOwner = null;
  holdNextReferenceTargetResolution = false;
}

function persistReferenceOriginBounded(
  referenceId: string,
  rootPath: string,
  activation: ReferenceActivationOwner
): Promise<string | null> {
  if (activation.signal.aborted) return Promise.resolve(null);
  const owner = resolvedReferenceRootCacheOwners.get(activation.ownerId);
  if (owner) {
    owner.originPersistencesStarted += 1;
    owner.activeOriginPersistences += 1;
  }
  const rawPersistence = setEntityReferenceWorkspaceRootPathIfMissing(referenceId, rootPath);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (winner: string | null, phase: 'complete' | 'abort'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activation.signal.removeEventListener('abort', abort);
      const currentOwner = resolvedReferenceRootCacheOwners.get(activation.ownerId);
      if (currentOwner) {
        currentOwner.activeOriginPersistences = Math.max(
          0,
          currentOwner.activeOriginPersistences - 1
        );
        currentOwner.completedOriginPersistences += phase === 'complete' ? 1 : 0;
        currentOwner.abortedOriginPersistences += phase === 'abort' ? 1 : 0;
      }
      resolve(winner);
    };
    const timeout = setTimeout(
      () => settle(null, 'complete'),
      INLINE_REFERENCE_ORIGIN_PERSISTENCE_TIMEOUT_MS
    );
    const abort = (): void => settle(null, 'abort');
    activation.signal.addEventListener('abort', abort, { once: true });
    if (activation.signal.aborted) {
      abort();
      return;
    }
    void rawPersistence.then(
      (winner) => settle(winner, 'complete'),
      () => settle(null, 'complete')
    );
  });
}

export function rememberResolvedReferenceRoot(
  cache: Map<string, string>,
  referenceId: string,
  rootPath: string,
  onCacheEvent?: (event: ResolvedReferenceRootCacheEvent) => void
): void {
  const kind = cache.has(referenceId) ? 'hit' : 'insert';
  cache.delete(referenceId);
  cache.set(referenceId, rootPath);
  let evictions = 0;
  while (cache.size > RESOLVED_REFERENCE_ROOT_CACHE_MAX_ENTRIES) {
    const oldestReferenceId = cache.keys().next().value;
    if (oldestReferenceId === undefined) break;
    cache.delete(oldestReferenceId);
    evictions += 1;
  }
  onCacheEvent?.({ kind, evictions, size: cache.size });
}

interface CollapsedTraceGroup {
  key: string;
  finalAssistantId: string;
  messages: Array<{ message: ChatMessage; index: number }>;
}

interface TraceScope {
  key: string;
  indices: number[];
  turnId: string | null;
}

function isVisibleNonUserMessage(msg: ChatMessage): boolean {
  if (msg.role === 'user') return false;
  if (msg.role !== 'activity') return true;
  const event = decodeAgentActivityMessage(msg.content);
  return Boolean(event && isChatVisibleAgentTraceEvent(event));
}

function isVisibleActivityMessage(msg: ChatMessage): boolean {
  if (msg.role === 'activity') {
    const event = decodeAgentActivityMessage(msg.content);
    return Boolean(event && isChatVisibleAgentTraceEvent(event));
  }
  return false;
}

function isCollapsiblePreAnswerProcessMessage(msg: ChatMessage): boolean {
  if (msg.role === 'assistant') return true;
  if (msg.role === 'activity') return isVisibleActivityMessage(msg);
  if (msg.role === 'tool') return !isReferenceCreationTool(msg.toolName);
  return false;
}

function TurnAttribution({
  turn,
  verb = 'Answered with',
}: {
  turn: ChatTurnSummary;
  verb?: string;
}) {
  return (
    <div
      className="mb-1.5 text-[11px] font-medium leading-4 text-fg-subtle"
      data-testid="chat-turn-attribution"
      title={`${verb} ${formatChatTurnRouteLabel(turn)}`}
    >
      {verb} {formatChatTurnRouteLabel(turn)}
    </div>
  );
}

interface StreamingSectionProps {
  messagesScrollRef: React.RefObject<HTMLDivElement>;
  referenceMap: Map<string, DBEntityReference>;
  onReferenceClick: (ref: DBEntityReference, options?: { snapshotIndex: number }) => void;
  onReferenceReveal: (ref: DBEntityReference) => void;
  renderInlineReference: (part: InlineReferencePart) => React.ReactNode;
  stopGeneration: () => void;
  isStreaming: boolean;
  activeTurn: ChatTurnSummary | null;

  streamingBlocksOverride?: ContentBlock[];
}

function completedReferenceToolInput(message: ChatMessage): unknown {
  try {
    const payload = JSON.parse(message.content) as { input?: unknown };
    return payload.input ?? {};
  } catch {
    return {};
  }
}

const StreamingSection = memo(function StreamingSection({
  messagesScrollRef,
  referenceMap,
  onReferenceClick,
  onReferenceReveal,
  renderInlineReference,
  stopGeneration,
  isStreaming,
  activeTurn,
  streamingBlocksOverride,
}: StreamingSectionProps) {
  const topStreamingBlocks = useChatStore((s) => s.streamingBlocks);
  const streamingBlocks = streamingBlocksOverride ?? topStreamingBlocks;
  const projectedStreamingBlocks = useMemo(
    () =>
      projectTraceItems(
        streamingBlocks,
        (block) => (block.type === 'trace' ? block.event : null),
        (block, index) => {
          if (block.type === 'text' || block.type === 'assistant_text') {
            return block.id || `${block.type}:${index}`;
          }
          if (block.type === 'ref' || block.type === 'tool') return block.message.id;
          return block.event.providerItemId
            ? `trace:${block.event.transport}:${block.event.providerItemId}`
            : `trace:sequence:${block.event.sequence}:${index}`;
        },
        (block) => (block.type === 'tool' ? (block.message.toolCallId ?? null) : null)
      ),
    [streamingBlocks]
  );

  useEffect(() => {
    if (isStreaming && streamingBlocks.length > 0) {
      const scrollArea = messagesScrollRef.current;
      if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
    }
  }, [streamingBlocks, isStreaming, messagesScrollRef]);

  if (!isStreaming || streamingBlocks.length === 0) return null;

  return (
    <>
      {activeTurn && <TurnAttribution turn={activeTurn} verb="Answering with" />}
      {projectedStreamingBlocks.map((projectedBlock, i) => {
        const block = projectedBlock.source;
        if (block.type === 'text' || block.type === 'assistant_text') {
          const isLast = i === projectedStreamingBlocks.length - 1;
          return (
            <div key={projectedBlock.key} className="relative group/stream">
              <div className="text-sm text-fg leading-relaxed inline-block max-w-full">
                <FormattedMessage
                  content={block.content}
                  streaming
                  references={referenceMap}
                  onReferenceClick={onReferenceClick}
                  onReferenceReveal={onReferenceReveal}
                  document={block.document}
                  renderInlineReference={renderInlineReference}
                />
                {isLast && <StreamingCursor />}
              </div>
            </div>
          );
        }
        if (block.type === 'ref') {
          return (
            <ReferenceChip
              key={projectedBlock.key}
              reference={block.reference}
              onClick={onReferenceClick}
              onReveal={onReferenceReveal}
              completedToolInput={completedReferenceToolInput(block.message)}
            />
          );
        }
        if (block.type === 'trace') {
          const event = projectedBlock.event ?? block.event;
          if (!isChatVisibleAgentTraceEvent(event)) return null;
          return <AgentTraceRow key={projectedBlock.key} event={event} />;
        }
        return (
          <div key={projectedBlock.key} className="mt-2 mb-2">
            <ToolResultDisplay
              toolName={block.message.toolName || 'tool'}
              content={block.message.content}
            />
          </div>
        );
      })}
      <button
        onClick={stopGeneration}
        className="mt-2 flex items-center gap-1.5 px-2 py-1 rounded border border-border bg-bg wp-interactive text-fg-muted text-xs transition-colors"
        title="Pause agent (Escape)"
        data-testid="ai-stop-button"
      >
        <StopIcon size={10} />
        <span>Pause</span>
      </button>
    </>
  );
});

interface FullChatViewProps {
  workspacePath: string | null;
  conversationId?: string;
  onOpenAssistantSources?: () => void;
  onConfigureHost?: (hostId: AssistantHostId) => void;
  onConversationIdChange?: (conversationId: string) => void;

  hideHeader?: boolean;

  hideInput?: boolean;

  onClose?: () => void;

  isOpen?: boolean;

  isVisible?: boolean;

  scoped?: boolean;

  onRequestPanelFocus?: () => void;

  onHistoryPinnedChange?: (pinned: boolean) => void;
}
export function FullChatView(props: FullChatViewProps) {
  return (
    <AISettingsBoundary>
      <InitializedChatView {...props} />
    </AISettingsBoundary>
  );
}

function InitializedChatView({
  workspacePath,
  conversationId,
  onOpenAssistantSources,
  onConfigureHost,
  onConversationIdChange,
  hideHeader = false,
  hideInput = false,
  isOpen: requestedOpen = true,
  isVisible,
  scoped = false,
  onRequestPanelFocus,
  onHistoryPinnedChange,
}: FullChatViewProps) {
  const chatFirst = CHAT_FIRST_INPUT && !hideHeader && !scoped;
  const workspaceVisible = useWorkspaceVisibility();
  const isOpen = requestedOpen && workspaceVisible;
  const isChatVisible = (isVisible ?? requestedOpen) && workspaceVisible;
  const navigateConversation = (direction: -1 | 1) => {
    const chat = useChatStore.getState();
    const index = chat.conversations.findIndex(
      (conversation) => conversation.id === chat.currentConversationId
    );
    const next = chat.conversations[index + direction];
    if (!next) return false;
    void chat.switchConversation(next.id);
    return true;
  };
  useCommandHandler(COMMAND_IDS.chatPrevious, () => navigateConversation(-1), { active: isOpen });
  useCommandHandler(COMMAND_IDS.chatNext, () => navigateConversation(1), { active: isOpen });

  const [input, setInput] = useState('');
  const [preStartError, setPreStartError] = useState<UserMessage | null>(null);
  const [showHistory, setShowHistory] = useChatHistoryPinned(isChatVisible);
  const [dropZoneElement, setDropZoneElement] = useState<HTMLDivElement | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [agentActionsOpen, setAgentActionsOpen] = useState(false);
  const [stagedCapability, setStagedCapability] = useState<AgentCapabilityChoice | null>(null);
  const liveComposerRef = useRef({
    input: '',
    attachedFiles: [] as AttachedFile[],
    composeReferences: [] as DBEntityReference[],
    stagedCapability: null as AgentCapabilityChoice | null,
  });
  const attachmentCaptureQueueRef = useRef<Promise<void>>(Promise.resolve());
  const sendAttemptRef = useRef(0);
  const latestSendAttemptByConversationRef = useRef<Map<string | null, number>>(new Map());
  const sendOwnerConversationRef = useRef<string | null | undefined>(undefined);
  const [expandedTraceGroups, setExpandedTraceGroups] = useState<Set<string>>(() => new Set());
  const presentation = usePresentationScope();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const workspaceFolders = useWorkspaceStore((state) => state.folders);
  const { dispatchCommand } = useCommandRegistry();
  const previousQueuedIdsRef = useRef<Set<string>>(new Set());
  const queuedMessageRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const queuedMessageElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const userMessageElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const promotedMessageIdsRef = useRef<Set<string>>(new Set());
  const promotionTimersRef = useRef<Map<string, number>>(new Map());
  const [animatingPromotionIds, setAnimatingPromotionIds] = useState<Set<string>>(() => new Set());

  const {
    messages: storeMessages,
    turns: storeTurns,
    activeTurnId: storeActiveTurnId,
    conversations,
    currentConversationId,
    isLoading: storeIsLoading,
    isStreaming: storeIsStreaming,
    error: storeError,
    queuedMessages: storeQueuedMessages,
    sendMessage,
    advanceQueueThrough,
    setError,
    switchConversation,
    hydrateConversation,
    stopGeneration,
    loadConversations,
    setComposerDraft,
    composerDrafts,
  } = useChatStore();

  const boundConversationState = useChatStore((state) =>
    conversationId ? (state._convStates.get(conversationId) ?? null) : null
  );
  const conversationIsKnown = Boolean(
    conversationId &&
    (boundConversationState ||
      conversations.some((conversation) => conversation.id === conversationId))
  );

  const viewConversationId = scoped
    ? (conversationId ?? null)
    : (conversationId ?? currentConversationId ?? null);
  const persistedViewConversation = viewConversationId
    ? conversations.find((conversation) => conversation.id === viewConversationId)
    : undefined;
  const draftWorkspacePath = viewConversationId
    ? composerDrafts.get(viewConversationId)?.workspacePath
    : undefined;
  const conversationWorkspacePath = persistedViewConversation
    ? persistedViewConversation.workspacePath
    : chatFirst && draftWorkspacePath !== undefined
      ? draftWorkspacePath
      : workspacePath;
  const conversationProject = workspaceFolders.find(
    (folder) => folder.path === conversationWorkspacePath
  );
  const conversationProjectName =
    conversationProject?.name ??
    (conversationWorkspacePath ? getFilename(conversationWorkspacePath) : null);
  if (sendOwnerConversationRef.current !== viewConversationId) {
    sendOwnerConversationRef.current = viewConversationId;
    sendAttemptRef.current += 1;
  }

  const storedViewConvState = useChatStore((s) =>
    viewConversationId === conversationId
      ? boundConversationState
      : viewConversationId
        ? (s._convStates.get(viewConversationId) ?? null)
        : null
  );
  const needsIsolatedFallback = Boolean(
    viewConversationId &&
    (scoped || !isOpen || (currentConversationId && viewConversationId !== currentConversationId))
  );
  const viewConvState = storedViewConvState ?? (needsIsolatedFallback ? EMPTY_CONV_STATE : null);
  const messages = viewConvState ? viewConvState.messages : storeMessages;
  const turns = viewConvState ? viewConvState.turns : storeTurns;
  const activeTurnId = viewConvState ? viewConvState.activeTurnId : storeActiveTurnId;
  const isLoading = viewConvState ? viewConvState.isLoading : storeIsLoading;
  const isStreaming = viewConvState ? viewConvState.isStreaming : storeIsStreaming;
  const error: UserMessage | null =
    preStartError ?? (viewConvState ? viewConvState.error : storeError);
  const queuedMessages =
    (viewConvState ? viewConvState.queuedMessages : storeQueuedMessages) ??
    EMPTY_CONV_STATE.queuedMessages;
  const viewStreamingBlocks = viewConvState ? viewConvState.streamingBlocks : undefined;

  const handleAdvanceQueueThrough = useCallback(
    (targetMessageId: string) => {
      advanceQueueThrough(targetMessageId, viewConversationId);
      safeFocus(inputRef.current);
    },
    [advanceQueueThrough, viewConversationId]
  );

  const handleQueuedMessageElementChange = useCallback(
    (messageId: string, element: HTMLDivElement | null) => {
      if (element) {
        queuedMessageElementsRef.current.set(messageId, element);
        return;
      }
      const previous = queuedMessageElementsRef.current.get(messageId);
      if (previous) {
        queuedMessageRectsRef.current.set(messageId, previous.getBoundingClientRect());
      }
      queuedMessageElementsRef.current.delete(messageId);
    },
    []
  );

  const hasStreamingContentTop = useChatStore((s) => s.streamingBlocks.length > 0);
  const hasStreamingContent = viewConvState
    ? viewConvState.streamingBlocks.length > 0
    : hasStreamingContentTop;
  const isThinking = isLoading && !hasStreamingContent;

  useEffect(() => {
    void loadConversations().catch(() => undefined);
  }, [loadConversations]);

  const historyObservation = useHistoryPaneObservation({
    conversationId: viewConversationId,
    known: conversationIsKnown,
    hasState: storedViewConvState !== null,
    isOpen,
    scoped,
    switchConversation,
    hydrateConversation,
    onConversationIdChange,
  });
  useChatConversationOwnership({
    scoped,
    isOpen,
    conversationId,
    currentConversationId,
    conversationIsKnown,
    conversationHasState: boundConversationState !== null,
    switchConversation: historyObservation.switchForOwnership,
    hydrateConversation: historyObservation.hydrateForOwnership,
  });

  useLayoutEffect(() => {
    const scrollArea = messagesScrollRef.current;
    if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
  }, [messages, queuedMessages]);

  useEffect(() => {
    if (isOpen) {
      const lease = presentation.owner.captureFocus(presentation.id);
      const timer = setTimeout(() => {
        if (!presentation.owner.isCurrent(lease)) return;
        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl && activeEl !== document.body && activeEl !== inputRef.current) return;
        safeFocus(inputRef.current);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [isOpen, presentation]);

  useEffect(() => {
    setPreStartError(null);
  }, [conversationId]);

  const pendingMessage = useChatStore((s) => s.pendingMessage);
  const clearPending = useChatStore((s) => s.setPendingMessage);

  const pendingDraft = useChatStore((s) => s.pendingDraft);
  const clearPendingDraft = useChatStore((s) => s.setPendingDraft);
  const pendingDraftFocusFrameRef = useRef<number | null>(null);
  const pendingDraftFocusTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (pendingMessage && isOpen) {
      if (pendingMessage.conversationId && pendingMessage.conversationId !== viewConversationId) {
        return;
      }
      const consumed = pendingMessage;
      clearPending(null);
      setPreStartError(null);
      void sendMessage(
        consumed.content,
        conversationWorkspacePath,
        viewConversationId ?? undefined,
        undefined,
        {
          claimIfUnowned: isOpen && !scoped,
          activateConversation: isOpen && !scoped,
          onNotStarted: setPreStartError,
        }
      )
        .then((disposition) => {
          if (disposition === 'rejected') {
            setInput((current) => current || consumed.content);
          }
        })
        .catch(() => {
          setInput((current) => current || consumed.content);
        });
    }
  }, [
    pendingMessage,
    isOpen,
    conversationWorkspacePath,
    viewConversationId,
    scoped,
    sendMessage,
    clearPending,
  ]);

  const [referenceMap, setReferenceMap] = useState<Map<string, DBEntityReference>>(new Map());

  const [messageReferenceIds, setMessageReferenceIds] = useState<Map<string, string[]>>(new Map());
  const [referenceResolution, setReferenceResolution] = useState<
    Map<string, 'loading' | 'resolved' | 'absent' | 'unavailable'>
  >(new Map());
  const [entityReferenceLoadFailures, setEntityReferenceLoadFailures] = useState<
    Map<string, number>
  >(new Map());

  const [referenceLoadFailures, setReferenceLoadFailures] = useState<Map<string, number>>(
    new Map()
  );
  const referenceConversationIdRef = useRef(viewConversationId);

  useEffect(() => {
    if (referenceConversationIdRef.current === viewConversationId) return;
    referenceConversationIdRef.current = viewConversationId;
    setReferenceMap(new Map());
    setMessageReferenceIds(new Map());
    setReferenceResolution(new Map());
    setEntityReferenceLoadFailures(new Map());
    setReferenceLoadFailures(new Map());
    setExpandedTraceGroups(new Set());
  }, [viewConversationId]);

  const visibleQueuedMessages = useMemo(
    () => queuedMessages.filter((message) => !message.displayInThreadWhilePending),
    [queuedMessages]
  );
  const displayMessages = useMemo<ChatMessage[]>(() => {
    const pendingDirect = queuedMessages.find(
      (message) =>
        message.displayInThreadWhilePending &&
        !messages.some((persisted) => persisted.id === message.id)
    );
    return pendingDirect
      ? [
          ...messages,
          {
            id: pendingDirect.id,
            role: 'user',
            content: pendingDirect.content,
            createdAt: pendingDirect.createdAt,
            attachments: pendingDirect.attachments,
          },
        ]
      : messages;
  }, [messages, queuedMessages]);
  const attributionMessageIds = useMemo(() => {
    const attributedTurns = new Set<string>();
    const firstVisibleMessages = new Set<string>();
    for (const message of displayMessages) {
      if (!message.turnId || !isVisibleNonUserMessage(message)) continue;
      if (!attributedTurns.has(message.turnId)) {
        attributedTurns.add(message.turnId);
        firstVisibleMessages.add(message.id);
      }
    }
    return firstVisibleMessages;
  }, [displayMessages]);

  const inlineDocumentsByMessageId = useMemo(() => {
    const documents = new Map<string, ReturnType<typeof projectPersistedInlineTextDocument>>();
    for (const message of displayMessages) {
      if (message.role !== 'assistant') continue;
      if (message.document) {
        documents.set(
          message.id,
          bindPersistedMolecularDocumentReferences(
            message.document,
            messageReferenceIds.get(message.id) ?? [],
            referenceMap
          )
        );
        continue;
      }
      if (!message.content.includes('dnaforge-chat://')) continue;
      documents.set(
        message.id,
        projectPersistedInlineTextDocument(
          message.content,
          messageReferenceIds.get(message.id) ?? [],
          referenceMap
        )
      );
    }
    return documents;
  }, [displayMessages, messageReferenceIds, referenceMap]);

  const [persistedWorkspaceTargetTypes, setPersistedWorkspaceTargetTypes] = useState(
    new Map<string, InlineReferenceTargetType>()
  );

  const persistedWorkspaceResolutionKey = persistedWorkspaceTargetResolutionKey(
    inlineDocumentsByMessageId.values(),
    workspaceFolders
  );
  const persistedWorkspaceResolutionInputRef = useRef({
    documents: inlineDocumentsByMessageId,
    roots: workspaceFolders,
  });
  persistedWorkspaceResolutionInputRef.current = {
    documents: inlineDocumentsByMessageId,
    roots: workspaceFolders,
  };

  useEffect(() => {
    if (persistedWorkspaceResolutionKey === '[]') {
      setPersistedWorkspaceTargetTypes((current) =>
        current.size === 0 ? current : new Map<string, InlineReferenceTargetType>()
      );
      return;
    }

    let canceled = false;
    const { documents, roots } = persistedWorkspaceResolutionInputRef.current;
    void resolvePersistedWorkspaceTargetTypes(
      documents.values(),
      roots,
      resolveInlineReferenceTargetBounded
    ).then((targetTypes) => {
      if (!canceled) {
        setPersistedWorkspaceTargetTypes((current) =>
          persistedWorkspaceTargetTypesEqual(current, targetTypes) ? current : targetTypes
        );
      }
    });
    return () => {
      canceled = true;
    };
  }, [persistedWorkspaceResolutionKey]);

  useLayoutEffect(() => {
    const previouslyQueued = previousQueuedIdsRef.current;
    const newlyPromoted = displayMessages.filter(
      (message) => message.role === 'user' && previouslyQueued.has(message.id)
    );

    if (newlyPromoted.length > 0) {
      setAnimatingPromotionIds((current) => {
        const next = new Set(current);
        newlyPromoted.forEach((message) => next.add(message.id));
        return next;
      });

      const reduceMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      newlyPromoted.forEach((message) => {
        promotedMessageIdsRef.current.add(message.id);
        const source = queuedMessageRectsRef.current.get(message.id);
        const target = userMessageElementsRef.current.get(message.id);
        if (source && target && !reduceMotion && typeof target.animate === 'function') {
          const destination = target.getBoundingClientRect();
          if (destination.width > 0 && destination.height > 0) {
            target.animate(
              [
                {
                  transform: `translate(${source.left - destination.left}px, ${source.top - destination.top}px) scale(${source.width / destination.width}, ${source.height / destination.height})`,
                  transformOrigin: 'top left',
                  opacity: 0.88,
                },
                {
                  transform: 'translate(0, 0) scale(1, 1)',
                  transformOrigin: 'top left',
                  opacity: 1,
                },
              ],
              {
                duration: 220,
                easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
              }
            );
          }
        }

        const previousTimer = promotionTimersRef.current.get(message.id);
        if (previousTimer !== undefined) window.clearTimeout(previousTimer);
        const timer = window.setTimeout(() => {
          promotionTimersRef.current.delete(message.id);
          setAnimatingPromotionIds((current) => {
            if (!current.has(message.id)) return current;
            const next = new Set(current);
            next.delete(message.id);
            return next;
          });
        }, 240);
        promotionTimersRef.current.set(message.id, timer);
      });
    }

    const nextQueuedIds = new Set<string>();
    visibleQueuedMessages.forEach((queuedMessage) => {
      nextQueuedIds.add(queuedMessage.id);
      const element = queuedMessageElementsRef.current.get(queuedMessage.id);
      if (element)
        queuedMessageRectsRef.current.set(queuedMessage.id, element.getBoundingClientRect());
    });
    previousQueuedIdsRef.current = nextQueuedIds;
  }, [displayMessages, visibleQueuedMessages]);

  useLayoutEffect(() => {
    const refreshQueuedRects = (): void => {
      visibleQueuedMessages.forEach((queuedMessage) => {
        const element = queuedMessageElementsRef.current.get(queuedMessage.id);
        if (element) {
          queuedMessageRectsRef.current.set(queuedMessage.id, element.getBoundingClientRect());
        }
      });
    };

    refreshQueuedRects();
    if (typeof ResizeObserver !== 'function') return;

    const observer = new ResizeObserver(refreshQueuedRects);
    const dropZone = dropZoneRef.current;
    const composer = dropZone?.querySelector<HTMLElement>('[data-testid="chat-composer"]');
    const queueStack = dropZone?.querySelector<HTMLElement>('[data-testid="queued-chat-stack"]');
    if (dropZone) observer.observe(dropZone);
    if (composer) observer.observe(composer);
    if (queueStack) observer.observe(queueStack);
    visibleQueuedMessages.forEach((queuedMessage) => {
      const element = queuedMessageElementsRef.current.get(queuedMessage.id);
      if (element) observer.observe(element);
    });
    return () => observer.disconnect();
  }, [visibleQueuedMessages, showHistory]);

  useEffect(
    () => () => {
      promotionTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      promotionTimersRef.current.clear();
    },
    []
  );

  const { collapsedTraceGroupsByFirstId, hiddenCollapsedTraceIds, completedAnswerIds } =
    useMemo(() => {
      const groups = new Map<string, CollapsedTraceGroup>();
      const hidden = new Set<string>();
      const completed = new Set<string>();
      const scopes = new Map<string, TraceScope>();

      let legacyScopeIndex = 0;
      for (let i = 0; i < displayMessages.length; i += 1) {
        const message = displayMessages[i];
        if (message.role === 'user') {
          legacyScopeIndex += 1;
        }

        const scopeKey = message.turnId ? `turn:${message.turnId}` : `legacy:${legacyScopeIndex}`;
        const existing = scopes.get(scopeKey);
        if (existing) {
          existing.indices.push(i);
        } else {
          scopes.set(scopeKey, {
            key: scopeKey,
            indices: [i],
            turnId: message.turnId ?? null,
          });
        }
      }

      scopes.forEach((scope) => {
        if (scope.turnId && activeTurnId === scope.turnId && isLoading) return;
        const turn = scope.turnId ? turns[scope.turnId] : null;
        if (turn?.status === 'running') return;

        const finalAssistantIndex = [...scope.indices]
          .reverse()
          .find((index) => displayMessages[index]?.role === 'assistant');
        if (finalAssistantIndex === undefined) return;

        const isComplete = turn
          ? turn.status === 'completed'
          : !((isLoading || isStreaming) && scope.key === `legacy:${legacyScopeIndex}`);
        if (isComplete) completed.add(displayMessages[finalAssistantIndex].id);

        const groupMessages: CollapsedTraceGroup['messages'] = scope.indices
          .filter((index) => index < finalAssistantIndex)
          .map((index) => ({ message: displayMessages[index], index }))
          .filter(({ message }) => isCollapsiblePreAnswerProcessMessage(message));

        if (groupMessages.length === 0) return;

        groupMessages.forEach(({ message }) => hidden.add(message.id));
        const firstMessage = groupMessages[0].message;
        groups.set(firstMessage.id, {
          key: `${scope.key}:${displayMessages[finalAssistantIndex].id}`,
          finalAssistantId: displayMessages[finalAssistantIndex].id,
          messages: groupMessages,
        });
      });

      return {
        collapsedTraceGroupsByFirstId: groups,
        hiddenCollapsedTraceIds: hidden,
        completedAnswerIds: completed,
      };
    }, [activeTurnId, displayMessages, isLoading, isStreaming, turns]);

  const projectedTraceGroups = useMemo(
    () =>
      new Map(
        Array.from(
          collapsedTraceGroupsByFirstId.values(),
          (group) =>
            [
              group.key,
              projectTraceItems(
                group.messages,
                ({ message }) =>
                  message.role === 'activity' ? decodeAgentActivityMessage(message.content) : null,
                ({ message }) => message.id,
                ({ message }) => (message.role === 'tool' ? (message.toolCallId ?? null) : null)
              ),
            ] as const
        )
      ),
    [collapsedTraceGroupsByFirstId]
  );

  const toggleTraceGroup = useCallback((key: string) => {
    setExpandedTraceGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const unseen = messages.filter(
      (msg) =>
        msg.role !== 'tool' &&
        msg.role !== 'activity' &&
        !messageReferenceIds.has(msg.id) &&
        (referenceLoadFailures.get(msg.id) ?? 0) < MAX_REFERENCE_LOAD_ATTEMPTS
    );
    if (unseen.length === 0) return;
    let cancelled = false;
    (async () => {
      const additions = new Map<string, string[]>();
      const failures = new Map<string, number>();
      for (const msg of unseen) {
        let structured: string[];
        try {
          structured = await getMessageReferences(msg.id);
        } catch (err) {
          console.error('[FullChatView] getMessageReferences failed for', msg.id, err);
          failures.set(msg.id, (referenceLoadFailures.get(msg.id) ?? 0) + 1);
          continue;
        }
        let ids = structured;
        if (ids.length === 0 && msg.content.includes('[[ref:')) {
          const parsed: string[] = [];
          const pattern = new RegExp(REF_TOKEN_PATTERN, 'g');
          for (const match of msg.content.matchAll(pattern)) {
            if (!parsed.includes(match[1])) parsed.push(match[1]);
          }
          ids = parsed;
        }
        additions.set(msg.id, ids);
      }
      if (cancelled) return;
      if (additions.size > 0) {
        setMessageReferenceIds((prev) => new Map([...prev, ...additions]));
      }
      if (failures.size > 0) {
        setReferenceLoadFailures((prev) => new Map([...prev, ...failures]));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, referenceLoadFailures]); // eslint-disable-line react-hooks/exhaustive-deps

  const allRefIds = useMemo(() => {
    const ids = new Set<string>();
    for (const list of messageReferenceIds.values()) {
      for (const id of list) ids.add(id);
    }
    for (const message of messages) {
      for (const id of message.referenceIds ?? []) ids.add(id);
    }
    for (const queuedMessage of queuedMessages) {
      for (const id of queuedMessage.referenceIds) ids.add(id);
    }
    return ids;
  }, [messageReferenceIds, messages, queuedMessages]);

  useEffect(() => {
    if (allRefIds.size === 0) {
      if (referenceMap.size > 0) setReferenceMap(new Map());
      return;
    }

    const idsToLoad = [...allRefIds].filter((id) => {
      if (referenceMap.has(id)) return false;
      const status = referenceResolution.get(id);
      if (status === 'absent' || status === 'unavailable') return false;
      return (entityReferenceLoadFailures.get(id) ?? 0) < MAX_REFERENCE_LOAD_ATTEMPTS;
    });
    if (idsToLoad.length === 0) return;

    getEntityReferencesByIds(idsToLoad)
      .then((refs) => {
        const resolvedIds = new Set(refs.map((ref) => ref.id));
        setReferenceMap((prev) => {
          const next = new Map(prev);
          for (const ref of refs) {
            next.set(ref.id, ref);
          }
          return next;
        });
        setReferenceResolution((prev) => {
          const next = new Map(prev);
          for (const id of idsToLoad) {
            next.set(id, resolvedIds.has(id) ? 'resolved' : 'absent');
          }
          return next;
        });
      })
      .catch((err) => {
        console.error('[FullChatView] Failed to load references:', err);
        setEntityReferenceLoadFailures((prev) => {
          const next = new Map(prev);
          for (const id of idsToLoad) {
            next.set(id, (prev.get(id) ?? 0) + 1);
          }
          return next;
        });
        setReferenceResolution((prev) => {
          const next = new Map(prev);
          for (const id of idsToLoad) {
            const nextAttempt = (entityReferenceLoadFailures.get(id) ?? 0) + 1;
            next.set(id, nextAttempt >= MAX_REFERENCE_LOAD_ATTEMPTS ? 'unavailable' : 'loading');
          }
          return next;
        });
      });
  }, [allRefIds, entityReferenceLoadFailures, referenceMap, referenceResolution]);

  const [composeReferences, setComposeReferences] = useState<DBEntityReference[]>([]);
  useLayoutEffect(() => {
    liveComposerRef.current = { ...liveComposerRef.current, input };
  }, [input]);
  useLayoutEffect(() => {
    liveComposerRef.current = { ...liveComposerRef.current, attachedFiles };
  }, [attachedFiles]);
  useLayoutEffect(() => {
    liveComposerRef.current = { ...liveComposerRef.current, composeReferences };
  }, [composeReferences]);
  useLayoutEffect(() => {
    liveComposerRef.current = { ...liveComposerRef.current, stagedCapability };
  }, [stagedCapability]);
  useConversationComposerDraft({
    conversationId: viewConversationId,
    workspacePath: chatFirst ? conversationWorkspacePath : undefined,
    text: input,
    attachments: attachedFiles,
    references: composeReferences,
    setText: setInput,
    setAttachments: setAttachedFiles,
    setReferences: setComposeReferences,
  });

  const addComposeReference = useCallback((ref: DBEntityReference) => {
    setComposeReferences((prev) => {
      if (prev.some((r) => r.id === ref.id)) return prev;
      if (
        prev.some(
          (existing) =>
            existing.entity_type === ref.entity_type &&
            existing.locator === ref.locator &&
            existing.deep_link_params === ref.deep_link_params
        )
      ) {
        return prev;
      }
      return [...prev, ref];
    });
  }, []);
  const handleSequencePaste = useComposerSequencePaste(addComposeReference);

  const removeComposeReference = useCallback((refId: string) => {
    setComposeReferences((prev) => prev.filter((r) => r.id !== refId));
  }, []);

  useEffect(() => {
    if (!pendingDraft || !isOpen) return;
    if (pendingDraft.conversationId && pendingDraft.conversationId !== viewConversationId) {
      return;
    }

    setInput((prev) => prev || pendingDraft.text || '');

    pendingDraft.references.forEach(addComposeReference);

    const lease = presentation.owner.captureFocus(presentation.id);
    const focusComposer = () =>
      presentation.owner.isCurrent(lease) &&
      safeFocus(document.querySelector<HTMLTextAreaElement>('[data-testid="ai-input"]'), {
        preventScroll: true,
      });
    if (!focusComposer()) {
      pendingDraftFocusFrameRef.current = window.requestAnimationFrame(() => {
        pendingDraftFocusFrameRef.current = null;
        if (focusComposer()) return;
        pendingDraftFocusTimeoutRef.current = window.setTimeout(() => {
          pendingDraftFocusTimeoutRef.current = null;
          focusComposer();
        }, 80);
      });
    }

    clearPendingDraft(null);
  }, [
    pendingDraft,
    isOpen,
    viewConversationId,
    addComposeReference,
    setInput,
    clearPendingDraft,
    presentation,
  ]);

  useEffect(
    () => () => {
      if (pendingDraftFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingDraftFocusFrameRef.current);
      }
      if (pendingDraftFocusTimeoutRef.current !== null) {
        window.clearTimeout(pendingDraftFocusTimeoutRef.current);
      }
    },
    []
  );

  const handleReferenceTarget = useCallback(
    (ref: DBEntityReference) => {
      void navigateToReference(ref, {
        sourceChatConversationId: scoped ? null : (conversationId ?? viewConversationId),
        target: true,
      }).catch((error: unknown) => {
        useToastStore
          .getState()
          .addToast(toUserMessage(error, 'failure.could-not-target-this-reference'), {
            definition: 'full-chat-view-could-not-target-reference',
          });
      });
    },
    [conversationId, scoped, viewConversationId]
  );
  const handleReferenceClick = useCallback(
    (ref: DBEntityReference, options?: { snapshotIndex: number }) => {
      if (ref.entity_type === 'alignment' && !ref.locator.startsWith('git://')) {
        useToastStore
          .getState()
          .addToast(userMessage('notice.the-alignment-viewer-is-not-available-yet'), {
            definition: 'full-chat-view-the-alignment-viewer-is-not-available-yet',
          });
        return;
      }
      void navigateToReference(ref, {
        sourceChatConversationId: scoped ? null : (conversationId ?? viewConversationId),
        ...options,
      }).catch((error: unknown) => {
        useToastStore
          .getState()
          .addToast(toUserMessage(error, 'failure.could-not-open-this-reference'), {
            definition: 'full-chat-view-could-not-open-this-reference',
          });
      });
    },
    [conversationId, scoped, viewConversationId]
  );

  const activationInFlightRef = useRef(new Set<string>());
  const activationControllersRef = useRef(new Map<string, AbortController>());
  const resolvedReferenceRootsRef = useRef(new Map<string, string>());
  const resolvedReferenceRootCacheOwnerIdRef = useRef<number | null>(null);
  const [busyReferenceKeys, setBusyReferenceKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const ownerId = registerResolvedReferenceRootCacheOwner();
    const activationControllers = activationControllersRef.current;
    const activationsInFlight = activationInFlightRef.current;
    const resolvedReferenceRoots = resolvedReferenceRootsRef.current;
    resolvedReferenceRootCacheOwnerIdRef.current = ownerId;
    return () => {
      for (const controller of activationControllers.values()) {
        controller.abort();
      }
      activationControllers.clear();
      activationsInFlight.clear();
      resolvedReferenceRoots.clear();
      releaseResolvedReferenceRootCacheOwner(ownerId);
      if (resolvedReferenceRootCacheOwnerIdRef.current === ownerId) {
        resolvedReferenceRootCacheOwnerIdRef.current = null;
      }
    };
  }, []);

  const observeResolvedReferenceRootCache = useCallback(
    (event: ResolvedReferenceRootCacheEvent): void => {
      const ownerId = resolvedReferenceRootCacheOwnerIdRef.current;
      if (ownerId === null) return;
      const owner = resolvedReferenceRootCacheOwners.get(ownerId);
      if (!owner) return;
      owner.size = event.size;
      owner.insertions += event.kind === 'insert' ? 1 : 0;
      owner.hits += event.kind === 'hit' ? 1 : 0;
      owner.evictions += event.evictions;
      owner.peakSize = Math.max(owner.peakSize, event.size);
    },
    []
  );

  const setReferenceBusy = useCallback((key: string, busy: boolean): void => {
    if (busy) activationInFlightRef.current.add(key);
    else activationInFlightRef.current.delete(key);
    const ownerId = resolvedReferenceRootCacheOwnerIdRef.current;
    if (ownerId === null || resolvedReferenceRootCacheOwners.get(ownerId)?.mounted !== true) {
      return;
    }
    setBusyReferenceKeys((current) => {
      const next = new Set(current);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const startReferenceActivation = useCallback(
    (key: string): ReferenceActivationOwner | null => {
      if (activationInFlightRef.current.has(key)) return null;
      const ownerId = resolvedReferenceRootCacheOwnerIdRef.current;
      if (ownerId === null) return null;
      const controller = new AbortController();
      activationControllersRef.current.set(key, controller);
      beginResolvedReferenceRootActivation(ownerId);
      setReferenceBusy(key, true);
      return {
        activationId: globalThis.crypto.randomUUID(),
        ownerId,
        controller,
        signal: controller.signal,
      };
    },
    [setReferenceBusy]
  );

  const finishReferenceActivation = useCallback(
    (key: string, activation: ReferenceActivationOwner, succeeded: boolean): void => {
      if (activationControllersRef.current.get(key) === activation.controller) {
        activationControllersRef.current.delete(key);
      }
      setReferenceBusy(key, false);
      completeResolvedReferenceRootActivation(activation.ownerId, succeeded);
    },
    [setReferenceBusy]
  );

  const resolveReferenceRoot = useCallback(
    async (
      reference: DBEntityReference,
      activation: ReferenceActivationOwner
    ): Promise<
      | { ok: true; rootPath: string }
      | {
          ok: false;
          code: 'origin-unrecoverable' | 'origin-persistence-failed' | 'origin-conflict';
        }
    > => {
      const cachedRoot = resolvedReferenceRootsRef.current.get(reference.id);
      if (cachedRoot) {
        rememberResolvedReferenceRoot(
          resolvedReferenceRootsRef.current,
          reference.id,
          cachedRoot,
          observeResolvedReferenceRootCache
        );
        return { ok: true, rootPath: cachedRoot };
      }

      const locator = gitLocatorParts(reference.locator);
      const origin = await resolveInlineReferenceOrigin({
        reference,
        conversationWorkspacePath: conversationWorkspacePath ?? null,
        validateCandidate: async (rootPath) => {
          if (!locator) return false;
          const result = await resolveInlineReferenceTargetBounded(
            {
              roots: [{ name: locator.root, path: rootPath }],
              root: locator.root,
              segments: locator.segments,
              targetKind:
                reference.entity_type === 'sequence' || reference.entity_type === 'structure'
                  ? reference.entity_type
                  : 'workspace',
            },
            activation
          );
          return result.ok;
        },
      });
      if (
        activation.signal.aborted ||
        resolvedReferenceRootCacheOwners.get(activation.ownerId)?.mounted !== true
      ) {
        return { ok: false, code: 'origin-unrecoverable' };
      }
      if (!origin.ok) return origin;
      if (!origin.recovered) {
        rememberResolvedReferenceRoot(
          resolvedReferenceRootsRef.current,
          reference.id,
          origin.rootPath,
          observeResolvedReferenceRootCache
        );
        return { ok: true, rootPath: origin.rootPath };
      }

      try {
        const winner = await persistReferenceOriginBounded(
          reference.id,
          origin.rootPath,
          activation
        );
        if (
          activation.signal.aborted ||
          resolvedReferenceRootCacheOwners.get(activation.ownerId)?.mounted !== true
        ) {
          return { ok: false, code: 'origin-unrecoverable' };
        }
        if (winner === null) return { ok: false, code: 'origin-persistence-failed' };
        if (winner !== origin.rootPath) return { ok: false, code: 'origin-conflict' };
        rememberResolvedReferenceRoot(
          resolvedReferenceRootsRef.current,
          reference.id,
          winner,
          observeResolvedReferenceRootCache
        );
        return { ok: true, rootPath: winner };
      } catch (error) {
        console.warn('[FullChatView] Could not persist recovered reference origin:', error);
        return { ok: false, code: 'origin-persistence-failed' };
      }
    },
    [conversationWorkspacePath, observeResolvedReferenceRootCache]
  );

  const revealSavedPath = useCallback(
    (rootName: string, rootPath: string, path: string): void => {
      const workspace = useWorkspaceStore.getState();
      if (!workspace.folders.some((folder) => folder.path === rootPath)) {
        workspace.addFolder(rootPath, rootName);
      }
      dispatchCommand(COMMAND_IDS.workspaceRevealPath, {
        source: 'ui',
        payload: { path },
      });
    },
    [dispatchCommand]
  );

  const sourceReferenceConversationId = scoped ? null : (conversationId ?? viewConversationId);
  const activateSavedReference = useCallback(
    (input: InlineReferenceActivationInput, activation: ReferenceActivationOwner) =>
      activateInlineReference(input, {
        signal: activation.signal,
        resolvePackageProduct: resolveSequencePackageProductForReference,
        openSequence: (openInput) =>
          openSequenceReference(openInput, sourceReferenceConversationId, activation),
        openStructure: (openInput) =>
          openStructureReference(openInput, sourceReferenceConversationId, activation),
        revealWorkspacePath: (path) =>
          revealSavedPath(input.declaration.root, input.rootPath, path),
        resolveTarget: (request) => resolveInlineReferenceTargetBounded(request, activation),
      }),
    [revealSavedPath, sourceReferenceConversationId]
  );

  const handleReferenceReveal = useCallback(
    async (ref: DBEntityReference) => {
      const declaration = inlineWorkspaceDeclarationFromReference(ref);
      if (!declaration) return;
      const activation = startReferenceActivation(ref.id);
      if (activation === null) return;
      let activationSucceeded = false;
      try {
        if (
          activation.signal.aborted ||
          resolvedReferenceRootCacheOwners.get(activation.ownerId)?.mounted !== true
        )
          return;
        const root = await resolveReferenceRoot(ref, activation);
        if (
          activation.signal.aborted ||
          resolvedReferenceRootCacheOwners.get(activation.ownerId)?.mounted !== true
        )
          return;
        if (!root.ok) {
          useToastStore
            .getState()
            .addToast(
              renderUserMessage(
                inlineReferenceActivationErrorMessage(
                  root.code,
                  stripDisplayExtension(ref.display_label),
                  ref.entity_type
                )
              ),
              { definition: 'full-chat-view-handle-reference-reveal' }
            );
          return;
        }
        const rootPath = root.rootPath;
        const result = await activateSavedReference(
          {
            declaration,
            intent: 'reveal',
            label: ref.display_label,
            rootPath,
          },
          activation
        );
        if (activation.signal.aborted) return;
        if (!result.ok) {
          useToastStore
            .getState()
            .addToast(
              renderUserMessage(
                inlineReferenceActivationErrorMessage(
                  result.code,
                  stripDisplayExtension(ref.display_label),
                  ref.entity_type
                )
              ),
              { definition: 'full-chat-view-handle-reference-reveal' }
            );
        } else {
          activationSucceeded = true;
        }
      } catch {
        if (activation.signal.aborted) return;
        useToastStore
          .getState()
          .addToast(
            renderUserMessage(
              inlineReferenceActivationErrorMessage(
                'open-failed',
                stripDisplayExtension(ref.display_label),
                ref.entity_type
              )
            ),
            { definition: 'full-chat-view-open-failed' }
          );
      } finally {
        finishReferenceActivation(ref.id, activation, activationSucceeded);
      }
    },
    [
      resolveReferenceRoot,
      activateSavedReference,
      finishReferenceActivation,
      startReferenceActivation,
    ]
  );

  const handleInlineReferenceAction = useCallback(
    async (part: InlineReferencePart, intent: 'open' | 'reveal') => {
      if (part.state.status !== 'resolved') return;
      if (part.declaration.kind === 'project-resource') {
        const activation = startReferenceActivation(part.key);
        if (activation === null) return;
        let succeeded = false;
        try {
          await openProjectResourceReference(part.declaration.resource, {
            intent,
            signal: activation.signal,
            sourceChatConversationId: viewConversationId,
          });
          succeeded = !activation.signal.aborted;
        } catch {
          if (!activation.signal.aborted)
            useToastStore
              .getState()
              .addToast(
                renderUserMessage(inlineReferenceActivationErrorMessage('open-failed', part.label)),
                { definition: 'full-chat-view-open-failed' }
              );
        } finally {
          finishReferenceActivation(part.key, activation, succeeded);
        }
        return;
      }
      let authoritativeReference = part.state.reference;
      if (part.declaration.kind === 'molecular-document') {
        if (intent === 'open' && authoritativeReference)
          handleReferenceClick(authoritativeReference);
        return;
      }
      let activationDeclaration: InlinePathDeclaration | null =
        part.declaration.kind === 'existing-reference' ? null : part.declaration;
      let activationLabel = part.state.canonicalLabel;
      if (part.declaration.kind === 'existing-reference') {
        const reference = part.state.reference ?? referenceMap.get(part.declaration.referenceId);
        if (!reference) return;
        authoritativeReference = reference;
        activationDeclaration =
          intent === 'reveal'
            ? inlineWorkspaceDeclarationFromReference(reference)
            : (inlinePathDeclarationFromReference(reference) ??
              (reference.entity_type === 'file' || reference.entity_type === 'folder'
                ? inlineWorkspaceDeclarationFromReference(reference)
                : null));
        if (!activationDeclaration) {
          if (intent === 'open') handleReferenceClick(reference);
          return;
        }
        activationLabel = reference.display_label;
      }
      if (!activationDeclaration) return;
      const activationKey = authoritativeReference?.id ?? part.key;
      const activation = startReferenceActivation(activationKey);
      if (activation === null) return;
      let activationSucceeded = false;
      try {
        if (
          activation.signal.aborted ||
          resolvedReferenceRootCacheOwners.get(activation.ownerId)?.mounted !== true
        )
          return;
        let rootPath: string | null = null;
        if (authoritativeReference) {
          const root = await resolveReferenceRoot(authoritativeReference, activation);
          if (
            activation.signal.aborted ||
            resolvedReferenceRootCacheOwners.get(activation.ownerId)?.mounted !== true
          )
            return;
          if (!root.ok) {
            useToastStore
              .getState()
              .addToast(
                renderUserMessage(
                  inlineReferenceActivationErrorMessage(
                    root.code,
                    activationLabel,
                    authoritativeReference.entity_type
                  )
                ),
                { definition: 'full-chat-view-handle-inline-reference-action' }
              );
            return;
          }
          rootPath = root.rootPath;
        } else if (
          conversationWorkspacePath &&
          getFilename(conversationWorkspacePath) === activationDeclaration.root
        ) {
          rootPath = conversationWorkspacePath;
        }
        if (!rootPath) {
          useToastStore
            .getState()
            .addToast(
              renderUserMessage(
                inlineReferenceActivationErrorMessage(
                  'origin-unrecoverable',
                  activationLabel,
                  authoritativeReference?.entity_type
                )
              ),
              { definition: 'full-chat-view-origin-unrecoverable' }
            );
          return;
        }
        const result = await activateSavedReference(
          {
            declaration: activationDeclaration,
            intent:
              activationDeclaration.kind === 'workspace-path' && intent === 'open'
                ? 'reveal'
                : intent,
            label: activationLabel,
            rootPath,
          },
          activation
        );
        if (activation.signal.aborted) return;
        if (!result.ok) {
          useToastStore
            .getState()
            .addToast(
              renderUserMessage(
                inlineReferenceActivationErrorMessage(
                  result.code,
                  activationLabel,
                  authoritativeReference?.entity_type
                )
              ),
              { definition: 'full-chat-view-handle-inline-reference-action' }
            );
        } else {
          activationSucceeded = true;
        }
      } catch {
        if (activation.signal.aborted) return;
        useToastStore
          .getState()
          .addToast(
            renderUserMessage(
              inlineReferenceActivationErrorMessage(
                'open-failed',
                activationLabel,
                authoritativeReference?.entity_type
              )
            ),
            { definition: 'full-chat-view-open-failed' }
          );
      } finally {
        finishReferenceActivation(activationKey, activation, activationSucceeded);
      }
    },
    [
      conversationWorkspacePath,
      activateSavedReference,
      handleReferenceClick,
      referenceMap,
      resolveReferenceRoot,
      finishReferenceActivation,
      startReferenceActivation,
      viewConversationId,
    ]
  );

  const renderInlineReference = useCallback(
    (part: InlineReferencePart): React.ReactNode => {
      if (part.state.status !== 'resolved') return part.label;
      if (part.declaration.kind === 'project-resource')
        return (
          <ProjectResourceChatChip
            reference={part.declaration.resource}
            label={part.state.canonicalLabel}
            busy={busyReferenceKeys.has(part.key)}
            onOpen={() => void handleInlineReferenceAction(part, 'open')}
            onReveal={() => void handleInlineReferenceAction(part, 'reveal')}
            testId={`inline-project-resource-chip-${part.key}`}
          />
        );
      if (part.declaration.kind === 'workspace-path') {
        const targetType =
          part.state.targetType ??
          persistedWorkspaceTargetTypes.get(
            persistedWorkspaceTargetKey(part.declaration, workspaceFolders)
          ) ??
          'file';
        const targetPath = `${part.declaration.root}/${part.declaration.segments.join('/')}`;
        return (
          <ChatEntityReferenceChip
            entityType={entityIconKindForWorkspaceTarget(targetPath, targetType)}
            label={part.state.canonicalLabel}
            detail={targetPath}
            onReveal={() => handleInlineReferenceAction(part, 'reveal')}
            primaryAction="reveal"
            busy={busyReferenceKeys.has(part.state.referenceId ?? part.key)}
            testId={`inline-workspace-chip-${part.key}`}
          />
        );
      }
      const reference =
        part.state.reference ??
        (part.declaration.kind === 'existing-reference'
          ? referenceMap.get(part.declaration.referenceId)
          : undefined);
      if (!reference) return part.state.canonicalLabel;
      return (
        <ReferenceChip
          reference={reference}
          inline
          onTarget={handleReferenceTarget}
          onClick={() => void handleInlineReferenceAction(part, 'open')}
          onReveal={() => void handleInlineReferenceAction(part, 'reveal')}
          busy={busyReferenceKeys.has(reference.id)}
        />
      );
    },
    [
      busyReferenceKeys,
      handleInlineReferenceAction,
      handleReferenceTarget,
      persistedWorkspaceTargetTypes,
      referenceMap,
      workspaceFolders,
    ]
  );

  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, []);

  const handleStopGeneration = useCallback(() => {
    stopGeneration(viewConversationId);
  }, [stopGeneration, viewConversationId]);

  const activeTurn = activeTurnId ? (turns[activeTurnId] ?? null) : null;
  const {
    activeAssistantRoute,
    activeRouteSendBlocked,
    activeRouteFallbackNotice,
    activeDirectApiNeedsKey,
    activeCliNeedsLogin,
    activeHostedNeedsLogin,
    activeHostedUnavailable,
    renderAssistantRouteSelector,
    renderModelControls,
    renderRouteConfigurationPrompt,
    renderRouteCheckingStatus,
    renderComputeConnectPrompt,
    renderConnectAiModal,
  } = useChatRouteControls({
    onConfigureHost,
    onOpenAssistantSources,
    isOpen,
  });
  const activeCapabilityProvider =
    activeAssistantRoute?.kind === 'cli' ? activeAssistantRoute.transport : null;
  const renderComposerModelControls = () =>
    renderModelControls(
      <ChatPermissionPickers conversationId={viewConversationId} route={activeAssistantRoute} />,
      activeCapabilityProvider
        ? [
            {
              id: 'actions',
              label: 'Actions',
              description: 'Commands, plugins and memory',
              onSelect: () => setAgentActionsOpen(true),
              testId: 'agent-actions-button',
            },
          ]
        : []
    );

  useEffect(() => {
    if (stagedCapability && stagedCapability.control.provider !== activeCapabilityProvider) {
      setStagedCapability(null);
    }
    if (!activeCapabilityProvider) setAgentActionsOpen(false);
  }, [activeCapabilityProvider, stagedCapability]);

  const handleComposerInputChange = useCallback(
    (value: string) => {
      setInput(value);
      if (value === '/' && activeCapabilityProvider) {
        setAgentActionsOpen(true);
      }
    },
    [activeCapabilityProvider]
  );

  const closeAgentActions = useCallback(() => {
    setAgentActionsOpen(false);
    setInput((current) => (current.trim() === '/' ? '' : current));
  }, []);

  const manageAgentExtensions = useCallback(() => {
    setShowHistory(false);
    closeAgentActions();
    onOpenAssistantSources?.();
  }, [closeAgentActions, onOpenAssistantSources, setShowHistory]);

  const handleCapabilitySelected = useCallback((choice: AgentCapabilityChoice) => {
    setStagedCapability(choice);
    setInput((current) => (current.trim() === '/' ? '' : current));
    scheduleFocus(inputRef.current);
  }, []);

  const renderAgentActionsControl = useCallback(
    () =>
      activeCapabilityProvider ? (
        <>
          {stagedCapability && (
            <span
              className="inline-flex h-7 max-w-48 items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 text-xs text-accent"
              data-testid="staged-agent-capability"
            >
              <span className="truncate">
                {formatAgentCapabilityKind(stagedCapability.control.kind)}:{' '}
                {stagedCapability.control.label}
              </span>
              <button
                type="button"
                onClick={() => {
                  setStagedCapability(null);
                  scheduleFocus(inputRef.current);
                }}
                className="shrink-0 rounded px-0.5 hover:bg-accent/15"
                aria-label={`Remove selected agent action: ${stagedCapability.control.label}`}
              >
                ×
              </button>
            </span>
          )}
        </>
      ) : null,
    [activeCapabilityProvider, stagedCapability]
  );

  const handleSend = useCallback(async () => {
    const hasContent = input.trim() || attachedFiles.length > 0 || composeReferences.length > 0;
    if (!hasContent) return;

    if (activeRouteSendBlocked) return;

    if (attachedFiles.length > 0 && !activeCapabilityProvider) {
      setPreStartError(
        userMessage(
          'failure.file-attachments-currently-require-a-local-cli-agent-route-choose-clau'
        )
      );
      return;
    }
    const message =
      input.trim() ||
      `Please analyze the attached ${attachedFiles.length === 1 ? 'file' : 'files'}.`;

    const referenceIds = composeReferences.map((r) => r.id);

    const sendAttempt = ++sendAttemptRef.current;
    const sendConversationId = viewConversationId;
    latestSendAttemptByConversationRef.current.set(sendConversationId, sendAttempt);
    const previousDraft = { input, attachedFiles, composeReferences, stagedCapability };
    setPreStartError(null);
    setError(null, sendConversationId);
    setInput('');
    setAttachedFiles([]);
    setComposeReferences([]);
    setStagedCapability(null);
    liveComposerRef.current = {
      input: '',
      attachedFiles: [],
      composeReferences: [],
      stagedCapability: null,
    };
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    const sendDisposition = await sendMessage(
      message,
      conversationWorkspacePath,
      sendConversationId ?? undefined,
      referenceIds,
      {
        claimIfUnowned: isOpen && !scoped,
        activateConversation: isOpen && !scoped,
        onNotStarted: setPreStartError,
        attachments: attachedFiles,
        ...(stagedCapability
          ? {
              capabilitySelection: {
                snapshotId: stagedCapability.snapshotId,
                provider: stagedCapability.control.provider,
                capabilityId: stagedCapability.control.id,
              },
            }
          : {}),
      }
    );
    const liveComposer = liveComposerRef.current;
    const composerIsStillEmpty =
      liveComposer.input.length === 0 &&
      liveComposer.attachedFiles.length === 0 &&
      liveComposer.composeReferences.length === 0;
    const isLatestAttemptForConversation =
      latestSendAttemptByConversationRef.current.get(sendConversationId) === sendAttempt;
    if (sendDisposition === 'rejected' && isLatestAttemptForConversation) {
      if (sendOwnerConversationRef.current === sendConversationId && composerIsStillEmpty) {
        setInput(previousDraft.input);
        setAttachedFiles(previousDraft.attachedFiles);
        setComposeReferences(previousDraft.composeReferences);
        setStagedCapability(previousDraft.stagedCapability);
      } else if (sendConversationId) {
        const latestDraft = useChatStore.getState().composerDrafts.get(sendConversationId);
        const latestDraftIsEmpty =
          !latestDraft ||
          (latestDraft.text.length === 0 &&
            latestDraft.attachments.length === 0 &&
            latestDraft.references.length === 0);
        if (latestDraftIsEmpty) {
          setComposerDraft(sendConversationId, {
            ...(chatFirst ? { workspacePath: conversationWorkspacePath } : {}),
            text: previousDraft.input,
            attachments: previousDraft.attachedFiles,
            references: previousDraft.composeReferences,
          });
        }
      }
    }
    if (isLatestAttemptForConversation) {
      latestSendAttemptByConversationRef.current.delete(sendConversationId);
    }
  }, [
    chatFirst,
    input,
    attachedFiles,
    composeReferences,
    stagedCapability,
    activeRouteSendBlocked,
    sendMessage,
    setError,
    setComposerDraft,
    conversationWorkspacePath,
    viewConversationId,
    scoped,
    isOpen,
    activeCapabilityProvider,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && (isLoading || visibleQueuedMessages.length > 0)) {
        e.preventDefault();
        e.stopPropagation();
        handleStopGeneration();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const composerIsEmpty =
          input.trim().length === 0 && attachedFiles.length === 0 && composeReferences.length === 0;
        if (composerIsEmpty) {
          if (visibleQueuedMessages.length > 0) handleStopGeneration();
          return;
        }
        handleSend();
      }
    },
    [
      attachedFiles.length,
      composeReferences.length,
      handleSend,
      handleStopGeneration,
      input,
      isLoading,
      visibleQueuedMessages.length,
    ]
  );

  const captureAttachmentPath = useCallback((filePath: string): Promise<void> => {
    const capture = attachmentCaptureQueueRef.current.then(async () => {
      const result = await platform().agentAttachments.capture({ path: filePath });
      if (!result.ok) {
        setPreStartError(
          result.userMessagePayload
            ? renderUserMessagePayload(result.userMessagePayload, 'assistant.failed')
            : toUserMessage(result.error, 'assistant.failed')
        );
        return;
      }
      const current = liveComposerRef.current.attachedFiles;
      if (current.some((file) => file.id === result.attachment.id)) {
        setPreStartError(null);
        return;
      }
      if (current.length >= AGENT_ATTACHMENT_MAX_COUNT) {
        setPreStartError(
          userMessageWithValues('assistant.attachmentLimit', {
            count: userMessageValue(AGENT_ATTACHMENT_MAX_COUNT),
          })
        );
        return;
      }
      const totalBytes = current.reduce((total, file) => total + file.size, 0);
      if (totalBytes + result.attachment.size > AGENT_ATTACHMENT_MAX_TOTAL_BYTES) {
        setPreStartError(userMessage('failure.attachments-must-be-4-mib-or-smaller-in-total'));
        return;
      }
      const next = [...current, result.attachment];
      liveComposerRef.current = { ...liveComposerRef.current, attachedFiles: next };
      setPreStartError(null);
      setAttachedFiles(next);
    });
    attachmentCaptureQueueRef.current = capture.catch(() => undefined);
    return capture;
  }, []);

  const handleAttachFile = useCallback(async () => {
    try {
      const { dialog } = platform();

      const selected = await dialog.open({
        multiple: true,
        filters: [
          {
            name: 'Biology Files',
            extensions: ['gb', 'gbk', 'fasta', 'fa', 'fas', 'seq', 'txt', 'md', 'json', 'csv'],
          },
        ],
      });

      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];

      for (const filePath of paths) {
        if (typeof filePath !== 'string') continue;
        try {
          await captureAttachmentPath(filePath);
        } catch (err) {
          setPreStartError(toUserMessage(err, 'assistant.failed'));
        }
      }
    } catch (err) {
      setPreStartError(toUserMessage(err, 'assistant.failed'));
    }
  }, [captureAttachmentPath]);

  const handleRemoveFile = useCallback((fileId: string) => {
    const next = liveComposerRef.current.attachedFiles.filter((file) => file.id !== fileId);
    liveComposerRef.current = { ...liveComposerRef.current, attachedFiles: next };
    setAttachedFiles(next);
  }, []);

  const [isDragOver, setIsDragOver] = useState(false);

  const renderCollapsedTraceMessage = (
    message: ChatMessage,
    projectedEvent: import('../platform').AgentTraceEventShape | null
  ): React.ReactNode => {
    if (message.role === 'activity') {
      const event = projectedEvent ?? decodeAgentActivityMessage(message.content);
      if (event && isChatVisibleAgentTraceEvent(event)) {
        return <AgentTraceRow event={event} />;
      }
      return null;
    }
    if (message.role === 'tool') {
      return (
        <ToolResultDisplay
          toolName={message.toolName || 'tool'}
          content={message.content}
          allowReactivation
        />
      );
    }
    if (message.role === 'assistant') {
      return (
        <div
          className="my-0.5 py-1 text-xs leading-relaxed text-fg-muted"
          data-testid="agent-process-assistant-text"
        >
          <FormattedMessage
            content={message.content}
            document={inlineDocumentsByMessageId.get(message.id)}
            renderInlineReference={renderInlineReference}
            references={referenceMap}
            referenceIds={message.referenceIds ?? messageReferenceIds.get(message.id)}
            referenceResolution={referenceResolution}
            referenceQueryState={
              (referenceLoadFailures.get(message.id) ?? 0) >= MAX_REFERENCE_LOAD_ATTEMPTS
                ? 'unavailable'
                : undefined
            }
            onReferenceClick={handleReferenceClick}
            onReferenceReveal={handleReferenceReveal}
          />
        </div>
      );
    }
    return null;
  };

  const renderCollapsedTraceGroup = (group: CollapsedTraceGroup) => {
    const expanded = expandedTraceGroups.has(group.key);
    const projectedMessages = projectedTraceGroups.get(group.key) ?? [];
    const count = projectedMessages.length;
    return (
      <div
        className="my-1 text-xs text-accent/80 dark:text-accent/70"
        data-testid="agent-trace-group"
      >
        <button
          type="button"
          onClick={() => toggleTraceGroup(group.key)}
          className="flex min-w-0 items-center gap-2 rounded-sm py-1 text-left transition-colors hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-expanded={expanded}
          data-testid="agent-trace-group-toggle"
        >
          <ChevronRightIcon
            size={10}
            className={`flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <span className="font-medium">{expanded ? 'Hide process' : 'Show process'}</span>
          <span className="text-accent/65 dark:text-accent/55">
            {count} {count === 1 ? 'step' : 'steps'}
          </span>
        </button>
        {expanded && (
          <div className="mt-0.5 space-y-0.5" data-testid="agent-trace-group-content">
            {projectedMessages.map(({ key, source, event }) => (
              <React.Fragment key={key}>
                {renderCollapsedTraceMessage(source.message, event)}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    );
  };

  const dropZoneRef = useRef<HTMLDivElement | null>(null);
  const handleDropZoneRef = useCallback((node: HTMLDivElement | null) => {
    dropZoneRef.current = node;
    setDropZoneElement(node);
  }, []);

  useEffect(() => {
    const zone = dropZoneRef.current;
    if (!zone) return;

    const handleFileDrop = async (e: Event) => {
      const { path: filePath, name } = (e as CustomEvent).detail as { path: string; name: string };
      setIsDragOver(false);

      const ext = filePath.split('.').pop()?.toLowerCase();
      const structExts = ['pdb', 'cif', 'mmcif'];
      let entityType = 'sequence';
      if (structExts.includes(ext || '')) entityType = 'structure';

      const sourceRoot = findContainingPathBoundary(workspaceFolders, filePath);
      const relativePath = sourceRoot ? pathRelativeToBoundary(filePath, sourceRoot.path) : null;
      if (!sourceRoot || !relativePath) {
        console.error('[FullChatView] Dropped file is outside every open project:', filePath);
        useToastStore
          .getState()
          .addToast(
            userMessageWithValues(
              'notice.value-isn-t-inside-an-open-project-so-dnaforge-didn-t-attach-it',
              { value0: userMessageValue(name) }
            ),
            {
              definition:
                'full-chat-view-example-isn-t-inside-an-open-project-so-dnaforge-didn-t-attach-it',
            }
          );
        return;
      }

      try {
        const ref = await createEntityReference({
          entityType,
          displayLabel: name,
          locator: `git://${sourceRoot.name}/${relativePath}`,
          deepLinkParams: null,
          data: null,
          source: 'user',
          workspaceScope: getCurrentWorkspaceScope(),
          workspaceRootPath: sourceRoot.path,
        });
        addComposeReference(ref);
      } catch (err) {
        console.error('[FullChatView] Failed to create reference for dropped file:', filePath, err);
      }
    };

    const handleDragHover = (e: Event) => {
      const { hovering } = (e as CustomEvent).detail as { hovering: boolean };
      setIsDragOver(hovering);
    };

    zone.addEventListener('waypoint-file-drop', handleFileDrop);
    zone.addEventListener('waypoint-file-drag-hover', handleDragHover);
    return () => {
      zone.removeEventListener('waypoint-file-drop', handleFileDrop);
      zone.removeEventListener('waypoint-file-drag-hover', handleDragHover);
    };
  }, [addComposeReference, workspaceFolders]);

  const handleExternalDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      for (const file of files) {
        const path = (file as unknown as { path?: string }).path;
        if (!path) continue;

        try {
          await captureAttachmentPath(path);
        } catch (err) {
          setPreStartError(toUserMessage(err, 'assistant.failed'));
        }
      }
    },
    [captureAttachmentPath]
  );

  const handleExternalDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setIsDragOver(true);
    }
  }, []);

  const handleExternalDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const activeConversationTitle = useMemo(
    () =>
      conversations.find((conversation) => conversation.id === viewConversationId)?.title?.trim() ||
      'New Chat',
    [conversations, viewConversationId]
  );
  const viewConversation = useMemo<(typeof conversations)[number] | null>(() => {
    if (!viewConversationId) return null;
    return (
      conversations.find((conversation) => conversation.id === viewConversationId) ?? {
        id: viewConversationId,
        title: activeConversationTitle,
        workspacePath,
        pinned: false,
        provider: null,
        model: null,
        createdAt: messages[0]?.createdAt ?? 0,
        updatedAt: messages[messages.length - 1]?.createdAt ?? 0,
      }
    );
  }, [activeConversationTitle, conversations, messages, viewConversationId, workspacePath]);
  const createTextThreadMarkdown = useCallback(() => {
    if (!viewConversation) return '';
    return serializeTextThreadMarkdown({
      conversation: viewConversation,
      messages,
    });
  }, [messages, viewConversation]);
  const createDetailedThreadMarkdown = useCallback(async () => {
    if (!viewConversation) return '';
    const messageIds = messages.map((message) => message.id);
    const referenceIdsByMessage = await getMessageReferencesForMessages(messageIds);
    const orderedReferenceIds: string[] = [];
    const seenReferenceIds = new Set<string>();
    for (const messageId of messageIds) {
      for (const referenceId of referenceIdsByMessage.get(messageId) ?? []) {
        if (seenReferenceIds.has(referenceId)) continue;
        seenReferenceIds.add(referenceId);
        orderedReferenceIds.push(referenceId);
      }
    }

    const references = await getEntityReferencesByIds(orderedReferenceIds);
    const referencesById = new Map(references.map((reference) => [reference.id, reference]));
    const missingReferenceId = orderedReferenceIds.find(
      (referenceId) => !referencesById.has(referenceId)
    );
    if (missingReferenceId) {
      throw new Error(`Could not resolve retained reference ${missingReferenceId}`);
    }

    const referencesByMessageId = new Map<string, DBEntityReference[]>();
    for (const messageId of messageIds) {
      const messageReferences = (referenceIdsByMessage.get(messageId) ?? []).map((referenceId) => {
        const reference = referencesById.get(referenceId);
        if (!reference) throw new Error(`Could not resolve retained reference ${referenceId}`);
        return reference;
      });
      if (messageReferences.length > 0) referencesByMessageId.set(messageId, messageReferences);
    }

    return serializeThreadMarkdown({
      conversation: viewConversation,
      messages,
      referencesByMessageId,
    });
  }, [messages, viewConversation]);

  return (
    <div
      ref={handleDropZoneRef}
      data-testid="full-chat-view"
      data-conversation-id={viewConversationId ?? undefined}
      data-analytics-block
      data-chat-drop-zone
      data-history-pinned={!hideHeader && isChatVisible && showHistory ? 'true' : undefined}
      className="ph-no-capture relative flex h-full flex-col bg-bg"
      onPointerDownCapture={onRequestPanelFocus}
      onFocusCapture={onRequestPanelFocus}
    >
      {renderConnectAiModal()}
      <AgentActionsPalette
        open={agentActionsOpen}
        provider={activeCapabilityProvider}
        workspacePath={conversationWorkspacePath}
        conversationId={viewConversationId}
        onClose={closeAgentActions}
        onSelect={handleCapabilitySelected}
        onManage={onOpenAssistantSources ? manageAgentExtensions : undefined}
      />
      {!hideHeader && (
        <ChatHistorySurface
          anchor={dropZoneElement}
          inputRef={inputRef}
          workspacePath={workspacePath}
          viewConversationId={viewConversationId}
          conversations={conversations}
          pinned={showHistory}
          setPinned={setShowHistory}
          isOpen={isOpen}
          isVisible={isChatVisible}
          isBusy={isLoading}
          queuedMessageCount={visibleQueuedMessages.length}
          onConversationIdChange={historyObservation.retarget}
          historyPaneGenerationId={historyObservation.paneGenerationId}
          onRequestPanelFocus={onRequestPanelFocus}
          onPinnedLayoutChange={onHistoryPinnedChange}
          onPause={handleStopGeneration}
          chatFirst={chatFirst}
        />
      )}
      {(viewConversation || chatFirst) && (
        <div
          className={`flex flex-shrink-0 items-start justify-end pb-1 pl-2 pr-3 ${chatFirst ? 'min-h-14 pt-4' : 'min-h-9 pt-2'}`}
          data-testid="copy-thread-surface"
          data-layout="thread-toolbar"
        >
          {viewConversation && (
            <CopyThreadButton
              createTextMarkdown={createTextThreadMarkdown}
              createDetailedMarkdown={createDetailedThreadMarkdown}
            />
          )}
        </div>
      )}
      {chatFirst && (
        <div className="flex min-w-0 items-center gap-2 border-b border-border/70 px-4 pb-2.5 text-xs text-fg-muted">
          <span className="shrink-0">Chat project</span>
          <span
            className="truncate font-medium text-fg"
            title={conversationProjectName ?? undefined}
            data-testid="chat-first-conversation-project"
          >
            {conversationProjectName ?? 'No project selected for this chat'}
          </span>
          {conversationWorkspacePath !== workspacePath && (
            <span
              className="ml-auto shrink-0 text-fg-muted"
              title="New chat uses the project selected in the title bar"
            >
              New chat to switch
            </span>
          )}
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="chat-main-column">
        {}
        {displayMessages.length === 0 && visibleQueuedMessages.length === 0 ? (
          <div
            className="flex min-w-0 flex-1 flex-col justify-center py-4"
            onDragOver={handleExternalDragOver}
            onDragLeave={handleExternalDragLeave}
            onDrop={handleExternalDrop}
          >
            <div className="chat-content-rail">
              <InlineAgentConfirmationHost
                conversationId={viewConversationId}
                scoped={scoped}
                isActive={isOpen}
              />
              <EmptyStateChatComposer
                input={input}
                onInputChange={handleComposerInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handleSequencePaste}
                onSend={handleSend}
                sendDisabled={
                  (!input.trim() && attachedFiles.length === 0 && composeReferences.length === 0) ||
                  activeRouteSendBlocked
                }
                sendTitle={
                  activeRouteFallbackNotice && !activeRouteSendBlocked
                    ? activeRouteFallbackNotice
                    : activeDirectApiNeedsKey
                      ? 'Add a Direct API key before sending'
                      : activeCliNeedsLogin
                        ? 'Sign in to this CLI host before sending'
                        : activeHostedNeedsLogin
                          ? 'Sign in to DNAForge before sending'
                          : activeHostedUnavailable
                            ? 'DNAForge AI is temporarily unavailable; choose another route'
                            : activeRouteSendBlocked
                              ? 'Waiting for AI route detection'
                              : isLoading
                                ? 'Queue message (Enter)'
                                : 'Send (Enter)'
                }
                isLoading={isLoading}
                inputRef={inputRef}
                error={error}
                hideInput={hideInput}
                attachedFiles={attachedFiles}
                onRemoveFile={handleRemoveFile}
                onAttachFile={handleAttachFile}
                renderAgentActionsControl={renderAgentActionsControl}
                composeReferences={composeReferences}
                onReferenceClick={handleReferenceClick}
                onReferenceReveal={handleReferenceReveal}
                onRemoveComposeReference={removeComposeReference}
                isDragOver={isDragOver}
                chatFirst={chatFirst}
                greetingTitle={chatFirst ? 'What are you working on?' : undefined}
                greetingSubtitle={
                  chatFirst
                    ? 'Ask for a notebook or a sequence. Results open beside your chat.'
                    : undefined
                }
                onSuggestionClick={
                  chatFirst
                    ? (suggestion) => {
                        handleComposerInputChange(suggestion);
                        inputRef.current?.focus();
                      }
                    : setInput
                }
                renderAssistantRouteSelector={renderAssistantRouteSelector}
                renderModelControls={renderComposerModelControls}
                renderRunningRouteStatus={() => null}
                renderRouteConfigurationPrompt={renderRouteConfigurationPrompt}
                renderRouteCheckingStatus={renderRouteCheckingStatus}
                renderComputeConnectPrompt={renderComputeConnectPrompt}
              />
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div
              ref={messagesScrollRef}
              className="flex-1 overflow-y-auto"
              data-testid="chat-messages-scroll"
              data-chat-scroll="transcript"
            >
              <div className="chat-content-rail">
                <div
                  className="mx-auto max-w-2xl space-y-4 p-4 pb-8"
                  data-testid="chat-transcript-rail"
                >
                  {displayMessages.map((msg) => {
                    const turn = msg.turnId ? turns[msg.turnId] : null;
                    const showAttribution = !!turn && attributionMessageIds.has(msg.id);
                    const collapsedTraceGroup = collapsedTraceGroupsByFirstId.get(msg.id);
                    if (collapsedTraceGroup) {
                      return (
                        <div key={collapsedTraceGroup.key} data-chat-scroll-anchor={msg.id}>
                          {showAttribution && turn && <TurnAttribution turn={turn} />}
                          {renderCollapsedTraceGroup(collapsedTraceGroup)}
                        </div>
                      );
                    }
                    if (hiddenCollapsedTraceIds.has(msg.id)) return null;

                    let renderedMessage: React.ReactNode = null;

                    if (msg.role === 'user') {
                      renderedMessage = (
                        <div
                          data-testid="user-message"
                          data-promoted-from-queue={
                            promotedMessageIdsRef.current.has(msg.id) ? 'true' : undefined
                          }
                          ref={(element) => {
                            if (element) userMessageElementsRef.current.set(msg.id, element);
                            else userMessageElementsRef.current.delete(msg.id);
                          }}
                          className={`max-w-full min-w-0 rounded-2xl px-4 py-2 text-sm [overflow-wrap:anywhere] ${
                            animatingPromotionIds.has(msg.id) ? 'animate-chat-queue-promotion' : ''
                          }`}
                        >
                          <FormattedMessage
                            content={msg.content}
                            role="user"
                            references={referenceMap}
                            referenceIds={
                              messageReferenceIds.get(msg.id) ??
                              queuedMessages.find((queued) => queued.id === msg.id)?.referenceIds
                            }
                            referenceResolution={referenceResolution}
                            referenceQueryState={
                              (referenceLoadFailures.get(msg.id) ?? 0) >=
                              MAX_REFERENCE_LOAD_ATTEMPTS
                                ? 'unavailable'
                                : undefined
                            }
                            onReferenceClick={handleReferenceClick}
                            onReferenceReveal={handleReferenceReveal}
                          />
                          {msg.attachments && msg.attachments.length > 0 && (
                            <div
                              className="mt-2 flex flex-wrap gap-1"
                              data-testid="message-attachments"
                            >
                              {msg.attachments.map((attachment) => (
                                <FilePill key={attachment.id} file={attachment} />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    } else if (msg.role === 'activity') {
                      const event = decodeAgentActivityMessage(msg.content);
                      if (event && isChatVisibleAgentTraceEvent(event)) {
                        renderedMessage = <AgentTraceRow event={event} />;
                      }
                    } else if (msg.role === 'tool') {
                      if (isReferenceCreationTool(msg.toolName)) {
                        try {
                          const data = JSON.parse(msg.content);
                          if (data.referenceData) {
                            renderedMessage = (
                              <ReferenceChip
                                reference={data.referenceData}
                                onClick={handleReferenceClick}
                                onReveal={handleReferenceReveal}
                                completedToolInput={data.input ?? {}}
                              />
                            );
                          }
                        } catch {}
                      }
                      if (!renderedMessage) {
                        renderedMessage = (
                          <ToolResultDisplay
                            toolName={msg.toolName || 'tool'}
                            content={msg.content}
                            allowReactivation
                          />
                        );
                      }
                    } else {
                      renderedMessage = (
                        <div data-testid="assistant-message">
                          <div className="text-sm text-fg leading-relaxed">
                            <FormattedMessage
                              content={msg.content}
                              document={inlineDocumentsByMessageId.get(msg.id)}
                              renderInlineReference={renderInlineReference}
                              references={referenceMap}
                              referenceIds={msg.referenceIds ?? messageReferenceIds.get(msg.id)}
                              referenceResolution={referenceResolution}
                              referenceQueryState={
                                (referenceLoadFailures.get(msg.id) ?? 0) >=
                                MAX_REFERENCE_LOAD_ATTEMPTS
                                  ? 'unavailable'
                                  : undefined
                              }
                              onReferenceClick={handleReferenceClick}
                              onReferenceReveal={handleReferenceReveal}
                            />
                          </div>
                          {msg.structuredOutput && (
                            <StructuredOutputCard receipt={msg.structuredOutput} />
                          )}
                        </div>
                      );
                    }

                    if (!renderedMessage) return null;

                    return (
                      <div
                        key={msg.id}
                        data-chat-scroll-anchor={msg.id}
                        data-testid={
                          msg.role === 'user' || msg.role === 'assistant'
                            ? 'chat-message'
                            : undefined
                        }
                        className={`group/message min-w-0 ${msg.role === 'user' ? 'ml-auto w-fit max-w-[80%] [overflow-wrap:anywhere]' : 'max-w-full'}`}
                      >
                        {showAttribution && turn && <TurnAttribution turn={turn} />}
                        {renderedMessage}
                        {(msg.role === 'user' || completedAnswerIds.has(msg.id)) && (
                          <div
                            data-testid="message-copy-actions"
                            className="flex items-center justify-end gap-2 pt-1 opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100"
                          >
                            <CopyButton
                              text={
                                extractMessageReferences(
                                  msg.role === 'assistant'
                                    ? sanitizeAssistantArtifactMetadata(msg.content)
                                    : msg.content
                                ).prose
                              }
                              size={12}
                              testId={msg.role === 'user' ? 'prompt-copy-button' : 'ai-copy-button'}
                              label={msg.role === 'user' ? 'Copy prompt' : 'Copy answer'}
                              showLabel
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {}
                  <StreamingSection
                    messagesScrollRef={messagesScrollRef}
                    referenceMap={referenceMap}
                    onReferenceClick={handleReferenceClick}
                    onReferenceReveal={handleReferenceReveal}
                    renderInlineReference={renderInlineReference}
                    stopGeneration={handleStopGeneration}
                    isStreaming={isStreaming}
                    activeTurn={activeTurn}
                    streamingBlocksOverride={viewStreamingBlocks}
                  />
                  {}
                  {isThinking && (
                    <div className="flex items-center gap-2" data-testid="ai-loading">
                      <ThinkingLabel />
                      <button
                        onClick={handleStopGeneration}
                        className="ml-2 p-1 rounded wp-interactive text-fg-muted transition-colors"
                        title="Pause agent (Escape)"
                        data-testid="ai-stop-button"
                      >
                        <StopIcon size={12} />
                      </button>
                    </div>
                  )}
                  <InlineAgentConfirmationHost
                    conversationId={viewConversationId}
                    scoped={scoped}
                    isActive={isOpen}
                  />
                </div>
              </div>
            </div>

            {}
            {!hideInput && (
              <div
                className="flex-shrink-0"
                onDragOver={handleExternalDragOver}
                onDragLeave={handleExternalDragLeave}
                onDrop={handleExternalDrop}
              >
                <div className="pb-4 pt-2">
                  <div className="chat-content-rail">
                    {}
                    {error && (
                      <div
                        data-testid="ai-error"
                        className="mb-2 px-3 py-1.5 rounded-lg bg-error/10 border border-error/20"
                      >
                        <p className="whitespace-pre-line text-xs leading-relaxed text-error">
                          {renderUserMessage(error)}
                        </p>
                      </div>
                    )}
                    {visibleQueuedMessages.length > 0 && (
                      <QueuedMessageStack
                        messages={visibleQueuedMessages}
                        referenceMap={referenceMap}
                        referenceResolution={referenceResolution}
                        onReferenceClick={handleReferenceClick}
                        onReferenceReveal={handleReferenceReveal}
                        onAdvanceThrough={handleAdvanceQueueThrough}
                        onMessageElementChange={handleQueuedMessageElementChange}
                      />
                    )}
                    <div
                      data-testid="chat-composer"
                      data-chat-composer-dirty={
                        input.trim().length > 0 ||
                        attachedFiles.length > 0 ||
                        composeReferences.length > 0
                      }
                      className={`
                        ${CHAT_COMPOSER_SURFACE_CLASS} shadow-lg
                        ${visibleQueuedMessages.length > 0 ? 'relative z-10' : ''}
                        focus-within:ring-2 focus-within:ring-accent/50 focus-within:border-accent/30
                        ${isDragOver ? 'ring-2 ring-accent border-accent/50 bg-accent/5' : ''}
                      `}
                    >
                      {(attachedFiles.length > 0 || composeReferences.length > 0) && (
                        <div className="flex flex-wrap gap-1 px-3 pt-3">
                          {attachedFiles.map((file) => (
                            <FilePill
                              key={file.id}
                              file={file}
                              onRemove={() => handleRemoveFile(file.id)}
                            />
                          ))}
                          {composeReferences.map((ref) => (
                            <ReferenceChip
                              key={ref.id}
                              reference={ref}
                              onClick={handleReferenceClick}
                              onReveal={handleReferenceReveal}
                              phase="draft"
                              onRemove={() => removeComposeReference(ref.id)}
                            />
                          ))}
                        </div>
                      )}
                      <div className="px-4 pt-2.5" data-testid="chat-composer-input-row">
                        <textarea
                          ref={inputRef}
                          value={input}
                          onChange={(e) => {
                            handleComposerInputChange(e.target.value);
                            autoResize(e.target);
                          }}
                          onKeyDown={handleKeyDown}
                          onPaste={handleSequencePaste}
                          placeholder={
                            attachedFiles.length > 0 ? 'Add a message or just send...' : 'Reply...'
                          }
                          rows={2}
                          data-testid="ai-input"
                          className="block w-full min-h-[52px] bg-transparent text-sm text-fg placeholder:text-fg-muted
                                     focus:outline-none disabled:opacity-50 resize-none overflow-y-auto"
                          style={{ maxHeight: '180px' }}
                        />
                      </div>
                      <ChatComposerToolbar
                        onAttach={handleAttachFile}
                        agentActions={renderAgentActionsControl()}
                        route={renderAssistantRouteSelector()}
                        onSend={handleSend}
                        sendDisabled={
                          (!input.trim() &&
                            attachedFiles.length === 0 &&
                            composeReferences.length === 0) ||
                          activeRouteSendBlocked
                        }
                        sendTitle={
                          activeRouteFallbackNotice && !activeRouteSendBlocked
                            ? activeRouteFallbackNotice
                            : activeDirectApiNeedsKey
                              ? 'Add a Direct API key before sending'
                              : activeCliNeedsLogin
                                ? 'Sign in to this CLI host before sending'
                                : activeRouteSendBlocked
                                  ? 'Waiting for AI route detection'
                                  : isLoading
                                    ? 'Queue message (Enter)'
                                    : 'Send (Enter)'
                        }
                      >
                        {renderComposerModelControls()}
                        {renderRouteConfigurationPrompt()}
                        {renderRouteCheckingStatus()}
                        {renderComputeConnectPrompt()}
                      </ChatComposerToolbar>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
