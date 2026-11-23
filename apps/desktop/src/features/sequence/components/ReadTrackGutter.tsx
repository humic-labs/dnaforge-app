import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Button, Select, TextField, VerticalRangeField } from '../../../components/ui';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import {
  GUTTER_UNBANDED_ROW_HEIGHT_PX,
  TrackGutter,
  type TrackGutterProps,
  type TrackMovePlacement,
} from './TrackGutter';
import { buildLaneGutterRows, type GutterRow } from './track-gutter-rows';
import type {
  ReadTrackBinding,
  ReadTrackCommand,
  ReadTrackLayout,
  ReadTrackRow,
} from './read-track-presentation';
import { useLaneScreenBands } from './useLaneScreenBands';
import { useTrackGutterScroll } from './useTrackGutterScroll';
import { useTrackGutterLayoutStore } from './track-gutter-layout-store';

interface Props extends Pick<
  TrackGutterProps,
  | 'annotationTrackRegistry'
  | 'visibleTypes'
  | 'onToggleVisibleType'
  | 'onSetVisibleTypes'
  | 'referenceControls'
> {
  mapRef: RefObject<IndexedGenomeTileNativeMapHandle | null>;
  rendererEpoch: number;
  referenceLabel: string;
  bindings: readonly ReadTrackBinding[];
  layout: ReadTrackLayout;
  onCommand: (command: ReadTrackCommand) => void;
  onPreviewCommand?: (command: ReadTrackCommand | null) => void;
}
type Group = Extract<ReadTrackRow, { kind: 'group' }>;

function TrackGroupSettings({
  id,
  label,
  group,
  groups,
  isGroup,
  onCommand,
}: {
  id: string;
  label: string;
  group?: string;
  groups: readonly Group[];
  isGroup: boolean;
  onCommand: Props['onCommand'];
}) {
  const [name, setName] = useState(isGroup ? label : '');
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {!isGroup && groups.length > 0 && (
        <Select
          ariaLabel={`Group for ${label}`}
          value={group ?? ''}
          options={[
            { value: '', label: 'No group' },
            ...groups.map((g) => ({ value: g.id, label: g.label })),
          ]}
          onValueChange={(value) => onCommand({ type: 'move', id, groupId: value || undefined })}
        />
      )}
      <form
        className="flex flex-col gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          onCommand(
            isGroup
              ? { type: 'rename-group', id, label: name }
              : {
                  type: 'create-group',
                  id: `group-${crypto.randomUUID()}`,
                  label: name,
                  trackIds: [id],
                }
          );
          if (!isGroup) setName('');
        }}
      >
        <TextField
          aria-label={isGroup ? 'Group name' : 'New group name'}
          placeholder={isGroup ? 'Group name' : 'New group name'}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" disabled={!name.trim() || (isGroup && name === label)}>
          {isGroup ? 'Rename group' : 'Create group'}
        </Button>
      </form>
      {isGroup && (
        <Button onClick={() => onCommand({ type: 'ungroup', id })}>Ungroup tracks</Button>
      )}
    </div>
  );
}

function TrackParameters({
  binding,
  label,
  onCommand,
}: {
  binding: ReadTrackBinding;
  label: string;
  onCommand: Props['onCommand'];
}) {
  return binding.controls.map((control) => {
    const setting = binding.settings[control.key];
    const value = typeof setting === 'number' ? setting : control.defaultValue;
    const logarithmic = control.scale === 'log2';
    const axis = logarithmic ? Math.log2 : (v: number) => v;
    const display = `${Number(value.toFixed(2))}${control.unit}`;
    const change = (value: number) =>
      onCommand({ type: 'setting', id: binding.key, key: control.key, value });
    return (
      <div
        key={control.key}
        className="flex min-h-0 shrink items-center gap-2 pl-1 text-xs text-fg-muted"
      >
        <VerticalRangeField
          aria-label={`${control.label} for ${label}`}
          aria-valuetext={display}
          min={axis(control.min)}
          max={axis(control.max)}
          step={control.step}
          value={axis(value)}
          onChange={(e) =>
            change(logarithmic ? 2 ** e.currentTarget.valueAsNumber : e.currentTarget.valueAsNumber)
          }
        />
        <span>{control.label}</span>
        <Button
          variant="link"
          aria-label={`Reset ${control.key} for ${label}`}
          onClick={() => change(control.defaultValue)}
        >
          {display}
        </Button>
      </div>
    );
  });
}

