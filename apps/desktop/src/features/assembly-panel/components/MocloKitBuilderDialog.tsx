'use client';

import { toUserMessage, userEntityLabel } from '@waypoint/user-messages';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, TextField, TextArea } from '../../../components/ui';
import type React from 'react';
import { ENZYME_SPECS } from '../../design/public/types';
import type { GoldenGateEnzyme } from '../../design/public/types';
import type { MocloKitDefinition } from '../../design/public/moclo-kit-definition';
import { saveMocloKit } from '../../design/public/moclo-schema-catalog';
import {
  loadMocloKitTemplates,
  type MocloKitTemplate,
} from '../../design/public/moclo-kit-templates';
import { searchCatalogReferencesByName } from '../../../db/catalog-reference-search';
import {
  DEFAULT_LAYOUT_NAME,
  defaultPositionLabel,
  emptyLayout,
  emptyPosition,
  KIT_BUILDER_ENZYMES,
  findKitDuplicate,
  kitIdFromName,
  layoutFromSchema,
  savePayload,
  stateFromDefinition,
  validateKitBuilderState,
  type KitBuilderLayout,
  type KitBuilderMember,
  type KitBuilderState,
} from './moclo-kit-builder-model';
import { FilterableSelect } from './FilterableSelect';
import { safeFocus } from '../../../shared/utils/safeFocus';
import { metadataValuesEqual } from '../../../shared/metadata-values';
import { MetadataSaveButton } from '../../../shared/components/MetadataSaveButton';

export interface MocloKitBuilderDialogProps {
  projectRoot: string;

  kit: MocloKitDefinition | null;

  existingKits: readonly MocloKitDefinition[];
  onClose: () => void;
  onSaved: (kitId: string, kitName: string) => void;

  onEditExisting?: (kitId: string) => void;
}

const fieldClass =
  'h-8 min-w-0 rounded border border-border bg-bg px-2 text-xs text-fg outline-none focus:border-accent';

function selectGeneratedDefault(defaultValue: string) {
  return (event: React.FocusEvent<HTMLInputElement>) => {
    if (event.target.value === defaultValue) event.target.select();
  };
}

