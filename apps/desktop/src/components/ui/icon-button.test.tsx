import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './index';

describe('shared icon-action Button', () => {
  it('uses a 32px square without text-button padding', () => {
    render(
      <Button variant="icon" aria-label="Close metadata">
        ×
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Close metadata', exact: true });
    expect(button).toHaveClass('size-8', 'shrink-0', 'p-0');
    expect(Array.from(button.classList).filter((token) => /^(px|py)-/.test(token))).toEqual([]);
  });

  it('preserves the default text-button padding and sizing', () => {
    render(<Button>Save metadata</Button>);
    const button = screen.getByRole('button', { name: 'Save metadata', exact: true });
    expect(button).toHaveClass('px-3', 'py-2');
    expect(button).not.toHaveClass('size-8');
  });
});
