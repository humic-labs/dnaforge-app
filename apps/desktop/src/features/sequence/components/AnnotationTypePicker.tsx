import { usePresentationListener } from '../../../presentation/PresentationSurface';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { AnnotationTrackDefinition } from '../annotation-track-registry';

export interface AnnotationTypePreset {
  id: string;
  label: string;
  trackIds: ReadonlyArray<string>;
}

export const ANNOTATION_TYPE_PRESETS: ReadonlyArray<AnnotationTypePreset> = [
  { id: 'genes', label: 'Genes', trackIds: ['gene', 'mRNA'] },
  {
    id: 'rna',
    label: 'RNA',
    trackIds: ['lncRNA', 'ncRNA', 'miRNA', 'snoRNA', 'snRNA', 'tRNA', 'rRNA', 'misc_RNA'],
  },
  {
    id: 'regulatory',
    label: 'Regulatory',
    trackIds: [
      'regulatory',
      'enhancer',
      'silencer',
      'promoter',
      'TATA_box',
      'CAAT_signal',
      'response_element',
      'insulator',
    ],
  },
  { id: 'all', label: 'All', trackIds: [] },
  { id: 'none', label: 'None', trackIds: [] },
];

export const ANNOTATION_TYPE_GROUPS: ReadonlyArray<{
  id: string;
  label: string;
  trackIds: ReadonlyArray<string>;
}> = [
  {
    id: 'genes',
    label: 'Genes & transcripts',
    trackIds: ['gene', 'mRNA', 'transcript', 'primary_transcript', 'pseudogene', 'CDS', 'exon'],
  },
  {
    id: 'rna',
    label: 'Non-coding RNA',
    trackIds: [
      'lncRNA',
      'lnc_RNA',
      'ncRNA',
      'miRNA',
      'snoRNA',
      'snRNA',
      'tRNA',
      'rRNA',
      'misc_RNA',
      'scaRNA',
      'scRNA',
      'antisense_RNA',
    ],
  },
  {
    id: 'regulatory',
    label: 'Regulatory',
    trackIds: [
      'regulatory',
      'enhancer',
      'silencer',
      'promoter',
      'TATA_box',
      'CAAT_signal',
      'response_element',
      'insulator',
      'transcriptional_cis_regulatory_region',
      'locus_control_region',
      'imprinting_control_region',
      'enhancer_blocking_element',
      'DNase_I_hypersensitive_site',
      'DNaseI_hypersensitive_site',
      'CAGE_cluster',
      'protein_binding_site',
      'matrix_attachment_site',
      'nucleotide_motif',
      'replication_regulatory_region',
    ],
  },
  {
    id: 'structure',
    label: 'Structure & repeats',
    trackIds: [
      'centromere',
      'telomere',
      'rep_origin',
      'origin_of_replication',
      'repeat_region',
      'tandem_repeat',
      'direct_repeat',
      'dispersed_repeat',
      'long_terminal_repeat',
      'mobile_genetic_element',
      'sequence_secondary_structure',
      'chromosome_breakpoint',
      'repeat_instability_region',
    ],
  },
  {
    id: 'regions',
    label: 'Regions & recombination',
    trackIds: [
      'region',
      'biological_region',
      'conserved_region',
      'meiotic_recombination_region',
      'mitotic_recombination_region',
      'non_allelic_homologous_recombination_region',
    ],
  },
  {
    id: 'evidence',
    label: 'Alignments & evidence',
    trackIds: ['match', 'cDNA_match', 'nucleotide_match', 'protein_match', 'EST_match'],
  },
];

const FLYOUT_WIDTH_PX = 720;
const FLYOUT_MAX_HEIGHT_PX = 640;
const SUMMARY_BADGE_LIMIT = 3;
const MORPH_MS = 220;

interface AnnotationTypePickerProps {
  registry: ReadonlyArray<AnnotationTrackDefinition>;
  visibleTypes: ReadonlySet<string>;
  onToggleVisibleType: (type: string) => void;
  onSetVisibleTypes: (types: ReadonlySet<string>) => void;
}

