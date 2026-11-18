'use client';

import { toUserMessage } from '@waypoint/user-messages';
import { complementBase } from '@waypoint/sequence-utils';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { SearchIcon } from '../../../components/icons';
import {
  deriveGoldenGateSlotEnds,
  isGoldenGateSchemaStructureLocked,
  type GoldenGateAssemblySchema,
} from '../../design/public/golden-gate-schema';
import { type MocloKitDefinition } from '../../design/public/moclo-kit-definition';
import { loadMocloSchemaCatalog } from '../../design/public/moclo-schema-catalog';
import { ENZYME_SPECS } from '../../design/public/types';
import {
  loadMocloCatalogCandidates,
  rankMocloCatalogCandidates,
  type MocloCatalogCandidate,
  type RankedMocloCatalogCandidate,
} from '../../design/public/moclo-part-catalog';
import {
  WORKSPACE_RECONCILED_EVENT,
  type WorkspaceReconciledEventDetail,
} from '../../../services/workspace-reconciled-event';
import type { MocloWorkspaceModel } from '../moclo-workspace-model';

export interface MocloSchemaEditResult {
  ok: boolean;
  message?: string;
}

interface MocloAssemblyWorkspaceProps {
  model: MocloWorkspaceModel;
  selectedRegionId: string | null;
  onSelectRegion: (regionId: string) => void;
  onChangeSchema: (schema: GoldenGateAssemblySchema) => MocloSchemaEditResult;
  onReplacePart: (slotIndex: number, candidate: MocloCatalogCandidate) => void;
  workspaceRoot: string | null;
  mapContent: ReactNode;
}

export type MocloPartPickerCatalogState =
  | { status: 'idle'; candidates: MocloCatalogCandidate[]; skippedSourceCount: number }
  | { status: 'loading'; candidates: MocloCatalogCandidate[]; skippedSourceCount: number }
  | { status: 'ready'; candidates: MocloCatalogCandidate[]; skippedSourceCount: number }
  | {
      status: 'error';
      candidates: MocloCatalogCandidate[];
      skippedSourceCount: number;
      message: string;
    };

type KitDefinitionState =
  | { status: 'idle'; definitions: MocloKitDefinition[] }
  | { status: 'loading'; definitions: MocloKitDefinition[] }
  | { status: 'ready'; definitions: MocloKitDefinition[]; issueCount: number }
  | { status: 'error'; definitions: MocloKitDefinition[]; message: string };

