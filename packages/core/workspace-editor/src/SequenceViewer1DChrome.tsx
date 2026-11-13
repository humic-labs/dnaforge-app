import { SequenceScrollbar1D } from './SequenceScrollbar1D';
import { FeatureHoverTooltip } from './FeatureHoverTooltip';
import type { PrimerDisplay } from './types';
import {
  sequenceViewer1DContentWidth,
  sequenceViewer1DPrimerDirectionLabel,
} from './sequence-viewer-1d-layout-flags';

export function SequenceViewer1DScrollbar(props: {
  show: boolean;
  totalWidth: number;
  viewportWidth: number;
  scrollLeft: number;
  onScrollChange: (next: number) => void;
  isCircular: boolean;
  columnCount: number;
  pxPerBase: number;
}): JSX.Element | null {
  if (!props.show) return null;
  return (
    <div style={{ padding: '4px 8px' }}>
      <SequenceScrollbar1D
        totalWidth={props.totalWidth}
        viewportWidth={props.viewportWidth}
        scrollLeft={props.scrollLeft}
        onScrollChange={props.onScrollChange}
        isCircular={props.isCircular}
        cycleWidth={sequenceViewer1DContentWidth(
          props.isCircular,
          props.columnCount,
          props.pxPerBase
        )}
      />
    </div>
  );
}

export function SequenceViewer1DPrimerTooltip(props: {
  primer: PrimerDisplay | null | undefined;
  position: { x: number; y: number } | null | undefined;
}): JSX.Element | null {
  if (!props.primer || !props.position) return null;
  const primer = props.primer;
  const pos = props.position;
  return (
    <FeatureHoverTooltip
      testId="primer-hover-tooltip"
      title={primer.name}
      lines={[
        `Primer • ${primer.start + 1}..${primer.end} bp`,
        `Tm: ${primer.tm.toFixed(1)}°C • GC: ${primer.gc.toFixed(1)}%`,
        sequenceViewer1DPrimerDirectionLabel(primer.direction),
        ...(primer.modificationMarkers?.map((marker) => `${marker.label} ${marker.token}`) ?? []),
      ]}
      clientX={pos.x}
      clientY={pos.y}
    />
  );
}