function resolvePresetTypes(
  preset: AnnotationTypePreset,
  registryIds: ReadonlySet<string>
): ReadonlySet<string> {
  if (preset.id === 'all') return new Set(registryIds);
  if (preset.id === 'none') return new Set();
  return new Set(preset.trackIds.filter((id) => registryIds.has(id)));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function groupRegistry(
  registry: ReadonlyArray<AnnotationTrackDefinition>,
  filter: string
): Array<{ id: string; label: string; tracks: AnnotationTrackDefinition[] }> {
  const q = filter.trim().toLowerCase();
  const match = (t: AnnotationTrackDefinition) =>
    !q || t.label.toLowerCase().includes(q) || t.trackId.toLowerCase().includes(q);

  const claimed = new Set<string>();
  const groups: Array<{ id: string; label: string; tracks: AnnotationTrackDefinition[] }> = [];
  const byLabel = (a: AnnotationTrackDefinition, b: AnnotationTrackDefinition) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });

  for (const g of ANNOTATION_TYPE_GROUPS) {
    const tracks = registry.filter((t) => g.trackIds.includes(t.trackId) && match(t)).sort(byLabel);
    for (const t of tracks) claimed.add(t.trackId);
    if (tracks.length > 0) groups.push({ id: g.id, label: g.label, tracks });
  }

  const other = registry.filter((t) => !claimed.has(t.trackId) && match(t)).sort(byLabel);
  if (other.length > 0) groups.push({ id: 'other', label: 'Other', tracks: other });
  return groups;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

