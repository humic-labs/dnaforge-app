import { useMemo } from 'react';
import { useCanvasStore } from './store';
import { resolveTabEditor } from './tab-editor';
import { isTabDirty } from './artifact-document-lifecycle';
import type { PanelState, Tab, TabType } from './types';
import { sequenceDisplayName } from '../../shared/sequence-presentation';
import {
  getCurrentCatalogFileForEntity,
  getCurrentSequenceFileForDocumentId,
} from '../../db/workspace-catalog';

export interface TabMenuPresentation {
  readonly id: string;
  readonly type: TabType;
  readonly label: string;
  readonly isDirty: boolean;
  readonly canRenameManagedSequence: boolean;
  readonly canRevealInWorkspace: boolean;
}

export interface PanelMenuPresentation {
  readonly tabs: readonly TabMenuPresentation[];
}

export interface TabStripPresentation {
  readonly id: string;
  readonly type: TabType;
  readonly label: string;
  readonly isDirty: boolean;
  readonly isIndexedSequence: boolean;
  readonly isMolecularDocument?: boolean;
}

export function projectTabStripTab(tab: Tab): TabStripPresentation {
  const editor = resolveTabEditor(tab);
  return {
    id: tab.id,
    type: editor.type,
    label: tab.type === 'sequence' ? sequenceDisplayName(tab.label) : tab.label,
    isDirty: isTabDirty(tab),
    ...(tab.type === 'structure' && tab.initialStructureAttrs?.molecularDocumentId
      ? { isMolecularDocument: true }
      : {}),
    isIndexedSequence:
      editor.type === 'sequence' &&
      (tab.sequenceDocument?.kind === 'indexed-sequence' || Boolean(tab.indexedGenome)),
  };
}

const DIRECT_FILE_TYPES = new Set<TabType>([
  'file',
  'text',
  'image',
  'html',
  'scientific-document',
]);

export function projectTabMenuPanels(
  panels: Readonly<Record<string, PanelState>>
): Readonly<Record<string, PanelMenuPresentation>> {
  return Object.fromEntries(
    Object.entries(panels).map(([id, panel]) => [
      id,
      {
        tabs: panel.tabs.map(
          (tab): TabMenuPresentation => ({
            id: tab.id,
            type: tab.type,
            label: tab.type === 'sequence' ? sequenceDisplayName(tab.label) : tab.label,
            isDirty: isTabDirty(tab),
            canRenameManagedSequence:
              tab.type === 'sequence' &&
              !tab.readOnly &&
              tab.sequenceDocument?.kind === 'managed-sequence',
            canRevealInWorkspace:
              Boolean(tab.trackView) ||
              DIRECT_FILE_TYPES.has(tab.type) ||
              tab.type === 'page' ||
              tab.type === 'design' ||
              (tab.type === 'sequence' &&
                (tab.sequenceDocument?.kind === 'managed-sequence' ||
                  tab.sequenceDocument?.kind === 'catalog-sequence')),
          })
        ),
      },
    ])
  );
}

export function useTabMenuPanels(): Readonly<Record<string, PanelMenuPresentation>> {
  const panels = useCanvasStore((state) => state.panels);
  return useMemo(() => projectTabMenuPanels(panels), [panels]);
}

export async function resolveTabWorkspacePath(
  panelId: string,
  tabId: string
): Promise<string | null> {
  const tab: Tab | undefined = useCanvasStore
    .getState()
    .panels[panelId]?.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return null;
  if (tab.legacyMigrationRead) {
    const { revalidateLegacyMigrationFastaRead } =
      await import('../../services/legacy-migration-fasta-read');
    return (await revalidateLegacyMigrationFastaRead(tab.legacyMigrationRead)).path;
  }
  if (tab.trackView) return tab.trackView.path;
  if (tab.type === 'sequence') {
    const ref = tab.sequenceDocument;
    if (ref?.kind === 'managed-sequence') return ref.packageRoot;
    if (ref?.kind !== 'catalog-sequence') return null;
    return (await getCurrentSequenceFileForDocumentId(ref.entityId))?.path ?? null;
  }
  if (DIRECT_FILE_TYPES.has(tab.type)) return tab.entityId;
  if (tab.type !== 'page' && tab.type !== 'design') return null;
  return (await getCurrentCatalogFileForEntity(tab.entityId))?.path ?? null;
}
