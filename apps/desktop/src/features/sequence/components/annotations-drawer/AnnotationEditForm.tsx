import { useState, useEffect, useRef } from 'react';
import type { Annotation } from '@waypoint/sequence-utils';
import {
  initEditState,
  isAnnotationRangeValid,
  type EditState,
  type AnnotationSavePayload,
} from './helpers';
import { TypeCombobox, StrandToggle, ColorPaletteSelector, RangeFields } from './annotation-fields';

export function AnnotationEditForm({
  annotation,
  allAnnotations,
  circular,
  sequenceLength,
  onSave,
  onDelete,
  onCancel,
  onHeightChange,
}: {
  annotation: Annotation;
  allAnnotations: Annotation[];
  circular?: boolean;
  sequenceLength?: number;
  onSave: (data: AnnotationSavePayload) => void;
  onDelete: () => void;
  onCancel: () => void;
  onHeightChange?: (height: number) => void;
}) {
  const [edit, setEdit] = useState<EditState>(() => initEditState(annotation));
  const formRef = useRef<HTMLDivElement>(null);

  const seededBounds = useRef(`${annotation.start}..${annotation.end}`);
  useEffect(() => {
    const bounds = `${annotation.start}..${annotation.end}`;
    if (seededBounds.current === bounds) return;
    seededBounds.current = bounds;
    setEdit(initEditState(annotation));
  }, [annotation]);

  const startNum = parseInt(edit.start, 10);
  const endNum = parseInt(edit.end, 10);
  const isValid = isAnnotationRangeValid(edit.name, startNum, endNum, circular, sequenceLength);
  const handleSaveClick = () => {
    if (!isValid) return;
    onSave({
      name: edit.name.trim(),
      type: edit.type,
      direction: edit.direction,
      color: edit.color,
      start: startNum,
      end: endNum,
    });
  };

  useEffect(() => {
    const el = formRef.current;
    if (!el || !onHeightChange || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.borderBoxSize?.[0]?.blockSize ?? entries[0]?.contentRect.height ?? 0;
      if (h > 0) onHeightChange(h);
    });
    ro.observe(el);
    onHeightChange(el.offsetHeight);
    return () => ro.disconnect();
  }, [onHeightChange]);

  return (
    <div
      ref={formRef}
      data-testid="annotation-edit-form"
      className="px-2 pb-2 space-y-2 border-b border-border"
    >
      {}
      <div className="flex gap-2">
        <label className="flex-1 min-w-0">
          <span className="text-xs text-fg-muted">Name</span>
          <input
            data-testid="edit-name-input"
            type="text"
            value={edit.name}
            onChange={(e) => setEdit((s) => ({ ...s, name: e.target.value }))}
            className="w-full mt-0.5 px-2 py-1 text-sm border border-border rounded bg-bg focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </label>
        <label className="flex-1 min-w-0">
          <span className="text-xs text-fg-muted">Type</span>
          <div className="mt-0.5">
            <TypeCombobox
              value={edit.type}
              onChange={(type) => setEdit((s) => ({ ...s, type }))}
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
              value={edit.direction}
              onChange={(direction) => setEdit((s) => ({ ...s, direction }))}
            />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <ColorPaletteSelector
            value={edit.color}
            onChange={(color) => setEdit((s) => ({ ...s, color }))}
            compact
          />
        </div>
      </div>

      {}
      <RangeFields
        idPrefix="edit"
        start={edit.start}
        end={edit.end}
        onStartChange={(v) => setEdit((s) => ({ ...s, start: v }))}
        onEndChange={(v) => setEdit((s) => ({ ...s, end: v }))}
      />

      {}
      <div className="flex items-center gap-1.5 pt-0.5">
        <button
          type="button"
          data-testid="edit-delete-button"
          onClick={onDelete}
          className="px-2 py-1 text-xs text-red-500 hover:bg-red-500/10 rounded"
        >
          Delete
        </button>
        <div className="flex-1" />
        <button
          type="button"
          data-testid="edit-cancel-button"
          onClick={onCancel}
          title="Discard unsaved annotation edits"
          aria-label="Cancel annotation edit"
          className="px-3 py-1 text-xs border border-border text-fg-muted rounded hover:bg-bg-subtle"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="edit-save-button"
          onClick={handleSaveClick}
          disabled={!isValid}
          className="px-3 py-1 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Save
        </button>
      </div>
    </div>
  );
}
