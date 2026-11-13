import { createHash, webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostedRecoveryPanel } from './HostedRecoveryPanel';

const accountId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const bytes = new TextEncoder().encode('exact retained scientific file\n');
const file = {
  path: 'sequences/construct/construct.gb',
  contentSha256: createHash('sha256').update(bytes).digest('hex'),
  sizeBytes: bytes.length,
  contentType: 'application/genbank',
};

function candidate(id = 'saved-capture', overrides: Record<string, unknown> = {}) {
  return {
    id,
    accountId,
    baseVersionId: null,
    reason: 'invalid-package',
    coverage: 'incomplete',
    createdAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function detail(id = 'saved-capture', overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    candidate: candidate(id),
    manifest: { schemaVersion: 1, files: [file] },
    resourceIdentities: [],
    missingPaths: ['sequences/construct/contents/missing.bin'],
    ...overrides,
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

function serve(
  input: { candidates?: unknown[]; detail?: unknown; downloadBytes?: Uint8Array } = {}
) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'https://storage.example.test/retained')
      return new Response(input.downloadBytes ?? bytes);
    expect(new Headers(init?.headers).get('X-DNAForge-Account-ID')).toBe(accountId);
    expect(init?.method ?? 'GET').toBe('GET');
    if (url.endsWith('/files?path=sequences%2Fconstruct%2Fconstruct.gb'))
      return json({ signedUrl: 'https://storage.example.test/retained' });
    if (url.endsWith('/recovery-candidates/saved-capture')) return json(input.detail ?? detail());
    if (url.endsWith('/recovery-candidates'))
      return json({ candidates: input.candidates ?? [candidate()] });
    throw new Error(`Unexpected network request: ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

let createObjectURL: ReturnType<typeof vi.fn>;
let click: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  createObjectURL = vi.fn(() => 'blob:verified-retained-file');
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    }
  );
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('HostedRecoveryPanel, crossing real recovery HTTP and hash verification', () => {
  it('lists only unexpired actor-private captures, with truthful coverage and no restore action', async () => {
    serve({
      candidates: [
        candidate(),
        candidate('expired', { expiresAt: '2000-01-01T00:00:00Z' }),
        candidate('foreign', { accountId: 'another-account' }),
        candidate('complete', { coverage: 'captured-bytes' }),
      ],
    });
    render(<HostedRecoveryPanel workspaceId={workspaceId} accountId={accountId} />);
    await screen.findByRole('button', { name: 'Inspect recovery capture saved-capture' });
    expect(screen.queryByRole('button', { name: /expired|foreign/ })).not.toBeInTheDocument();
    expect(screen.getByText(/not accepted revisions/i)).toBeInTheDocument();
    expect(screen.getByText(/incomplete capture/i)).toBeInTheDocument();
    expect(screen.getByText(/captured files retained/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restore|publish/i })).not.toBeInTheDocument();
  });

  it('inspects exact saved paths and missing members, without silently filling absent files', async () => {
    serve();
    render(<HostedRecoveryPanel workspaceId={workspaceId} accountId={accountId} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Inspect recovery capture saved-capture' })
    );
    expect(await screen.findByText('sequences/construct/contents/missing.bin')).toBeInTheDocument();
    expect(screen.getByText(file.path)).toBeInTheDocument();
    expect(screen.getByText(/downloads do not restore or publish/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Download ${file.path}` })).toBeEnabled();
    expect(click).not.toHaveBeenCalled();
  });

  it('downloads only hash-verified bytes using a safe single filename, with no project mutation', async () => {
    const network = serve();
    render(<HostedRecoveryPanel workspaceId={workspaceId} accountId={accountId} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Inspect recovery capture saved-capture' })
    );
    fireEvent.click(await screen.findByRole('button', { name: `Download ${file.path}` }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(createObjectURL).toHaveBeenCalledOnce();
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe('construct.gb');
    expect(anchor.href).toBe('blob:verified-retained-file');
    expect(network.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true
    );
  });

  it('refuses a corrupt download and never offers it as recovered bytes', async () => {
    serve({ downloadBytes: new TextEncoder().encode('corrupted retained bytes') });
    render(<HostedRecoveryPanel workspaceId={workspaceId} accountId={accountId} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Inspect recovery capture saved-capture' })
    );
    fireEvent.click(await screen.findByRole('button', { name: `Download ${file.path}` }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/saved size and digest/i);
    expect(click).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('discards late actor/workspace results instead of rendering the preceding account’s captures', async () => {
    let resolveOld!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.includes(workspaceId)
          ? new Promise<Response>((resolve) => {
              resolveOld = resolve;
            })
          : Promise.resolve(json({ candidates: [] }))
      )
    );
    const view = render(<HostedRecoveryPanel workspaceId={workspaceId} accountId={accountId} />);
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    view.rerender(<HostedRecoveryPanel workspaceId="new-workspace" accountId="new-account" />);
    await screen.findByText(/no unexpired recovery captures/i);
    await act(async () => {
      resolveOld(json({ candidates: [candidate()] }));
    });
    expect(
      screen.queryByRole('button', { name: 'Inspect recovery capture saved-capture' })
    ).not.toBeInTheDocument();
  });

  it('does not download a completed old request after the active account changes', async () => {
    let resolveBytes!: (response: Response) => void;
    const ordinary = serve();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) =>
        url === 'https://storage.example.test/retained'
          ? new Promise<Response>((resolve) => {
              resolveBytes = resolve;
            })
          : url.includes('new-workspace')
            ? Promise.resolve(json({ candidates: [] }))
            : ordinary(url, init)
      )
    );
    const view = render(<HostedRecoveryPanel workspaceId={workspaceId} accountId={accountId} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Inspect recovery capture saved-capture' })
    );
    fireEvent.click(await screen.findByRole('button', { name: `Download ${file.path}` }));
    await waitFor(() => expect(resolveBytes).toBeTypeOf('function'));
    view.rerender(<HostedRecoveryPanel workspaceId="new-workspace" accountId="new-account" />);
    await act(async () => {
      resolveBytes(new Response(bytes));
    });
    expect(click).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
