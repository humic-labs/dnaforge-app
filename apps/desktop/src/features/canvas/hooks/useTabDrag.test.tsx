import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Tab } from '../components/Tab';
import { CanvasTabStrip } from '../components/CanvasTabStrip';
import { useCanvasStore } from '../store';
import { useTabDrag } from './useTabDrag';

function EditorTabs() {
  useTabDrag();
  const panels = useCanvasStore((state) => state.panels);
  return Object.values(panels).map((panel) => (
    <CanvasTabStrip key={panel.id} panelId={panel.id}>
      {panel.tabs.map((tab, index) => (
        <Tab
          key={tab.id}
          tab={{ ...tab, isDirty: false, isIndexedSequence: false }}
          panelId={panel.id}
          index={index}
          isActive={panel.activeTabId === tab.id}
          onSelect={() => {}}
          onClose={() => {}}
        />
      ))}
    </CanvasTabStrip>
  ));
}

function openTabs(panel: string, labels: string[]) {
  for (const label of labels) {
    useCanvasStore.getState().openTab(panel, { type: 'text', entityId: label, label });
  }
}

function labels(panel: string) {
  return useCanvasStore.getState().panels[panel].tabs.map((tab) => tab.label);
}

beforeEach(() => {
  useCanvasStore.getState().reset();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const bar = this.closest<HTMLElement>('[data-tab-bar]');
    const top = bar?.dataset.tabBar === 'main' ? 0 : 100;
    const index = this.dataset.tabIndex;
    const left = index === undefined ? 0 : Number(index) * 100;
    return new DOMRect(left, top, index === undefined ? 500 : 100, 36);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function dragFirstTo(x: number, y: number) {
  fireEvent.mouseDown(screen.getByRole('tab', { name: /^A/ }), { clientX: 40, clientY: 18 });
  fireEvent.mouseMove(document, { clientX: 60, clientY: 18 });
  fireEvent.mouseMove(document, { clientX: 400, clientY: 18 });
  fireEvent.mouseMove(document, { clientX: x, clientY: y });
  fireEvent.mouseUp(document, { clientX: x, clientY: y });
}

it.each([
  ['original slot', 40, ['A', 'B', 'C']],
  ['between the second and third tabs', 210, ['B', 'A', 'C']],
] as const)('drops at the %s after moving to the end', (_, x, expected) => {
  openTabs('main', ['A', 'B', 'C']);
  render(<EditorTabs />);
  dragFirstTo(x, 18);
  expect(labels('main')).toEqual(expected);
});

it('inserts between the destination tabs when crossing panels', () => {
  openTabs('main', ['A', 'B']);
  const right = useCanvasStore.getState().splitPanel('main', 'vertical');
  openTabs(right, ['C', 'D']);
  render(<EditorTabs />);
  dragFirstTo(110, 118);
  expect(labels('main')).toEqual(['B']);
  expect(labels(right)).toEqual(['C', 'A', 'D']);
});
