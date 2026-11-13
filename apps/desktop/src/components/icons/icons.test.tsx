import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  SendIcon,
  SettingsIcon,
  HistoryIcon,
  SearchIcon,
  SidebarIcon,
  CloseIcon,
  TrashIcon,
  PinIcon,
  PaperclipIcon,
  XIcon,
  CopyIcon,
  CheckIcon,
  RefreshIcon,
  StopIcon,
  EditIcon,
  OpenExternalIcon,
  ChevronRightIcon,
  ChatTabIcon,
  NotebookTabIcon,
  AssemblyTabIcon,
  ProteinIcon,
  StructureFileIcon,
  createTabTypeIconElement,
} from './index';

describe('Shared Icons', () => {
  it('SendIcon renders with default size', () => {
    render(<SendIcon data-testid="send-icon" />);
    const svg = document.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('width', '16');
    expect(svg).toHaveAttribute('height', '16');
  });

  it('SendIcon renders with custom size', () => {
    render(<SendIcon size={12} />);
    const svg = document.querySelector('svg');
    expect(svg).toHaveAttribute('width', '12');
    expect(svg).toHaveAttribute('height', '12');
  });

  it('SettingsIcon renders with default size', () => {
    render(<SettingsIcon />);
    const svg = document.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('width', '14');
    expect(svg).toHaveAttribute('data-icon', 'settings-gear');
  });

  it('HistoryIcon renders', () => {
    render(<HistoryIcon />);
    expect(document.querySelector('svg')).toBeInTheDocument();
  });

  it('SearchIcon renders', () => {
    render(<SearchIcon />);
    expect(document.querySelector('svg')).toBeInTheDocument();
  });

  it('SidebarIcon renders', () => {
    render(<SidebarIcon />);
    expect(document.querySelector('svg')).toBeInTheDocument();
  });

  it('CloseIcon renders', () => {
    render(<CloseIcon />);
    expect(document.querySelector('svg')).toBeInTheDocument();
  });

  it('TrashIcon renders with default size 12', () => {
    render(<TrashIcon />);
    const svg = document.querySelector('svg');
    expect(svg).toHaveAttribute('width', '12');
  });

  it('PinIcon renders unfilled by default', () => {
    render(<PinIcon />);
    const svg = document.querySelector('svg');
    expect(svg).toHaveAttribute('fill', 'none');
  });

  it('PinIcon renders filled when filled prop is true', () => {
    render(<PinIcon filled />);
    const svg = document.querySelector('svg');
    expect(svg).toHaveAttribute('fill', 'currentColor');
  });

  it('PaperclipIcon renders', () => {
    render(<PaperclipIcon />);
    expect(document.querySelector('svg')).toBeInTheDocument();
  });

  it('XIcon renders', () => {
    render(<XIcon />);
    expect(document.querySelector('svg')).toBeInTheDocument();
  });

  it('CopyIcon renders with custom size', () => {
    render(<CopyIcon size={20} />);
    const svg = document.querySelector('svg');
    expect(svg).toHaveAttribute('width', '20');
  });

  it('CheckIcon renders', () => {
    render(<CheckIcon />);
    expect(document.querySelector('svg')).toBeInTheDocument();
  });

  it('RefreshIcon renders', () => {
    render(<RefreshIcon />);
    expect(document.querySelector('svg')).toBeInTheDocument();
  });

  it('StopIcon renders with fill', () => {
    render(<StopIcon />);
    const svg = document.querySelector('svg');
    expect(svg).toHaveAttribute('fill', 'currentColor');
  });

  it('EditIcon renders', () => {
    render(<EditIcon />);
    expect(document.querySelector('svg')).toBeInTheDocument();
  });

  it('OpenExternalIcon renders', () => {
    render(<OpenExternalIcon />);
    expect(document.querySelector('svg')).toBeInTheDocument();
  });

  it('ChevronRightIcon renders with default size 12', () => {
    render(<ChevronRightIcon />);
    const svg = document.querySelector('svg');
    expect(svg).toHaveAttribute('width', '12');
  });

  it('Icons accept className prop', () => {
    render(<SendIcon className="custom-class" />);
    const svg = document.querySelector('svg');
    expect(svg).toHaveClass('custom-class');
  });
});

describe('TabType icons', () => {
  it('uses the approved structure glyph as the sole protein icon geometry', () => {
    expect(ProteinIcon).toBe(StructureFileIcon);
    const { container } = render(<ProteinIcon />);
    const svg = container.querySelector('svg[data-file-type-icon="structure"]');
    expect(svg).not.toBeNull();
    expect(svg?.querySelector('path')).toHaveAttribute(
      'd',
      'M2.8 4.375Q4 4.375 4 5.575V18.5A2 1.5 0 0 0 8 18.5V5.5A2 1.5 0 0 1 12 5.5V18.5A2 1.5 0 0 0 16 18.5V5.5A2 1.5 0 0 1 20 5.5V17.92Q20 19.12 21.2 19.12'
    );
  });

  it.each([
    ['ChatTabIcon', ChatTabIcon, 'chat'],
    ['NotebookTabIcon', NotebookTabIcon, 'page'],
    ['AssemblyTabIcon', AssemblyTabIcon, 'design'],
  ] as const)('%s renders an SVG glyph tagged for its tab type', (_name, Icon, tabType) => {
    render(<Icon />);
    const svg = document.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('data-tab-type-icon', tabType);
  });

  it('renders the assembly glyph as four smooth arcs without endpoint dots', () => {
    const { container } = render(<AssemblyTabIcon />);
    const svg = container.querySelector('svg[data-tab-type-icon="design"]');
    const paths = Array.from(svg?.querySelectorAll('path') ?? []);

    expect(paths).toHaveLength(4);
    expect(paths.every((path) => path.getAttribute('d')?.includes('a9 9'))).toBe(true);
    expect(svg?.querySelectorAll('circle')).toHaveLength(0);
  });

  it('does not keep the retired paired-strand assembly geometry', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/icons/glyphs.tsx'), 'utf8');
    expect(source).not.toContain('M8 3c4.5 3.2');
    expect(source).not.toContain('M16 3c-4.5 3.2');
    expect(source).not.toContain('Two paired strands with rungs');
    expect(source).not.toContain('AssemblyPlusIcon');
  });
  describe('createTabTypeIconElement (vanilla-DOM drag preview builder)', () => {
    it.each([
      'file',
      'text',
      'image',
      'html',
      'chat',
      'page',
      'structure',
      'design',
      'primer',
    ] as const)('builds a real <svg> for tab type %s, not an emoji text node', (tabType) => {
      const el = createTabTypeIconElement(tabType, 14);
      expect(el).not.toBeNull();
      expect(el?.tagName.toLowerCase()).toBe('svg');
      expect(el?.getAttribute('width')).toBe('14');
      expect(el?.textContent).toBe('');
    });

    it('returns null for an unrecognized type, leaving sequence/table to their own builders', () => {
      expect(createTabTypeIconElement('sequence')).toBeNull();
      expect(createTabTypeIconElement('table')).toBeNull();
      expect(createTabTypeIconElement('not-a-real-type')).toBeNull();
    });
  });
});
