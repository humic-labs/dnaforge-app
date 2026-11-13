import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const TRACK_HEIGHT = 12;
const THUMB_MIN_WIDTH = 24;

export interface SequenceScrollbar1DProps {
  totalWidth: number;
  viewportWidth: number;
  scrollLeft: number;
  onScrollChange: (nextScrollLeft: number) => void;
  className?: string;
  isCircular?: boolean;
  cycleWidth?: number;
}

export function SequenceScrollbar1D({
  totalWidth,
  viewportWidth,
  scrollLeft,
  onScrollChange,
  className,
  isCircular = false,
  cycleWidth,
}: SequenceScrollbar1DProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [measuredTrackWidth, setMeasuredTrackWidth] = useState<number | null>(null);
  const dragStateRef = useRef<{
    startClientX: number;
    startScrollLeft: number;
    trackWidth: number;
  } | null>(null);

  const needsScrollbar = totalWidth > viewportWidth + 1 && viewportWidth > 0;

  const trackWidth = measuredTrackWidth ?? viewportWidth;

  const scrollRange = isCircular && cycleWidth ? cycleWidth : totalWidth;
  const ratio = needsScrollbar ? viewportWidth / scrollRange : 1;
  const thumbWidth = Math.max(THUMB_MIN_WIDTH, Math.floor(trackWidth * ratio));

  const straddle = isCircular && !!cycleWidth && scrollLeft + viewportWidth > cycleWidth;

  let preWidth = 0;
  let preLeft = 0;
  let postWidth = 0;
  let postLeft = 0;
  if (straddle && cycleWidth) {
    const preVisiblePx = Math.max(0, cycleWidth - scrollLeft);
    const postVisiblePx = Math.max(0, viewportWidth - preVisiblePx);
    preWidth = (trackWidth * preVisiblePx) / cycleWidth;
    postWidth = (trackWidth * postVisiblePx) / cycleWidth;
    preLeft = Math.max(0, trackWidth - preWidth);
    postLeft = 0;
  }

  const maxScroll = Math.max(0, scrollRange - viewportWidth);
  const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
  const thumbLeft =
    isCircular && cycleWidth && !straddle
      ? Math.round((scrollLeft / cycleWidth) * trackWidth)
      : maxScroll > 0
        ? Math.round((scrollLeft / maxScroll) * maxThumbLeft)
        : 0;

  const onThumbPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!trackRef.current) return;
      (e.target as Element).setPointerCapture(e.pointerId);
      dragStateRef.current = {
        startClientX: e.clientX,
        startScrollLeft: scrollLeft,
        trackWidth: trackRef.current.clientWidth,
      };
      e.preventDefault();
    },
    [scrollLeft]
  );

  const onThumbPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const dxPx = e.clientX - drag.startClientX;

      if (isCircular && cycleWidth) {
        const dxScroll = (dxPx / drag.trackWidth) * cycleWidth;
        onScrollChange(drag.startScrollLeft + dxScroll);
        return;
      }

      const localMaxThumbLeft = Math.max(0, drag.trackWidth - thumbWidth);
      if (localMaxThumbLeft === 0) return;
      const dxScroll = (dxPx / localMaxThumbLeft) * maxScroll;
      const next = Math.max(0, Math.min(maxScroll, drag.startScrollLeft + dxScroll));
      onScrollChange(next);
    },
    [isCircular, cycleWidth, maxScroll, thumbWidth, onScrollChange]
  );

  const onThumbPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragStateRef.current = null;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {}
  }, []);

  const onTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!trackRef.current || !needsScrollbar) return;
      const rect = trackRef.current.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      if (straddle) {
        if (localX >= preLeft && localX <= preLeft + preWidth) return;
        if (localX >= postLeft && localX <= postLeft + postWidth) return;
      } else {
        if (localX >= thumbLeft && localX <= thumbLeft + thumbWidth) return;
      }

      const anchor = straddle ? preLeft : thumbLeft;
      const direction = localX < anchor ? -1 : 1;
      if (isCircular && cycleWidth) {
        onScrollChange(scrollLeft + direction * viewportWidth);
      } else {
        const next = Math.max(0, Math.min(maxScroll, scrollLeft + direction * viewportWidth));
        onScrollChange(next);
      }
    },
    [
      needsScrollbar,
      thumbLeft,
      thumbWidth,
      straddle,
      preLeft,
      preWidth,
      postLeft,
      postWidth,
      isCircular,
      cycleWidth,
      scrollLeft,
      maxScroll,
      viewportWidth,
      onScrollChange,
    ]
  );

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => setMeasuredTrackWidth(track.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    return () => ro.disconnect();
  }, [needsScrollbar]);

  if (!needsScrollbar) return null;

  const thumbStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    height: TRACK_HEIGHT,
    background: 'rgba(0, 0, 0, 0.35)',
    borderRadius: TRACK_HEIGHT / 2,
    cursor: 'grab',
    touchAction: 'none',
  };

  return (
    <div
      ref={trackRef}
      className={className}
      onPointerDown={onTrackPointerDown}
      style={{
        position: 'relative',
        width: '100%',
        height: TRACK_HEIGHT,
        background: 'rgba(0, 0, 0, 0.06)',
        borderRadius: TRACK_HEIGHT / 2,
        cursor: 'pointer',
        userSelect: 'none',
      }}
      data-testid="sequence-scrollbar-1d"
    >
      {straddle ? (
        <>
          <div
            onPointerDown={onThumbPointerDown}
            onPointerMove={onThumbPointerMove}
            onPointerUp={onThumbPointerUp}
            onPointerCancel={onThumbPointerUp}
            style={{ ...thumbStyle, left: preLeft, width: preWidth }}
            data-testid="sequence-scrollbar-1d-thumb"
            data-thumb-side="pre"
          />
          <div
            onPointerDown={onThumbPointerDown}
            onPointerMove={onThumbPointerMove}
            onPointerUp={onThumbPointerUp}
            onPointerCancel={onThumbPointerUp}
            style={{ ...thumbStyle, left: postLeft, width: postWidth }}
            data-testid="sequence-scrollbar-1d-thumb-post"
            data-thumb-side="post"
          />
        </>
      ) : (
        <div
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={onThumbPointerUp}
          onPointerCancel={onThumbPointerUp}
          style={{ ...thumbStyle, left: thumbLeft, width: thumbWidth }}
          data-testid="sequence-scrollbar-1d-thumb"
        />
      )}
    </div>
  );
}