export function MocloAssemblyWorkspace({
  model,
  selectedRegionId,
  onSelectRegion,
  onChangeSchema,
  onReplacePart,
  workspaceRoot,
  mapContent,
}: MocloAssemblyWorkspaceProps) {
  const [openSlotIndex, setOpenSlotIndex] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [includePhysicallyIncompatible, setIncludePhysicallyIncompatible] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [overhangDrafts, setOverhangDrafts] = useState<Record<string, string>>({});
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [catalog, setCatalog] = useState<MocloPartPickerCatalogState>({
    status: 'idle',
    candidates: [],
    skippedSourceCount: 0,
  });
  const [kitDefinitions, setKitDefinitions] = useState<KitDefinitionState>({
    status: 'idle',
    definitions: [],
  });
  const catalogAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setOverhangDrafts(
      Object.fromEntries(model.schema.slots.map((slot) => [slot.id, slot.outgoingOverhang ?? '']))
    );
    setLabelDrafts(Object.fromEntries(model.schema.slots.map((slot) => [slot.id, slot.label])));
  }, [model.schema]);

  useEffect(() => {
    catalogAbortControllerRef.current?.abort();
    catalogAbortControllerRef.current = null;
    setOpenSlotIndex(null);
    setCatalog({ status: 'idle', candidates: [], skippedSourceCount: 0 });
    return () => {
      catalogAbortControllerRef.current?.abort();
    };
  }, [model.enzyme, workspaceRoot]);

  useEffect(() => {
    let active = true;
    setKitDefinitions({ status: 'loading', definitions: [] });
    void loadMocloSchemaCatalog(workspaceRoot)
      .then((inventory) => {
        if (!active) return;
        setKitDefinitions({
          status: 'ready',
          definitions: inventory.definitions,
          issueCount: inventory.issues.length,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setKitDefinitions({
          status: 'error',
          definitions: [],
          message: toUserMessage(error, 'failure.could-not-load-moclo-kit-definitions'),
        });
      });
    return () => {
      active = false;
    };
  }, [workspaceRoot]);

  const junctionsAreSchemaLocked = isGoldenGateSchemaStructureLocked(model.schema);
  const partForSlot = (index: number) => {
    const slotId = model.schema.slots[index]?.id;
    return model.parts.find((part) =>
      model.schemaIsPersisted ? part.schemaSlotId === slotId : part.regionId === slotId
    );
  };
  const replaceableOpenSlotIndex =
    openSlotIndex !== null && partForSlot(openSlotIndex)?.input.kind !== 'stage-output'
      ? openSlotIndex
      : null;

  const visibleCandidates = useMemo(() => {
    if (replaceableOpenSlotIndex === null) return [];
    return rankMocloCatalogCandidates({
      candidates: catalog.candidates,
      schema: model.schema,
      slotIndex: replaceableOpenSlotIndex,
      topology: model.topology,
      query,
      includePhysicallyIncompatible,
    });
  }, [
    catalog.candidates,
    includePhysicallyIncompatible,
    model.schema,
    model.topology,
    replaceableOpenSlotIndex,
    query,
  ]);

  const refreshCatalog = useCallback((): Promise<void> => {
    catalogAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    catalogAbortControllerRef.current = abortController;
    setCatalog({ status: 'loading', candidates: [], skippedSourceCount: 0 });
    return loadMocloCatalogCandidates({
      workspaceRoot,
      enzymeName: model.enzyme,
      kitDefinitions: kitDefinitions.definitions,
      abortSignal: abortController.signal,
    })
      .then((result) => {
        if (abortController.signal.aborted) return;
        catalogAbortControllerRef.current = null;
        setCatalog({ status: 'ready', ...result });
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) return;
        catalogAbortControllerRef.current = null;
        setCatalog({
          status: 'error',
          candidates: [],
          skippedSourceCount: 0,
          message: toUserMessage(error, 'failure.could-not-search-the-component-catalog'),
        });
      });
  }, [kitDefinitions.definitions, model.enzyme, workspaceRoot]);

  useEffect(() => {
    if (
      replaceableOpenSlotIndex === null ||
      kitDefinitions.status === 'idle' ||
      kitDefinitions.status === 'loading' ||
      catalog.status !== 'idle'
    ) {
      return;
    }
    void refreshCatalog();
  }, [catalog.status, kitDefinitions.status, refreshCatalog, replaceableOpenSlotIndex]);

  useEffect(() => {
    if (openSlotIndex !== null && replaceableOpenSlotIndex === null) {
      catalogAbortControllerRef.current?.abort();
      catalogAbortControllerRef.current = null;
      setOpenSlotIndex(null);
      setCatalog({ status: 'idle', candidates: [], skippedSourceCount: 0 });
    }
  }, [openSlotIndex, replaceableOpenSlotIndex]);

  useEffect(() => {
    const handleWorkspaceReconciled = (event: Event): void => {
      const detail = (event as CustomEvent<WorkspaceReconciledEventDetail>).detail;
      if (
        !workspaceRoot ||
        detail.workspaceRoot.replace(/\/+$/, '') !== workspaceRoot.replace(/\/+$/, '')
      ) {
        return;
      }
      if (openSlotIndex === null) {
        setCatalog({ status: 'idle', candidates: [], skippedSourceCount: 0 });
        return;
      }
      void refreshCatalog();
    };

    window.addEventListener(WORKSPACE_RECONCILED_EVENT, handleWorkspaceReconciled);
    return () => window.removeEventListener(WORKSPACE_RECONCILED_EVENT, handleWorkspaceReconciled);
  }, [openSlotIndex, refreshCatalog, workspaceRoot]);

  const openPartPicker = (slotIndex: number): void => {
    if (partForSlot(slotIndex)?.input.kind === 'stage-output') return;
    const nextOpen = openSlotIndex === slotIndex ? null : slotIndex;
    setOpenSlotIndex(nextOpen);
    setQuery('');
    if (nextOpen === null) return;
    const part = partForSlot(slotIndex);
    if (part) onSelectRegion(part.regionId);
  };

  const commitSchema = (schema: GoldenGateAssemblySchema): void => {
    const result = onChangeSchema(schema);
    setSchemaError(toUserMessage(result, 'failure.schema-change-was-rejected'));
  };

  const commitOverhang = (slotIndex: number): void => {
    if (junctionsAreSchemaLocked) return;
    const slot = model.schema.slots[slotIndex];
    if (!slot) return;
    const value = (overhangDrafts[slot.id] ?? '').trim().toUpperCase();
    commitSchema({
      ...model.schema,
      revision: model.schema.revision + 1,
      slots: model.schema.slots.map((candidate, index) =>
        index === slotIndex ? { ...candidate, outgoingOverhang: value || null } : candidate
      ),
    });
  };

  const commitLabel = (slotIndex: number): void => {
    const slot = model.schema.slots[slotIndex];
    if (!slot) return;
    const label = (labelDrafts[slot.id] ?? '').trim();
    if (!label || label === slot.label) return;
    commitSchema({
      ...model.schema,
      revision: model.schema.revision + 1,
      slots: model.schema.slots.map((candidate, index) =>
        index === slotIndex ? { ...candidate, label, preferredRoles: [{ label }] } : candidate
      ),
    });
  };

  const addPosition = (): void => {
    const existingIds = new Set(model.schema.slots.map((slot) => slot.id));
    let suffix = model.schema.slots.length + 1;
    let id = `position-${suffix}`;
    while (existingIds.has(id)) {
      suffix += 1;
      id = `position-${suffix}`;
    }
    commitSchema({
      ...model.schema,
      revision: model.schema.revision + 1,
      slots: [
        ...model.schema.slots,
        { id, label: `Position ${suffix}`, outgoingOverhang: null, preferredRoles: [] },
      ],
    });
  };

  return (
    <div data-testid="moclo-assembly-workspace" className="flex h-full min-h-0 flex-col bg-bg-base">
      <section
        data-testid="moclo-schema-strip"
        aria-label="Golden Gate assembly schema"
        className="relative z-30 flex-none border-b border-border bg-bg-subtle"
      >
        <span data-testid="moclo-workspace-status" className="sr-only">
          {model.isClosed ? 'Closed route' : 'Open route'}
        </span>

        <div
          data-testid="moclo-schema-chain"
          data-junctions-locked={junctionsAreSchemaLocked ? 'true' : 'false'}
          className="flex min-h-[72px] items-center overflow-x-auto px-3 py-2"
        >
          {model.schema.slots.map((slot, slotIndex) => {
            const part = partForSlot(slotIndex);
            const selected = part?.regionId === selectedRegionId;
            const pickerOpen = replaceableOpenSlotIndex === slotIndex;
            const stageOutput = part?.input.kind === 'stage-output' ? part.input : null;
            const slotEnds = deriveGoldenGateSlotEnds(model.schema, slotIndex, model.topology);
            const displayedOutgoingOverhang = junctionsAreSchemaLocked
              ? (slotEnds.outgoingOverhang ?? '')
              : (overhangDrafts[slot.id] ?? '');
            const outgoingPairedComplement = displayedOutgoingOverhang
              ? [...displayedOutgoingOverhang].map((base) => complementBase(base)).join('')
              : '';
            const nextSlotIndex = slotIndex + 1;
            const nextSlotEnds =
              nextSlotIndex < model.schema.slots.length
                ? deriveGoldenGateSlotEnds(model.schema, nextSlotIndex, model.topology)
                : model.topology === 'circular' && model.schema.slots.length > 0
                  ? deriveGoldenGateSlotEnds(model.schema, 0, model.topology)
                  : null;
            const connectsToNext =
              slotEnds.outgoingOverhang !== null &&
              slotEnds.outgoingOverhang === nextSlotEnds?.incomingOverhang;
            return (
              <div key={slot.id} className="flex items-center">
                <div
                  data-testid="moclo-schema-part"
                  data-slot-id={slot.id}
                  data-entry-overhang={slotEnds.incomingOverhang ?? ''}
                  data-exit-overhang={slotEnds.outgoingOverhang ?? ''}
                  data-connects-to-next={connectsToNext ? 'true' : 'false'}
                  data-route={part?.route ?? 'Unassigned'}
                  className={`w-44 flex-none rounded-md border bg-bg-base px-2 py-1.5 transition-colors ${
                    selected || pickerOpen ? 'border-accent ring-1 ring-accent/20' : 'border-border'
                  }`}
                  style={{ borderTopColor: part?.color, borderTopWidth: 3 }}
                >
                  {junctionsAreSchemaLocked ? (
                    <span className="flex h-5 items-center truncate text-[11px] font-semibold uppercase tracking-[0.035em] text-fg-muted">
                      {slot.label}
                    </span>
                  ) : (
                    <input
                      value={labelDrafts[slot.id] ?? slot.label}
                      onChange={(event) =>
                        setLabelDrafts((current) => ({ ...current, [slot.id]: event.target.value }))
                      }
                      onBlur={() => commitLabel(slotIndex)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                      aria-label={`Position ${slotIndex + 1} role`}
                      className="h-5 w-full bg-transparent text-[11px] font-semibold uppercase tracking-[0.035em] text-fg-muted outline-none focus:text-fg-default"
                    />
                  )}
                  <button
                    type="button"
                    data-testid={`moclo-part-picker-${slotIndex}`}
                    aria-expanded={pickerOpen}
                    aria-label={
                      stageOutput
                        ? `${slot.label} is supplied by a prior stage`
                        : `Choose part for ${slot.label}`
                    }
                    title={stageOutput ? 'Supplied by a prior factory stage' : undefined}
                    disabled={stageOutput !== null}
                    onClick={() => openPartPicker(slotIndex)}
                    className="flex h-5 w-full items-center justify-between gap-1 text-left text-[11px] font-semibold text-fg-default hover:text-accent disabled:cursor-default disabled:hover:text-fg-default"
                  >
                    <span className="truncate">{part?.name || 'Choose part'}</span>
                    {stageOutput ? null : (
                      <span aria-hidden="true" className="text-[9px] text-fg-subtle">
                        ▾
                      </span>
                    )}
                  </button>
                </div>

                <div
                  data-testid={`moclo-schema-junction-pair-${slotIndex}`}
                  className="flex w-16 flex-none flex-col items-center justify-center gap-0.5 font-mono text-xs font-semibold uppercase tracking-[0.06em] text-amber-700 dark:text-amber-300"
                >
                  {junctionsAreSchemaLocked ? (
                    <span
                      data-testid={`moclo-schema-junction-${slotIndex}`}
                      data-junction-locked="true"
                      aria-label={`Schema-defined junction after ${slot.label}: ${slotEnds.outgoingOverhang ?? 'none'}`}
                      title="Defined by the selected schema"
                    >
                      {slotEnds.outgoingOverhang ?? '—'}
                    </span>
                  ) : (
                    <input
                      data-testid={`moclo-schema-junction-${slotIndex}`}
                      data-junction-locked="false"
                      value={overhangDrafts[slot.id] ?? ''}
                      onChange={(event) =>
                        setOverhangDrafts((current) => ({
                          ...current,
                          [slot.id]: event.target.value
                            .toUpperCase()
                            .slice(0, ENZYME_SPECS[model.enzyme].overhangLength),
                        }))
                      }
                      onBlur={() => commitOverhang(slotIndex)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                      aria-label={`Junction after ${slot.label}`}
                      placeholder="—"
                      className="h-5 w-14 bg-transparent text-center font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-amber-700 outline-none focus:underline dark:text-amber-300"
                    />
                  )}
                  <span
                    data-testid={`moclo-schema-junction-reverse-${slotIndex}`}
                    data-paired-complement={outgoingPairedComplement}
                    aria-label={
                      displayedOutgoingOverhang
                        ? `Opposite strand paired with ${displayedOutgoingOverhang}: ${outgoingPairedComplement}`
                        : 'No paired overhang'
                    }
                    className="text-amber-700/80 dark:text-amber-300/80"
                  >
                    {outgoingPairedComplement || '—'}
                  </span>
                </div>
              </div>
            );
          })}
          {!junctionsAreSchemaLocked ? (
            <button
              type="button"
              onClick={addPosition}
              className="ml-1 h-7 flex-none px-2 text-[11px] text-fg-muted wp-interactive"
            >
              + Position
            </button>
          ) : null}
        </div>

        {schemaError ? (
          <p role="alert" className="border-t border-red-500/20 px-3 py-1 text-[10px] text-red-600">
            {toUserMessage(schemaError, 'assembly.failed')}
          </p>
        ) : null}

        {kitDefinitions.status === 'error' ? (
          <p role="alert" className="border-t border-red-500/20 px-3 py-1 text-[10px] text-red-600">
            {toUserMessage(kitDefinitions.message, 'assembly.failed')}
          </p>
        ) : null}

        {kitDefinitions.status === 'ready' && kitDefinitions.issueCount > 0 ? (
          <p
            role="alert"
            className="border-t border-amber-500/20 px-3 py-1 text-[10px] text-amber-700"
          >
            {kitDefinitions.issueCount === 1
              ? '1 MoClo kit definition could not be loaded.'
              : `${kitDefinitions.issueCount} MoClo kit definitions could not be loaded.`}
          </p>
        ) : null}

        {replaceableOpenSlotIndex !== null ? (
          <MocloPartPicker
            slotLabel={
              model.schema.slots[replaceableOpenSlotIndex]?.label ??
              `Position ${replaceableOpenSlotIndex + 1}`
            }
            catalog={catalog}
            candidates={visibleCandidates}
            query={query}
            setQuery={setQuery}
            includePhysicallyIncompatible={includePhysicallyIncompatible}
            setIncludePhysicallyIncompatible={setIncludePhysicallyIncompatible}
            onChoose={(candidate) => {
              const part = partForSlot(replaceableOpenSlotIndex);
              if (part) onReplacePart(part.index, candidate);
              setOpenSlotIndex(null);
            }}
            onClose={() => setOpenSlotIndex(null)}
          />
        ) : null}
      </section>

      <div data-testid="moclo-map-view" className="relative min-h-0 flex-1 overflow-hidden">
        {mapContent}
      </div>
    </div>
  );
}

export function MocloPartPicker(props: {
  slotLabel: string;
  catalog: MocloPartPickerCatalogState;
  candidates: RankedMocloCatalogCandidate[];
  query: string;
  setQuery: (query: string) => void;
  includePhysicallyIncompatible: boolean;
  setIncludePhysicallyIncompatible: (include: boolean) => void;
  onChoose: (candidate: MocloCatalogCandidate) => void;
  onClose: () => void;
  layout?: 'map' | 'drawer' | 'portal';
}) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const candidates = props.catalog.status === 'ready' ? props.candidates : [];
  const activeIndex = candidates.findIndex((candidate) => candidate.id === activeId);

  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !row) return;
    const bounds = list.getBoundingClientRect();
    const item = row.getBoundingClientRect();
    if (item.top < bounds.top) list.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
  }, [activeIndex, props.candidates]);

  return (
    <div
      data-testid="moclo-part-picker-popover"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }
      }}
      className={`${
        props.layout === 'portal'
          ? 'relative min-h-0 max-h-[min(430px,60vh)] w-full'
          : props.layout === 'drawer'
            ? 'relative mt-1 max-h-[360px] w-full'
            : 'absolute left-3 top-full max-h-[min(430px,60vh)] w-[520px]'
      } z-50 flex flex-col overflow-hidden ${
        props.layout === 'portal'
          ? 'bg-transparent'
          : 'rounded-md border border-border bg-bg shadow-xl'
      }`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search parts for {props.slotLabel}</span>
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            autoFocus
            type="search"
            value={props.query}
            onChange={(event) => {
              setActiveId(null);
              props.setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                event.ctrlKey ||
                event.metaKey ||
                event.altKey ||
                event.shiftKey
              )
                return;
              if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              if (!candidates.length) return;
              if (event.key === 'Enter') {
                if (activeIndex >= 0) props.onChoose(candidates[activeIndex]);
                return;
              }
              const next =
                event.key === 'ArrowDown'
                  ? Math.min(activeIndex + 1, candidates.length - 1)
                  : activeIndex < 0
                    ? candidates.length - 1
                    : Math.max(0, activeIndex - 1);
              setActiveId(candidates[next].id);
            }}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
            aria-label={`Search parts for ${props.slotLabel}`}
            placeholder="Search parts…"
            className="h-9 w-full rounded bg-transparent pl-7 pr-2 text-[13px] text-fg-default outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
        </label>
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={props.includePhysicallyIncompatible}
            onChange={(event) => {
              setActiveId(null);
              props.setIncludePhysicallyIncompatible(event.target.checked);
            }}
          />
          Show incompatible overhangs
        </label>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close part picker"
          className="h-8 w-8 rounded text-fg-muted wp-interactive "
        >
          ×
        </button>
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={`Parts for ${props.slotLabel}`}
        className="min-h-0 overflow-y-auto overscroll-contain p-1"
      >
        {props.catalog.status === 'idle' || props.catalog.status === 'loading' ? (
          <p className="px-3 py-6 text-center text-xs text-fg-muted">Indexing compatible parts…</p>
        ) : null}
        {props.catalog.status === 'error' ? (
          <p role="alert" className="px-3 py-6 text-center text-xs text-red-600">
            {toUserMessage(props.catalog.message, 'assembly.failed')}
          </p>
        ) : null}
        {props.catalog.status === 'ready' && props.candidates.length === 0 ? (
          <p
            role={props.catalog.skippedSourceCount > 0 ? 'alert' : undefined}
            className="px-3 py-6 text-center text-xs text-fg-muted"
          >
            {props.catalog.skippedSourceCount > 0
              ? 'Project parts could not be loaded.'
              : 'No matching parts'}
          </p>
        ) : null}
        {candidates.map((candidate, index) => (
          <CandidateRow
            key={candidate.id}
            candidate={candidate}
            onChoose={props.onChoose}
            optionId={`${listId}-${index}`}
            active={index === activeIndex}
            onPointerMove={() => setActiveId(candidate.id)}
          />
        ))}
      </div>
    </div>
  );
}

