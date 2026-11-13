'use client';

import { createContext, useCallback, useMemo } from 'react';
import { openDocument } from '@/features/document-opening/open-document';
import { useCanvasStore } from '@/features/canvas/store';
import { openSequenceDocument } from '@/features/document-opening/compat';
import { resolveSequenceDocumentById } from '@/features/sequence/sequence-document-repository';
import { getSequenceWithPath } from '@/db';
import type { TabType } from '../tab-kind';
import { useWorkspaceStore } from '@/stores/workspaceStore';

interface PanelContextValue {
  openPage: (pageId: string, label?: string) => void;
  openSequence: (documentId: string, label?: string) => void;
  openStructure: (structureId: string, label?: string) => void;
  openTab: (type: TabType, entityId: string, label: string) => void;
  closeActiveTab: () => void;
}

const PanelContext = createContext<PanelContextValue | null>(null);

export function PanelContextProvider({ children }: { children: React.ReactNode }) {
  const { openWithSmartPlacement, closeActiveTab } = useCanvasStore();

  const openPage = useCallback((pageId: string, label?: string) => {
    void openDocument({
      target: { kind: 'record', tabType: 'page', entityId: pageId },
      label: label || `Page ${pageId}`,
      placement: { kind: 'smart' },
      source: 'menu',
    });
  }, []);

  const openSequence = useCallback(async (inputDocumentId: string, label?: string) => {
    let documentId = inputDocumentId;
    if (documentId.startsWith('seq_')) {
      const numericId = parseInt(documentId.slice(4), 10);
      if (!isNaN(numericId)) {
        try {
          const seq = await getSequenceWithPath(numericId);
          if (seq) {
            documentId = seq.document_id;
            label = label || seq.name;
          } else {
            console.error(`Sequence ${documentId} not found in database`);
            return;
          }
        } catch (error) {
          console.error('Failed to look up sequence:', error);
          return;
        }
      }
    }

    const resolved = await resolveSequenceDocumentById(
      documentId,
      useWorkspaceStore.getState().folders.map((folder) => folder.path)
    );
    await openSequenceDocument(resolved.ref, {
      label: label || resolved.name || 'Sequence',
    });
  }, []);

  const openStructure = useCallback((structureId: string, label?: string) => {
    void openDocument({
      target: { kind: 'record', tabType: 'structure', entityId: structureId },
      label: label || `Structure ${structureId}`,
      placement: { kind: 'smart' },
      source: 'menu',
    });
  }, []);

  const openTab = useCallback(
    (type: TabType, entityId: string, label: string) => {
      if (type === 'sequence') void openSequence(entityId, label);
      else if (type === 'chat') openWithSmartPlacement(type, entityId, label);
      else
        void openDocument({
          target: { kind: 'record', tabType: type, entityId },
          label,
          placement: { kind: 'smart' },
          source: 'menu',
        });
    },
    [openWithSmartPlacement, openSequence]
  );

  const value = useMemo(
    () => ({
      openPage,
      openSequence,
      openStructure,
      openTab,
      closeActiveTab,
    }),
    [openPage, openSequence, openStructure, openTab, closeActiveTab]
  );

  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}
