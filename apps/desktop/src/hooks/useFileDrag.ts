import type React from 'react';
import { useEffect, useRef, useCallback } from 'react';
import { baseNameOf, isValidMoveTarget, parentDirOf, pathIsWithinDir } from '../shared/move-target';

export interface FileDropDetail {
  path: string;
  name: string;
}

export interface FileDragHoverDetail {
  hovering: boolean;
}

export interface FileMoveDetail {
  sourcePath: string;
  destDir: string;
}

interface FileDragStartDetail {
  path: string;
  name: string;
  x: number;
  y: number;
}

export function startFileDrag(path: string, name: string, e: React.MouseEvent) {
  document.dispatchEvent(
    new CustomEvent<FileDragStartDetail>('waypoint-file-drag-start', {
      detail: { path, name, x: e.clientX, y: e.clientY },
    })
  );
}

const DRAG_THRESHOLD = 5;
const EDGE_AUTOSCROLL_PX = 36;
const EDGE_AUTOSCROLL_SPEED = 9;
const FILE_TREE_SCROLL_SELECTOR = '[data-testid="file-browser-scroll-container"]';
const DROP_TARGET_SELECTOR = '[data-file-drop-target="true"]';
const FILE_ITEM_SELECTOR = '[data-testid="file-tree-item"][data-entry-path]';
const WORKSPACE_ROOT_SELECTOR = '[data-workspace-root-path]';

