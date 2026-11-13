/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';

import { refreshBenchlingExternalLinkMarkers } from './benchling-external-link-marker';

const BENCHLING_URL =
  'https://benchling.com/examplelab/f/lib_DemoLib1-registry/seq_DemoSeq1-pdemo666/edit';

function proseRoot(): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = `<p>Direct assembly with <a href="${BENCHLING_URL}" data-provider-stable-id="seq_DemoSeq1" data-provider-object-class="sequence">pDEMO666</a></p>`;
  return root;
}

describe('Benchling external-link marker', () => {
  it('marks a prose link whose current destination is Benchling', async () => {
    const root = proseRoot();
    const resolveDestination = vi.fn().mockResolvedValue({ kind: 'benchling', url: BENCHLING_URL });

    await refreshBenchlingExternalLinkMarkers({
      root,
      owningRoot: '/lab/caspian',
      generation: 0,
      resolveDestination,
    });

    const link = root.querySelector('a');
    expect(link?.getAttribute('data-benchling-link-destination')).toBe('external');
    expect(link?.getAttribute('data-benchling-link-marker')).toBe('B↗');
    expect(link?.getAttribute('title')).toBe('Opens in Benchling');
    expect(link?.getAttribute('aria-label')).toBe('pDEMO666, opens in Benchling');
  });

  it('does not mark a link that resolves inside DNAForge', async () => {
    const root = proseRoot();

    await refreshBenchlingExternalLinkMarkers({
      root,
      owningRoot: '/lab/caspian',
      generation: 0,
      resolveDestination: vi.fn().mockResolvedValue({
        kind: 'native',
        detail: {
          entityId: 'caspian::sequence-pdemo666',
          label: 'pDEMO666',
          owningRoot: '/lab/caspian',
        },
      }),
    });

    const link = root.querySelector('a');
    expect(link?.getAttribute('data-benchling-link-destination')).toBe('native');
    expect(link?.hasAttribute('data-benchling-link-marker')).toBe(false);
    expect(link?.hasAttribute('aria-label')).toBe(false);
  });

  it('marks a safe raw Benchling link that has no resolvable provider identity', async () => {
    const root = document.createElement('div');
    root.innerHTML = `<a href="${BENCHLING_URL}">pDEMO666</a>`;
    const resolveDestination = vi.fn().mockResolvedValue({ kind: 'benchling', url: BENCHLING_URL });

    await refreshBenchlingExternalLinkMarkers({
      root,
      owningRoot: '/lab/caspian',
      generation: 0,
      resolveDestination,
    });

    expect(root.querySelector('a')?.getAttribute('data-benchling-link-destination')).toBe(
      'external'
    );
  });

  it('ignores links to other providers', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<a href="https://www.ncbi.nlm.nih.gov/nuccore/NC_001133">NCBI</a>';
    const resolveDestination = vi.fn();

    await refreshBenchlingExternalLinkMarkers({
      root,
      owningRoot: '/lab/caspian',
      generation: 0,
      resolveDestination,
    });

    expect(resolveDestination).not.toHaveBeenCalled();
    expect(root.querySelector('a')?.hasAttribute('data-benchling-link-destination')).toBe(false);
  });
});
