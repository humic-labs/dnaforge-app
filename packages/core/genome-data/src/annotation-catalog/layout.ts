import {
  assemblyAccession,
  isAssemblyAccession,
  isCatalogId,
  sourceId,
  trackBindingId,
  visualizationId,
  type AssemblyAccession,
  type SourceId,
  type TrackBindingId,
  type VisualizationId,
} from './ids';
import { FEATURE_KIND_LABELS, isFeatureKind, type FeatureKind } from './records';
import type { AnnotationSourceCatalog } from './sources';
import type { AnnotationVisualizationCatalog } from './visualizations';

export const ANNOTATION_TRACK_LAYOUT_SCHEMA = 'dnaforge.annotation-track-layout.v0';

export type HexColor = `#${string}`;

export interface AnnotationTrackPresentation {
  readonly color: HexColor | null;
  readonly rowHeightPx: number | null;
  readonly maxRows: number | null;
}

export interface AnnotationTrackFilter {
  readonly minScore: number | null;
}

export interface AnnotationTrackBinding {
  readonly id: TrackBindingId;
  readonly kind: FeatureKind;
  readonly sourceId: SourceId;
  readonly visualizationId: VisualizationId;
  readonly visible: boolean;
  readonly label: string | null;
  readonly presentation: AnnotationTrackPresentation;
  readonly filter: AnnotationTrackFilter;
}

export interface AnnotationTrackLayout {
  readonly schema: typeof ANNOTATION_TRACK_LAYOUT_SCHEMA;
  readonly assembly: AssemblyAccession;
  readonly tracks: readonly AnnotationTrackBinding[];
}

export const DEFAULT_PRESENTATION: AnnotationTrackPresentation = Object.freeze({
  color: null,
  rowHeightPx: null,
  maxRows: null,
});

export const DEFAULT_FILTER: AnnotationTrackFilter = Object.freeze({ minScore: null });

export type AnnotationTrackCommand =
  | {
      readonly kind: 'add-track';
      readonly binding: AnnotationTrackBinding;
      readonly index?: number;
    }
  | { readonly kind: 'remove-track'; readonly trackId: TrackBindingId }
  | { readonly kind: 'set-source'; readonly trackId: TrackBindingId; readonly sourceId: SourceId }
  | {
      readonly kind: 'set-visualization';
      readonly trackId: TrackBindingId;
      readonly visualizationId: VisualizationId;
    }
  | { readonly kind: 'set-visibility'; readonly trackId: TrackBindingId; readonly visible: boolean }
  | {
      readonly kind: 'set-presentation';
      readonly trackId: TrackBindingId;
      readonly presentation: Partial<AnnotationTrackPresentation>;
    }
  | {
      readonly kind: 'set-filter';
      readonly trackId: TrackBindingId;
      readonly filter: Partial<AnnotationTrackFilter>;
    }
  | { readonly kind: 'move-track'; readonly trackId: TrackBindingId; readonly toIndex: number };

export interface LayoutIssue {
  readonly trackId: TrackBindingId | null;
  readonly code:
    | 'duplicate-track-id'
    | 'unknown-source'
    | 'source-wrong-kind'
    | 'source-wrong-assembly'
    | 'source-unavailable'
    | 'unknown-visualization'
    | 'visualization-wrong-kind'
    | 'unknown-track'
    | 'invalid-presentation'
    | 'invalid-index';
  readonly message: string;
}

export type AnnotationTrackCommandResult =
  | { readonly ok: true; readonly layout: AnnotationTrackLayout }
  | { readonly ok: false; readonly issues: readonly [LayoutIssue, ...LayoutIssue[]] };

interface Catalogs {
  readonly sources: AnnotationSourceCatalog;
  readonly visualizations: AnnotationVisualizationCatalog;
}

export function applyAnnotationTrackCommand(
  input: Catalogs & {
    readonly layout: AnnotationTrackLayout;
    readonly command: AnnotationTrackCommand;
  }
): AnnotationTrackCommandResult {
  const next = reduce(input.layout, input.command);
  if (!next.ok) return next;
  const issues = validateAnnotationTrackLayout({ ...input, layout: next.layout });
  const [first, ...rest] = issues;
  return first ? { ok: false, issues: [first, ...rest] } : next;
}

