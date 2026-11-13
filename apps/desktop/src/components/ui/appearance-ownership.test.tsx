import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Button, TextArea, TextField } from './controls';

it('shared controls discard appearance overrides even when JavaScript spreads supply them', () => {
  const override = { className: 'private-style', style: { padding: 5, fontSize: 11 } };
  const onClick = vi.fn();
  render(
    <>
      <Button {...override} onClick={onClick}>
        Run
      </Button>
      <TextField {...override} aria-label="Name" defaultValue="retained" />
      <TextArea {...override} aria-label="Notes" defaultValue="draft" />
    </>
  );
  for (const control of [
    screen.getByRole('button', { name: 'Run' }),
    screen.getByLabelText('Name'),
    screen.getByLabelText('Notes'),
  ]) {
    expect(control).not.toHaveClass('private-style');
    expect(control).not.toHaveAttribute('style');
  }
  expect(screen.getByLabelText('Name')).toHaveValue('retained');
  expect(screen.getByLabelText('Notes')).toHaveValue('draft');
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  expect(onClick).toHaveBeenCalledOnce();
});
