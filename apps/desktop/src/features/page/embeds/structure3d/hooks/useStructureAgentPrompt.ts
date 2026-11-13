import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { canOpenSlashAsk } from '../../../../sequence/public/slash-ask/gate';
import { useCanvasStore } from '../../../../canvas/public/store';
import type { AskAiSelectionInput } from '../../../../ai/public/ask-ai-about-selection';
import { askAiAboutStructureView } from '../../../../ai/public/ask-ai-about-structure-view';
import type { Structure3dAttrs } from '../types';

const activeViewers = new WeakMap<Document, HTMLElement>();

interface StructureAgentPromptOptions {
  rootRef: RefObject<HTMLDivElement | null>;
  structureViewId: string;
  attrs: Structure3dAttrs | undefined;
  selectionInput: AskAiSelectionInput | null;
  selectedCount: number;
  workspaceRoot: string | null;
  enabled: boolean;
}

export function useStructureAgentPrompt(options: StructureAgentPromptOptions) {
  const current = useRef(options);
  current.current = options;
  const opening = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = useCallback(async () => {
    const input = current.current;
    if (!input.enabled || !input.attrs || opening.current) return;
    setError(null);
    if (input.selectedCount > 0 && !input.selectionInput) {
      setError(
        userMessage(
          'failure.this-selection-is-not-ready-to-attach-wait-for-the-structure-to-finish'
        )
      );
      return;
    }
    opening.current = true;
    setBusy(true);
    try {
      await askAiAboutStructureView({
        structureViewId: input.structureViewId,
        attrs: input.attrs,
        selection: input.selectionInput,
        workspaceRoot: input.workspaceRoot,
        sourcePanelId:
          input.rootRef.current
            ?.closest('[data-panel-content]')
            ?.getAttribute('data-panel-content') ?? undefined,
      });
    } catch (reason) {
      setError(toUserMessage(reason, 'failure.could-not-open-agent-chat'));
    } finally {
      opening.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const root = options.rootRef.current;
    if (!root) return;
    const doc = root.ownerDocument;
    const activate = () => activeViewers.set(doc, root);
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key !== '/' ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        !current.current.enabled
      )
        return;
      if (
        !canOpenSlashAsk({
          isEditMode: false,
          activeElement: doc.activeElement,
          hasOpenDialog: !!doc.querySelector('[role="dialog"], [aria-modal="true"]'),
        })
      )
        return;
      const pane = root.closest('[data-panel-content]');
      if (
        !pane ||
        pane.getAttribute('data-panel-content') !== useCanvasStore.getState().focusedPanelId ||
        !root.getClientRects().length
      )
        return;
      const active = activeViewers.get(doc);
      if (active && pane.contains(active) && active.getClientRects().length) {
        if (active !== root) return;
      } else {
        const visible = [
          ...pane.querySelectorAll<HTMLElement>('[data-structure-agent-host]'),
        ].filter((node) => node.getClientRects().length);
        if (visible.length !== 1 || visible[0] !== root) return;
      }
      event.preventDefault();
      void ask();
    };
    root.addEventListener('pointerdown', activate, true);
    doc.addEventListener('keydown', keydown, true);
    return () => {
      root.removeEventListener('pointerdown', activate, true);
      doc.removeEventListener('keydown', keydown, true);
      if (activeViewers.get(doc) === root) activeViewers.delete(doc);
    };
  }, [options.rootRef, options.enabled, ask]);

  return { ask, busy, error };
}
