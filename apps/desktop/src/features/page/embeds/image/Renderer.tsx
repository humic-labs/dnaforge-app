'use client';

import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { EmbedRendererProps } from '../types';
import { EmbedWrapper } from '../components/EmbedWrapper';
import type { ImageAttrs, ImageSource } from './types';
import { IMAGE_CONSTANTS, isAllowedImageType, isFileSizeAllowed } from './types';
import { readNotebookImage } from './file-source';
import {
  capturedMigrationAttachmentRelativePath,
  nativeNotebookAssetRelativePath,
  readNativeNotebookAsset,
  readVerifiedCapturedMigrationAttachment,
  resolveCapturedMigrationAttachmentPath,
} from './migration-attachment';
import { platform } from '../../../../platform';
import { useCanvasStore } from '../../../canvas/public/store';
import { useWorkspaceStore } from '../../../../stores/workspaceStore';
import { findNotebookFileByPageId } from '../../../../db/find-notebook-file-by-page-id';
import { useOptionalReferenceContext } from '../../entity-ref/reference-context';

const { MIN_WIDTH, MAX_WIDTH } = IMAGE_CONSTANTS;

export function ImageRenderer({
  attrs,
  selected,
  onRemove,
  onExpand,
  onUpdateAttrs,
}: EmbedRendererProps) {
  const data = attrs as ImageAttrs;
  const label = data.alt || data.fileName || 'Image';
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoadingUrl, setIsLoadingUrl] = useState(false);
  const [error, setError] = useState<string | null>(data.error || null);
  const [isResizing, setIsResizing] = useState(false);

  const [hovered, setHovered] = useState(false);
  const [inputMode, setInputMode] = useState<ImageSource>('upload');
  const [urlInput, setUrlInput] = useState('');
  const [resolvedCapturedSource, setResolvedCapturedSource] = useState<string | null>(null);
  const [capturedAttachmentPath, setCapturedAttachmentPath] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const startWidthRef = useRef<number>(0);
  const startXRef = useRef<number>(0);
  const openInFocusedPanel = useCanvasStore((state) => state.openInFocusedPanel);
  const workspaceFolders = useWorkspaceStore((state) => state.folders);
  const referenceContext = useOptionalReferenceContext();
  const capturedRelativePath = useMemo(
    () => capturedMigrationAttachmentRelativePath(data.src),
    [data.src]
  );
  const nativeAssetRelativePath = useMemo(
    () => nativeNotebookAssetRelativePath(data.src),
    [data.src]
  );
  const localAssetRelativePath = capturedRelativePath ?? nativeAssetRelativePath;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setResolvedCapturedSource(null);
    setCapturedAttachmentPath(null);
    if (!localAssetRelativePath) return;
    void (async () => {
      let absolutePath: string | null = null;
      const bytes = capturedRelativePath
        ? await (async () => {
            absolutePath = await resolveCapturedMigrationAttachmentPath({
              relativePath: capturedRelativePath,
              migrationRunId: data.migrationRunId,
              folders: workspaceFolders,
              readMarker: (markerPath, maxBytes) =>
                platform().fs.readTextFileSlice(markerPath, maxBytes),
            });
            return readVerifiedCapturedMigrationAttachment({
              path: absolutePath,
              expectedSha256: capturedRelativePath.split('/').pop() ?? '',
              maxBytes: IMAGE_CONSTANTS.MAX_FILE_SIZE,
              readFileBounded: (path, maxBytes) => platform().fs.readFileBounded(path, maxBytes),
            });
          })()
        : await (async () => {
            const currentNotebookMatches = referenceContext?.pageId
              ? await findNotebookFileByPageId(referenceContext.pageId, referenceContext.owningRoot)
              : [];
            if (currentNotebookMatches.length > 1) {
              throw new Error('Notebook asset project is ambiguous');
            }
            const asset = await readNativeNotebookAsset({
              relativePath: nativeAssetRelativePath,
              notebookPackagePath: data.notebookPackagePath ?? currentNotebookMatches[0]?.path,
              currentNotebookPackage: currentNotebookMatches[0]
                ? {
                    relativePath: currentNotebookMatches[0].path,
                    owningRoot: referenceContext?.owningRoot,
                  }
                : undefined,
              folders: workspaceFolders,
              maxBytes: IMAGE_CONSTANTS.MAX_FILE_SIZE,
              exists: (path) => platform().fs.exists(path),
              readFileBounded: (path, maxBytes) => platform().fs.readFileBounded(path, maxBytes),
            });
            absolutePath = asset.path;
            return asset.bytes;
          })();
      if (cancelled) return;
      objectUrl = URL.createObjectURL(
        new Blob([bytes], { type: data.mediaType ?? 'application/octet-stream' })
      );
      setError(null);
      setResolvedCapturedSource(objectUrl);
      setCapturedAttachmentPath(absolutePath);
    })().catch((loadError: unknown) => {
      if (!cancelled) {
        setError(toUserMessage(loadError, 'failure.captured-attachment-is-unavailable'));
      }
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    capturedRelativePath,
    data.mediaType,
    data.migrationRunId,
    data.notebookPackagePath,
    localAssetRelativePath,
    nativeAssetRelativePath,
    referenceContext?.owningRoot,
    referenceContext?.pageId,
    workspaceFolders,
  ]);

  const handleFile = useCallback(
    (file: File) => {
      setError(null);

      if (!isAllowedImageType(file.type)) {
        setError(userMessage('failure.file-must-be-an-image-png-jpg-gif-webp'));
        return;
      }

      if (!isFileSizeAllowed(file.size)) {
        setError(userMessage('failure.image-too-large-max-50mb'));
        return;
      }

      setIsUploading(true);
      void readNotebookImage(file)
        .then((source) => onUpdateAttrs?.({ ...data, ...source }))
        .catch(() => setError(userMessage('failure.failed-to-read-file-please-try-again')))
        .finally(() => setIsUploading(false));
    },
    [data, onUpdateAttrs]
  );

  const handleUrlSubmit = useCallback(() => {
    const url = urlInput.trim();
    if (!url) return;

    try {
      new URL(url);
    } catch {
      setError(userMessage('failure.please-enter-a-valid-url'));
      return;
    }

    setError(null);
    setIsLoadingUrl(true);

    const img = new Image();
    img.onload = () => {
      setIsLoadingUrl(false);
      onUpdateAttrs?.({
        ...data,
        src: url,
        source: 'url',
      });
    };
    img.onerror = () => {
      setIsLoadingUrl(false);
      setError(userMessage('failure.could-not-load-image-from-url'));
    };
    img.src = url;
  }, [urlInput, data, onUpdateAttrs]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, direction: 'left' | 'right') => {
      e.preventDefault();
      e.stopPropagation();

      const currentWidth = data.width || 100;
      startWidthRef.current = currentWidth;
      startXRef.current = e.clientX;
      setIsResizing(true);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!containerRef.current) return;

        const containerWidth = containerRef.current.parentElement?.offsetWidth || 1;
        const deltaX = moveEvent.clientX - startXRef.current;
        const deltaPercent = (deltaX / containerWidth) * 100;

        let newWidth: number;
        if (direction === 'right') {
          newWidth = startWidthRef.current + deltaPercent;
        } else {
          newWidth = startWidthRef.current - deltaPercent;
        }

        newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth));

        onUpdateAttrs?.({
          ...data,
          width: Math.round(newWidth),
        });
      };

      const handleMouseUp = () => {
        setIsResizing(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [data, onUpdateAttrs]
  );

  const handleAltChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onUpdateAttrs?.({
      ...data,
      alt: e.target.value,
    });
  };

  const handleCaptionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onUpdateAttrs?.({
      ...data,
      caption: e.target.value,
    });
  };

  if (!data.src) {
    return (
      <EmbedWrapper type="image" label="Add Image" selected={selected} onRemove={onRemove}>
        <div className="p-2">
          {}
          <div className="flex gap-1 mb-2">
            <button
              onClick={() => {
                setInputMode('upload');
                setError(null);
              }}
              className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                inputMode === 'upload'
                  ? 'bg-accent text-white'
                  : 'bg-bg-muted text-fg-muted hover:bg-bg-subtle'
              }`}
            >
              Upload
            </button>
            <button
              onClick={() => {
                setInputMode('url');
                setError(null);
              }}
              className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                inputMode === 'url'
                  ? 'bg-accent text-white'
                  : 'bg-bg-muted text-fg-muted hover:bg-bg-subtle'
              }`}
            >
              URL
            </button>
          </div>

          {}
          {error && (
            <div className="mb-2 p-2 bg-error/10 border border-error/20 rounded text-sm text-error">
              {toUserMessage(error, 'operation.failed')}
            </div>
          )}

          {}
          {inputMode === 'url' && (
            <div className="flex gap-2">
              <input
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
                placeholder="https://example.com/image.png"
                className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded focus:outline-none focus:ring-1 focus:ring-accent"
                disabled={isLoadingUrl}
              />
              <button
                onClick={handleUrlSubmit}
                disabled={isLoadingUrl || !urlInput.trim()}
                className="px-3 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isLoadingUrl ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  'Load'
                )}
              </button>
            </div>
          )}

          {}
          {inputMode === 'upload' && (
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => !isUploading && fileInputRef.current?.click()}
              className={`h-24 border-2 border-dashed rounded-md flex flex-col items-center justify-center transition-colors ${
                isUploading
                  ? 'border-accent bg-accent/5 cursor-wait'
                  : isDragging
                    ? 'border-accent bg-accent/5 cursor-copy'
                    : 'border-border hover:border-fg-muted cursor-pointer'
              }`}
            >
              {isUploading ? (
                <>
                  <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin mb-1" />
                  <span className="text-xs text-fg-muted">Uploading...</span>
                </>
              ) : (
                <>
                  <span className="text-xl mb-0.5">+</span>
                  <span className="text-xs text-fg-muted">Drop image or click to browse</span>
                </>
              )}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = '';
            }}
            className="hidden"
          />
        </div>
      </EmbedWrapper>
    );
  }

  const imageWidth = data.width || 100;
  const displayedSource = localAssetRelativePath ? resolvedCapturedSource : data.src;

  return (
    <EmbedWrapper
      type="image"
      label={label}
      selected={selected}
      onRemove={onRemove}
      onExpand={onExpand}
    >
      <div
        className="group/image p-2"
        ref={containerRef}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="relative mx-auto" style={{ width: `${imageWidth}%` }}>
          {}
          {(selected || hovered) && (
            <>
              <div
                data-testid="image-resize-handle-left"
                aria-label="Resize image from the left"
                onMouseDown={(e) => handleResizeStart(e, 'left')}
                className="absolute left-0 top-0 bottom-0 w-4 cursor-ew-resize group/handle z-10 flex items-center justify-start"
              >
                <div className="w-1.5 h-10 bg-accent rounded-full opacity-70 group-hover/handle:opacity-100 shadow-sm transition-opacity" />
              </div>
              <div
                data-testid="image-resize-handle-right"
                aria-label="Resize image from the right"
                onMouseDown={(e) => handleResizeStart(e, 'right')}
                className="absolute right-0 top-0 bottom-0 w-4 cursor-ew-resize group/handle z-10 flex items-center justify-end"
              >
                <div className="w-1.5 h-10 bg-accent rounded-full opacity-70 group-hover/handle:opacity-100 shadow-sm transition-opacity" />
              </div>
            </>
          )}

          {displayedSource ? (
            <img
              src={displayedSource}
              alt={data.alt || 'Embedded image'}
              className={`max-w-full h-auto rounded ${isResizing ? 'pointer-events-none select-none' : ''}`}
              draggable={false}
            />
          ) : (
            <div className="min-h-24 flex items-center justify-center text-sm text-fg-muted">
              {error != null
                ? toUserMessage(error, 'failure.checking-captured-attachment')
                : userMessage('failure.checking-captured-attachment')}
            </div>
          )}
        </div>

        {capturedAttachmentPath && (
          <div className="mt-2 flex justify-center">
            <button
              type="button"
              data-testid="open-captured-migration-attachment"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openInFocusedPanel('image', capturedAttachmentPath, data.fileName || label, {
                  ...(data.fileName ? { sourceFileName: data.fileName } : {}),
                  readOnly: true,
                });
              }}
              className="px-2 py-1 text-xs text-accent hover:bg-accent/10 rounded transition-colors"
            >
              Open attachment
            </button>
          </div>
        )}

        {}
        {(data.caption || selected) && (
          <div className="mt-2 text-center">
            {selected ? (
              <input
                type="text"
                value={data.caption || ''}
                onChange={handleCaptionChange}
                placeholder="Add a caption..."
                className="w-full text-center text-sm text-fg-muted bg-transparent border-0 border-b border-dashed border-border focus:border-accent focus:outline-none px-2 py-1"
              />
            ) : data.caption ? (
              <p className="text-sm text-fg-muted italic">{data.caption}</p>
            ) : null}
          </div>
        )}

        {}
        {selected && (
          <div className="mt-3 pt-3 border-t border-border">
            <label className="block text-xs text-fg-muted mb-1">Alt text (accessibility)</label>
            <input
              type="text"
              value={data.alt || ''}
              onChange={handleAltChange}
              placeholder="Describe this image..."
              className="w-full text-sm bg-bg-muted border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        )}

        {}
        {isResizing && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-bg/90 px-2 py-1 rounded text-sm font-medium">
            {imageWidth}%
          </div>
        )}
      </div>
    </EmbedWrapper>
  );
}
