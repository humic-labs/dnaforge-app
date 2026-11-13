import { createEntityReference, type DBEntityReference } from '../../db/entity-references';
import { getCurrentWorkspaceScope, useWorkspaceStore } from '../../stores/workspaceStore';
import { resolveChatWorkspacePath } from '../canvas/public/components/chat-workspace';
import type { ActiveOverlaySnapshot } from './selection-descriptor/active-overlays';
import { buildSelectionDescriptor } from './selection-descriptor/build';
import { hasCompleteStructureResidueIdentities } from './selection-descriptor/structure';
import { isSelectionDescriptor, type SelectionRegion } from './selection-descriptor/types';
import { useChatStore } from './hooks/useChat';
import type { HighlightGroup, ResidueLocation } from '../page/public/embeds/structure3d/types';
import type { MolecularViewTarget } from '../../shared/molecular-view';
import { molecularViewTargetLocator } from '../../shared/molecular-reference';
import {
  molecularDocumentReferenceLocator,
  type MolecularDocumentReference,
} from '../../shared/molecular-document-reference';
import type {
  LinkedCodingDnaContext,
  StructureVisibleRepresentation,
} from './selection-descriptor/types';

export interface AskAiSequenceSelectionInput {
  entityType: 'sequence_region';

  displayLabel: string;

  locator: string;

  workspaceRootPath?: string | null;

  deepLinkParams: { start: number; end: number; wraps?: boolean };

  seedText?: string;

  activeOverlays?: ActiveOverlaySnapshot;

  regions?: SelectionRegion[];

  anchor?: { x: number; y: number };
}

export interface AskAiStructureSelectionInput {
  entityType: 'structure';
  molecularDocumentReference?: MolecularDocumentReference;

  molecularViewTarget?: MolecularViewTarget;
  displayLabel: string;

  locator: string;

  workspaceRootPath?: string | null;
  deepLinkParams: { highlightGroups: HighlightGroup[] };
  structure: {
    residues: ReadonlyArray<ResidueLocation>;
    visibleRepresentations: StructureVisibleRepresentation[];
    linkedCodingDna?: LinkedCodingDnaContext;
  };
  seedText?: string;
  anchor?: { x: number; y: number };
}

export type AskAiSelectionInput = AskAiSequenceSelectionInput | AskAiStructureSelectionInput;

export interface AskAiRouteOptions {
  route?: 'picker' | 'seed-focused-chat';
}

export async function createAskAiSelectionReference(
  input: AskAiSelectionInput
): Promise<DBEntityReference> {
  let descriptor: Record<string, unknown> | null = null;
  try {
    const result =
      input.entityType === 'structure'
        ? buildSelectionDescriptor({
            kind: 'structure',
            path: input.locator,
            label: input.displayLabel,
            ...input.structure,
          })
        : buildSelectionDescriptor({
            kind: 'sequence_region',
            documentId: input.locator,
            range: input.deepLinkParams,
            activeOverlays: input.activeOverlays,
            regions: input.regions,
          });
    if (isSelectionDescriptor(result)) {
      descriptor = result as unknown as Record<string, unknown>;
    }
  } catch {
    descriptor = null;
  }

  if (input.entityType === 'structure' && !hasCompleteStructureResidueIdentities(descriptor)) {
    throw new Error(
      'Cannot attach a structure selection before every selected residue identity is resolved.'
    );
  }
  if (input.entityType === 'structure' && input.molecularViewTarget && descriptor)
    descriptor.molecularViewTarget = input.molecularViewTarget;
  if (input.entityType === 'structure' && input.molecularDocumentReference && descriptor)
    descriptor.molecularDocumentReference = input.molecularDocumentReference;

  const referenceDeepLinkParams =
    input.entityType === 'structure'
      ? {
          highlightGroups: input.deepLinkParams.highlightGroups.map((group) => ({
            ...group,
            renderMode: 'selection' as const,
          })),
        }
      : input.deepLinkParams;

  const workspaceRootPath = input.workspaceRootPath ?? null;

  return createEntityReference({
    entityType:
      input.entityType === 'structure' && input.molecularDocumentReference
        ? 'molecular-document'
        : input.entityType,
    displayLabel: input.displayLabel,
    locator:
      input.entityType === 'structure' && input.molecularDocumentReference
        ? molecularDocumentReferenceLocator(input.molecularDocumentReference)
        : input.entityType === 'structure' && input.molecularViewTarget
          ? molecularViewTargetLocator(input.molecularViewTarget)
          : input.entityType === 'structure' && !input.locator.startsWith('entity://')
            ? `entity://structure/${input.locator}`
            : input.locator,
    deepLinkParams: referenceDeepLinkParams,
    data: descriptor,
    source: 'user',
    workspaceScope:
      input.entityType === 'structure' && input.molecularDocumentReference
        ? input.molecularDocumentReference.projectId
        : getCurrentWorkspaceScope(),
    workspaceRootPath,
  });
}

export async function askAiAboutSelection(
  input: AskAiSelectionInput,
  options?: AskAiRouteOptions
): Promise<DBEntityReference> {
  const { useCanvasStore } = await import('../canvas/public/store');
  const sourcePanelId = useCanvasStore.getState().focusedPanelId ?? undefined;
  const ref = await createAskAiSelectionReference(input);

  if (options?.route === 'seed-focused-chat') {
    const { conversationId } = useCanvasStore.getState().openChatTab();
    useChatStore.getState().setPendingDraft({
      conversationId,
      references: [ref],
      text: input.seedText,
    });
    return ref;
  }

  const chatWorkspacePath = resolveChatWorkspacePath(null, useWorkspaceStore.getState().folders);
  useChatStore.getState().setPendingAskAiPicker({
    reference: ref,
    chatWorkspacePath,
    seedText: input.seedText,

    anchor: input.anchor,
    sourcePanelId,
  });

  return ref;
}
