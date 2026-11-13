import { describe, expect, it } from 'vitest';
import { EntityNavigationQueue } from './entity-navigation';

describe('entity navigation startup delivery', () => {
  it('retains a cold-launch selection until the renderer subscribes', () => {
    const queue = new EntityNavigationQueue();
    const target = {
      entityId: 'stable-entity',
      projectId: 'owning-project',
      referenceId: 'exact-selection',
    };
    expect(queue.enqueue(target)).toEqual([]);
    expect(queue.takePendingAndMarkReady()).toEqual([target]);
    expect(queue.takePendingAndMarkReady()).toEqual([]);
    expect(queue.enqueue(target)).toEqual([target]);
  });

  it('buffers native links during a renderer reload', () => {
    const queue = new EntityNavigationQueue();
    queue.takePendingAndMarkReady();
    queue.markRendererLoading();
    const target = { entityId: 'entity-after-reload' };
    expect(queue.enqueue(target)).toEqual([]);
    expect(queue.takePendingAndMarkReady()).toEqual([target]);
  });
});
