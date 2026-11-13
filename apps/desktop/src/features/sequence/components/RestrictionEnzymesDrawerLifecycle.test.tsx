import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useDrawerState, type DrawerType } from '../hooks/useDrawerState';
import { SequenceDrawer } from './SequenceDrawer';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: () => {
      store = {};
    },
    _peek: (key: string) => store[key] ?? null,
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

const FILE_PATH = '/path/to/plasmid.gb';

function Harness({ filePath = FILE_PATH }: { filePath?: string }) {
  const {
    activeDrawer,
    isDrawerOpen,
    drawerWidth,
    toggleDrawer,
    openDrawer,
    closeDrawer,
    getDrawerWidth,
    setDrawerWidth,
  } = useDrawerState(filePath);

  const drawerHostedByWorkspace = activeDrawer === 'restriction-enzymes';
  const shouldRenderDrawerSlot = isDrawerOpen && !drawerHostedByWorkspace;

  const handleRestrictionEnzymeDrawerOpenChange = (open: boolean) => {
    if (open) {
      openDrawer('restriction-enzymes');
      return;
    }
    if (activeDrawer === 'restriction-enzymes') {
      closeDrawer();
    }
  };

  return (
    <div>
      {}
      <button data-testid="toggle-annotations" onClick={() => toggleDrawer('annotations')}>
        annotations
      </button>
      <button data-testid="toggle-alignments" onClick={() => toggleDrawer('alignments')}>
        alignments
      </button>
      <button data-testid="toggle-git-history" onClick={() => toggleDrawer('git-history')}>
        git-history
      </button>
      <button
        data-testid="toggle-restriction-enzymes"
        onClick={() => toggleDrawer('restriction-enzymes')}
      >
        restriction-enzymes
      </button>

      <div data-testid="active-drawer-label">{activeDrawer ?? 'none'}</div>

      {}
      {shouldRenderDrawerSlot ? (
        <SequenceDrawer width={drawerWidth} onWidthChange={setDrawerWidth}>
          <div data-testid={`generic-drawer-${activeDrawer}`}>{activeDrawer} drawer content</div>
        </SequenceDrawer>
      ) : null}

      {}
      {activeDrawer === 'restriction-enzymes' ? (
        <SequenceDrawer
          width={getDrawerWidth('restriction-enzymes')}
          onWidthChange={setDrawerWidth}
        >
          <div data-testid="restriction-enzymes-drawer">
            <button
              data-testid="restriction-enzymes-drawer-close"
              onClick={() => handleRestrictionEnzymeDrawerOpenChange(false)}
            >
              Close
            </button>
            <div>Restriction Enzymes</div>
          </div>
        </SequenceDrawer>
      ) : null}
    </div>
  );
}

const OTHER_DRAWERS: Array<{
  type: Exclude<DrawerType, 'restriction-enzymes' | 'primers' | 'structure'>;
  testid: string;
}> = [
  { type: 'annotations', testid: 'toggle-annotations' },
  { type: 'alignments', testid: 'toggle-alignments' },
  { type: 'git-history', testid: 'toggle-git-history' },
];