function CandidateRow(props: {
  candidate: RankedMocloCatalogCandidate;
  onChoose: (candidate: MocloCatalogCandidate) => void;
  optionId: string;
  active: boolean;
  onPointerMove: () => void;
}) {
  const componentLabel = props.candidate.componentLabel;
  const secondaryLabel = [componentLabel ? props.candidate.name : null, props.candidate.kit?.name]
    .filter(Boolean)
    .join(' · ');
  const physical = props.candidate.compatibility.physical;
  const physicalDescription =
    physical.type === 'incompatible'
      ? physical.mismatches
          .map((mismatch) => `${mismatch.end === 'upstream' ? 'Left' : 'Right'} overhang mismatch`)
          .join(' · ')
      : physical.type === 'pcr-adaptable'
        ? 'Primer overhangs needed'
        : null;
  return (
    <button
      type="button"
      id={props.optionId}
      role="option"
      aria-selected={props.active}
      tabIndex={-1}
      data-testid={`moclo-candidate-${props.candidate.id}`}
      onPointerMove={props.onPointerMove}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => props.onChoose(props.candidate)}
      className={`flex w-full items-center gap-3 rounded px-2.5 py-2 text-left transition-colors duration-100 wp-interactive ${props.active ? 'bg-bg-muted ring-1 ring-inset ring-accent/40' : ''}`}
    >
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-[13px] font-semibold text-fg-default"
          title={
            componentLabel
              ? `${componentLabel.source === 'annotation' ? 'Source annotation' : 'Source description'}: ${componentLabel.text}`
              : props.candidate.name
          }
        >
          {componentLabel?.text ?? props.candidate.name}
        </span>
        {secondaryLabel ? (
          <span className="mt-0.5 block truncate text-xs text-fg-muted">{secondaryLabel}</span>
        ) : null}
        {physicalDescription ? (
          <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-300">
            {physicalDescription}
          </span>
        ) : null}
      </span>
      <span className="flex-none text-right">
        <span className="block font-mono text-xs text-amber-700 dark:text-amber-300">
          {props.candidate.upstreamOverhang ?? '—'} → {props.candidate.downstreamOverhang ?? '—'}
        </span>
        <span className="mt-0.5 block text-xs text-fg-subtle">
          {props.candidate.fragment.length.toLocaleString()} bp
        </span>
      </span>
    </button>
  );
}