export function MocloKitBuilderDialog({
  projectRoot,
  kit,
  existingKits,
  onClose,
  onSaved,
  onEditExisting,
}: MocloKitBuilderDialogProps) {
  const [state, setState] = useState<KitBuilderState>(() => stateFromDefinition(kit));
  const [savedPayload, setSavedPayload] = useState(() => savePayload(state, kit));
  const hasChanges = !kit || !metadataValuesEqual(savePayload(state, kit), savedPayload);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const [templates, setTemplates] = useState<MocloKitTemplate[]>([]);

  useEffect(() => {
    let active = true;
    void loadMocloKitTemplates()
      .then((loaded) => {
        if (active) setTemplates(loaded);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    safeFocus(nameRef.current);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, saving]);

  const issues = useMemo(() => validateKitBuilderState(state), [state]);
  const activeLayout =
    state.layouts.find((layout) => layout.id === state.activeLayoutId) ?? state.layouts[0] ?? null;

  const patchLayout = (layoutId: string, patch: Partial<KitBuilderLayout>) =>
    setState((current) => ({
      ...current,
      layouts: current.layouts.map((layout) =>
        layout.id === layoutId ? { ...layout, ...patch } : layout
      ),
    }));

  const applyTemplate = (templateId: string) => {
    const template = templates.find((entry) => entry.id === templateId);
    if (!template) return;
    const layouts = template.definition.assemblySchemas.map((schema) => layoutFromSchema(schema));
    setState((current) => ({
      name: current.name.trim() ? current.name : template.definition.name,
      description: current.description.trim()
        ? current.description
        : template.definition.description,
      citations: template.definition.citations,
      members: current.members,
      layouts: layouts.length ? layouts : current.layouts,
      activeLayoutId: layouts[0]?.id ?? current.activeLayoutId,
    }));
    setShowIssues(false);
  };

  const save = () => {
    if (saving || !hasChanges) return;
    setShowIssues(true);
    if (issues.length) return;
    setSaving(true);
    setSaveError(null);
    const payload = savePayload(state, kit);
    void saveMocloKit({ projectRoot, ...payload })
      .then((result) => {
        setSavedPayload(payload);
        onSaved(result.kitId, payload.name);
      })
      .catch((error: unknown) => {
        setSaveError(toUserMessage(error, 'failure.could-not-save-this-kit'));
      })
      .finally(() => setSaving(false));
  };

  const kitId = kit?.id ?? kitIdFromName(state.name);

  const duplicate = kit ? null : findKitDuplicate(state.name, existingKits);

  return (
    <div
      className="fixed inset-0 z-[10100] flex items-center justify-center bg-black/45 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="moclo-kit-builder-title"
        data-testid="moclo-kit-builder"
        className="flex max-h-[min(760px,88vh)] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-2xl"
      >
        <header className="border-b border-border px-5 py-4">
          <h2 id="moclo-kit-builder-title" className="text-base font-semibold text-fg">
            {kit ? `Edit ${kit.name}` : 'New MoClo kit'}
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            A kit is a named set of layouts: the ordered positions a part goes into, and the
            four-base junction that joins each position to the next.
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {kit ? (
            <div
              data-testid="moclo-kit-builder-experimental-notice"
              className="mb-4 rounded border border-amber-500/40 bg-amber-100 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
            >
              <span className="mr-1.5 rounded bg-amber-500/25 px-1.5 py-0.5 font-semibold uppercase tracking-wide">
                Experimental
              </span>
              Editing an existing kit is rough. This dialog changes layouts only — the kit&rsquo;s
              parts, part types and multi-step recipes are kept untouched but are not shown here, so
              you cannot check them before saving. Removing a layout does not change assemblies
              already built on it.
            </div>
          ) : null}
          {!kit && templates.length ? (
            <label className="mb-4 flex items-center gap-2 text-xs">
              <span className="w-28 shrink-0 font-medium text-fg-muted">Start from</span>
              <FilterableSelect
                label="Kit template"
                value=""
                placeholder="A published kit architecture…"
                testId="moclo-kit-template-picker"
                options={templates.map((template) => ({
                  value: template.id,
                  label: template.name,
                  hint: template.addgene
                    ? `${template.organism} · Addgene ${template.addgene.kitId}`
                    : template.organism,
                }))}
                onChange={applyTemplate}
              />
            </label>
          ) : null}

          <label className="mb-3 flex items-center gap-2 text-xs">
            <span className="w-28 shrink-0 font-medium text-fg-muted">Kit name</span>
            <div className="min-w-0 flex-1">
              <TextField
                ref={nameRef}
                aria-label="Kit name"
                value={state.name}
                disabled={Boolean(kit)}
                onChange={(event) =>
                  setState((current) => ({ ...current, name: event.target.value }))
                }
              />
            </div>
          </label>
          <label className="mb-1 flex items-start gap-2 text-xs">
            <span className="mt-1.5 w-28 shrink-0 font-medium text-fg-muted">Description</span>
            <div className="min-w-0 flex-1">
              <TextArea
                aria-label="Kit description"
                rows={2}
                value={state.description}
                onChange={(event) =>
                  setState((current) => ({ ...current, description: event.target.value }))
                }
              />
            </div>
          </label>
          {state.citations.length ? (
            <p className="mb-1 pl-[7.5rem] text-[11px] text-fg-subtle">
              Source: {state.citations.map((citation) => citation.label).join('; ')}
            </p>
          ) : null}
          {kitId ? (
            <p className="mb-1 pl-[7.5rem] text-[11px] text-fg-subtle">
              Saved in this project as <span className="font-mono">{kitId}.json</span>
            </p>
          ) : null}
          {duplicate ? (
            <div
              data-testid="moclo-kit-duplicate-warning"
              className="mb-4 ml-[7.5rem] rounded border border-amber-500/40 bg-amber-100 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
            >
              {duplicate.kind === 'same-id'
                ? `This project already has a kit saved as ${kitId}.json.`
                : `This project already has “${duplicate.existingKitName}”, which looks like the same kit.`}{' '}
              Saving creates a second one.
              {onEditExisting ? (
                <button
                  type="button"
                  data-testid="moclo-kit-duplicate-edit"
                  className="ml-1 underline underline-offset-2 hover:no-underline"
                  onClick={() => onEditExisting(duplicate.existingKitId)}
                >
                  Edit {duplicate.existingKitName} instead
                </button>
              ) : null}
            </div>
          ) : (
            <div className="mb-4" />
          )}

          <KitMembersSection
            projectRoot={projectRoot}
            members={state.members}
            onChange={(members) => setState((current) => ({ ...current, members }))}
          />

          <div className="mb-2 flex items-center justify-between border-t border-border pt-3">
            <h3 className="text-xs font-semibold text-fg">Layouts</h3>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-[11px] text-fg hover:bg-bg-muted"
              onClick={() =>
                setState((current) => {
                  const layout = emptyLayout(current.layouts.map((entry) => entry.id));
                  return {
                    ...current,
                    layouts: [...current.layouts, layout],
                    activeLayoutId: layout.id,
                  };
                })
              }
            >
              Add layout
            </button>
          </div>

          {state.layouts.length > 1 ? (
            <div role="tablist" aria-label="Layouts" className="mb-3 flex flex-wrap gap-1">
              {state.layouts.map((layout) => (
                <button
                  key={layout.id}
                  type="button"
                  role="tab"
                  aria-selected={layout.id === activeLayout?.id}
                  onClick={() => setState((current) => ({ ...current, activeLayoutId: layout.id }))}
                  className={`rounded px-2 py-1 text-[11px] ${
                    layout.id === activeLayout?.id
                      ? 'bg-bg-muted text-fg ring-1 ring-inset ring-accent/40'
                      : 'text-fg-muted hover:bg-bg-muted'
                  }`}
                >
                  {userEntityLabel(layout.name)}
                </button>
              ))}
            </div>
          ) : null}

          {activeLayout ? (
            <LayoutEditor
              layout={activeLayout}
              onPatch={(patch) => patchLayout(activeLayout.id, patch)}
              onRemove={
                state.layouts.length > 1
                  ? () =>
                      setState((current) => {
                        const layouts = current.layouts.filter(
                          (layout) => layout.id !== activeLayout.id
                        );
                        return {
                          ...current,
                          layouts,
                          activeLayoutId: layouts[0]?.id ?? null,
                        };
                      })
                  : undefined
              }
            />
          ) : null}

          {showIssues && issues.length ? (
            <ul role="alert" className="mt-4 space-y-1 text-[11px] text-error">
              {issues.map((issue, index) => (
                <li key={`${issue.layoutId ?? 'kit'}-${index}`}>
                  {toUserMessage(issue.message, 'assembly.failed')}
                </li>
              ))}
            </ul>
          ) : null}
          {saveError ? (
            <p role="alert" className="mt-3 text-[11px] text-error">
              {toUserMessage(saveError, 'assembly.failed')}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <MetadataSaveButton
            type="button"
            hasChanges={hasChanges}
            data-testid="moclo-kit-builder-save"
            onClick={save}
            disabled={saving}
          >
            {saving ? 'Saving…' : kit ? 'Save changes' : 'Create kit'}
          </MetadataSaveButton>
        </footer>
      </div>
    </div>
  );
}

function LayoutEditor({
  layout,
  onPatch,
  onRemove,
}: {
  layout: KitBuilderLayout;
  onPatch: (patch: Partial<KitBuilderLayout>) => void;
  onRemove?: () => void;
}) {
  const expected = ENZYME_SPECS[layout.enzyme].overhangLength;
  const patchPosition = (positionId: string, patch: Partial<KitBuilderLayout['positions'][0]>) =>
    onPatch({
      positions: layout.positions.map((position) =>
        position.id === positionId ? { ...position, ...patch } : position
      ),
    });

  return (
    <section className="rounded-md border border-border bg-bg-subtle p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          aria-label="Layout name"
          className={`${fieldClass} w-56`}
          value={layout.name}
          onFocus={selectGeneratedDefault(DEFAULT_LAYOUT_NAME)}
          onChange={(event) => onPatch({ name: event.target.value })}
        />
        <select
          aria-label="Layout enzyme"
          className={`${fieldClass} w-24`}
          value={layout.enzyme}
          onChange={(event) => onPatch({ enzyme: event.target.value as GoldenGateEnzyme })}
        >
          {KIT_BUILDER_ENZYMES.map((enzyme) => (
            <option key={enzyme} value={enzyme}>
              {enzyme}
            </option>
          ))}
        </select>
        <select
          aria-label="Layout topology"
          className={`${fieldClass} w-28`}
          value={layout.topology}
          onChange={(event) => onPatch({ topology: event.target.value as 'linear' | 'circular' })}
        >
          <option value="circular">Circular</option>
          <option value="linear">Linear</option>
        </select>
        {onRemove ? (
          <button
            type="button"
            className="ml-auto rounded px-2 py-1 text-[11px] text-fg-muted hover:bg-bg-muted hover:text-error"
            onClick={onRemove}
          >
            Remove layout
          </button>
        ) : null}
      </div>

      <p className="mb-2 text-[11px] text-fg-muted">
        {layout.topology === 'circular'
          ? `Each position hands a ${expected}-base junction to the next; the last one closes the circle back to the first.`
          : `Each position hands a ${expected}-base junction to the next; the last position ends the run.`}
      </p>

      <ol className="space-y-1.5">
        {layout.positions.map((position, index) => {
          const isClosing = layout.topology === 'linear' && index === layout.positions.length - 1;
          return (
            <li key={position.id} className="flex items-center gap-2">
              <span className="w-5 shrink-0 text-right font-mono text-[11px] text-fg-subtle">
                {index + 1}
              </span>
              <input
                aria-label={`Position ${index + 1} name`}
                className={`${fieldClass} min-w-[6rem] flex-1`}
                value={position.label}
                onFocus={selectGeneratedDefault(defaultPositionLabel(index))}
                onChange={(event) => patchPosition(position.id, { label: event.target.value })}
              />
              <input
                aria-label={`Position ${index + 1} role`}
                className={`${fieldClass} w-32`}
                placeholder="Role (optional)"
                value={position.role}
                onChange={(event) => patchPosition(position.id, { role: event.target.value })}
              />
              <input
                aria-label={`Position ${index + 1} junction`}
                className={`${fieldClass} w-24 font-mono uppercase`}
                placeholder={isClosing ? 'none' : 'ACGT'.slice(0, expected)}
                maxLength={expected}
                disabled={isClosing}
                value={position.outgoingOverhang}
                onChange={(event) =>
                  patchPosition(position.id, {
                    outgoingOverhang: event.target.value.toUpperCase().replace(/[^ACGT]/g, ''),
                  })
                }
              />
              <button
                type="button"
                aria-label={`Remove position ${index + 1}`}
                className="h-7 w-7 shrink-0 rounded text-fg-muted hover:bg-bg-muted hover:text-error disabled:opacity-40"
                disabled={layout.positions.length <= 1}
                onClick={() =>
                  onPatch({
                    positions: layout.positions.filter((entry) => entry.id !== position.id),
                  })
                }
              >
                ×
              </button>
            </li>
          );
        })}
      </ol>

      <button
        type="button"
        className="mt-2 rounded border border-border px-2 py-1 text-[11px] text-fg hover:bg-bg-muted"
        onClick={() =>
          onPatch({
            positions: [
              ...layout.positions,
              emptyPosition(
                layout.positions.map((position) => position.id),
                layout.positions.length
              ),
            ],
          })
        }
      >
        Add position
      </button>
      <span className="ml-2 text-[11px] text-fg-subtle">{layout.positions.length} positions</span>
    </section>
  );
}

function KitMembersSection({
  projectRoot,
  members,
  onChange,
}: {
  projectRoot: string;
  members: KitBuilderMember[];
  onChange: (members: KitBuilderMember[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KitBuilderMember[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let active = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void searchCatalogReferencesByName({
        query,
        entityType: 'sequence',
        workspaceRoot: projectRoot,
        limit: 40,
      })
        .then((candidates) => {
          if (!active) return;
          const managed: KitBuilderMember[] = [];
          for (const candidate of candidates) {
            const ref = candidate.sequenceDocument;
            if (ref?.kind !== 'managed-sequence') continue;
            managed.push({ sequencePackageId: ref.packageId, name: candidate.name });
          }
          setResults(managed);
        })
        .catch(() => {
          if (active) setResults([]);
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [projectRoot, query]);

  const declared = new Set(members.map((member) => member.sequencePackageId));
  const available = results.filter((result) => !declared.has(result.sequencePackageId));

  return (
    <section className="mb-4 border-t border-border pt-3" data-testid="moclo-kit-members">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-xs font-semibold text-fg">Parts</h3>
        <span className="text-[11px] text-fg-subtle">
          {members.length === 0
            ? 'None yet — a kit with no parts fills no positions'
            : `${members.length} in this kit`}
        </span>
      </div>

      {members.length ? (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {members.map((member) => (
            <li
              key={member.sequencePackageId}
              className="flex items-center gap-1 rounded border border-border bg-bg-subtle py-0.5 pl-2 pr-1 text-[11px] text-fg"
            >
              <span className="max-w-[16rem] truncate">{member.name}</span>
              <button
                type="button"
                aria-label={`Remove ${member.name} from this kit`}
                className="rounded px-1 text-fg-muted hover:bg-bg-muted hover:text-error"
                onClick={() =>
                  onChange(
                    members.filter((entry) => entry.sequencePackageId !== member.sequencePackageId)
                  )
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <input
        aria-label="Search this project for parts"
        placeholder="Search this project's sequences to add…"
        className={`${fieldClass} w-full`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div
        role="listbox"
        aria-label="Project sequences"
        className="mt-1 max-h-32 overflow-y-auto rounded border border-border"
      >
        {available.length === 0 ? (
          <p className="px-2 py-2 text-[11px] text-fg-muted">
            {searching ? 'Searching…' : 'No other managed sequences in this project'}
          </p>
        ) : (
          available.map((result) => (
            <button
              key={result.sequencePackageId}
              type="button"
              role="option"
              aria-selected={false}
              className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[11px] text-fg hover:bg-bg-muted"
              onClick={() => onChange([...members, result])}
            >
              <span className="min-w-0 truncate">{result.name}</span>
              <span className="shrink-0 text-fg-subtle">Add</span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