describe('restriction-enzymes drawer lifecycle  follow-up to ', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('opens the restriction-enzymes drawer when the button is clicked', () => {
    render(<Harness />);

    expect(screen.queryByTestId('restriction-enzymes-drawer')).toBeNull();
    expect(screen.getByTestId('active-drawer-label').textContent).toBe('none');

    fireEvent.click(screen.getByTestId('toggle-restriction-enzymes'));

    expect(screen.getByTestId('restriction-enzymes-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('active-drawer-label').textContent).toBe('restriction-enzymes');
  });

  it('does not render the restriction-enzymes drawer in the generic drawer slot (workspace-hosted)', () => {
    render(<Harness />);

    fireEvent.click(screen.getByTestId('toggle-restriction-enzymes'));

    expect(screen.queryByTestId('generic-drawer-restriction-enzymes')).toBeNull();
    expect(screen.getByTestId('restriction-enzymes-drawer')).toBeInTheDocument();
  });

  it('persists drawer width in localStorage across close + reopen', () => {
    const { unmount } = render(<Harness />);

    fireEvent.click(screen.getByTestId('toggle-restriction-enzymes'));
    expect(screen.getByTestId('restriction-enzymes-drawer')).toBeInTheDocument();

    const dragHandle = screen.getByTestId('drawer-drag-handle');
    act(() => {
      fireEvent.mouseDown(dragHandle, { clientX: 1000 });
      fireEvent(document, new MouseEvent('mousemove', { clientX: 930, bubbles: true }));
      fireEvent(document, new MouseEvent('mouseup', { bubbles: true }));
    });

    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      `drawer-width:restriction-enzymes:${FILE_PATH}`,
      '420'
    );
    expect(localStorageMock._peek(`drawer-width:restriction-enzymes:${FILE_PATH}`)).toBe('420');

    fireEvent.click(screen.getByTestId('restriction-enzymes-drawer-close'));
    expect(screen.queryByTestId('restriction-enzymes-drawer')).toBeNull();

    unmount();
    render(<Harness />);
    fireEvent.click(screen.getByTestId('toggle-restriction-enzymes'));

    const reopened = screen.getByTestId('restriction-enzymes-drawer');
    let widthHost: HTMLElement | null = reopened.parentElement;
    while (widthHost && !widthHost.style.width) widthHost = widthHost.parentElement;
    expect(widthHost).not.toBeNull();
    expect(widthHost!.style.width).toBe('420px');
  });

  it.each(OTHER_DRAWERS)(
    'opening restriction-enzymes closes the currently-open $type drawer',
    ({ type, testid }) => {
      render(<Harness />);

      fireEvent.click(screen.getByTestId(testid));
      expect(screen.getByTestId(`generic-drawer-${type}`)).toBeInTheDocument();
      expect(screen.getByTestId('active-drawer-label').textContent).toBe(type);

      fireEvent.click(screen.getByTestId('toggle-restriction-enzymes'));

      expect(screen.queryByTestId(`generic-drawer-${type}`)).toBeNull();
      expect(screen.getByTestId('restriction-enzymes-drawer')).toBeInTheDocument();
      expect(screen.getByTestId('active-drawer-label').textContent).toBe('restriction-enzymes');
    }
  );

  it.each(OTHER_DRAWERS)(
    'opening the $type drawer closes an open restriction-enzymes drawer',
    ({ type, testid }) => {
      render(<Harness />);

      fireEvent.click(screen.getByTestId('toggle-restriction-enzymes'));
      expect(screen.getByTestId('restriction-enzymes-drawer')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId(testid));

      expect(screen.queryByTestId('restriction-enzymes-drawer')).toBeNull();
      expect(screen.getByTestId(`generic-drawer-${type}`)).toBeInTheDocument();
      expect(screen.getByTestId('active-drawer-label').textContent).toBe(type);
    }
  );

  it('closes the restriction-enzymes drawer when the close button is clicked', () => {
    render(<Harness />);

    fireEvent.click(screen.getByTestId('toggle-restriction-enzymes'));
    expect(screen.getByTestId('restriction-enzymes-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('active-drawer-label').textContent).toBe('restriction-enzymes');

    fireEvent.click(screen.getByTestId('restriction-enzymes-drawer-close'));

    expect(screen.queryByTestId('restriction-enzymes-drawer')).toBeNull();
    expect(screen.getByTestId('active-drawer-label').textContent).toBe('none');
  });

  it('toggling the restriction-enzymes button closes the drawer when it is already open', () => {
    render(<Harness />);

    fireEvent.click(screen.getByTestId('toggle-restriction-enzymes'));
    expect(screen.getByTestId('restriction-enzymes-drawer')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toggle-restriction-enzymes'));
    expect(screen.queryByTestId('restriction-enzymes-drawer')).toBeNull();
    expect(screen.getByTestId('active-drawer-label').textContent).toBe('none');
  });
});
