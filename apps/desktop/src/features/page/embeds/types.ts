import type { ReactNode } from 'react';
import type { TableOperationObservation } from '../../../shared/table-notebook-observation';

export interface EmbedRendererProps {
  type: string;

  refId: string;

  attrs: Record<string, unknown>;

  selected: boolean;

  documentManaged?: boolean;

  onRemove: () => void;

  onExpand?: () => void;

  onUpdateAttrs?: (attrs: Record<string, unknown>, observation?: TableOperationObservation) => void;
  onOpenTable?: (open: () => boolean) => void;

  onSelect?: () => void;

  onBlurToEditor?: () => void;
}

export interface PickerStageProps {
  data: Record<string, unknown>;

  onAdvance: (stageData: Record<string, unknown>) => void;

  onBack: () => void;

  onCancel: () => void;
}

export interface EmbedPreviewProps {
  refId: string;

  position?: { x: number; y: number };
}

export interface PickerStage {
  name: string;

  component: React.ComponentType<PickerStageProps>;
}

export type PickerSize = 'sm' | 'md' | 'lg' | 'xl';

export type PickerResult =
  | {
      nodeType: 'embed';

      embedType: string;

      refId: string;

      data?: Record<string, unknown>;
    }
  | {
      nodeType: 'mention';

      entityType: string;

      entityId: string | null;

      label: string;

      path?: string | null;

      contentHash?: string | null;

      objectUuid?: string | null;
    };

export interface SlashCommandDefinition {
  type: string;

  version: number;

  label: string;

  icon: ReactNode;

  keywords: string[];

  capturesEditorFocus?: boolean;

  importOnly?: boolean;

  picker: {
    stages: PickerStage[];

    size?: PickerSize;

    onComplete: (data: Record<string, unknown>) => PickerResult | Promise<PickerResult>;

    onCancel?: () => void;
  };

  Renderer?: React.ComponentType<EmbedRendererProps>;

  Preview?: React.ComponentType<EmbedPreviewProps>;
}

export interface EmbedDefinition extends SlashCommandDefinition {}

export interface EmbedNodeAttrs {
  type: string;

  version: number;

  refId: string;

  data: Record<string, unknown>;
}
