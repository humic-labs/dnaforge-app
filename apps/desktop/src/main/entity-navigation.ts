import type { EntityNavigationTarget } from '../shared/entity-navigation';

export class EntityNavigationQueue {
  private ready = false;
  private pending: EntityNavigationTarget[] = [];

  enqueue(target: EntityNavigationTarget): EntityNavigationTarget[] {
    if (this.ready) return [target];
    this.pending.push(target);
    return [];
  }

  takePendingAndMarkReady(): EntityNavigationTarget[] {
    this.ready = true;
    return this.pending.splice(0);
  }

  markRendererLoading(): void {
    this.ready = false;
  }
}