function ChevronIcon({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {open ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
    </svg>
  );
}

function SummaryBadges({
  badges,
  overflow,
}: {
  badges: ReadonlyArray<AnnotationTrackDefinition>;
  overflow: number;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap gap-0.5"
      data-testid="annotation-type-picker-summary-badges"
    >
      {badges.map((track) => (
        <span
          key={track.trackId}
          className="max-w-[5.5rem] truncate rounded-full bg-emerald-600/15 px-1.5 py-px text-[9px] leading-tight text-fg"
        >
          {track.label}
        </span>
      ))}
      {overflow > 0 ? (
        <span
          data-testid="annotation-type-picker-summary-overflow"
          className="rounded-full bg-fg/[0.06] px-1.5 py-px text-[9px] leading-tight text-fg-muted"
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}

function computeOpenBox(from: Box): Box {
  const width = Math.min(
    FLYOUT_WIDTH_PX,
    Math.max(Math.max(480, from.width), window.innerWidth * 0.42)
  );
  const height = Math.min(FLYOUT_MAX_HEIGHT_PX, Math.max(360, window.innerHeight * 0.7));
  let left = from.left;
  if (left + width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - width - 8);
  }
  let top = from.top;
  if (top + Math.min(height, 280) > window.innerHeight - 12) {
    top = Math.max(12, window.innerHeight - height - 12);
  }
  return { top, left, width, height };
}

export function AnnotationTypePicker({
  registry,
  visibleTypes,
  onToggleVisibleType,
  onSetVisibleTypes,
}: AnnotationTypePickerProps) {
  const presentationEvents = usePresentationListener();

  const [open, setOpen] = useState(false);
  const [morphed, setMorphed] = useState(false);
  const [closing, setClosing] = useState(false);
  const [filter, setFilter] = useState('');
  const [fromBox, setFromBox] = useState<Box | null>(null);
  const [toBox, setToBox] = useState<Box | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const registryIds = useMemo(() => new Set(registry.map((t) => t.trackId)), [registry]);
  const selectedTracks = useMemo(
    () => registry.filter((t) => visibleTypes.has(t.trackId)),
    [registry, visibleTypes]
  );
  const selectedCount = selectedTracks.length;
  const summaryBadges = selectedTracks.slice(0, SUMMARY_BADGE_LIMIT);
  const summaryOverflow = Math.max(0, selectedCount - SUMMARY_BADGE_LIMIT);
  const groups = useMemo(() => groupRegistry(registry, filter), [registry, filter]);

  const activePresetId = useMemo(() => {
    for (const preset of ANNOTATION_TYPE_PRESETS) {
      if (sameSet(resolvePresetTypes(preset, registryIds), visibleTypes)) return preset.id;
    }
    return null;
  }, [registryIds, visibleTypes]);

  const closeFully = () => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setOpen(false);
    setMorphed(false);
    setClosing(false);
    setFromBox(null);
    setToBox(null);
    setFilter('');
  };

  const beginOpen = () => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const from: Box = {
      top: r.top,
      left: r.left,
      width: Math.max(1, r.width),
      height: Math.max(1, r.height),
    };
    setFromBox(from);
    setToBox(computeOpenBox(from));
    setClosing(false);
    setMorphed(false);
    setOpen(true);
  };

  const beginClose = () => {
    if (!open || closing) return;
    setClosing(true);
    setMorphed(false);
    closeTimerRef.current = window.setTimeout(closeFully, MORPH_MS + 20);
  };

  useLayoutEffect(() => {
    if (!open || closing || !fromBox || !toBox || morphed) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setMorphed(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [open, closing, fromBox, toBox, morphed]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!open || !morphed) return;
    const refresh = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const nextFromBox: Box = {
        top: rect.top,
        left: rect.left,
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      };
      setFromBox(nextFromBox);
      setToBox(computeOpenBox(nextFromBox));
    };
    window.addEventListener('resize', refresh);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refresh) : null;
    if (observer) {
      let element: HTMLElement | null = anchorRef.current;
      while (element) {
        observer.observe(element);
        element = element.parentElement;
      }
      const canvasHost = document.querySelector('[data-testid="indexed-genome-canvas-host"]');
      if (canvasHost) observer.observe(canvasHost);
    }
    return () => {
      window.removeEventListener('resize', refresh);
      observer?.disconnect();
    };
  }, [open, morphed]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') beginClose();
    };
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (anchorRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      beginClose();
    };
    presentationEvents.add(document, 'keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      presentationEvents.remove(document, 'keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open, presentationEvents]);

  const summaryTitle =
    selectedCount === 0
      ? 'No annotation types shown — click to choose'
      : `${selectedCount} of ${registry.length} annotation types shown — click to change`;

  const box = open && fromBox && toBox ? (morphed ? toBox : fromBox) : null;
  const bodyRevealed = open && morphed;

  const headerRow = (
    <div className="flex items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate text-[10px] text-fg-muted">Annotations</span>
      <span
        data-testid="annotation-type-picker-count"
        className="shrink-0 text-[10px] tabular-nums text-fg-subtle"
      >
        {selectedCount} of {registry.length}
      </span>
      <ChevronIcon open={open && morphed} className="h-4 w-4 shrink-0 text-fg-muted" />
    </div>
  );

  const badgesBlock =
    selectedCount === 0 ? (
      <span className="text-[10px] text-fg-subtle">None shown</span>
    ) : (
      <SummaryBadges badges={summaryBadges} overflow={summaryOverflow} />
    );

  return (
    <div ref={anchorRef} className="relative w-full min-w-0">
      {}
      <button
        type="button"
        data-testid="annotation-type-picker-summary"
        aria-expanded={open}
        aria-haspopup="true"
        title={summaryTitle}
        onClick={(e) => {
          e.stopPropagation();
          if (closing) return;
          if (open) beginClose();
          else beginOpen();
        }}
        className={`flex w-full min-w-0 flex-col items-stretch gap-1 rounded px-0.5 py-0.5 text-left transition-[background-color] duration-0 ${
          open ? 'invisible' : 'hover:bg-fg/[0.08]'
        }`}
      >
        {headerRow}
        {badgesBlock}
      </button>

      {open &&
        box &&
        createPortal(
          <div
            ref={panelRef}
            role="group"
            aria-label="Annotation types"
            data-testid="annotation-type-picker"
            data-flyout="true"
            data-morphed={morphed ? 'true' : 'false'}
            style={{
              position: 'fixed',
              top: box.top,
              left: box.left,
              width: box.width,
              height: box.height,
              zIndex: 40,
              overflow: 'hidden',
              transformOrigin: 'top left',
              transition: `top ${MORPH_MS}ms ease-out, left ${MORPH_MS}ms ease-out, width ${MORPH_MS}ms ease-out, height ${MORPH_MS}ms ease-out, box-shadow ${MORPH_MS}ms ease-out`,
            }}
            className={`flex flex-col rounded-md border border-border/60 bg-bg ${
              morphed ? 'shadow-lg' : 'shadow-sm'
            }`}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              data-testid="annotation-type-picker-summary-expanded"
              title={summaryTitle}
              onClick={(e) => {
                e.stopPropagation();
                beginClose();
              }}
              className="flex w-full min-w-0 shrink-0 flex-col items-stretch gap-1 px-2.5 pt-2 pb-1.5 text-left hover:bg-fg/[0.04]"
            >
              {headerRow}
              {badgesBlock}
            </button>

            <div
              className="flex min-h-0 flex-1 flex-col overflow-hidden transition-opacity duration-150 ease-out"
              style={{
                opacity: bodyRevealed ? 1 : 0,
                pointerEvents: bodyRevealed ? 'auto' : 'none',
              }}
            >
              <div className="flex shrink-0 flex-col gap-2 border-t border-border/40 px-3 pt-2.5 pb-2">
                <div
                  className="flex flex-wrap gap-1"
                  data-testid="annotation-type-presets"
                  role="group"
                  aria-label="Presets"
                >
                  {ANNOTATION_TYPE_PRESETS.map((preset) => {
                    const active = activePresetId === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        data-testid={`annotation-type-preset-${preset.id}`}
                        onClick={() => onSetVisibleTypes(resolvePresetTypes(preset, registryIds))}
                        className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-[background-color,color,border-color] duration-0 ${
                          active
                            ? 'border-fg bg-fg text-bg'
                            : 'border-border text-fg-muted hover:border-fg-muted hover:bg-fg/[0.08] hover:text-fg'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>

                <input
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter…"
                  data-testid="annotation-type-filter"
                  autoFocus={bodyRevealed}
                  className="h-7 w-full border-0 border-b border-border/50 bg-transparent px-0 text-xs text-fg outline-none placeholder:text-fg-subtle focus:border-fg-muted"
                />
              </div>

              <div
                className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1"
                data-testid="annotation-type-picker-options"
              >
                {groups.length === 0 ? (
                  <div className="py-6 text-center text-xs text-fg-muted">No matches</div>
                ) : (
                  <div className="flex flex-col gap-3.5">
                    {groups.map((group) => (
                      <section key={group.id} data-testid={`annotation-type-group-${group.id}`}>
                        <h3 className="mb-1 text-[10px] text-fg-subtle">
                          {group.label}
                          <span className="ml-1.5 tabular-nums">
                            {group.tracks.filter((t) => visibleTypes.has(t.trackId)).length}/
                            {group.tracks.length}
                          </span>
                        </h3>
                        <div className="flex flex-wrap gap-1">
                          {group.tracks.map((track) => {
                            const checked = visibleTypes.has(track.trackId);
                            return (
                              <button
                                key={track.trackId}
                                type="button"
                                data-testid={`annotation-type-${track.trackId}`}
                                aria-pressed={checked}
                                title={
                                  track.label !== track.trackId
                                    ? `${track.label} (${track.trackId})`
                                    : track.label
                                }
                                onClick={() => onToggleVisibleType(track.trackId)}
                                className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-[background-color,color,border-color] duration-0 ${
                                  checked
                                    ? 'border-emerald-600/40 bg-emerald-600/15 text-fg'
                                    : 'border-border text-fg-muted hover:border-fg-muted hover:bg-fg/[0.08] hover:text-fg'
                                }`}
                              >
                                {track.label}
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