export function ReadTrackGutter({
  mapRef,
  rendererEpoch,
  bindings,
  layout,
  referenceLabel,
  onCommand,
  onPreviewCommand,
  ...reference
}: Props) {
  const bands = useLaneScreenBands(mapRef, rendererEpoch);
  const scrollLayerRef = useTrackGutterScroll(mapRef, rendererEpoch);
  const width = useTrackGutterLayoutStore((s) => s.width);
  const resize = useTrackGutterLayoutStore((s) => s.setWidth);
  const { rows, groups, order, lookup } = useMemo(() => {
    const groups = layout.rows.filter((r): r is Group => r.kind === 'group');
    const lookup = new Map(bindings.map((binding) => [binding.key, binding]));
    const parsed = buildLaneGutterRows({
      bands,
      referenceLabel,
      annotationVisibleCount: reference.visibleTypes?.size ?? 1,
      dataLanes: bindings.map(({ track }) => ({
        dataset: {
          trackId: track.id,
          label: track.label ?? track.id,
          trackPx: track.sizing?.kind === 'fixed' ? track.sizing.pixels : undefined,
        },
        visible: track.visible,
        bucket: 'read',
        removable: false,
        reorderable: true,
      })),
    });
    const byId = new Map(parsed.map((row) => [row.trackId, row]));
    const referenceRow = parsed.find((row) => row.kind === 'reference')!;
    const rows: GutterRow[] = [{ ...referenceRow, visible: true, togglable: false }];
    const order: string[] = [];
    const append = (key: string, groupId?: string) => {
      const binding = lookup.get(key);
      const row = binding && byId.get(binding.track.id);
      if (row) {
        rows.push({ ...row, trackId: key, groupId });
        order.push(key);
      }
    };
    for (const node of layout.rows) {
      if (node.kind === 'group') {
        rows.push({
          id: node.id,
          trackId: node.id,
          kind: 'group',
          label: node.label,
          visible: true,
          removable: false,
          togglable: false,
          reorderable: true,
          band: bands.dataBounds[node.id],
        });
        order.push(node.id);
        for (const key of node.trackIds) append(key, node.id);
      } else append(node.id);
    }
    return { rows, order, groups, lookup };
  }, [bindings, layout, bands, referenceLabel, reference.visibleTypes]);
  const endReserve = rows.filter((row) => !row.band).length * GUTTER_UNBANDED_ROW_HEIGHT_PX;
  useEffect(() => {
    mapRef.current?.setTrackStackEndReserve?.(endReserve);
  }, [endReserve, rendererEpoch, mapRef]);

  function move(id: string, target: string, side: TrackMovePlacement): ReadTrackCommand {
    const parent = groups.find((g) => g.trackIds.includes(target));
    const sourceIsGroup = groups.some((g) => g.id === id);
    const destination = sourceIsGroup && parent ? parent.id : target;
    const insertInto =
      !sourceIsGroup && side === 'after' ? groups.find((g) => g.id === destination) : undefined;
    if (insertInto)
      return { type: 'move', id, groupId: insertInto.id, beforeId: insertInto.trackIds[0] };
    const siblings = (
      !sourceIsGroup && parent ? parent.trackIds : layout.rows.map((r) => r.id)
    ).filter((key) => key !== id);
    return {
      type: 'move',
      id,
      groupId: sourceIsGroup ? undefined : parent?.id,
      beforeId: side === 'before' ? destination : siblings[siblings.indexOf(destination) + 1],
    };
  }
  return (
    <TrackGutter
      {...reference}
      rows={rows}
      width={width}
      onResize={resize}
      scrollLayerRef={scrollLayerRef}
      onVerticalScroll={(delta) => mapRef.current?.scrollTracksBy(delta)}
      dataRowOrder={order}
      onToggleVisible={(row) =>
        row.trackId && onCommand({ type: 'visibility', id: row.trackId, visible: !row.visible })
      }
      onMoveDataRow={(id, target, side) => onCommand(move(id, target, side))}
      onPreviewMoveDataRow={(id, target, side) => onPreviewCommand?.(move(id, target, side))}
      onCancelDataRowOrder={() => onPreviewCommand?.(null)}
      onPreviewDataRowHeight={(row, heightPx) =>
        row.trackId && onPreviewCommand?.({ type: 'resize', id: row.trackId, heightPx })
      }
      onCommitDataRowHeight={(row, _start, heightPx) =>
        row.trackId && onCommand({ type: 'resize', id: row.trackId, heightPx })
      }
      onCancelDataRowHeight={() => onPreviewCommand?.(null)}
      renderDataControls={(row, expanded) => {
        if (!row.trackId) return null;
        const binding = lookup.get(row.trackId);
        const showInline = row.visible && (row.band?.heightPx ?? 0) >= 112;
        const parameters = binding ? (
          <TrackParameters binding={binding} label={row.label} onCommand={onCommand} />
        ) : null;
        if (expanded)
          return (
            <>
              {!showInline && parameters}
              <TrackGroupSettings
                key={row.id}
                id={row.trackId}
                label={row.label}
                group={row.groupId}
                groups={groups}
                isGroup={row.kind === 'group'}
                onCommand={onCommand}
              />
            </>
          );
        return showInline ? parameters : null;
      }}
      onRemove={() => {}}
    />
  );
}
