import { isRetainedOverlayTrack } from './overlay-track';
import type {
  OverlayTrack,
  OverlayHitResult,
  RetainedOverlayDebugSnapshot,
  RetainedOverlayRenderMode,
} from './overlay-track';
import type { PathMapper } from '../shared/path-mapper';
import type { RenderState } from '../../../types';

export class OverlayRegistry {
  private overlays: OverlayTrack[] = [];
  private layoutRevision = 0;
  private frameRequester: (() => void) | null = null;

  register(overlay: OverlayTrack): void {
    if (!this.overlays.find((o) => o.id === overlay.id)) {
      this.overlays.push(overlay);
      if (this.frameRequester) overlay.setFrameRequester?.(this.frameRequester);
      this.layoutRevision += 1;
    }
  }

  setFrameRequester(requester: (() => void) | null): void {
    this.frameRequester = requester;
    for (const overlay of this.overlays) overlay.setFrameRequester?.(requester);
  }

  unregister(id: string): void {
    const idx = this.overlays.findIndex((o) => o.id === id);
    if (idx !== -1) {
      this.overlays[idx].destroy();
      this.overlays.splice(idx, 1);
      this.layoutRevision += 1;
    }
  }

  getAll(): readonly OverlayTrack[] {
    return this.overlays;
  }

  get(id: string): OverlayTrack | undefined {
    return this.overlays.find((o) => o.id === id);
  }

  toggle(id: string): void {
    const overlay = this.get(id);
    if (overlay) {
      overlay.enabled = !overlay.enabled;
      this.layoutRevision += 1;
    }
  }

  reorder(id: string, newSortOrder: number): void {
    const overlay = this.get(id);
    if (overlay && overlay.sortOrder !== newSortOrder) {
      overlay.sortOrder = newSortOrder;
      this.layoutRevision += 1;
    }
  }

  moveAbove(idToMove: string, idTarget: string): void {
    const toMove = this.get(idToMove);
    const target = this.get(idTarget);
    if (!toMove || !target || toMove.position !== target.position) return;
    toMove.sortOrder = target.sortOrder - 1;
    this.layoutRevision += 1;
  }

  moveBelow(idToMove: string, idTarget: string): void {
    const toMove = this.get(idToMove);
    const target = this.get(idTarget);
    if (!toMove || !target || toMove.position !== target.position) return;
    toMove.sortOrder = target.sortOrder + 1;
    this.layoutRevision += 1;
  }

  invalidateLayout(): void {
    this.layoutRevision += 1;
  }

  loadGenome(genome: import('../../../types').Genome): void {
    for (const o of this.overlays) o.loadGenome(genome);
    this.layoutRevision += 1;
  }

  getLayoutRevision(): number {
    return this.layoutRevision;
  }

  layoutCacheKeysMatch(
    priorKeys: readonly (string | number | boolean | null)[],
    genome: import('../../../types').Genome,
    state: RenderState,
    pixelsPerBp: number
  ): boolean {
    if (priorKeys.length !== this.overlays.length) return false;
    for (let index = 0; index < this.overlays.length; index++) {
      const overlay = this.overlays[index];
      if (!overlay.enabled) continue;
      if (!overlay.layoutCacheKey) return false;
      if (!Object.is(priorKeys[index], overlay.layoutCacheKey(genome, state, pixelsPerBp))) {
        return false;
      }
    }
    return true;
  }

  captureLayoutCacheKeys(
    genome: import('../../../types').Genome,
    state: RenderState,
    pixelsPerBp: number
  ): readonly (string | number | boolean | null)[] | null {
    const keys: (string | number | boolean | null)[] = [];
    for (const overlay of this.overlays) {
      if (!overlay.enabled) {
        keys.push(null);
        continue;
      }
      if (!overlay.layoutCacheKey) return null;
      keys.push(overlay.layoutCacheKey(genome, state, pixelsPerBp));
    }
    return keys;
  }

  getRetainedDebugSnapshots(): RetainedOverlayDebugSnapshot[] {
    return this.overlays.flatMap((overlay) => {
      if (!isRetainedOverlayTrack(overlay)) return [];
      const snapshot = overlay.getRetainedDebugSnapshot?.();
      return snapshot ? [snapshot] : [];
    });
  }

  renderOverlay(
    overlay: OverlayTrack,
    path: PathMapper,
    state: RenderState,
    yOffset: number,
    height: number
  ): RetainedOverlayRenderMode {
    if (!overlay.enabled) return 'inactive';

    if (isRetainedOverlayTrack(overlay)) {
      const handled = overlay.updateRetainedCamera?.({ path, state, yOffset, height }) ?? false;
      if (handled) {
        overlay.updateRetainedInteraction?.(state);
        return 'retained';
      }
    }

    overlay.render(path, state, yOffset, height);
    return 'fallback';
  }

  hitTestAll(
    screenX: number,
    screenY: number,
    path: PathMapper,
    state: RenderState
  ): OverlayHitResult | null {
    const ordered = this.overlays
      .map((overlay, index) => ({ overlay, index }))
      .sort(
        (a, b) =>
          (b.overlay.hitTestOrder ?? b.overlay.sortOrder) -
            (a.overlay.hitTestOrder ?? a.overlay.sortOrder) || b.index - a.index
      );
    for (const { overlay: o } of ordered) {
      if (!o.enabled) continue;
      const result = o.hitTest(screenX, screenY, path, state);
      if (result) return result;
    }
    return null;
  }

  destroyAll(): void {
    for (const o of this.overlays) o.destroy();
    this.overlays = [];
    this.layoutRevision += 1;
  }
}
