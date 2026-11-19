import { createHash } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FastaPreview } from './FastaPreview';

const readFileBounded = vi.hoisted(() => vi.fn());
vi.mock('../../platform', () => ({
  platform: () => ({ fileAssociations: { readPreviewBytes: readFileBounded } }),
}));
afterEach(cleanup);

it('shows every record in source order with its own case, name, description, alphabet and snapshot', async () => {
  const source =
    '\uFEFF; note\r\n>same first\r\naCgT\r\n>same\tsecond\r\nPEpUO*.\r\n>rna\r\n' +
    'ACGU'.repeat(6);
  const bytes = new TextEncoder().encode(source);
  readFileBounded.mockResolvedValue(bytes);
  const snapshot = vi.fn();
  render(<FastaPreview path="/input.fna" onSnapshot={snapshot} />);
  expect(await screen.findByText('3 records')).toBeVisible();
  expect(screen.getByLabelText('Sequence')).toHaveTextContent('aCgT');
  expect(screen.getByText('Ambiguous alphabet · 4 symbols')).toBeVisible();
  fireEvent.click(screen.getByRole('combobox', { name: 'FASTA record' }));
  fireEvent.click(screen.getByRole('option', { name: '2. same' }));
  expect(screen.getByText('second')).toBeVisible();
  expect(screen.getByLabelText('Sequence')).toHaveTextContent('PEpUO*.');
  expect(screen.getByText('Protein-like · 7 symbols')).toBeVisible();
  fireEvent.click(screen.getByRole('combobox', { name: 'FASTA record' }));
  fireEvent.click(screen.getByRole('option', { name: '3. rna' }));
  expect(screen.getByText('RNA-like · 24 symbols')).toBeVisible();
  await waitFor(() =>
    expect(snapshot).toHaveBeenLastCalledWith(createHash('sha256').update(bytes).digest('hex'))
  );
});

it.each([
  '>one\nAC\n>empty\n>two\nGG\n',
  'ACGT\n>later\nTT\n',
  '>ok\nAC\n>\nGG\n',
  '>ok\nAC\n>last\n',
])('refuses incomplete sources without displaying a partial collection', async (source) => {
  readFileBounded.mockResolvedValue(new TextEncoder().encode(source));
  const snapshot = vi.fn();
  render(<FastaPreview path="/bad.fa" onSnapshot={snapshot} />);
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.queryByLabelText('Sequence')).toBeNull();
  expect(snapshot).toHaveBeenLastCalledWith(null);
});

it('retains every position of a long record through the last page', async () => {
  readFileBounded.mockResolvedValue(
    new TextEncoder().encode('>long\n' + 'ACGT'.repeat(1000) + 'taa\n')
  );
  render(<FastaPreview path="/long.fa" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Next positions' }));
  expect(screen.getByLabelText('Sequence')).toHaveTextContent('taa');
  expect(screen.getByText('4,001–4,003 of 4,003')).toBeVisible();
});
