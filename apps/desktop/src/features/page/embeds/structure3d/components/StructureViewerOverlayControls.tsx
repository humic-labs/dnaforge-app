'use client';

import { toUserMessage } from '@waypoint/user-messages';
import { memo, type ReactNode, type Ref } from 'react';
import { GearIcon } from './Icons';
import { SparklesIcon } from '../../../../../components/icons/glyphs';
import { STRUCTURE_VIEWER_BUTTON_CLASS } from './structureViewerStyles';
import {
  StructureSelectionLegend,
  type StructureSelectionLegendProps,
} from './StructureSelectionLegend';

interface StructureViewerOverlayControlsProps extends StructureSelectionLegendProps {
  isSettingsOpen?: boolean;
  onToggleSettings?: () => void;
  settingsTriggerRef?: Ref<HTMLButtonElement>;
  onAskAgent?: () => void;
  agentBusy?: boolean;
  agentDisabled?: boolean;
  agentError?: string | null;
  presentationControls?: ReactNode;
}

export const StructureViewerOverlayControls = memo(function StructureViewerOverlayControls({
  isSettingsOpen,
  onToggleSettings,
  settingsTriggerRef,
  onAskAgent,
  agentBusy,
  agentDisabled,
  agentError,
  presentationControls,
  ...selectionProps
}: StructureViewerOverlayControlsProps) {
  const showPrimaryControls = !!onToggleSettings || !!onAskAgent || !!presentationControls;
  return (
    <>
      {showPrimaryControls && (
        <div
          data-testid="structure-viewer-overlay-controls"
          className="pointer-events-none absolute left-2 right-2 top-2 z-20 flex items-start gap-2"
        >
          <div
            data-testid="structure-primary-overlay-controls"
            className="pointer-events-auto flex w-full min-w-0 max-w-full flex-wrap items-center gap-3"
          >
            {presentationControls}
            <div
              data-testid="structure-view-controls"
              className="ml-auto flex shrink-0 items-center gap-1.5"
            >
              {onAskAgent && (
                <button
                  type="button"
                  data-testid="structure-ask-agent"
                  onClick={onAskAgent}
                  disabled={agentDisabled || agentBusy}
                  title="Ask Agent (/)"
                  aria-label="Ask Agent"
                  className={`${STRUCTURE_VIEWER_BUTTON_CLASS} flex w-7 items-center justify-center !px-0`}
                >
                  <SparklesIcon size={13} className={agentBusy ? 'animate-pulse' : undefined} />
                </button>
              )}
              {agentError && (
                <span role="alert" className="max-w-64 rounded bg-bg px-2 py-1 text-xs text-error">
                  {toUserMessage(agentError, 'structure.failed')}
                </span>
              )}
              {onToggleSettings && (
                <button
                  type="button"
                  data-testid="structure-advanced-settings-toggle"
                  ref={settingsTriggerRef}
                  onClick={onToggleSettings}
                  className={`${STRUCTURE_VIEWER_BUTTON_CLASS} flex w-7 items-center justify-center !px-0 ${isSettingsOpen ? '!text-accent' : ''}`}
                  title="Advanced settings"
                  aria-label="Advanced settings"
                >
                  <GearIcon size={12} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      <StructureSelectionLegend {...selectionProps} />
    </>
  );
});
