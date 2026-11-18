import { usePresentationListener } from '../../../presentation/PresentationSurface';
import {
  toUserMessage,
  userMessage,
  userMessageValue,
  userMessageWithValues,
  type UserMessage,
} from '@waypoint/user-messages';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  ANNOTATION_TRACK_LAYOUT_SCHEMA,
  DEFAULT_FILTER,
  DEFAULT_PRESENTATION,
  sourceId,
  trackBindingId,
  visualizationId,
  type AnnotationTrackBinding,
  type AnnotationTrackLayout,
  type FeatureKind,
} from '@waypoint/genome-data/annotation-catalog';
import { CompactFilterSelect } from '@waypoint/ui-components';
import { SCIENTIFIC_COLOR_PALETTES } from '@waypoint/sequence-utils';

import { Button } from '../../../shared/components/Button';
import { SettingsIcon } from '../../../components/icons';
import type { SequenceDataLayerPresentation } from '../../../shared/sequence-data-layer';
import type {
  SequenceDataLayerTrackControls,
  SequenceDataLayerTrackRow,
} from '../data-layers/useSequenceDataLayers';
import {
  inspectSequenceAnnotationTracks,
  subscribeSequenceAnnotationTracks,
  updateSequenceAnnotationTracks,
  type AnnotationKindChoices,
  type InspectedAnnotationTrack,
  type InspectedTrackResolution,
  type SequenceAnnotationTracksCommand,
} from './annotation-catalog-commands';
import {
  defaultLayoutFallbacksFor,
  defaultLayoutFor,
  fallbackNotice,
  type DefaultTrackFallback,
} from './default-layout';
import { friendlyLicenseName } from './license-names';

const CIRCULAR_NOTICE =
  'These tracks draw on the linear map. Switch the map to linear to see them.';

function useTracksInspection(ownerTabId: string) {
  const [version, bump] = useReducer((value: number) => value + 1, 0);
  useEffect(() => subscribeSequenceAnnotationTracks(ownerTabId, bump), [ownerTabId]);
  return useMemo(
    () => inspectSequenceAnnotationTracks(ownerTabId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ownerTabId, version]
  );
}

function resolutionText(resolution: InspectedTrackResolution): UserMessage {
  switch (resolution.status) {
    case 'hidden':
      return userMessage('tracks.statusHidden');
    case 'not-drawn':
      return userMessageWithValues('tracks.statusNotDrawn', {
        reason: userMessageValue(resolution.reason.toLowerCase()),
      });
    case 'loading':
      return userMessage('tracks.statusLoading');
    case 'ready':
      return resolution.recordCount === resolution.totalBeforeFilter
        ? userMessageWithValues('tracks.statusLoaded', {
            count: userMessageValue(resolution.recordCount.toLocaleString('en-US')),
          })
        : userMessageWithValues('tracks.statusLoadedOfTotal', {
            count: userMessageValue(resolution.recordCount.toLocaleString('en-US')),
            total: userMessageValue(resolution.totalBeforeFilter.toLocaleString('en-US')),
          });
    case 'error':
      return toUserMessage(resolution.message, 'tracks.loadFailed');
    default: {
      const _exhaustive: never = resolution;
      return _exhaustive;
    }
  }
}

