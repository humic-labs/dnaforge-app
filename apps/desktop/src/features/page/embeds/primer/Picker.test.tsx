/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { searchPrimerReferencesByName } from '../../../../db/primer-reference-search';
import { PrimerPicker } from './Picker';

vi.mock('../../../../db/primer-reference-search', () => ({
  searchPrimerReferencesByName: vi.fn(),
}));

vi.mock('../../entity-ref/reference-context', () => ({
  useOptionalReferenceContext: () => ({ owningRoot: '/workspace/research' }),
}));

const searchPrimers = vi.mocked(searchPrimerReferencesByName);

function picker() {
  return render(<PrimerPicker data={{}} onAdvance={vi.fn()} onBack={vi.fn()} onCancel={vi.fn()} />);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('PrimerPicker product language', () => {
  it('describes an empty product library without exposing its database', async () => {
    searchPrimers.mockResolvedValue([]);
    picker();

    expect(await screen.findByText('Your primer library is empty')).toBeInTheDocument();
    expect(screen.queryByText(/database/i)).toBeNull();
  });

  it('does not label installation-backed primers with workspace-scope language', async () => {
    searchPrimers.mockResolvedValue([
      {
        primerId: 'primer-f2-forward',
        name: 'F2 forward',
        sequence: 'ACGTACGT',
        length: 8,
        catalogNumber: null,
        workspaceRelativePath: null,
        localOnly: true,
      },
    ]);
    picker();

    await waitFor(() => expect(screen.getByText('F2 forward')).toBeInTheDocument());
    expect(screen.getByText('8 bp')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/workspace only|workspace scope|database/i);
  });
});
