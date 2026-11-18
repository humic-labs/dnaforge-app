import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindConfig from '../../../../../tailwind.config';
import { FlowPopup } from './FlowPopup';
import { MentionMenu } from '../components/MentionMenu';

const flow = vi.hoisted(() => ({
  activeFlow: { flowName: 'sequence', stageIndex: 0, data: {}, startPos: 0 } as {
    flowName: string;
    stageIndex: number;
    data: Record<string, unknown>;
    startPos: number;
  } | null,
  advanceFlow: vi.fn(),
  goBack: vi.fn(),
  cancelFlow: vi.fn(),
}));

vi.mock('./flow-context', () => ({ useFlowManager: () => flow }));
vi.mock('../../embeds/registry', () => ({
  embedRegistry: {
    getPicker: () => ({
      stages: [
        {
          name: 'Select sequence',
          component: () => (
            <div>
              <input aria-label="Search sequences" autoFocus />
              <button>Insert</button>
            </div>
          ),
        },
      ],
    }),
    getPickerSize: () => 'xl',
  },
}));

async function backgroundDeclarations(element: HTMLElement): Promise<string[]> {
  const compiled = await postcss([
    tailwindcss({
      ...tailwindConfig,
      content: [{ raw: document.body.innerHTML, extension: 'html' }],
    }),
  ]).process('@tailwind utilities;', { from: undefined });
  const backgrounds: string[] = [];
  compiled.root.walkRules((rule) => {
    if (!element.matches(rule.selector)) return;
    rule.walkDecls('background-color', (declaration) => {
      backgrounds.push(declaration.value);
    });
  });
  return backgrounds;
}

beforeEach(() => {
  flow.activeFlow = { flowName: 'sequence', stageIndex: 0, data: {}, startPos: 0 };
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('notebook overlay surfaces', () => {
  it('the actual insertion dialog classes compile to an opaque theme background', async () => {
    render(<FlowPopup />);
    expect(await backgroundDeclarations(screen.getByRole('dialog'))).toContain(
      'hsl(var(--color-bg) / var(--tw-bg-opacity, 1))'
    );
  });

  it('paints the empty mention menu with the opaque Files panel surface', async () => {
    render(<MentionMenu items={[]} query="" command={vi.fn()} />);
    expect(await backgroundDeclarations(screen.getByTestId('mention-menu'))).toContain(
      'hsl(var(--color-bg-subtle) / var(--tw-bg-opacity, 1))'
    );
  });
});

describe('notebook insertion modal keyboard behavior', () => {
  it('renders outside an editor container that may clip overlays', () => {
    const parent = document.createElement('div');
    parent.style.overflow = 'hidden';
    document.body.append(parent);
    render(<FlowPopup />, { container: parent });
    expect(parent.contains(screen.getByRole('dialog'))).toBe(false);
  });

  it('wraps forward and backward Tab within the modal', () => {
    render(<FlowPopup />);
    const first = screen.getByRole('button', { name: 'Cancel' });
    const last = screen.getByRole('button', { name: 'Insert' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('restores the editor trigger after dismissal', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const { rerender } = render(<FlowPopup />);
    expect(screen.getByRole('textbox')).toHaveFocus();
    flow.activeFlow = null;
    rerender(<FlowPopup />);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('respects Escape already handled by an inner control', () => {
    render(<FlowPopup />);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    screen.getByRole('textbox').dispatchEvent(event);
    expect(flow.cancelFlow).not.toHaveBeenCalled();
  });
});
