import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { FileIconCategory } from '../../utils/fileTypes';
import { FileTypeIcon } from './file-type-icon';

describe('FileTypeIcon', () => {
  const markedCategories: FileIconCategory[] = [
    'structure',
    'web',
    'image',
    'pdf',
    'archive',
    'spreadsheet',
    'code',
    'text',
  ];

  for (const category of markedCategories) {
    it(`renders the ${category} glyph`, () => {
      const { container } = render(<FileTypeIcon category={category} />);
      const svg = container.querySelector(`svg[data-file-type-icon="${category}"]`);
      expect(svg).toBeInTheDocument();
    });
  }

  it('renders the biology glyph for biology files (no generic marker)', () => {
    const { container } = render(<FileTypeIcon category="biology" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(container.querySelector('[data-file-type-icon]')).toBeNull();
  });

  it('renders the generic page glyph as the fallback', () => {
    const { container } = render(<FileTypeIcon category="generic" />);
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.querySelector('[data-file-type-icon]')).toBeNull();
  });

  it('forwards className to the chosen glyph', () => {
    const { container } = render(<FileTypeIcon category="image" className="text-accent w-6 h-6" />);
    const svg = container.querySelector('svg[data-file-type-icon="image"]');
    expect(svg?.getAttribute('class')).toContain('text-accent');
  });
});
