// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { loadScenarioAssets } from './assets';
import type { AppScenario } from './types';

describe('native scenario assets', () => {
  const scenario = (optional = false): AppScenario => ({
    workspace: { folders: [{ path: '/fixture/assembly-demo', name: 'assembly-demo' }] },
    files: { '/fixture/assembly-demo/README.md': 'Assembly demo' },
    assets: [
      {
        wpAssetsPath: 'MG1655_ecoli.gb',
        mountPath: '/fixture/assembly-demo/genomes/E_coli_MG1655_host.gb',
        optional,
      },
    ],
  });

  it('reads an approved optional genome and declares its owned native sequence import', async () => {
    const read = vi.fn(async () => 'LOCUS       synthetic_host');
    const loaded = await loadScenarioAssets(scenario(true), read, '/approved-assets');
    expect(read).toHaveBeenCalledWith('/approved-assets/MG1655_ecoli.gb');
    expect(loaded.files).toEqual({
      '/fixture/assembly-demo/README.md': 'Assembly demo',
      '/fixture/assembly-demo/genomes/E_coli_MG1655_host.gb': 'LOCUS       synthetic_host',
    });
    expect(Object.values(loaded.sequenceSources ?? {})).toEqual([
      {
        sourcePath: '/fixture/assembly-demo/genomes/E_coli_MG1655_host.gb',
        name: 'E_coli_MG1655_host.gb',
      },
    ]);
  });

  it('omits only an explicitly optional unavailable asset', async () => {
    const input = scenario(true);
    const loaded = await loadScenarioAssets(
      input,
      async () => {
        throw new Error('Source unavailable');
      },
      '/approved-assets'
    );
    expect(loaded.files).toEqual(input.files);
    expect(loaded.sequenceSources).toEqual({});
  });

  it('retains the failure of an unavailable required asset', async () => {
    await expect(
      loadScenarioAssets(
        scenario(),
        async () => {
          throw new Error('Source unavailable');
        },
        '/approved-assets'
      )
    ).rejects.toThrow('Source unavailable');
  });

  it('refuses a required relative source when the approved assets root is unavailable', async () => {
    const read = vi.fn(async () => 'unexpected content');
    await expect(loadScenarioAssets(scenario(), read, '')).rejects.toThrow(
      'Local fixture assets are unavailable'
    );
    expect(read).not.toHaveBeenCalled();
  });
});
