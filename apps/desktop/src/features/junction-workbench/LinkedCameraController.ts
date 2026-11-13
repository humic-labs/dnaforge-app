import { DEFAULT_EDITOR_CONFIG } from '@waypoint/workspace-editor';
import type { CoordMapping } from './coord-mapping';
import { LinkedCoordinateRegistry, type LinkedCoordinateAxis } from './LinkedCoordinateRegistry';
import type { JunctionWorkbenchRow } from './model';

export const LINKED_CAMERA_DEFAULT_PX_PER_BASE = DEFAULT_EDITOR_CONFIG.charWidth;
export const LINKED_CAMERA_MIN_ZOOM_PERCENT = 10;
export const LINKED_CAMERA_MAX_ZOOM_PERCENT = 100;

export interface LinkedCameraSnapshot {
  cameraBioCol: number;
  zoomPercent: number;
  pxPerBase: number;
  viewportWidth: number;
  referenceRowId: string | null;
  registeredAxis: LinkedCoordinateAxis;
  referenceTotalWidth: number;
  maxSharedScrollLeft: number;
  sharedScrollLeft: number;
  scrollLeftByRowId: Readonly<Record<string, number>>;
  frameCount: number;
  revision: number;
  inputEventCount: number;
  lastFrameDurationMs: number;
  maxFrameDurationMs: number;
  lastFrameIntervalMs: number | null;
  maxFrameIntervalMs: number;
  lastRedrawCount: number;
}

interface LinkedCameraControllerInput {
  rows: JunctionWorkbenchRow[];
  mapping: CoordMapping;
  initialCameraBioCol?: number;
  initialZoomPercent?: number;
}

type Listener = () => void;

export class LinkedCameraController {
  private rows: JunctionWorkbenchRow[];
  private mapping: CoordMapping;
  private registry: LinkedCoordinateRegistry;
  private cameraBioCol: number;
  private zoomPercent: number;
  private viewportWidth = 0;
  private sharedScrollLeft = 0;
  private pendingDeltaPixels = 0;
  private pendingAbsoluteScrollLeft: number | null = null;
  private rafId: number | null = null;
  private listeners = new Set<Listener>();
  private frameCount = 0;
  private revision = 0;
  private inputEventCount = 0;
  private lastFrameDurationMs = 0;
  private maxFrameDurationMs = 0;
  private lastFrameAt: number | null = null;
  private lastFrameIntervalMs: number | null = null;
  private maxFrameIntervalMs = 0;
  private lastRedrawCount = 0;
  private snapshot: LinkedCameraSnapshot;

