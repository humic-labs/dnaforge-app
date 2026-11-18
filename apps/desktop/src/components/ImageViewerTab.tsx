import { INTERACTION_CLASS } from '@waypoint/ui-components';
import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  type CSSProperties,
} from 'react';
import { getExtension, getFilename } from '../utils/fileTypes';
import { platform } from '../platform';
import {
  beginReadableContentOwner,
  type ReadableContentOwner,
} from '../lib/readable-content-telemetry';
import {
  beginImageRead,
  type ImageReadLease,
  type ImageReadFailure,
} from '../features/document-opening/image-view-lifecycle';
import {
  IMAGE_ZOOM_PRESETS,
  IMAGE_MIN_ZOOM,
  IMAGE_MAX_ZOOM,
  imageFitScale,
  stepImageScale,
  type ImageZoom,
  type ImageSize,
} from './image-view-geometry';

const MAX_IMAGE_VIEWER_BYTES = 256 * 1024 * 1024;
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};
const FAILURE_GUIDANCE: Record<ImageReadFailure, string> = {
  read_unknown:
    'The file could not be read. Check access, availability, and the 256 MiB limit, then retry.',
  decode_unknown:
    'The image could not be decoded. It may be damaged or use an unsupported format. Replace it with a supported image, then retry.',
  prepare_unknown: 'The image could not be prepared for display. Retry, or close and reopen it.',
};
interface ImageViewerTabProps {
  filePath: string;
  sourceFileName?: string;
  canvasTabId?: string;
}
type Attempt = {
  serial: number;
  filePath: string;
  sourceFileName?: string;
  canvasTabId?: string;
  lease: ImageReadLease;
  readableOwner: ReadableContentOwner | null;
  phase: 'reading' | 'decoding' | 'ready' | 'failed';
  url: string | null;
  ended: boolean;
};
type View = {
  attempt: Attempt | null;
  status: Attempt['phase'];
  natural: ImageSize | null;
  failure: ImageReadFailure | null;
};

function revoke(attempt: Attempt): void {
  if (!attempt.url) return;
  const url = attempt.url;
  attempt.url = null;
  try {
    URL.revokeObjectURL(url);
  } catch (_error) {
    void _error;
  }
}

