'use client';

import { useState, useCallback, useRef, type ReactNode } from 'react';
import type { Editor } from '@tiptap/core';
import type { FlowState } from './types';
import { FlowPopup } from './FlowPopup';
import { embedRegistry } from '../../embeds/registry';
import { FlowManagerContext } from './flow-context';
export { useFlowManager } from './flow-context';

interface FlowManagerProviderProps {
  children: ReactNode;
}

export function FlowManagerProvider({ children }: FlowManagerProviderProps) {
  const [activeFlow, setActiveFlow] = useState<FlowState | null>(null);
  const editorRef = useRef<Editor | null>(null);

  const startFlow = useCallback((flowName: string, startPos: number) => {
    const picker = embedRegistry.getPicker(flowName);
    if (!picker) {
      console.warn(`[FlowManager] No picker found for: ${flowName}`);
      return;
    }

    if (picker.stages.length === 0) {
      const editor = editorRef.current;
      if (editor && !editor.isDestroyed) {
        const success = embedRegistry.completePickerFlow(flowName, editor, {}, startPos);
        if (!success) {
          console.error(`[FlowManager] Failed to complete immediate flow: ${flowName}`);
        }
      } else {
        console.warn('[FlowManager] Cannot start flow: editor not available or destroyed');
      }
      return;
    }

    setActiveFlow({
      flowName,
      stageIndex: 0,
      data: {},
      startPos,
    });
  }, []);

  const advanceFlow = useCallback(
    (stageData: Record<string, unknown>) => {
      if (!activeFlow) return;

      const picker = embedRegistry.getPicker(activeFlow.flowName);
      if (!picker) return;

      const nextIndex = activeFlow.stageIndex + 1;
      const newData = { ...activeFlow.data, ...stageData };

      if (nextIndex >= picker.stages.length) {
        const editor = editorRef.current;
        if (editor && !editor.isDestroyed) {
          const success = embedRegistry.completePickerFlow(
            activeFlow.flowName,
            editor,
            newData,
            activeFlow.startPos
          );
          if (!success) {
            console.error(`[FlowManager] Failed to complete flow: ${activeFlow.flowName}`);
          }
        } else {
          console.warn('[FlowManager] Cannot complete flow: editor not available or destroyed');
        }
        setActiveFlow(null);
      } else {
        setActiveFlow({
          ...activeFlow,
          stageIndex: nextIndex,
          data: newData,
        });
      }
    },
    [activeFlow]
  );

  const goBack = useCallback(() => {
    if (!activeFlow) return;

    if (activeFlow.stageIndex === 0) {
      embedRegistry.cancelPickerFlow(activeFlow.flowName);
      setActiveFlow(null);
    } else {
      setActiveFlow({
        ...activeFlow,
        stageIndex: activeFlow.stageIndex - 1,
      });
    }
  }, [activeFlow]);

  const cancelFlow = useCallback(() => {
    if (activeFlow) {
      embedRegistry.cancelPickerFlow(activeFlow.flowName);
    }
    setActiveFlow(null);
  }, [activeFlow]);

  const setEditor = useCallback((editor: Editor | null) => {
    editorRef.current = editor;
  }, []);

  return (
    <FlowManagerContext.Provider
      value={{
        activeFlow,
        startFlow,
        advanceFlow,
        goBack,
        cancelFlow,
        setEditor,
      }}
    >
      {children}
      <FlowPopup returnFocusTarget={editorRef.current?.view.dom} />
    </FlowManagerContext.Provider>
  );
}
