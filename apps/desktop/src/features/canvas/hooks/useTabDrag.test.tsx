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
  ['between the second and third tabs', 140, ['B', 'A', 'C']],
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

it('slides the grabbed tab from the first movement and restores the row on leaving or returning', () => {
  openTabs('main', ['A', 'B', 'C']);
  render(<EditorTabs />);
  const [a, b, c] = screen.getAllByRole('tab');
  const shift = (tab: HTMLElement) => tab.style.getPropertyValue('--tab-slide-x');
  fireEvent.mouseDown(a, { clientX: 20, clientY: 18 });
  fireEvent.mouseMove(document, { clientX: 170, clientY: 22 });
  expect(shift(a)).toBe('150px');
  expect(shift(b)).toBe('-100px');
  expect(shift(c)).toBe('');
  expect(labels('main')).toEqual(['A', 'B', 'C']);
  expect(document.querySelector('[data-floating-tab-preview]')).toBeNull();

  fireEvent.mouseMove(document, { clientX: 170, clientY: 90 });
  expect(shift(a)).toBe('');
  expect(shift(b)).toBe('');
  expect(document.querySelector('[data-floating-tab-preview]')).toBeTruthy();

  fireEvent.mouseMove(document, { clientX: 280, clientY: 18 });
  expect(shift(a)).toBe('200px');
  expect(shift(b)).toBe('-100px');
  expect(shift(c)).toBe('-100px');
  expect(document.querySelector('[data-floating-tab-preview]')).toBeNull();
  fireEvent.mouseUp(document, { clientX: 20, clientY: 18 });
  expect(labels('main')).toEqual(['A', 'B', 'C']);
  expect(shift(a)).toBe('');
});

it('keeps a wide tab under its grab point in a scrolled row without chasing animated neighbors', () => {
  openTabs('main', ['A', 'B', 'C']);
  render(<EditorTabs />);
  const [a, b, c] = screen.getAllByRole('tab');
  const strip = b.parentElement!;
  strip.scrollLeft = 40;
  const slots = new Map<HTMLElement, [number, number]>([
    [a, [0, 75]],
    [b, [75, 140]],
    [c, [215, 80]],
  ]);
  for (const [tab, [left, width]] of slots) {
    vi.spyOn(tab, 'getBoundingClientRect').mockImplementation(() => {
      const slide = parseFloat(tab.style.getPropertyValue('--tab-slide-x')) || 0;
      return new DOMRect(left - strip.scrollLeft + slide, 0, width, 36);
    });
  }

  fireEvent.mouseDown(b, { clientX: 65, clientY: 18 });
  fireEvent.mouseMove(document, { clientX: 89, clientY: 18 });
  expect(b.getBoundingClientRect().left).toBe(59);
  strip.scrollLeft = 55;
  fireEvent.mouseMove(document, { clientX: 94, clientY: 18 });
  expect(b.getBoundingClientRect().left).toBe(64);
  fireEvent.mouseMove(document, { clientX: 91, clientY: 18 });
  expect(c.style.getPropertyValue('--tab-slide-x')).toBe('-140px');
  fireEvent.mouseMove(document, { clientX: 90, clientY: 18 });
  expect(c.style.getPropertyValue('--tab-slide-x')).toBe('');
  fireEvent.mouseUp(document, { clientX: 91, clientY: 18 });
  expect(labels('main')).toEqual(['A', 'C', 'B']);
});

it.each([
  { direction: 1, grip: 12, destination: ['A', 'C', 'B'] },
  { direction: -1, grip: 88, destination: ['B', 'A', 'C'] },
])(
  'reorders at the moving edge with a $grip px grab offset',
  ({ direction, grip, destination }) => {
    openTabs('main', ['A', 'B', 'C']);
    render(<EditorTabs />);
    const tabs = screen.getAllByRole('tab');
    const startX = 100 + grip;
    const point = (distance: number) => ({ clientX: startX + direction * distance, clientY: 18 });
    const neighbor = tabs[1 + direction];
    fireEvent.mouseDown(tabs[1], point(0));
    for (const distance of [49, 50, 51, 50, 49, 51]) {
      fireEvent.mouseMove(document, point(distance));
      const shift = neighbor.style.getPropertyValue('--tab-slide-x');
      expect(shift).toBe(distance > 50 ? `${-100 * direction}px` : '');
    }
    fireEvent.mouseUp(document, point(51));
    expect(labels('main')).toEqual(destination);
  }
);
