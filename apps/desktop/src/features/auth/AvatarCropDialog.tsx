import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../../presentation/PresentationSurface';
import { Button } from '../../components/ui';
import { useEffect, useRef, useState, type Ref } from 'react';
import {
  AVATAR_MAX_ZOOM,
  AVATAR_MIN_ZOOM,
  AVATAR_VIEWPORT_PX,
  avatarDisplayPlacement,
  avatarSourceRect,
  blobToBase64,
  drawAvatarJpeg,
  encodeWithinByteBudget,
  type AvatarCrop,
  type ImageSize,
} from './avatar-crop';

const INITIAL_CROP: AvatarCrop = { zoom: 1, offsetX: 0, offsetY: 0 };

export interface AvatarCropResult {
  base64: string;
  contentType: 'image/jpeg';
  previewUrl: string;
}

export function AvatarCropDialog({
  imageUrl,
  busy,
  onClose,
  onChangePhoto,
  onAccept,
  onError,
}: {
  imageUrl: string;
  busy: boolean;
  onClose: () => void;
  onChangePhoto: () => void;
  onAccept: (result: AvatarCropResult) => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const presentationOverlay = usePresentationOverlay('modal');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const [decoded, setDecoded] = useState<HTMLImageElement | null>(null);
  const [size, setSize] = useState<ImageSize | null>(null);
  const [crop, setCrop] = useState<AvatarCrop>(INITIAL_CROP);
  const [failed, setFailed] = useState(false);
  const [encoding, setEncoding] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    setDecoded(null);
    setSize(null);
    setCrop(INITIAL_CROP);
    setFailed(false);
    dragRef.current = null;
    setGrabbing(false);
  }, [imageUrl]);

  useEffect(() => {
    if (busy || encoding) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    presentationEvents.add(window, 'keydown', onKey);
    return () => presentationEvents.remove(window, 'keydown', onKey);
  }, [busy, encoding, onClose, presentationEvents]);

  const placement = size ? avatarDisplayPlacement(size, AVATAR_VIEWPORT_PX, crop) : null;
  const locked = busy || encoding;
  const imageStyle = placement
    ? {
        width: `${placement.width}px`,
        height: `${placement.height}px`,
        left: `${placement.left}px`,
        top: `${placement.top}px`,
        maxWidth: 'none',
      }
    : undefined;

  function rememberSize(image: HTMLImageElement): void {
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    setFailed(false);
    setDecoded((current) => (current === image ? current : image));
    setSize((current) =>
      current && current.width === image.naturalWidth && current.height === image.naturalHeight
        ? current
        : { width: image.naturalWidth, height: image.naturalHeight }
    );
  }

  useEffect(() => {
    const node = imageRef.current;
    if (node?.complete && node.naturalWidth > 0) rememberSize(node);
  }, [imageUrl]);

  const setImageRef: Ref<HTMLImageElement> = (node) => {
    imageRef.current = node;
  };

  function moveBy(dx: number, dy: number): void {
    if (!size) return;
    setCrop(
      (current) =>
        avatarDisplayPlacement(size, AVATAR_VIEWPORT_PX, {
          ...current,
          offsetX: current.offsetX + dx,
          offsetY: current.offsetY + dy,
        }).crop
    );
  }

  async function accept(): Promise<void> {
    if (!decoded || !size || locked) return;
    setEncoding(true);
    try {
      const rect = avatarSourceRect(size, AVATAR_VIEWPORT_PX, crop);
      const blob = await encodeWithinByteBudget((quality, outputSize) =>
        drawAvatarJpeg(decoded, rect, quality, outputSize)
      );
      const base64 = await blobToBase64(blob);
      const previewUrl = URL.createObjectURL(blob);
      await onAccept({ base64, contentType: 'image/jpeg', previewUrl });
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not crop that photo.');
    } finally {
      setEncoding(false);
    }
  }

  return (
    <PresentationScopeContext.Provider value={presentationOverlay.scope}>
      <div
        className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-crop-title"
        data-testid="avatar-crop-dialog"
        ref={presentationOverlay.bindRef(undefined, '0')}
      >
        <div className="relative w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-bg p-5 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="avatar-crop-title" className="text-base font-semibold text-fg">
                Adjust photo
              </h2>
              <p className="mt-1 text-xs leading-5 text-fg-muted">
                Drag to reposition. The saved photo is the circle crop, kept under 512 KB.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close"
              data-testid="avatar-crop-close"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-lg leading-none text-fg-muted wp-interactive disabled:opacity-50"
              disabled={locked}
              onClick={onClose}
            >
              ×
            </button>
          </div>

          <div
            data-testid="avatar-crop-stage"
            className={`relative mx-auto mt-4 overflow-hidden touch-none select-none bg-bg-muted ${grabbing ? 'cursor-grabbing' : 'cursor-grab'}`}
            style={{ width: AVATAR_VIEWPORT_PX, height: AVATAR_VIEWPORT_PX }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !size || locked) return;
              dragRef.current = { x: event.clientX, y: event.clientY };
              setGrabbing(true);
              try {
                event.currentTarget.setPointerCapture?.(event.pointerId);
              } catch {}
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag) return;
              const dx = event.clientX - drag.x;
              const dy = event.clientY - drag.y;
              dragRef.current = { x: event.clientX, y: event.clientY };
              moveBy(dx, dy);
            }}
            onPointerUp={() => {
              dragRef.current = null;
              setGrabbing(false);
            }}
            onPointerCancel={() => {
              dragRef.current = null;
              setGrabbing(false);
            }}
          >
            {failed ? (
              <p className="flex h-full items-center justify-center px-6 text-center text-sm text-fg-muted">
                Could not read that photo.
              </p>
            ) : (
              <>
                <img
                  alt=""
                  src={imageUrl}
                  draggable={false}
                  className="pointer-events-none absolute opacity-40"
                  style={imageStyle}
                />
                <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-full ring-2 ring-accent">
                  <img
                    alt=""
                    src={imageUrl}
                    draggable={false}
                    data-testid="avatar-crop-image"
                    className="absolute"
                    style={imageStyle}
                    ref={setImageRef}
                    onLoad={(event) => rememberSize(event.currentTarget)}
                    onError={() => setFailed(true)}
                  />
                </div>
              </>
            )}
          </div>

          <label className="mt-4 flex items-center gap-3 text-sm text-fg">
            <span className="w-12 shrink-0">Zoom</span>
            <input
              type="range"
              min={AVATAR_MIN_ZOOM}
              max={AVATAR_MAX_ZOOM}
              step={0.01}
              value={placement?.crop.zoom ?? crop.zoom}
              aria-label="Zoom"
              data-testid="avatar-crop-zoom"
              disabled={!size || locked}
              className="min-w-0 flex-1"
              onChange={(event) => {
                if (!size) return;
                const zoom = Number(event.target.value);
                setCrop(
                  (current) =>
                    avatarDisplayPlacement(size, AVATAR_VIEWPORT_PX, { ...current, zoom }).crop
                );
              }}
            />
          </label>

          <div className="mt-4 flex items-center justify-between gap-2">
            <Button
              type="button"
              data-testid="avatar-crop-change"
              disabled={locked}
              onClick={onChangePhoto}
            >
              Change photo
            </Button>
            <Button
              variant="primary"
              type="button"
              data-testid="avatar-crop-accept"
              disabled={!decoded || failed || locked}
              onClick={() => void accept()}
            >
              {locked ? 'Saving…' : 'Accept'}
            </Button>
          </div>
        </div>
      </div>
    </PresentationScopeContext.Provider>
  );
}
