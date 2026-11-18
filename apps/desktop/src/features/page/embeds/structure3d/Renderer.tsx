'use client';

import { structureFileSource } from './file-source';

import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import type { EmbedRendererProps } from '../types';
import { EmbedWrapper } from '../components/EmbedWrapper';
import { InlineSearch } from './components/InlineSearch';
import { LazyLoadedViewer } from './components/LazyLoadedViewer';
import { useStructure3dStore } from './store';
import { useCanvasStore } from '../../../canvas/public/store';
import type { Structure3dAttrs } from './types';

function useStableCallback<Args extends unknown[], R>(
  callback: ((...args: Args) => R) | undefined
): ((...args: Args) => R) | undefined {
  const ref = useRef(callback);
  ref.current = callback;
  return useMemo(() => {
    if (!callback) return undefined;
    return (...args: Args) => ref.current!(...args);
  }, [!!callback]);
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function getStage(attrs: Structure3dAttrs): 'empty' | 'loaded' {
  if (attrs.source && attrs.sourceId) {
    return 'loaded';
  }

  if (attrs.pdbId || attrs.uniprotId || attrs.url) {
    return 'loaded';
  }
  return 'empty';
}

export function Structure3dRenderer({
  refId: _refId,
  attrs,
  selected,
  onRemove,
  onUpdateAttrs,
  documentManaged = false,
}: EmbedRendererProps) {
  const data = attrs as Structure3dAttrs;
  const stage = getStage(data);

  const [isEditing, setIsEditing] = useState(false);
  const [originalAttrs, setOriginalAttrs] = useState<Structure3dAttrs | null>(null);

  const stableOnUpdateAttrs = useStableCallback(onUpdateAttrs);

  const generatedIdRef = useRef<string | null>(null);
  const structureId = useMemo(() => {
    if (data.id) return data.id as string;

    if (!generatedIdRef.current) {
      generatedIdRef.current = `structure-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    }
    return generatedIdRef.current;
  }, [data.id]);

  useEffect(() => {
    if ((documentManaged && stage === 'empty') || data.id || !generatedIdRef.current) return;
    const id = generatedIdRef.current;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) stableOnUpdateAttrs?.({ id });
    });
    return () => {
      cancelled = true;
    };
  }, [data.id, stableOnUpdateAttrs, stage, documentManaged]);

  const registerStructure = useStructure3dStore((state) => state.registerStructure);
  const expandedStructures = useStructure3dStore((state) => state.expandedStructures);
  const openWithSmartPlacement = useCanvasStore((state) => state.openWithSmartPlacement);
  const panels = useCanvasStore((state) => state.panels);

  const hasDataInStore = structureId in expandedStructures;

  const hasTabForStructure = useMemo(() => {
    return Object.values(panels).some((panel) =>
      panel.tabs.some((tab) => tab.type === 'structure' && tab.entityId === structureId)
    );
  }, [panels, structureId]);

  const isOpenInPanel = hasTabForStructure && hasDataInStore;

  const dataId = data.id;
  const dataSourceId = data.sourceId;
  const dataLabel = data.label;
  useEffect(() => {
    if (hasTabForStructure && dataId) {
      const label = dataLabel || dataSourceId || 'Structure';
      registerStructure(structureId, data, label, {
        onUpdate: stableOnUpdateAttrs,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omit `data` to prevent re-registration on every keystroke
  }, [
    hasTabForStructure,
    structureId,
    dataId,
    dataSourceId,
    dataLabel,
    registerStructure,
    stableOnUpdateAttrs,
  ]);

  const handleUpdateAttrs = useCallback(
    (newAttrs: Structure3dAttrs) => {
      onUpdateAttrs?.({ ...newAttrs, id: newAttrs.id ?? structureId });

      if (newAttrs.sourceId && isEditing) {
        setIsEditing(false);
        setOriginalAttrs(null);
      }
    },
    [onUpdateAttrs, isEditing, structureId]
  );

  const handleFileData = useCallback(
    (content: string, fileName: string) => {
      handleUpdateAttrs(structureFileSource(data, content, fileName));
    },
    [data, handleUpdateAttrs]
  );

  const handleStartEdit = useCallback(() => {
    setOriginalAttrs({ ...data });
    setIsEditing(true);

    onUpdateAttrs?.({
      ...data,
      sourceId: undefined,
      label: undefined,
      error: undefined,
    });
  }, [data, onUpdateAttrs]);

  const handleCancelEdit = useCallback(() => {
    if (originalAttrs) {
      onUpdateAttrs?.(originalAttrs);
    }
    setIsEditing(false);
    setOriginalAttrs(null);
  }, [originalAttrs, onUpdateAttrs]);

  const getLabel = () => {
    if (data.label) return data.label;
    if (data.name) return data.name;
    if (data.sourceId) return data.sourceId;
    if (data.pdbId) return data.pdbId;
    if (data.uniprotId) return data.uniprotId;
    if (isEditing && originalAttrs?.sourceId) return originalAttrs.sourceId;
    return 'New Structure';
  };

  const label = getLabel();

  const handleExpand = useCallback(() => {
    if (stage !== 'loaded') return;

    registerStructure(structureId, data, label, {
      onUpdate: stableOnUpdateAttrs,
    });

    openWithSmartPlacement('structure', structureId, label);
  }, [
    structureId,
    data,
    label,
    stage,
    registerStructure,
    openWithSmartPlacement,
    stableOnUpdateAttrs,
  ]);

  const handleFocusPanel = useCallback(() => {
    if (isOpenInPanel) {
      openWithSmartPlacement('structure', structureId, label);
    }
  }, [isOpenInPanel, structureId, label, openWithSmartPlacement]);

  const showInlineSearch = stage === 'empty' || isEditing;

  return (
    <EmbedWrapper
      type="3d"
      label={label}
      selected={selected}
      onRemove={onRemove}
      onExpand={stage === 'loaded' ? handleExpand : undefined}
    >
      <div className="p-3 relative select-none">
        {showInlineSearch ? (
          <div className="min-h-[80px] flex flex-col justify-center">
            <InlineSearch
              attrs={data}
              onUpdateAttrs={handleUpdateAttrs}
              onFileData={handleFileData}
              isEditing={isEditing}
              originalAttrs={originalAttrs || undefined}
              onCancelEdit={isEditing ? handleCancelEdit : undefined}
            />
            <div className="text-xs text-fg-muted/50 mt-2">
              {isEditing
                ? 'Type new ID or Escape to cancel'
                : 'Type source name and press Tab, or drop a .pdb/.cif file'}
            </div>
          </div>
        ) : isOpenInPanel ? (
          <div
            className="min-h-[200px] flex items-center justify-center cursor-pointer wp-interactive rounded-md transition-colors"
            onClick={handleFocusPanel}
            title="Click to focus the panel"
          >
            <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-subtle border border-border rounded-md shadow-sm">
              <LockIcon className="w-4 h-4 text-fg-muted" />
              <span className="text-sm text-fg-muted">Viewing in panel</span>
            </div>
          </div>
        ) : (
          <LazyLoadedViewer
            attrs={data}
            onUpdateAttrs={handleUpdateAttrs}
            onReset={handleStartEdit}
            structureId={structureId}
          />
        )}
      </div>
    </EmbedWrapper>
  );
}