export function ImageViewerTab({ filePath, sourceFileName, canvasTabId }: ImageViewerTabProps) {
  const [view, setView] = useState<View>({
    attempt: null,
    status: 'reading',
    natural: null,
    failure: null,
  });
  const [zoom, setZoom] = useState<ImageZoom>('fit');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [viewport, setViewport] = useState<ImageSize>({ width: 0, height: 0 });
  const active = useRef<Attempt | null>(null);
  const serial = useRef(0);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const filename = useMemo(
    () => getFilename(sourceFileName ?? filePath),
    [filePath, sourceFileName]
  );
  const current = useCallback(
    (attempt: Attempt) => active.current === attempt && !attempt.ended && attempt.lease.isCurrent(),
    []
  );
  const endDrag = useCallback(() => {
    drag.current = null;
    setIsDragging(false);
  }, []);
  const endAttempt = useCallback((attempt: Attempt) => {
    if (attempt.ended) return;
    attempt.ended = true;
    try {
      attempt.lease.dispose();
    } catch (_error) {
      void _error;
    } finally {
      attempt.readableOwner?.release();
      revoke(attempt);
      if (active.current === attempt) active.current = null;
    }
  }, []);
  const failAttempt = useCallback(
    (attempt: Attempt, failure: ImageReadFailure) => {
      if (!current(attempt) || attempt.phase === 'ready' || attempt.phase === 'failed') return;
      attempt.phase = 'failed';
      revoke(attempt);
      attempt.lease.fail(failure);
      attempt.readableOwner?.fail();
      endDrag();
      setView({ attempt, status: 'failed', failure, natural: null });
    },
    [current, endDrag]
  );

  const startAttempt = useCallback(
    (retry = false) => {
      if (active.current) endAttempt(active.current);
      const attempt: Attempt = {
        serial: ++serial.current,
        filePath,
        sourceFileName,
        canvasTabId,
        lease: beginImageRead({ tabId: canvasTabId, filePath, sourceFileName, retry }),
        readableOwner: beginReadableContentOwner({ tabId: canvasTabId, contentKey: filePath }),
        phase: 'reading',
        url: null,
        ended: false,
      };
      active.current = attempt;
      endDrag();
      setZoom('fit');
      setPan({ x: 0, y: 0 });
      setView({ attempt, status: 'reading', natural: null, failure: null });
      if (!current(attempt)) return attempt;
      attempt.lease.readStarted();
      void (async () => {
        let bytesRead = false;
        try {
          const bytes = await platform().fs.readFileBounded(filePath, MAX_IMAGE_VIEWER_BYTES);
          if (!current(attempt)) return;
          bytesRead = true;
          attempt.lease.bytesReady();
          const extension = getExtension(sourceFileName ?? filePath);
          const blob = new Blob([bytes], {
            type: (extension && IMAGE_MIME_BY_EXT[extension]) || '',
          });
          attempt.url = URL.createObjectURL(blob);
          if (!current(attempt)) {
            revoke(attempt);
            return;
          }
          attempt.phase = 'decoding';
          setView({ attempt, status: 'decoding', natural: null, failure: null });
        } catch {
          failAttempt(attempt, bytesRead ? 'prepare_unknown' : 'read_unknown');
        }
      })();
      return attempt;
    },
    [canvasTabId, current, endAttempt, endDrag, failAttempt, filePath, sourceFileName]
  );
  useEffect(() => {
    startAttempt();
    return () => {
      if (active.current) endAttempt(active.current);
    };
  }, [endAttempt, startAttempt]);

  const handleImageLoad = useCallback(
    (attempt: Attempt, image: HTMLImageElement) => {
      if (
        !current(attempt) ||
        attempt.phase !== 'decoding' ||
        image !== imageRef.current ||
        image.getAttribute('src') !== attempt.url
      )
        return;
      const natural = { width: image.naturalWidth, height: image.naturalHeight };
      if (![natural.width, natural.height].every((value) => Number.isFinite(value) && value > 0)) {
        failAttempt(attempt, 'decode_unknown');
        return;
      }
      attempt.phase = 'ready';
      attempt.lease.decoded();
      attempt.readableOwner?.readable();
      setPan({ x: 0, y: 0 });
      setView({ attempt, status: 'ready', natural, failure: null });
    },
    [current, failAttempt]
  );
  const handleImageError = useCallback(
    (attempt: Attempt, image: HTMLImageElement) => {
      if (
        current(attempt) &&
        attempt.phase === 'decoding' &&
        image === imageRef.current &&
        image.getAttribute('src') === attempt.url
      )
        failAttempt(attempt, 'decode_unknown');
    },
    [current, failAttempt]
  );

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = (size: ImageSize) => {
      if (containerRef.current !== element) return;
      setViewport((previous) =>
        previous.width === size.width && previous.height === size.height ? previous : size
      );
    };
    const readSize = () => measure({ width: element.clientWidth, height: element.clientHeight });
    readSize();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            const entry = entries.find((candidate) => candidate.target === element);
            if (entry)
              measure({ width: entry.contentRect.width, height: entry.contentRect.height });
          });
    observer?.observe(element);
    window.addEventListener('resize', readSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', readSize);
    };
  }, [view.attempt, view.status]);
  useEffect(() => {
    document.addEventListener('mouseup', endDrag);
    window.addEventListener('blur', endDrag);
    return () => {
      document.removeEventListener('mouseup', endDrag);
      window.removeEventListener('blur', endDrag);
    };
  }, [endDrag]);

  const fitScale = imageFitScale(view.natural, viewport);
  const effectiveScale = zoom === 'fit' ? fitScale : zoom / 100;
  const handleZoomChange = useCallback(
    (level: ImageZoom) => {
      setZoom(level);
      if (level === 'fit') {
        setPan({ x: 0, y: 0 });
        endDrag();
      }
    },
    [endDrag]
  );
  const cycleZoom = useCallback(
    (direction: 1 | -1) => {
      setZoom((previous) => {
        const scale = previous === 'fit' ? fitScale : previous / 100;
        if (scale === null) return previous;
        const next = stepImageScale(scale, direction);
        return next === scale ? previous : next * 100;
      });
    },
    [fitScale]
  );
  const handleDoubleClick = useCallback(() => {
    setZoom((previous) => (previous === 'fit' ? 100 : 'fit'));
    setPan({ x: 0, y: 0 });
    endDrag();
  }, [endDrag]);
  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (view.status !== 'ready') return;
      if (
        (!event.metaKey && !event.ctrlKey) ||
        !Number.isFinite(event.deltaY) ||
        event.deltaY === 0
      )
        return;
      event.preventDefault();
      cycleZoom(event.deltaY > 0 ? -1 : 1);
    },
    [cycleZoom, view.status]
  );
  useEffect(() => {
    const element = containerRef.current;
    element?.addEventListener('wheel', handleWheel, { passive: false });
    return () => element?.removeEventListener('wheel', handleWheel);
  }, [handleWheel, view.attempt, view.status]);
  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (zoom === 'fit' || view.status !== 'ready' || event.button !== 0) return;
      drag.current = { x: event.clientX - pan.x, y: event.clientY - pan.y };
      setIsDragging(true);
    },
    [pan, view.status, zoom]
  );
  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    if (drag.current)
      setPan({ x: event.clientX - drag.current.x, y: event.clientY - drag.current.y });
  }, []);
  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(filePath);
    } catch {
      console.error('Failed to copy image path');
    }
  }, [filePath]);
  const imageStyle = useMemo<CSSProperties>(() => {
    const scale = zoom === 'fit' ? fitScale : zoom / 100;
    return {
      width: view.natural && scale !== null ? view.natural.width * scale : undefined,
      height: view.natural && scale !== null ? view.natural.height * scale : undefined,
      maxWidth: view.natural && scale !== null ? 'none' : '100%',
      maxHeight: view.natural && scale !== null ? 'none' : '100%',
      objectFit: 'contain',
      flexShrink: 0,
      transform: `translate(${pan.x}px, ${pan.y}px)`,
      cursor: zoom === 'fit' ? 'default' : isDragging ? 'grabbing' : 'grab',
    };
  }, [fitScale, isDragging, pan, view.natural, zoom]);

  const attempt = view.attempt;
  if (
    !attempt ||
    attempt.filePath !== filePath ||
    attempt.sourceFileName !== sourceFileName ||
    attempt.canvasTabId !== canvasTabId ||
    !current(attempt) ||
    view.status === 'reading'
  ) {
    return (
      <div
        className="h-full flex items-center justify-center bg-bg-inset ph-no-capture rr-block"
        data-ph-no-capture
        data-analytics-block
        data-ph-mask
      >
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full mx-auto mb-2" />
          <p className="text-sm text-fg-muted">Loading image...</p>
        </div>
      </div>
    );
  }
  if (view.status === 'failed') {
    return (
      <div
        className="h-full flex items-center justify-center bg-bg-inset p-4 ph-no-capture rr-block"
        data-ph-no-capture
        data-analytics-block
        data-ph-mask
      >
        <div className="text-center max-w-md">
          <div className="text-4xl mb-4">🖼️</div>
          <div className="text-lg font-medium text-fg mb-2">Failed to load image</div>
          <div className="text-sm text-fg-muted">
            {FAILURE_GUIDANCE[view.failure ?? 'read_unknown']}
          </div>
          <button
            data-testid="image-viewer-retry"
            className="mt-3 px-3 py-1.5 rounded bg-accent/10 text-accent"
            onClick={() => {
              if (current(attempt) && attempt.phase === 'failed' && attempt.lease.isVisible())
                startAttempt(true);
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  return (
    <div
      className="h-full flex flex-col bg-bg-inset ph-no-capture rr-block"
      data-ph-no-capture
      data-analytics-block
      data-ph-mask
    >
      <div className="tab-chrome-surface flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm text-fg truncate">{filename}</span>
          {view.natural && (
            <span className="text-xs text-fg-muted">
              {view.natural.width} × {view.natural.height}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(['fit', ...IMAGE_ZOOM_PRESETS] as const).map((level) => (
            <button
              key={level}
              onClick={() => handleZoomChange(level)}
              data-selected={zoom === level}
              className={`${INTERACTION_CLASS} px-2 py-1 text-xs rounded transition-colors ${zoom === level ? 'bg-accent/10 text-accent' : 'text-fg-muted '}`}
            >
              {level === 'fit' ? 'Fit' : `${level}%`}
            </button>
          ))}
          <div className="flex items-center ml-2 border-l border-border pl-2">
            <button
              onClick={() => cycleZoom(-1)}
              disabled={
                view.status !== 'ready' ||
                effectiveScale === null ||
                effectiveScale <= IMAGE_MIN_ZOOM
              }
              className={`${INTERACTION_CLASS} px-2 py-1 text-sm text-fg-muted rounded transition-colors disabled:opacity-40`}
              title="Zoom out"
            >
              −
            </button>
            <button
              onClick={() => cycleZoom(1)}
              disabled={
                view.status !== 'ready' ||
                effectiveScale === null ||
                effectiveScale >= IMAGE_MAX_ZOOM
              }
              className={`${INTERACTION_CLASS} px-2 py-1 text-sm text-fg-muted rounded transition-colors disabled:opacity-40`}
              title="Zoom in"
            >
              +
            </button>
          </div>
          <button
            onClick={handleCopyPath}
            className={`${INTERACTION_CLASS} ml-2 px-2 py-1 text-xs text-fg-muted rounded transition-colors`}
            title="Copy image path"
          >
            Copy Path
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        data-testid="image-viewer-surface"
        className="relative flex-1 overflow-hidden flex items-center justify-center"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onDoubleClick={handleDoubleClick}
      >
        {attempt.url && (
          <img
            key={attempt.serial}
            ref={imageRef}
            data-testid="image-viewer-img"
            src={attempt.url}
            alt={filename}
            onLoad={(event) => handleImageLoad(attempt, event.currentTarget)}
            onError={(event) => handleImageError(attempt, event.currentTarget)}
            style={imageStyle}
            className="select-none"
            draggable={false}
          />
        )}
        {view.status === 'decoding' && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg-inset/80">
            <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full" />
          </div>
        )}
      </div>
      <div className="px-3 py-1.5 border-t border-border bg-bg-subtle text-xs text-fg-muted text-center">
        {zoom === 'fit'
          ? 'Double-click for 100% • Cmd/Ctrl + scroll to zoom'
          : 'Drag to pan • Double-click to fit • Cmd/Ctrl + scroll to zoom'}
      </div>
    </div>
  );
}
