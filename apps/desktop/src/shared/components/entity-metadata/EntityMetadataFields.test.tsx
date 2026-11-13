import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RegistryRecordValue } from './EntityMetadataFields';

afterEach(cleanup);

describe('public protein metadata values', () => {
  it('shows amino acids without exposing the storage object', () => {
    render(
      <RegistryRecordValue
        type="protein_sequence"
        value={{
          mode: 'inline',
          aminoAcids: 'MPEPTIDE',
          length: 8,
          contentHash: 'private-protein-hash',
          relPath: '/private/storage/protein.fa',
        }}
      />
    );
    expect(screen.getByText('MPEPTIDE', { exact: true })).toBeVisible();
    expect(document.body).not.toHaveTextContent('private-protein-hash');
    expect(document.body).not.toHaveTextContent('/private/storage/protein.fa');
    expect(screen.queryByText('Stored value')).not.toBeInTheDocument();
  });

  it('bounds long sequence previews while retaining the full length', () => {
    render(
      <RegistryRecordValue
        type="protein_sequence"
        value={{ mode: 'inline', aminoAcids: 'M'.repeat(160), length: 160 }}
      />
    );
    expect(document.body).toHaveTextContent(`${'M'.repeat(80)}… (160 aa)`);
    expect(document.body).not.toHaveTextContent('M'.repeat(160));
  });

  it('describes file-backed sequences without showing storage paths or hashes', () => {
    render(
      <RegistryRecordValue
        type="protein_sequence"
        value={{
          mode: 'file',
          length: 12,
          relPath: '/private/storage/a.fa',
          contentHash: 'private-hash',
        }}
      />
    );
    expect(document.body).toHaveTextContent('12 aa · Stored in file');
    expect(document.body).not.toHaveTextContent('/private/storage/a.fa');
    expect(document.body).not.toHaveTextContent('private-hash');
  });
});
