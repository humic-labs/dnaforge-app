import type { Editor } from '@tiptap/core';

export interface FlowState {
  flowName: string;
  stageIndex: number;
  data: Record<string, unknown>;
  startPos: number;
}

export interface FlowManagerContextValue {
  activeFlow: FlowState | null;
  startFlow: (flowName: string, startPos: number) => void;
  advanceFlow: (stageData: Record<string, unknown>) => void;
  goBack: () => void;
  cancelFlow: () => void;
  setEditor: (editor: Editor | null) => void;
}