function newTrackId(layout: AnnotationTrackLayout | null, kind: FeatureKind): string {
  const base = kind.replace(/_/g, '-');
  const taken = new Set<string>(layout?.tracks.map((track) => track.id) ?? []);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

export interface AddableTrack {
  readonly key: string;
  readonly kind: FeatureKind;
  readonly sourceId: string;
  readonly label: string;
}

export function addableTracks(choices: readonly AnnotationKindChoices[]): AddableTrack[] {
  return choices.flatMap((choice) =>
    choice.sources
      .filter((source) => source.availability.status === 'available')
      .map((source) => ({
        key: `${choice.kind}|${source.id}`,
        kind: choice.kind,
        sourceId: source.id,
        label: `${source.label} — ${choice.label}`,
      }))
  );
}

function bindingFor(
  layout: AnnotationTrackLayout | null,
  track: AddableTrack,
  visualization: string
): AnnotationTrackBinding {
  return {
    id: trackBindingId(newTrackId(layout, track.kind)),
    kind: track.kind,
    sourceId: sourceId(track.sourceId),
    visualizationId: visualizationId(visualization),
    visible: true,
    label: null,
    presentation: DEFAULT_PRESENTATION,
    filter: DEFAULT_FILTER,
  };
}

function EvidenceChip({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-semibold text-fg-muted">
      {label}
    </span>
  );
}

function TrackRow({
  track,
  choices,
  fallback,
  run,
}: {
  track: InspectedAnnotationTrack;
  choices: AnnotationKindChoices | undefined;
  fallback: DefaultTrackFallback | undefined;
  run: (command: SequenceAnnotationTracksCommand) => void;
}) {
  const { binding, source, resolution } = track;
  const unavailable = choices?.sources.filter(
    (option) => option.availability.status !== 'available'
  );
  return (
    <li
      className="flex flex-col gap-1.5 border-b border-border px-3 py-2 last:border-b-0"
      data-testid="annotation-track-row"
      data-track-id={binding.id}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={binding.visible}
          aria-label={`Show ${track.label}`}
          onChange={(event) =>
            run({ kind: 'set-visibility', trackId: binding.id, visible: event.target.checked })
          }
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-fg">
          {track.label}
        </span>
        {source ? <EvidenceChip label={source.evidenceLabel} /> : null}
        <button
          type="button"
          className="rounded px-1 text-[13px] leading-none text-fg-muted hover:bg-bg-muted hover:text-fg"
          aria-label={`Remove ${track.label}`}
          title="Remove track"
          onClick={() => run({ kind: 'remove-track', trackId: binding.id })}
        >
          ×
        </button>
      </div>
      <div className="grid grid-cols-[72px_1fr] items-center gap-x-2 gap-y-1 text-[11px] text-fg-muted">
        <span>Source</span>
        <CompactFilterSelect
          value={binding.sourceId}
          ariaLabel={`${track.label} source`}
          title={source?.label}
          options={(choices?.sources ?? []).map((option) => ({
            value: option.id,
            label:
              option.availability.status === 'available'
                ? option.label
                : `${option.label} (not available)`,
            disabled: option.availability.status !== 'available',
          }))}
          onChange={(value) =>
            run({ kind: 'set-source', trackId: binding.id, sourceId: sourceId(value) })
          }
        />
        <span>Drawn as</span>
        <CompactFilterSelect
          value={binding.visualizationId}
          ariaLabel={`${track.label} drawing style`}
          options={(choices?.visualizations ?? []).map((option) => ({
            value: option.id,
            label: option.label,
          }))}
          onChange={(value) =>
            run({
              kind: 'set-visualization',
              trackId: binding.id,
              visualizationId: visualizationId(value),
            })
          }
        />
      </div>
      {unavailable && unavailable.length > 0 ? (
        <div className="text-[10px] text-fg-muted">
          {unavailable.map((option) => (
            <span
              key={option.id}
              title={option.availability.status === 'unavailable' ? option.availability.reason : ''}
              className="cursor-help underline decoration-dotted"
            >
              Why is {option.label} not available?
            </span>
          ))}
        </div>
      ) : null}
      {fallback ? (
        <div className="text-[10px] text-fg-muted" data-testid="annotation-track-fallback">
          {fallbackNotice(fallback)}
        </div>
      ) : null}
      <div
        className={`text-[11px] ${resolution.status === 'error' ? 'text-error' : 'text-fg-muted'}`}
        data-testid="annotation-track-status"
        title={
          resolution.status === 'error'
            ? toUserMessage(resolution.detail, 'tracks.loadFailed')
            : undefined
        }
      >
        {resolutionText(resolution)}
      </div>
      {source ? (
        <div className="text-[10px] leading-snug text-fg-muted">
          <span className="font-semibold">{friendlyLicenseName(source.license.spdx)}</span> ·{' '}
          {source.license.attribution}
        </div>
      ) : (
        <div className="text-[10px] text-error">This source is no longer in the catalog.</div>
      )}
    </li>
  );
}

function DataLayerTrackRow({
  row,
  controls,
}: {
  row: SequenceDataLayerTrackRow;
  controls: SequenceDataLayerTrackControls;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { presentation } = row;
  const palette =
    Object.entries(SCIENTIFIC_COLOR_PALETTES).find(
      ([, candidate]) =>
        JSON.stringify(candidate.colors) === JSON.stringify(presentation.style.colorScale.colors)
    )?.[0] ?? 'custom';
  const setPresentation = (next: SequenceDataLayerPresentation) =>
    controls.onPresentationChange(row.id, next);
  return (
    <li
      className="flex flex-col gap-1.5 border-b border-border px-3 py-2 last:border-b-0"
      data-testid="sequence-data-layer-track-row"
      data-track-id={row.id}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={row.visible}
          aria-label={`Show ${row.label}`}
          onChange={(event) => controls.onVisibilityChange(row.id, event.target.checked)}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-fg">
          {row.label}
        </span>
        <button
          type="button"
          aria-label={`${settingsOpen ? 'Close' : 'Open'} settings for ${row.label}`}
          aria-expanded={settingsOpen}
          aria-controls={settingsOpen ? `sequence-data-layer-settings-${row.id}` : undefined}
          onClick={() => setSettingsOpen((open) => !open)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-bg-muted hover:text-fg"
        >
          <SettingsIcon size={14} />
        </button>
      </div>
      {row.unavailable ? (
        <div role="status" className="text-[11px] text-fg-muted">
          {row.unavailable}
        </div>
      ) : null}
      {settingsOpen ? (
        <div
          id={`sequence-data-layer-settings-${row.id}`}
          className="grid grid-cols-[72px_1fr] items-center gap-x-2 gap-y-2 text-[11px] text-fg-muted"
        >
          {presentation.style.geometry === 'matrix' ? (
            <>
              <span>Samples</span>
              <span>All {row.samples.length} source samples</span>
            </>
          ) : (
            <>
              <span>Sample</span>
              <CompactFilterSelect
                value={presentation.sampleId}
                ariaLabel={`Sample for ${row.label}`}
                options={row.samples.map((sample) => ({ value: sample.id, label: sample.label }))}
                onChange={(sampleId) => setPresentation({ ...presentation, sampleId })}
              />
            </>
          )}
          <span>Drawn as</span>
          <CompactFilterSelect
            value={presentation.style.geometry}
            ariaLabel={`Drawing style for ${row.label}`}
            options={[
              { value: 'bars', label: 'Bars' },
              { value: 'band', label: 'Color band' },
              { value: 'points', label: 'Points' },
              { value: 'arcs', label: 'Arcs' },
              { value: 'matrix', label: 'Matrix' },
            ]}
            onChange={(geometry) => {
              if (
                geometry === 'bars' ||
                geometry === 'band' ||
                geometry === 'points' ||
                geometry === 'arcs' ||
                geometry === 'matrix'
              )
                setPresentation({ ...presentation, style: { ...presentation.style, geometry } });
            }}
          />
          <span>Palette</span>
          <CompactFilterSelect
            value={palette}
            ariaLabel={`Color palette for ${row.label}`}
            options={[
              ...Object.entries(SCIENTIFIC_COLOR_PALETTES).map(([value, entry]) => ({
                value,
                label: entry.name,
              })),
              ...(palette === 'custom' ? [{ value: 'custom', label: 'Custom' }] : []),
            ]}
            onChange={(value) => {
              const colors = Object.entries(SCIENTIFIC_COLOR_PALETTES).find(
                ([key]) => key === value
              )?.[1].colors;
              if (colors)
                setPresentation({
                  ...presentation,
                  style: {
                    ...presentation.style,
                    colorScale: { ...presentation.style.colorScale, colors: [...colors] },
                  },
                });
            }}
          />
          {presentation.style.geometry !== 'matrix' &&
          controls.annotationColorsSupported !== false &&
          row.annotationColorsSupported !== false ? (
            <label className="col-span-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={presentation.annotationColors}
                aria-label={`Color annotations from ${row.label}`}
                onChange={(event) =>
                  setPresentation({ ...presentation, annotationColors: event.target.checked })
                }
              />
              Annotation colors
            </label>
          ) : null}
          <label className="col-span-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={presentation.signalVisible}
              aria-label={`Show signal for ${row.label}`}
              onChange={(event) =>
                setPresentation({ ...presentation, signalVisible: event.target.checked })
              }
            />
            Signal
          </label>
        </div>
      ) : null}
    </li>
  );
}

function DataLayerTrackRows({ controls }: { controls?: SequenceDataLayerTrackControls }) {
  if (!controls) return null;
  return (
    <>
      {controls.errors.map((error, index) => (
        <div key={index} role="alert" className="px-3 py-2 text-[11px] text-error">
          {error}
        </div>
      ))}
      {controls.rows.length > 0 ? (
        <ul className="flex flex-col">
          {controls.rows.map((row) => (
            <DataLayerTrackRow key={row.id} row={row} controls={controls} />
          ))}
        </ul>
      ) : null}
    </>
  );
}

export function SequenceAnnotationTracksPanel({
  ownerTabId,
  mapCircular,
  dataLayers,
}: {
  ownerTabId: string;
  mapCircular: boolean;
  dataLayers?: SequenceDataLayerTrackControls;
}) {
  const inspection = useTracksInspection(ownerTabId);
  const [problem, setProblem] = useState<string | null>(null);
  const [addKey, setAddKey] = useState<string | null>(null);
  const [addVisualization, setAddVisualization] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = useCallback(
    (command: SequenceAnnotationTracksCommand) => {
      const result = updateSequenceAnnotationTracks({ ownerTabId, command });
      if (result.status === 'updated') setProblem(null);
      else if (result.status === 'missing') setProblem('This tab is no longer open.');
      else setProblem(toUserMessage(result.issues[0].message, 'operation.failed'));
    },
    [ownerTabId]
  );

  if (inspection.status === 'missing' || !inspection.assembly) {
    if (dataLayers && (dataLayers.rows.length > 0 || dataLayers.errors.length > 0)) {
      return (
        <div data-testid="annotation-tracks-panel">
          {mapCircular ? (
            <div className="border-b border-border px-3 py-2 text-[11px] text-fg-muted">
              {CIRCULAR_NOTICE}
            </div>
          ) : null}
          <DataLayerTrackRows controls={dataLayers} />
        </div>
      );
    }
    return (
      <div className="p-3 text-[12px] text-fg-muted">No annotation tracks for this sequence.</div>
    );
  }

  const { layout, assembly, drawing, tracks, choices } = inspection;
  const choicesByKind = new Map(choices.map((choice) => [choice.kind, choice]));
  const fallbacksByTrack = new Map(
    defaultLayoutFallbacksFor(assembly.accession).map((fallback) => [fallback.trackId, fallback])
  );
  const fallbackFor = (track: InspectedAnnotationTrack) => {
    const fallback = fallbacksByTrack.get(track.binding.id);
    return fallback?.usedSourceId === track.binding.sourceId ? fallback : undefined;
  };

  const addable = addableTracks(choices);
  const selectedTrack = addable.find((track) => track.key === addKey) ?? addable[0] ?? null;
  const styleOptions = selectedTrack
    ? (choicesByKind.get(selectedTrack.kind)?.visualizations ?? []).map((option) => ({
        value: String(option.id),
        label: option.label,
      }))
    : [];
  const selectedStyle =
    styleOptions.find((option) => option.value === addVisualization)?.value ??
    styleOptions[0]?.value ??
    null;

  const addTrack = () => {
    if (!selectedTrack || !selectedStyle) {
      setProblem('No track is available to add.');
      return;
    }
    const binding = bindingFor(layout, selectedTrack, selectedStyle);
    if (layout) {
      run({ kind: 'add-track', binding });
    } else {
      run({
        kind: 'set-layout',
        layout: {
          schema: ANNOTATION_TRACK_LAYOUT_SCHEMA,
          assembly: assembly.accession,
          tracks: [binding],
        },
      });
    }
  };

  const copyLayout = () => {
    if (!layout) return;
    void navigator.clipboard
      .writeText(JSON.stringify(layout, null, 2))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setProblem("Couldn't copy the track settings."));
  };

  return (
    <div className="flex flex-col" data-testid="annotation-tracks-panel">
      <div className="border-b border-border px-3 py-2">
        <div className="text-[12px] font-semibold text-fg">Annotation tracks</div>
        <div className="text-[11px] text-fg-muted">{assembly.displayName}</div>
      </div>
      {mapCircular || drawing.phase === 'map-circular' ? (
        <div className="border-b border-border px-3 py-2 text-[11px] text-fg" role="note">
          {CIRCULAR_NOTICE}
        </div>
      ) : null}
      {drawing.phase === 'view-transformed' ? (
        <div className="border-b border-border px-3 py-2 text-[11px] text-fg" role="note">
          Tracks are hidden while the sequence is flipped or its start position is moved.
        </div>
      ) : null}
      {drawing.phase === 'error' ? (
        <div
          className="border-b border-border px-3 py-2 text-[11px] text-error"
          role="alert"
          title={drawing.detail ? toUserMessage(drawing.detail, 'tracks.loadFailed') : undefined}
        >
          {toUserMessage(drawing.message, 'tracks.loadFailed')}
        </div>
      ) : null}
      {problem ? (
        <div className="border-b border-border px-3 py-2 text-[11px] text-error" role="alert">
          {problem}
        </div>
      ) : null}
      {tracks.length > 0 ? (
        <ul className="flex flex-col">
          {tracks.map((track) => (
            <TrackRow
              key={track.binding.id}
              track={track}
              choices={choicesByKind.get(track.binding.kind)}
              fallback={fallbackFor(track)}
              run={run}
            />
          ))}
        </ul>
      ) : (
        <div className="px-3 py-2 text-[11px] text-fg-muted">No tracks yet.</div>
      )}
      <DataLayerTrackRows controls={dataLayers} />
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
        <CompactFilterSelect
          value={selectedTrack?.key ?? ''}
          ariaLabel="Track to add"
          className="w-64"
          options={addable.map((track) => ({ value: track.key, label: track.label }))}
          onChange={(value) => {
            setAddKey(value);
            setAddVisualization(null);
          }}
        />
        <span className="text-[11px] text-fg-muted">drawn as</span>
        <CompactFilterSelect
          value={selectedStyle ?? ''}
          ariaLabel="Drawing style for the new track"
          className="w-40"
          options={styleOptions}
          onChange={setAddVisualization}
        />
        <Button size="xs" variant="secondary" onClick={addTrack}>
          Add track
        </Button>
        {layout ? null : (
          <Button
            size="xs"
            variant="secondary"
            onClick={() => {
              const defaults = defaultLayoutFor(assembly.accession);
              if (defaults) run({ kind: 'set-layout', layout: defaults });
            }}
          >
            Use default tracks
          </Button>
        )}
        {layout ? (
          <Button size="xs" variant="ghost" onClick={copyLayout}>
            {copied ? 'Copied' : 'Copy track settings'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function SequenceAnnotationTracksControl({
  ownerTabId,
  mapCircular,
  dataLayers,
}: {
  ownerTabId: string;
  mapCircular: boolean;
  dataLayers?: SequenceDataLayerTrackControls;
}) {
  const presentationEvents = usePresentationListener();

  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    presentationEvents.add(document, 'keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      presentationEvents.remove(document, 'keydown', escape);
    };
  }, [open, presentationEvents]);

  return (
    <div
      ref={root}
      style={{ position: 'relative' }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="webgl-sync-lock-toggle"
        data-testid="annotation-tracks-toggle"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        title="Choose tracks and their appearance"
      >
        <span className="webgl-sync-lock-toggle-label">Tracks</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Annotation tracks"
          className="absolute left-0 top-[calc(100%+6px)] z-30 w-[360px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-md border border-border bg-bg shadow-lg"
          style={{ maxHeight: 'min(70vh, 560px)' }}
        >
          <SequenceAnnotationTracksPanel
            ownerTabId={ownerTabId}
            mapCircular={mapCircular}
            dataLayers={dataLayers}
          />
        </div>
      ) : null}
    </div>
  );
}
