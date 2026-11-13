/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockResolveProviderReference } = vi.hoisted(() => ({
  mockResolveProviderReference: vi.fn(),
}));

vi.mock('../../../../platform', () => ({
  platform: () => ({
    benchlingMigration: { resolveProviderReference: mockResolveProviderReference },
  }),
}));

vi.mock('../../entity-ref/reference-context', () => ({
  useOptionalReferenceContext: () => ({ owningRoot: '/lab/destination', workspaceScopeKey: 'ws1' }),
}));

import { BenchlingReferenceRenderer } from './Renderer';
import type { BenchlingReferenceAttrs } from './types';

const INTENDED = 'seq_DemoSeq004';

function attrs(overrides: Partial<BenchlingReferenceAttrs> = {}): BenchlingReferenceAttrs {
  return {
    refId: 'benchling-reference-abc123',
    sourceNotebookId: 'etr_DemoEtr001',
    relationshipId: 'rel_abc',
    relationType: 'references',
    target: {
      provider: 'benchling',
      stableObjectId: INTENDED,
      objectClass: 'sequence',
      canonicalUrl: null,
      providerAccountHint: null,
    },
    expectedObjectClass: 'sequence',
    label: 'Controlled Corpus Sequence',
    sourceUrl: null,
    disposition: 'pending',
    ...overrides,
  };
}

function renderCard(overrides: Partial<BenchlingReferenceAttrs> = {}) {
  return render(
    <BenchlingReferenceRenderer
      type="benchling-reference"
      refId="benchling-reference-abc123"
      attrs={attrs(overrides) as unknown as Record<string, unknown>}
      selected={false}
      onRemove={() => {}}
    />
  );
}

beforeEach(() => {
  mockResolveProviderReference.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('benchling reference card states', () => {
  it('reads "Source not imported yet" while the target is missing', async () => {
    mockResolveProviderReference.mockResolvedValue({
      resolution: { status: 'pending', reason: 'target_not_imported' },
      target: null,
    });
    renderCard();
    expect(await screen.findByText(/source not imported yet/i)).toBeTruthy();
  });

  it('reads "Needs review" when the export recorded no exact ID', async () => {
    mockResolveProviderReference.mockResolvedValue({
      resolution: { status: 'pending', reason: 'identity_missing' },
      target: null,
    });
    renderCard();
    expect(await screen.findByText(/needs review/i)).toBeTruthy();
  });

  it('names its native target and opens the exact entity when resolved', async () => {
    mockResolveProviderReference.mockResolvedValue({
      resolution: {
        status: 'resolved',
        entityId: 'ws1::sequence-abc',
        scope: 'workspace',
        evidence: 'stable_id',
      },
      target: {
        entityId: 'ws1::sequence-abc',
        title: 'Corpus sequence',
        entityType: 'sequence',
        scope: 'workspace',
      },
    });
    const opened = vi.fn();
    window.addEventListener('waypoint:open-entity', opened, { once: true });

    renderCard();
    const button = await screen.findByTestId('benchling-reference-open');
    expect(button.textContent).toBe('Corpus sequence');
    fireEvent.click(button);

    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      entityType: 'native-catalog',
      entityId: 'ws1::sequence-abc',
      label: 'Corpus sequence',
      owningRoot: '/lab/destination',
    });
  });

  it('offers no candidate to open when the reference is ambiguous', async () => {
    mockResolveProviderReference.mockResolvedValue({
      resolution: {
        status: 'ambiguous',
        candidateEntityIds: ['ws1::a', 'ws2::b'],
        reason: 'multiple_exact_candidates',
      },
      target: null,
    });
    renderCard();
    expect(await screen.findByText(/more than one object/i)).toBeTruthy();
    expect(screen.queryByTestId('benchling-reference-open')).toBeNull();
    expect(screen.queryByText(/ws1::a/)).toBeNull();
  });

  it('opens only its safe HTTPS Benchling URL for an external reference', async () => {
    const sourceUrl = 'https://benchling.com/exampleowner/f/lib_x/ent_DemoEnt1-person/edit';
    mockResolveProviderReference.mockResolvedValue({
      resolution: { status: 'external', sourceUrl },
      target: null,
    });
    renderCard({ disposition: 'external', sourceUrl });
    const link = (await screen.findByTestId('benchling-reference-external')) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(sourceUrl);
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('does not claim a source-broken target is merely missing', async () => {
    mockResolveProviderReference.mockResolvedValue({
      resolution: { status: 'source_broken', reason: 'The export recorded a broken link.' },
      target: null,
    });
    renderCard({
      disposition: 'source_broken',
      brokenReason: 'The export recorded a broken link.',
    });
    expect(await screen.findByText(/source link is broken/i)).toBeTruthy();
    expect(screen.queryByText(/not imported yet/i)).toBeNull();
  });

  it('never renders raw provider JSON', async () => {
    mockResolveProviderReference.mockResolvedValue({
      resolution: { status: 'pending', reason: 'target_not_imported' },
      target: null,
    });
    const { container } = renderCard();
    await screen.findByText(/source not imported yet/i);
    expect(container.textContent).not.toContain('stableObjectId');
    expect(container.textContent).not.toContain(INTENDED);
    expect(container.textContent).not.toContain('rel_abc');
  });

  it('says so honestly when resolution itself fails', async () => {
    mockResolveProviderReference.mockRejectedValue(new Error('bridge down'));
    renderCard();
    expect(await screen.findByText(/could not check this reference/i)).toBeTruthy();
  });
});

describe('benchling reference card invalidation', () => {
  it('moves from pending to available after the workspace is reconciled', async () => {
    mockResolveProviderReference.mockResolvedValueOnce({
      resolution: { status: 'pending', reason: 'target_not_imported' },
      target: null,
    });
    renderCard();
    expect(await screen.findByText(/source not imported yet/i)).toBeTruthy();

    mockResolveProviderReference.mockResolvedValue({
      resolution: {
        status: 'resolved',
        entityId: 'ws1::sequence-abc',
        scope: 'workspace',
        evidence: 'stable_id',
      },
      target: {
        entityId: 'ws1::sequence-abc',
        title: 'Corpus sequence',
        entityType: 'sequence',
        scope: 'workspace',
      },
    });
    window.dispatchEvent(new CustomEvent('waypoint:workspace-reconciled', { detail: {} }));

    expect(await screen.findByTestId('benchling-reference-open')).toBeTruthy();
  });

  it('resolves against the catalog only after reconcile, not on the earlier file event', async () => {
    mockResolveProviderReference.mockResolvedValue({
      resolution: { status: 'pending', reason: 'target_not_imported' },
      target: null,
    });
    renderCard();
    await screen.findByText(/source not imported yet/i);
    const afterMount = mockResolveProviderReference.mock.calls.length;

    window.dispatchEvent(new CustomEvent('waypoint:workspace-reconciled', { detail: {} }));
    await waitFor(() =>
      expect(mockResolveProviderReference.mock.calls.length).toBeGreaterThan(afterMount)
    );
  });

  it('sends the owning workspace root, never a caller-chosen scope', async () => {
    mockResolveProviderReference.mockResolvedValue({
      resolution: { status: 'pending', reason: 'target_not_imported' },
      target: null,
    });
    renderCard();
    await screen.findByText(/source not imported yet/i);
    expect(mockResolveProviderReference).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/lab/destination' })
    );
    const request = mockResolveProviderReference.mock.calls[0][0] as Record<string, unknown>;
    expect(request).not.toHaveProperty('allowedWorkspaceIds');
    expect(request).not.toHaveProperty('allowedRegistryEntityIds');
  });
});
