import React, { useState, useCallback } from 'react';
import { cutSiteRecognitionSelection, type CutSite } from '@waypoint/sequence-utils';
import { SequenceViewer } from './SequenceViewer';
import { useCutSites } from './restriction-enzymes/useCutSites';
import type { WorkspaceEditorProps, Selection } from './types';

export interface WorkspaceEditorWithEnzymesProps extends WorkspaceEditorProps {
  renderToolbar?: (props: {
    isDropdownOpen: boolean;
    toggleDropdown: () => void;
    cutSitesState: ReturnType<typeof useCutSites>[0];
    cutSitesActions: ReturnType<typeof useCutSites>[1];
  }) => React.ReactNode;
  onCutSiteClick?: (cutSite: CutSite) => void;
  onCutSiteDoubleClick?: (cutSite: CutSite) => void;
  cutSitesScopeKey?: string;
}

export const WorkspaceEditorWithEnzymes: React.FC<WorkspaceEditorWithEnzymesProps> = ({
  sequence,
  keyboardActive,
  config,
  selection,
  onSelectionChange,
  onPositionClick,
  onAnnotationClick,
  className,
  style,
  renderToolbar,
  onCutSiteClick: _onCutSiteClick,
  onCutSiteDoubleClick,
  cutSitesScopeKey,
}) => {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const sequenceStr = sequence?.sequence ?? '';

  const [cutSitesState, cutSitesActions] = useCutSites(sequenceStr, cutSitesScopeKey, {
    catalogSummaryEnabled: isDropdownOpen,
  });

  const toggleDropdown = useCallback(() => {
    setIsDropdownOpen((prev) => !prev);
  }, []);

  const handleSelectionChange = useCallback(
    (newSelection: Selection | null) => {
      onSelectionChange?.(newSelection);
    },
    [onSelectionChange]
  );

  const _handleCutSiteDoubleClick = useCallback(
    (cutSite: CutSite) => {
      if (onSelectionChange) {
        onSelectionChange(cutSiteRecognitionSelection(cutSite, sequenceStr.length));
      }
      onCutSiteDoubleClick?.(cutSite);
    },
    [onSelectionChange, onCutSiteDoubleClick, sequenceStr.length]
  );

  return (
    <div style={{ position: 'relative', height: '100%', ...style }}>
      {}
      {renderToolbar?.({
        isDropdownOpen,
        toggleDropdown,
        cutSitesState,
        cutSitesActions,
      })}

      {}
      <SequenceViewer
        sequence={sequence}
        keyboardActive={keyboardActive}
        config={config}
        selection={selection}
        onSelectionChange={handleSelectionChange}
        onPositionClick={onPositionClick}
        onAnnotationClick={onAnnotationClick}
        className={className}
      />

      {}
      {}
      {}
    </div>
  );
};

export { useCutSites };
