import { useState, useEffect, useRef, useCallback } from 'react';
import type { Annotation } from '@waypoint/sequence-utils';
import type { AnnotationDraft } from '../../types';
import {
  initAddState,
  isAnnotationRangeValid,
  annotationKindForType,
  pickCdsQualifiers,
  hasQualifiers,
  stripCdsQualifiers,
  type AddState,
  type AnnotationRange,
} from './helpers';
import { TypeCombobox, StrandToggle, ColorPaletteSelector, RangeFields } from './annotation-fields';

export function AnnotationAddForm({
  allAnnotations,
  circular,
  sequenceLength,
  initialRange,
  initialDraft,
  highlightSelectionRange,
  onSave,
  onCancel,
  onDraftEdit,
}: {
  allAnnotations: Annotation[];
  circular?: boolean;
  sequenceLength?: number;
  initialRange?: AnnotationRange | null;
  highlightSelectionRange?: AnnotationRange | null;
  initialDraft?: AnnotationDraft | null;
  onSave: (annotation: Annotation) => void;
  onCancel: () => void;
  onDraftEdit?: (draft: AnnotationDraft | null) => void;
}) {
  const [add, setAdd] = useState<AddState>(() => initAddState(initialDraft, initialRange));
  const cdsQualifierBackupRef = useRef<Record<string, string[]> | null>(
    annotationKindForType(add.type) === 'cds' ? pickCdsQualifiers(add.qualifiers) : null
  );
  const highlightSelectionLabel = highlightSelectionRange
    ? `${highlightSelectionRange.start}..${highlightSelectionRange.end}`
    : null;
  const setAnnotationType = useCallback((type: string) => {
    setAdd((s) => {
      if (s.type === 'CDS') {
        const cdsQualifiers = pickCdsQualifiers(s.qualifiers);
        if (hasQualifiers(cdsQualifiers)) {
          cdsQualifierBackupRef.current = cdsQualifiers;
        }
      }
      if (type === 'CDS') {
        return {
          ...s,
          type,
          qualifiers: {
            ...s.qualifiers,
            ...(cdsQualifierBackupRef.current ?? {}),
          },
        };
      }
      return {
        ...s,
        type,
        qualifiers: stripCdsQualifiers(s.qualifiers),
      };
    });
  }, []);
  const applyHighlightSelection = useCallback(() => {
    if (!highlightSelectionRange) return;
    setAdd((s) => ({
      ...s,
      start: String(highlightSelectionRange.start),
      end: String(highlightSelectionRange.end),
    }));
  }, [highlightSelectionRange]);

  const isInitialMountRef = useRef(true);
  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }
    if (!onDraftEdit) return;
    const startNum = parseInt(add.start, 10);
    const endNum = parseInt(add.end, 10);
    if (isNaN(startNum) || isNaN(endNum) || startNum < 1 || endNum < startNum) {
      onDraftEdit(null);
      return;
    }
    const qualifiers = add.type === 'CDS' ? add.qualifiers : stripCdsQualifiers(add.qualifiers);
    onDraftEdit({
      type: add.type,
      name: add.name.trim(),
      start: startNum,
      end: endNum,
      direction: add.direction,
      color: add.color,
      qualifiers: hasQualifiers(qualifiers) ? { ...qualifiers } : undefined,
    });
  }, [add, onDraftEdit]);

  const startNum = parseInt(add.start, 10);
  const endNum = parseInt(add.end, 10);
  const isValid = isAnnotationRangeValid(add.name, startNum, endNum, circular, sequenceLength);

  const handleSave = () => {
    if (!isValid) return;
    const qualifiers = add.type === 'CDS' ? add.qualifiers : stripCdsQualifiers(add.qualifiers);
    const annotation: Annotation = {
      name: add.name.trim(),
      type: add.type,
      direction: add.direction,
      color: add.color,
      start: startNum,
      end: endNum,
    };
    if (hasQualifiers(qualifiers)) {
      annotation.qualifiers = { ...qualifiers };
    }
    onSave(annotation);
  };

  return (
    <div
      data-testid="annotation-add-form"
      className="px-2 py-2 space-y-2 border-b border-border bg-accent/5"
    >
      {}
      <div className="flex gap-2">
        <label className="flex-1 min-w-0">
          <span className="text-xs text-fg-muted">Name</span>
          <input
            data-testid="add-name-input"
            type="text"
            value={add.name}
            onChange={(e) => setAdd((s) => ({ ...s, name: e.target.value }))}
            placeholder="Feature name"
            autoFocus
            className="w-full mt-0.5 px-2 py-1 text-sm border border-border rounded bg-bg focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </label>
        <label className="flex-1 min-w-0">
          <span className="text-xs text-fg-muted">Type</span>
          <div className="mt-0.5">
            <TypeCombobox
              value={add.type}
              onChange={setAnnotationType}
              allAnnotations={allAnnotations}
            />
          </div>
        </label>
      </div>

      {}
      <div className="flex gap-3 items-start">
        <div className="shrink-0">
          <span className="text-xs text-fg-muted block">Strand</span>
          <div className="mt-0.5">
            <StrandToggle
              value={add.direction}
              onChange={(direction) => setAdd((s) => ({ ...s, direction }))}
            />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <ColorPaletteSelector
            value={add.color}
            onChange={(color) => setAdd((s) => ({ ...s, color }))}
            compact
          />
        </div>
      </div>

      {}
      <RangeFields
        idPrefix="add"
        start={add.start}
        end={add.end}
        onStartChange={(v) => setAdd((s) => ({ ...s, start: v }))}
        onEndChange={(v) => setAdd((s) => ({ ...s, end: v }))}
        trailing={
          highlightSelectionRange ? (
            <button
              data-testid="apply-highlight-boundaries-button"
              type="button"
              title={`Set Start and End to the current highlight selection (${highlightSelectionLabel})`}
              onClick={applyHighlightSelection}
              className="mt-1 text-left text-[11px] font-medium text-green-700 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300 focus:outline-none focus:ring-1 focus:ring-green-500 rounded px-1 py-0.5"
            >
              Apply highlight selection as annotation boundaries
            </button>
          ) : undefined
        }
      />

      {}
      <div className="flex items-center gap-1.5 pt-0.5">
        <div className="flex-1" />
        <button
          type="button"
          data-testid="add-cancel-button"
          onClick={onCancel}
          title="Discard annotation draft"
          aria-label="Cancel annotation draft"
          className="px-3 py-1 text-xs border border-border text-fg-muted rounded hover:bg-bg-subtle"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="add-save-button"
          onClick={handleSave}
          disabled={!isValid}
          className="px-3 py-1 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Add
        </button>
      </div>
    </div>
  );
}