function reduce(
  layout: AnnotationTrackLayout,
  command: AnnotationTrackCommand
): AnnotationTrackCommandResult {
  const tracks = layout.tracks;
  const fail = (issue: LayoutIssue): AnnotationTrackCommandResult => ({
    ok: false,
    issues: [issue],
  });
  const withTracks = (next: readonly AnnotationTrackBinding[]): AnnotationTrackCommandResult => ({
    ok: true,
    layout: { ...layout, tracks: next },
  });

  if (command.kind === 'add-track') {
    const index = command.index ?? tracks.length;
    if (!Number.isInteger(index) || index < 0 || index > tracks.length) {
      return fail({
        trackId: command.binding.id,
        code: 'invalid-index',
        message: `Index ${index} is out of range`,
      });
    }
    return withTracks([...tracks.slice(0, index), command.binding, ...tracks.slice(index)]);
  }

  const position = tracks.findIndex((t) => t.id === command.trackId);
  if (position < 0) {
    return fail({
      trackId: command.trackId,
      code: 'unknown-track',
      message: `No track "${command.trackId}"`,
    });
  }
  const current = tracks[position];
  const replace = (binding: AnnotationTrackBinding) =>
    withTracks(tracks.map((t, i) => (i === position ? binding : t)));

  switch (command.kind) {
    case 'remove-track':
      return withTracks(tracks.filter((_, i) => i !== position));
    case 'set-source':
      return replace({ ...current, sourceId: command.sourceId });
    case 'set-visualization':
      return replace({ ...current, visualizationId: command.visualizationId });
    case 'set-visibility':
      return replace({ ...current, visible: command.visible });
    case 'set-presentation':
      return replace({
        ...current,
        presentation: { ...current.presentation, ...command.presentation },
      });
    case 'set-filter':
      return replace({ ...current, filter: { ...current.filter, ...command.filter } });
    case 'move-track': {
      if (
        !Number.isInteger(command.toIndex) ||
        command.toIndex < 0 ||
        command.toIndex >= tracks.length
      ) {
        return fail({
          trackId: command.trackId,
          code: 'invalid-index',
          message: `Index ${command.toIndex} is out of range`,
        });
      }
      const without = tracks.filter((_, i) => i !== position);
      return withTracks([
        ...without.slice(0, command.toIndex),
        current,
        ...without.slice(command.toIndex),
      ]);
    }
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

export function validateAnnotationTrackLayout(
  input: Catalogs & { readonly layout: AnnotationTrackLayout }
): readonly LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const seen = new Set<TrackBindingId>();
  for (const track of input.layout.tracks) {
    if (seen.has(track.id)) {
      issues.push({
        trackId: track.id,
        code: 'duplicate-track-id',
        message: `Track id "${track.id}" is used twice`,
      });
    }
    seen.add(track.id);

    const kindLabel = FEATURE_KIND_LABELS[track.kind].toLowerCase();
    const source = input.sources.get(track.sourceId);
    if (!source) {
      issues.push({
        trackId: track.id,
        code: 'unknown-source',
        message: `Unknown source "${track.sourceId}"`,
      });
    } else {
      if (!source.kinds.includes(track.kind)) {
        issues.push({
          trackId: track.id,
          code: 'source-wrong-kind',
          message: `${source.label} does not provide ${kindLabel}`,
        });
      }
      if (source.assembly !== input.layout.assembly) {
        issues.push({
          trackId: track.id,
          code: 'source-wrong-assembly',
          message: `${source.label} is for ${source.assembly}, this layout is for ${input.layout.assembly}`,
        });
      }
      if (source.availability.status === 'unavailable') {
        issues.push({
          trackId: track.id,
          code: 'source-unavailable',
          message: `${source.label}: ${source.availability.reason}`,
        });
      }
    }

    const visualization = input.visualizations.get(track.visualizationId);
    if (!visualization) {
      issues.push({
        trackId: track.id,
        code: 'unknown-visualization',
        message: `Unknown visualization "${track.visualizationId}"`,
      });
    } else if (!visualization.accepts.includes(track.kind)) {
      issues.push({
        trackId: track.id,
        code: 'visualization-wrong-kind',
        message: `${visualization.label} cannot draw ${kindLabel}`,
      });
    }

    const presentationProblem = checkPresentation(track.presentation);
    if (presentationProblem) {
      issues.push({
        trackId: track.id,
        code: 'invalid-presentation',
        message: presentationProblem,
      });
    }
  }
  return issues;
}

function checkPresentation(presentation: AnnotationTrackPresentation): string | null {
  if (presentation.color !== null && !/^#[0-9a-fA-F]{6}$/.test(presentation.color)) {
    return `Color must be #rrggbb, got "${presentation.color}"`;
  }
  if (
    presentation.rowHeightPx !== null &&
    !(presentation.rowHeightPx >= 4 && presentation.rowHeightPx <= 64)
  ) {
    return `Row height must be 4-64 px, got ${presentation.rowHeightPx}`;
  }
  if (
    presentation.maxRows !== null &&
    !(
      Number.isInteger(presentation.maxRows) &&
      presentation.maxRows >= 1 &&
      presentation.maxRows <= 64
    )
  ) {
    return `Max rows must be an integer 1-64, got ${presentation.maxRows}`;
  }
  return null;
}

export type ParseLayoutResult =
  | { readonly ok: true; readonly layout: AnnotationTrackLayout }
  | { readonly ok: false; readonly error: string };

export function parseAnnotationTrackLayout(raw: unknown): ParseLayoutResult {
  if (!isObject(raw)) return { ok: false, error: 'Layout must be an object' };
  if (raw.schema !== ANNOTATION_TRACK_LAYOUT_SCHEMA) {
    return { ok: false, error: `Expected schema ${ANNOTATION_TRACK_LAYOUT_SCHEMA}` };
  }
  if (typeof raw.assembly !== 'string' || !isAssemblyAccession(raw.assembly)) {
    return { ok: false, error: 'assembly must be a versioned accession' };
  }
  if (!Array.isArray(raw.tracks)) return { ok: false, error: 'tracks must be an array' };
  const tracks: AnnotationTrackBinding[] = [];
  for (const [index, entry] of raw.tracks.entries()) {
    const parsed = parseBinding(entry);
    if (typeof parsed === 'string') return { ok: false, error: `tracks[${index}]: ${parsed}` };
    tracks.push(parsed);
  }
  return {
    ok: true,
    layout: {
      schema: ANNOTATION_TRACK_LAYOUT_SCHEMA,
      assembly: assemblyAccession(raw.assembly),
      tracks,
    },
  };
}

function parseBinding(raw: unknown): AnnotationTrackBinding | string {
  if (!isObject(raw)) return 'must be an object';
  const { id, kind, sourceId: source, visualizationId: visualization, visible } = raw;
  if (typeof id !== 'string' || !isCatalogId(id)) return 'id must be a catalog id';
  if (typeof kind !== 'string' || !isFeatureKind(kind)) return `unknown kind "${String(kind)}"`;
  if (typeof source !== 'string' || !isCatalogId(source)) return 'sourceId must be a catalog id';
  if (typeof visualization !== 'string' || !isCatalogId(visualization))
    return 'visualizationId must be a catalog id';
  if (typeof visible !== 'boolean') return 'visible must be a boolean';
  const label = raw.label === undefined || raw.label === null ? null : raw.label;
  if (label !== null && typeof label !== 'string') return 'label must be a string or null';

  const presentationRaw = raw.presentation === undefined ? {} : raw.presentation;
  if (!isObject(presentationRaw)) return 'presentation must be an object';
  const color = nullableString(presentationRaw.color);
  const rowHeightPx = nullableNumber(presentationRaw.rowHeightPx);
  const maxRows = nullableNumber(presentationRaw.maxRows);
  if (color === undefined || rowHeightPx === undefined || maxRows === undefined) {
    return 'presentation fields must be null or the right type';
  }
  if (color !== null && !isHexColor(color)) return `color must be #rrggbb, got "${color}"`;

  const filterRaw = raw.filter === undefined ? {} : raw.filter;
  if (!isObject(filterRaw)) return 'filter must be an object';
  const minScore = nullableNumber(filterRaw.minScore);
  if (minScore === undefined) return 'filter.minScore must be a number or null';

  return {
    id: trackBindingId(id),
    kind,
    sourceId: sourceId(source),
    visualizationId: visualizationId(visualization),
    visible,
    label,
    presentation: { color, rowHeightPx, maxRows },
    filter: { minScore },
  };
}

function isHexColor(value: string): value is HexColor {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
