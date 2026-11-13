import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { selectCompiledBroadThemeOwner } from './indexed-compiled-broad-theme-roster';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('selectCompiledBroadThemeOwner', () => {
  it('lives outside annotation-overlay.ts', () => {
    expect(overlaySource()).not.toContain('function selectCompiledBroadThemeOwner');
  });

  it('prefers a candidate, then a current owner, once any owner names a theme', () => {
    const light: { provenance: { themeMode?: 'light' | 'dark' } } = {
      provenance: { themeMode: 'light' },
    };
    const dark: { provenance: { themeMode?: 'light' | 'dark' } } = {
      provenance: { themeMode: 'dark' },
    };
    const unthemed: { provenance: { themeMode?: 'light' | 'dark' } } = {
      provenance: { themeMode: undefined },
    };
    expect(
      selectCompiledBroadThemeOwner({
        requestedThemeMode: 'light',
        rosterHasExplicitThemeAuthority: true,
        currentOwner: dark,
        registeredCandidateOwner: light,
      })
    ).toEqual({
      currentOwner: dark,
      candidateOwner: light,
      owner: light,
    });
    expect(
      selectCompiledBroadThemeOwner({
        requestedThemeMode: 'light',
        rosterHasExplicitThemeAuthority: true,
        currentOwner: light,
        registeredCandidateOwner: dark,
      })
    ).toEqual({
      currentOwner: light,
      candidateOwner: null,
      owner: light,
    });
    expect(
      selectCompiledBroadThemeOwner({
        requestedThemeMode: 'light',
        rosterHasExplicitThemeAuthority: false,
        currentOwner: unthemed,
        registeredCandidateOwner: null,
      })
    ).toEqual({
      currentOwner: unthemed,
      candidateOwner: null,
      owner: unthemed,
    });
  });
});
