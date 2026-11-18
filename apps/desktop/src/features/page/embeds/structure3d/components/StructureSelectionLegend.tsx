import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import type { HighlightGroup, ResidueInteractionState } from '../types';
import { resolveHighlightGroupColor, selectionToHighlightGroup } from '../utils/highlightUtils';
import { ColorLegend } from './ColorLegend';
import { StructureTargetButton } from './StructureTargetButton';

export interface StructureSelectionLegendProps extends Omit<
  ComponentProps<typeof ColorLegend>,
  'legends'
> {
  legends?: ComponentProps<typeof ColorLegend>['legends'];
  interactionState: ResidueInteractionState;
  highlightGroups?: HighlightGroup[];
  selectionLoadErrors?: ReadonlyArray<string>;
  onSaveSelection?: (group: HighlightGroup) => void | Promise<void>;
  onClearSelection?: () => void;
  onCenterSelection?: () => void;
  onActivateSelection?: (id: string) => void;
  onTargetSavedSelection?: (id: string) => void;
  onRenameSelection?: (id: string, label: string) => void | Promise<void>;
  onDeleteSelection?: (id: string) => void;
}

const actionClass = 'rounded px-1.5 py-0.5 text-fg-muted wp-interactive disabled:opacity-50';

export function StructureSelectionLegend({
  legends = [],
  colorKeys = [],
  namedGroups,
  onSelectNamedGroup,
  onFocusNamedGroup,
  interactionState,
  highlightGroups = [],
  selectionLoadErrors = [],
  onSaveSelection,
  onClearSelection,
  onCenterSelection,
  onActivateSelection,
  onTargetSavedSelection,
  onRenameSelection,
  onDeleteSelection,
}: StructureSelectionLegendProps) {
  const [saveLabel, setSaveLabel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const selected = interactionState.selected;
  const hasSelection = selected.length > 0;
  const selectionKey = JSON.stringify(selected);
  const latestSelectionKey = useRef(selectionKey);
  latestSelectionKey.current = selectionKey;

  useEffect(() => {
    setSaveLabel(null);
    setSaveError(null);
  }, [selectionKey]);

  const save = async () => {
    if (!saveLabel?.trim() || !onSaveSelection || saving || !hasSelection) return;
    const group = selectionToHighlightGroup(selected, saveLabel.trim(), highlightGroups);
    if (!group) return;
    setSaving(true);
    setSaveError(null);
    const savingSelectionKey = selectionKey;
    try {
      await onSaveSelection(group);
      setSaveLabel(null);
      if (latestSelectionKey.current === savingSelectionKey) onClearSelection?.();
    } catch (error) {
      setSaveError(toUserMessage(error, 'structure.failed'));
    } finally {
      setSaving(false);
    }
  };

  const rename = async () => {
    if (!editing?.label.trim() || !onRenameSelection || renaming) return;
    setRenaming(true);
    setRenameError(null);
    try {
      await onRenameSelection(editing.id, editing.label.trim());
      setEditing(null);
    } catch (error) {
      setRenameError(toUserMessage(error, 'structure.failed'));
    } finally {
      setRenaming(false);
    }
  };

  const hasRows = hasSelection || highlightGroups.length > 0 || selectionLoadErrors.length > 0;
  return (
    <ColorLegend
      legends={legends}
      colorKeys={colorKeys}
      namedGroups={namedGroups}
      onSelectNamedGroup={onSelectNamedGroup}
      onFocusNamedGroup={onFocusNamedGroup}
    >
      {hasRows ? (
        <div
          className={`space-y-2 ${legends.length || colorKeys.length ? 'border-b border-border pb-2' : ''}`}
        >
          {hasSelection && (
            <div data-testid="structure-selection-controls" className="space-y-1">
              {saveLabel !== null ? (
                <div className="flex flex-wrap items-center gap-1">
                  <input
                    aria-label="Selection name"
                    data-testid="structure-selection-save-label"
                    className="min-w-0 flex-1 rounded border border-border bg-bg px-1.5 py-1 text-xs text-fg"
                    autoFocus
                    value={saveLabel}
                    disabled={saving}
                    placeholder="Selection name"
                    onChange={(event) => setSaveLabel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.stopPropagation();
                        event.preventDefault();
                        void save();
                      }
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        setSaveLabel(null);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className={actionClass}
                    disabled={!saveLabel.trim() || saving}
                    onClick={() => void save()}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className={actionClass}
                    disabled={saving}
                    onClick={() => setSaveLabel(null)}
                  >
                    Cancel
                  </button>
                  {saveError && (
                    <span
                      role="alert"
                      data-testid="structure-selection-save-error"
                      className="basis-full text-error"
                    >
                      {toUserMessage(saveError, 'structure.failed')}
                    </span>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <span
                    data-testid="structure-selection-count"
                    className="min-w-0 flex-1 text-fg-muted"
                  >
                    {selected.length} {selected.length === 1 ? 'residue' : 'residues'} selected
                  </span>
                  <StructureTargetButton label="selection" onClick={onCenterSelection} />
                  {onSaveSelection && (
                    <button
                      type="button"
                      className={actionClass}
                      onClick={() => {
                        setSaveError(null);
                        setSaveLabel('');
                      }}
                    >
                      Save
                    </button>
                  )}
                  {onClearSelection && (
                    <button
                      type="button"
                      data-testid="structure-clear-selection-button"
                      className={actionClass}
                      onClick={onClearSelection}
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {highlightGroups.map((group) => (
            <div
              key={group.id}
              className="space-y-1"
              data-testid="structure-saved-selection-row"
              data-selection-id={group.id}
            >
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`Select ${group.label}`}
                  disabled={!onActivateSelection}
                  onClick={() => onActivateSelection?.(group.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-fg-muted enabled:hover:underline"
                >
                  <span
                    className="h-3 w-3 shrink-0 rounded-sm"
                    style={{ backgroundColor: resolveHighlightGroupColor(group) }}
                  />
                  <span className="min-w-0 break-words">{group.label}</span>
                </button>
                <StructureTargetButton
                  label={group.label}
                  onClick={
                    onTargetSavedSelection ? () => onTargetSavedSelection(group.id) : undefined
                  }
                />
                {(onRenameSelection || onDeleteSelection) && (
                  <details className="relative">
                    <summary
                      aria-label={`Manage ${group.label}`}
                      title={`Manage ${group.label}`}
                      className="cursor-pointer list-none rounded px-1 text-fg-muted wp-interactive"
                    >
                      ···
                    </summary>
                    <div className="absolute bottom-full right-0 z-30 rounded border border-border bg-bg p-1 shadow-lg">
                      {onRenameSelection && (
                        <button
                          type="button"
                          className={`${actionClass} block w-full text-left`}
                          onClick={(event) => {
                            event.currentTarget.closest('details')?.removeAttribute('open');
                            setRenameError(null);
                            setEditing({ id: group.id, label: group.label });
                          }}
                        >
                          Rename
                        </button>
                      )}
                      {onDeleteSelection && (
                        <button
                          type="button"
                          className={`${actionClass} block w-full text-left`}
                          onClick={() => onDeleteSelection(group.id)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </details>
                )}
              </div>
              {editing?.id === group.id && (
                <div className="flex flex-wrap gap-1">
                  <input
                    aria-label={`Rename ${group.label}`}
                    value={editing.label}
                    disabled={renaming}
                    autoFocus
                    className="min-w-0 flex-1 rounded border border-border bg-bg px-1 text-fg"
                    onChange={(event) => setEditing({ ...editing, label: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.stopPropagation();
                        void rename();
                      }
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        setEditing(null);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className={actionClass}
                    disabled={renaming || !editing.label.trim()}
                    onClick={() => void rename()}
                  >
                    Save name
                  </button>
                  <button
                    type="button"
                    className={actionClass}
                    disabled={renaming}
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                  {renameError && (
                    <span role="alert" className="basis-full text-error">
                      {toUserMessage(renameError, 'structure.failed')}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
          {selectionLoadErrors.map((error) => (
            <div key={error} role="alert" className="text-error">
              {toUserMessage(error, 'structure.failed')}
            </div>
          ))}
        </div>
      ) : undefined}
    </ColorLegend>
  );
}
