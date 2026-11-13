// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest';
import { useDragStore } from './dragStore';

function resetStore() {
  useDragStore.setState({
    isDragging: false,
    dragTabId: null,
    dragFromPanelId: null,
  });
}

describe('useDragStore', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('initial state', () => {
    it('initializes with no drag in progress', () => {
      const state = useDragStore.getState();
      expect(state.isDragging).toBe(false);
      expect(state.dragTabId).toBeNull();
      expect(state.dragFromPanelId).toBeNull();
    });
  });

  describe('startDrag', () => {
    it('sets dragging state with tab and panel info', () => {
      const store = useDragStore.getState();
      store.startDrag('tab-123', 'panel-main', 'Tab Label', 'sequence');

      const state = useDragStore.getState();
      expect(state.isDragging).toBe(true);
      expect(state.dragTabId).toBe('tab-123');
      expect(state.dragFromPanelId).toBe('panel-main');
    });

    it('overwrites previous drag state', () => {
      const store = useDragStore.getState();
      store.startDrag('tab-1', 'panel-1', 'Tab 1', 'sequence');
      store.startDrag('tab-2', 'panel-2', 'Tab 2', 'sequence');

      const state = useDragStore.getState();
      expect(state.dragTabId).toBe('tab-2');
      expect(state.dragFromPanelId).toBe('panel-2');
    });
  });

  describe('endDrag', () => {
    it('clears all drag state', () => {
      const store = useDragStore.getState();
      store.startDrag('tab-123', 'panel-main', 'Tab Label', 'sequence');
      store.endDrag();

      const state = useDragStore.getState();
      expect(state.isDragging).toBe(false);
      expect(state.dragTabId).toBeNull();
      expect(state.dragFromPanelId).toBeNull();
    });

    it('is safe to call when not dragging', () => {
      const store = useDragStore.getState();
      store.endDrag();

      const state = useDragStore.getState();
      expect(state.isDragging).toBe(false);
    });
  });

  describe('drag lifecycle', () => {
    it('supports multiple drag cycles', () => {
      const store = useDragStore.getState();

      store.startDrag('tab-1', 'panel-a', 'Tab 1', 'sequence');
      expect(useDragStore.getState().isDragging).toBe(true);
      store.endDrag();
      expect(useDragStore.getState().isDragging).toBe(false);

      store.startDrag('tab-2', 'panel-b', 'Tab 2', 'sequence');
      expect(useDragStore.getState().isDragging).toBe(true);
      expect(useDragStore.getState().dragTabId).toBe('tab-2');
      store.endDrag();
      expect(useDragStore.getState().isDragging).toBe(false);
    });
  });
});