  constructor(input: LinkedCameraControllerInput) {
    this.rows = input.rows;
    this.mapping = input.mapping;
    this.registry = new LinkedCoordinateRegistry(input.rows, input.mapping);
    this.cameraBioCol = input.initialCameraBioCol ?? 0;
    this.zoomPercent = clampZoom(input.initialZoomPercent ?? 100);
    this.snapshot = this.computeSnapshot();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LinkedCameraSnapshot => this.snapshot;

  setInputs(rows: JunctionWorkbenchRow[], mapping: CoordMapping): void {
    this.rows = rows;
    this.mapping = mapping;
    this.registry = new LinkedCoordinateRegistry(rows, mapping);
    this.sharedScrollLeft = this.sharedScrollLeftForCamera();
    this.publish();
  }

  setViewportWidth(width: number): void {
    const next = Math.max(0, Math.round(width));
    if (next === this.viewportWidth) return;
    this.viewportWidth = next;
    this.sharedScrollLeft = this.sharedScrollLeftForCamera();
    this.publish();
  }

  panPixels(deltaPixels: number): void {
    if (!Number.isFinite(deltaPixels) || deltaPixels === 0) return;
    this.inputEventCount++;
    this.pendingDeltaPixels += deltaPixels;
    this.scheduleFrame();
  }

  scrollToSharedScrollLeft(scrollLeft: number): void {
    if (!Number.isFinite(scrollLeft)) return;
    this.inputEventCount++;
    this.pendingAbsoluteScrollLeft = scrollLeft;
    this.pendingDeltaPixels = 0;
    this.scheduleFrame();
  }

  zoomAt(deltaY: number, rowId: string, anchorScreenX: number): void {
    if (!Number.isFinite(deltaY)) return;
    const beforePxPerBase = this.pxPerBase;
    const currentRowScroll = this.snapshot.scrollLeftByRowId[rowId] ?? 0;
    const anchorBioCol = this.registry.hasRow(rowId)
      ? (this.registry.bioColForRowScreenX(
          rowId,
          currentRowScroll + anchorScreenX,
          beforePxPerBase
        ) ?? this.cameraBioCol)
      : this.cameraBioCol;

    const factor = deltaY > 0 ? 0.9 : 1.1;
    this.zoomPercent = clampZoom(this.zoomPercent * factor);
    const afterPxPerBase = this.pxPerBase;
    const anchorX = this.registry.screenXForBioCol(anchorBioCol, afterPxPerBase);
    this.cameraBioCol = anchorBioCol;
    this.pendingAbsoluteScrollLeft = anchorX - anchorScreenX;
    this.inputEventCount++;
    this.scheduleFrame();
  }

  dispose(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.listeners.clear();
  }

  private get pxPerBase(): number {
    return (LINKED_CAMERA_DEFAULT_PX_PER_BASE * this.zoomPercent) / 100;
  }

  private scheduleFrame(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      const started = performance.now();
      this.applyPendingInput();
      this.frameCount++;
      this.lastRedrawCount = Math.min(3, this.rows.length);
      const ended = performance.now();
      this.lastFrameDurationMs = ended - started;
      this.maxFrameDurationMs = Math.max(this.maxFrameDurationMs, this.lastFrameDurationMs);
      if (this.lastFrameAt !== null) {
        this.lastFrameIntervalMs = ended - this.lastFrameAt;
        this.maxFrameIntervalMs = Math.max(this.maxFrameIntervalMs, this.lastFrameIntervalMs);
      }
      this.lastFrameAt = ended;
      this.publish();
    });
  }

  private applyPendingInput(): void {
    const nextShared =
      this.pendingAbsoluteScrollLeft ?? this.sharedScrollLeft + this.pendingDeltaPixels;
    this.pendingAbsoluteScrollLeft = null;
    this.pendingDeltaPixels = 0;
    this.sharedScrollLeft = this.clampSharedScrollLeft(nextShared);
    this.cameraBioCol = this.bioColForSharedScrollLeft(this.sharedScrollLeft);
  }

  private publish(): void {
    this.revision++;
    this.snapshot = this.computeSnapshot();
    this.listeners.forEach((listener) => listener());
  }

  private computeSnapshot(): LinkedCameraSnapshot {
    const scrollLeftByRowId: Record<string, number> = {};
    for (const row of this.rows) {
      scrollLeftByRowId[row.id] = this.scrollLeftForRow(row.id);
    }

    return {
      cameraBioCol: this.cameraBioCol,
      zoomPercent: this.zoomPercent,
      pxPerBase: this.pxPerBase,
      viewportWidth: this.viewportWidth,
      referenceRowId: this.registry.referenceRowId,
      registeredAxis: this.registry.axis,
      referenceTotalWidth: this.registry.totalWidth(this.pxPerBase),
      maxSharedScrollLeft: this.registry.maxScrollLeft(this.pxPerBase, this.viewportWidth),
      sharedScrollLeft: this.sharedScrollLeft,
      scrollLeftByRowId,
      frameCount: this.frameCount,
      revision: this.revision,
      inputEventCount: this.inputEventCount,
      lastFrameDurationMs: this.lastFrameDurationMs,
      maxFrameDurationMs: this.maxFrameDurationMs,
      lastFrameIntervalMs: this.lastFrameIntervalMs,
      maxFrameIntervalMs: this.maxFrameIntervalMs,
      lastRedrawCount: this.lastRedrawCount,
    };
  }

  private sharedScrollLeftForCamera(): number {
    if (!this.registry.referenceRowId) return 0;
    return this.registry.scrollLeftForBioCol(this.cameraBioCol, this.pxPerBase, this.viewportWidth);
  }

  private bioColForSharedScrollLeft(scrollLeft: number): number {
    if (!this.registry.referenceRowId || this.viewportWidth <= 0) return this.cameraBioCol;
    return (
      this.registry.bioColForScrollLeft(scrollLeft, this.pxPerBase, this.viewportWidth) ??
      this.cameraBioCol
    );
  }

  private scrollLeftForRow(rowId: string): number {
    return this.registry.hasRow(rowId)
      ? this.registry.scrollLeftForRow(rowId, this.sharedScrollLeft, this.pxPerBase)
      : 0;
  }

  private clampSharedScrollLeft(scrollLeft: number): number {
    return this.registry.clampScrollLeft(scrollLeft, {
      pxPerBase: this.pxPerBase,
      viewportWidth: this.viewportWidth,
    });
  }

  screenXForBioCol(bioCol: number): number {
    return this.registry.screenXForBioCol(bioCol, this.pxPerBase);
  }

  screenXForBioColInRow(rowId: string, bioCol: number): number {
    return this.registry.screenXForBioColInRow(rowId, bioCol, this.pxPerBase);
  }
}

function clampZoom(value: number): number {
  return clamp(value, LINKED_CAMERA_MIN_ZOOM_PERCENT, LINKED_CAMERA_MAX_ZOOM_PERCENT);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