export function useFileDrag() {
  const dragFileRef = useRef<{ path: string; name: string } | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const activeRef = useRef(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const lastHoverTargetRef = useRef<Element | null>(null);
  const dropDestRef = useRef<{ destDir: string; els: HTMLElement[] } | null>(null);
  const pointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const autoscrollRafRef = useRef<number | null>(null);
  const autoscrollDirRef = useRef<-1 | 0 | 1>(0);
  const preventSelectRef = useRef<((e: Event) => void) | null>(null);

  const clearDropTarget = useCallback(() => {
    if (dropDestRef.current) {
      for (const el of dropDestRef.current.els) el.removeAttribute('data-drop-active');
    }
    dropDestRef.current = null;
  }, []);

  const stopAutoscroll = useCallback(() => {
    if (autoscrollRafRef.current != null) {
      cancelAnimationFrame(autoscrollRafRef.current);
      autoscrollRafRef.current = null;
    }
    autoscrollDirRef.current = 0;
  }, []);

  const cleanup = useCallback(() => {
    activeRef.current = false;
    dragFileRef.current = null;
    startPosRef.current = null;

    if (previewRef.current) {
      previewRef.current.remove();
      previewRef.current = null;
    }

    if (preventSelectRef.current) {
      document.removeEventListener('selectstart', preventSelectRef.current);
      preventSelectRef.current = null;
    }

    document.body.classList.remove('dragging-file');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    if (lastHoverTargetRef.current) {
      lastHoverTargetRef.current.dispatchEvent(
        new CustomEvent<FileDragHoverDetail>('waypoint-file-drag-hover', {
          bubbles: false,
          detail: { hovering: false },
        })
      );
      lastHoverTargetRef.current = null;
    }

    clearDropTarget();
    stopAutoscroll();
  }, [clearDropTarget, stopAutoscroll]);

  const createPreview = useCallback((name: string) => {
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 9999;
      padding: 4px 10px;
      background: var(--color-bg-subtle, #1e1e2e);
      border: 1px solid var(--color-border, #333);
      border-radius: 6px;
      font-size: 12px;
      color: var(--color-fg, #cdd6f4);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      white-space: nowrap;
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
    `;
    el.textContent = name;
    el.setAttribute('data-testid', 'file-drag-preview');
    document.body.appendChild(el);
    return el;
  }, []);

  useEffect(() => {
    const findDropHighlightEls = (destDir: string): HTMLElement[] => {
      const els: HTMLElement[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-entry-path]'))) {
        const p = el.getAttribute('data-entry-path');
        if (p && pathIsWithinDir(p, destDir)) els.push(el);
      }
      return els;
    };

    const resolveDropDestination = (x: number, y: number): string | null => {
      const src = dragFileRef.current;
      if (!src) return null;
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      if (el.closest('[data-file-move-disabled]')) return null;

      let destDir: string | null = null;
      const directTarget = el.closest<HTMLElement>(DROP_TARGET_SELECTOR);
      if (directTarget) {
        destDir = directTarget.getAttribute('data-entry-path');
      } else {
        const fileItem = el.closest<HTMLElement>(FILE_ITEM_SELECTOR);
        if (fileItem) {
          const filePath = fileItem.getAttribute('data-entry-path');
          if (filePath) destDir = parentDirOf(filePath);
        } else {
          const rootContainer = el.closest<HTMLElement>(WORKSPACE_ROOT_SELECTOR);
          if (rootContainer) {
            destDir = rootContainer.getAttribute('data-workspace-root-path');
          } else {
            const scroll = el.closest<HTMLElement>(FILE_TREE_SCROLL_SELECTOR);
            if (scroll) {
              const roots = scroll.querySelectorAll<HTMLElement>(WORKSPACE_ROOT_SELECTOR);
              const last = roots[roots.length - 1];
              destDir = last?.getAttribute('data-workspace-root-path') ?? null;
            }
          }
        }
      }

      if (!destDir || !isValidMoveTarget(src.path, destDir)) return null;
      return destDir;
    };

    const updateDropTarget = (x: number, y: number) => {
      const destDir = resolveDropDestination(x, y);
      if (destDir !== (dropDestRef.current?.destDir ?? null)) {
        if (dropDestRef.current) {
          for (const el of dropDestRef.current.els) el.removeAttribute('data-drop-active');
        }
        if (destDir) {
          const els = findDropHighlightEls(destDir);
          for (const el of els) el.setAttribute('data-drop-active', 'true');
          dropDestRef.current = { destDir, els };
        } else {
          dropDestRef.current = null;
        }
      }

      if (previewRef.current && dragFileRef.current) {
        previewRef.current.textContent = destDir
          ? `${dragFileRef.current.name}  →  ${baseNameOf(destDir)}`
          : dragFileRef.current.name;
      }
    };

    const tickAutoscroll = () => {
      const container = document.querySelector<HTMLElement>(FILE_TREE_SCROLL_SELECTOR);
      if (!container || autoscrollDirRef.current === 0) {
        autoscrollRafRef.current = null;
        return;
      }
      const before = container.scrollTop;
      container.scrollTop = before + autoscrollDirRef.current * EDGE_AUTOSCROLL_SPEED;
      updateDropTarget(pointerRef.current.x, pointerRef.current.y);
      if (container.scrollTop === before) {
        autoscrollDirRef.current = 0;
        autoscrollRafRef.current = null;
        return;
      }
      autoscrollRafRef.current = requestAnimationFrame(tickAutoscroll);
    };

    const maybeAutoscroll = (y: number) => {
      const container = document.querySelector<HTMLElement>(FILE_TREE_SCROLL_SELECTOR);
      if (!container) {
        stopAutoscroll();
        return;
      }
      const rect = container.getBoundingClientRect();
      const canScrollUp = container.scrollTop > 0;
      const canScrollDown =
        container.scrollTop + container.clientHeight < container.scrollHeight - 1;
      let dir: -1 | 0 | 1 = 0;
      if (y < rect.top + EDGE_AUTOSCROLL_PX && canScrollUp) dir = -1;
      else if (y > rect.bottom - EDGE_AUTOSCROLL_PX && canScrollDown) dir = 1;
      autoscrollDirRef.current = dir;
      if (dir !== 0) {
        if (autoscrollRafRef.current == null) {
          autoscrollRafRef.current = requestAnimationFrame(tickAutoscroll);
        }
      } else {
        stopAutoscroll();
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragFileRef.current || !startPosRef.current) return;

      const dx = e.clientX - startPosRef.current.x;
      const dy = e.clientY - startPosRef.current.y;

      if (!activeRef.current) {
        if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
        activeRef.current = true;
        document.body.classList.add('dragging-file');
        document.body.style.cursor = 'grabbing';
        window.getSelection()?.removeAllRanges();
        previewRef.current = createPreview(dragFileRef.current.name);
      }

      pointerRef.current = { x: e.clientX, y: e.clientY };

      if (previewRef.current) {
        previewRef.current.style.left = `${e.clientX + 12}px`;
        previewRef.current.style.top = `${e.clientY + 12}px`;
      }

      const target = document.elementFromPoint(e.clientX, e.clientY);
      const dropZone =
        target?.closest('[data-chat-drop-zone]') ??
        target?.closest('[data-file-drop-zone]') ??
        null;

      if (dropZone !== lastHoverTargetRef.current) {
        if (lastHoverTargetRef.current) {
          lastHoverTargetRef.current.dispatchEvent(
            new CustomEvent<FileDragHoverDetail>('waypoint-file-drag-hover', {
              bubbles: false,
              detail: { hovering: false },
            })
          );
        }
        if (dropZone) {
          dropZone.dispatchEvent(
            new CustomEvent<FileDragHoverDetail>('waypoint-file-drag-hover', {
              bubbles: false,
              detail: { hovering: true },
            })
          );
        }
        lastHoverTargetRef.current = dropZone;
      }

      if (dropZone) {
        clearDropTarget();
        if (previewRef.current && dragFileRef.current) {
          previewRef.current.textContent = dragFileRef.current.name;
        }
        stopAutoscroll();
      } else {
        updateDropTarget(e.clientX, e.clientY);
        maybeAutoscroll(e.clientY);
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (!dragFileRef.current) return;
      if (activeRef.current) {
        const source = dragFileRef.current;
        const target = document.elementFromPoint(e.clientX, e.clientY);
        const dropZone =
          target?.closest('[data-chat-drop-zone]') ?? target?.closest('[data-file-drop-zone]');

        if (dropZone) {
          dropZone.dispatchEvent(
            new CustomEvent<FileDropDetail>('waypoint-file-drop', {
              bubbles: false,
              detail: { path: source.path, name: source.name },
            })
          );
        } else {
          const destDir = resolveDropDestination(e.clientX, e.clientY);
          if (destDir) {
            window.dispatchEvent(
              new CustomEvent<FileMoveDetail>('waypoint-file-move', {
                detail: { sourcePath: source.path, destDir },
              })
            );
          }
        }
      }

      cleanup();
    };

    const handleDragStart = (event: Event) => {
      const detail = (event as CustomEvent<FileDragStartDetail>).detail;
      if (!detail) return;
      dragFileRef.current = { path: detail.path, name: detail.name };
      startPosRef.current = { x: detail.x, y: detail.y };
      preventSelectRef.current = (e: Event) => e.preventDefault();
      document.addEventListener('selectstart', preventSelectRef.current);
    };

    document.addEventListener('waypoint-file-drag-start', handleDragStart);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('waypoint-file-drag-start', handleDragStart);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      stopAutoscroll();
    };
  }, [cleanup, clearDropTarget, createPreview, stopAutoscroll]);
}
