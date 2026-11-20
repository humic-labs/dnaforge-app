import { useLayoutEffect, useRef, type RefObject } from 'react';

import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import type { SharedSangerLane } from './shared-sequence-read-model';

interface Props {
  mapRef: RefObject<IndexedGenomeTileNativeMapHandle | null>;
  lanes: readonly SharedSangerLane[];
  gains?: Readonly<Record<string, number>>;
  onGainChange: (lane: SharedSangerLane, gain: number) => void;
  rendererEpoch: number;
}

export function sangerGainKey(laneId: string): string {
  return laneId.startsWith('sanger-direct-') ? 'sanger-direct' : laneId;
}

function gainLabel(gain: number): string {
  return `${Number(gain.toFixed(2))}×`;
}

export function SangerGainGutter({ mapRef, lanes, gains, onGainChange, rendererEpoch }: Props) {
  const gutter = useRef<HTMLDivElement>(null);
  const controls = useRef(new Map<string, HTMLDivElement>());
  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map || !rendererEpoch) return;
    const sync = () => {
      const renderer = map.getLinearRenderer();
      if (!renderer) return;
      const bounds = renderer.getLaneScreenSnapshot().trackScreenBounds;
      const clip = renderer.getPresentedTrackScrollReceipt()?.contentClipTopPx ?? 0;
      if (gutter.current) gutter.current.style.clipPath = `inset(${Math.max(0, clip)}px 0 0)`;
      for (const [id, control] of controls.current) {
        const band = bounds[id];
        control.style.visibility = band ? 'visible' : 'hidden';
        if (!band) continue;
        control.style.top = `${band.topPx}px`;
        control.style.height = `${band.heightPx}px`;
      }
    };
    sync();
    return map.subscribeToPresentedFrames(sync);
  }, [mapRef, rendererEpoch, lanes]);

  return (
    <div
      ref={gutter}
      data-sanger-gain-controls
      className="relative w-10 shrink-0 overflow-hidden border-r border-border bg-bg"
      onKeyDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      {lanes.map((lane) => {
        const gain = gains?.[sangerGainKey(lane.id)] ?? 1;
        return (
          <div
            key={lane.id}
            ref={(node) => {
              if (node) controls.current.set(lane.id, node);
              else controls.current.delete(lane.id);
            }}
            className="invisible absolute inset-x-0 flex flex-col items-center justify-center gap-1 text-[10px] text-fg-muted"
          >
            <span>Gain</span>
            <input
              type="range"
              min={0}
              max={3}
              step={0.125}
              aria-label={`Trace gain for ${lane.label}`}
              aria-orientation="vertical"
              aria-valuetext={gainLabel(gain)}
              value={Math.log2(gain)}
              onChange={(event) => onGainChange(lane, 2 ** event.currentTarget.valueAsNumber)}
              className="h-16 w-4 cursor-pointer"
              style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
            />
            <button
              type="button"
              title="Reset gain to 1×"
              aria-label={`Reset gain for ${lane.label}`}
              onClick={() => onGainChange(lane, 1)}
            >
              {gainLabel(gain)}
            </button>
          </div>
        );
      })}
    </div>
  );
}
