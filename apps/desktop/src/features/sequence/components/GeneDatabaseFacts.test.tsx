// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeneDatabaseFacts } from './GeneDatabaseFacts';

vi.mock('../../../services/service-manager', () => ({
  serviceManager: { getExternalLookupBaseUrl: () => 'http://sidecar.test' },
}));

afterEach(() => vi.unstubAllGlobals());

describe('GeneDatabaseFacts', () => {
  it('loads only on request and links to the original record', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ facts: [{ label: 'Summary', value: 'Database summary' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<GeneDatabaseFacts attributes={{ Dbxref: ['GeneID:672'] }} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Database facts' }));
    expect(await screen.findByText('Database summary')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe('http://sidecar.test/external/gene-facts?database=ncbi&identifier=672');
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://www.ncbi.nlm.nih.gov/gene/672');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('keeps the source link available when the service fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<GeneDatabaseFacts attributes={{ Dbxref: ['GeneID:672'] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Database facts' }));
    expect(await screen.findByText(/Facts unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('target', '_blank');
  });

  it('explains missing identifiers without sending a gene-name search', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<GeneDatabaseFacts attributes={{ Name: ['BRCA1'] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Database facts' }));
    expect(screen.getByText(/No supported database identifiers/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts outstanding lookups when closed', async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    render(<GeneDatabaseFacts attributes={{ Dbxref: ['GeneID:672'] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Database facts' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(signal.aborted).toBe(true);
  });
});
