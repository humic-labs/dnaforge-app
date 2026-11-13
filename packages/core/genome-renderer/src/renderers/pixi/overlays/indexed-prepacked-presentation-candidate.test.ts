import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compiledExactPrepackedOwnerKey,
  isAdmittedPrepackedPresentationCandidate,
  resolveLastCompletePrepackedResidents,
  resolvePrepackedPresentationResident,
} from './indexed-prepacked-presentation-candidate';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('isAdmittedPrepackedPresentationCandidate', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function isAdmittedPrepackedPresentationCandidate');
    expect(source).not.toContain('function compiledExactPrepackedOwnerKey');
    expect(source).not.toContain('function resolvePrepackedPresentationResident');
    expect(source).not.toContain('function resolveLastCompletePrepackedResidents');
  });

  it('requires admission, exact track/theme, and layer coverage or an empty detail packet', () => {
    const base = {
      admitted: true,
      trackType: 'mRNA',
      themeMode: 'light' as const,
      requestedTrackType: 'mRNA',
      requestedThemeMode: 'light' as const,
      coversRequestedLayer: true,
      emptyDetailPacket: false,
    };
    expect(isAdmittedPrepackedPresentationCandidate(base)).toBe(true);
    expect(isAdmittedPrepackedPresentationCandidate({ ...base, admitted: false })).toBe(false);
    expect(isAdmittedPrepackedPresentationCandidate({ ...base, coversRequestedLayer: false })).toBe(
      false
    );
    expect(
      isAdmittedPrepackedPresentationCandidate({
        ...base,
        coversRequestedLayer: false,
        emptyDetailPacket: true,
      })
    ).toBe(true);
    expect(
      isAdmittedPrepackedPresentationCandidate({ ...base, requestedTrackType: 'enhancer' })
    ).toBe(false);
  });
});

describe('compiledExactPrepackedOwnerKey', () => {
  it('uses the compiled owner only when it is the requested color basis', () => {
    expect(
      compiledExactPrepackedOwnerKey({
        compiledTrackType: 'mRNA',
        requestedTrackType: 'mRNA',
        compiledThemeMode: 'light',
        requestedThemeMode: 'light',
        compiledOwnerKey: 'owner-a',
      })
    ).toBe('owner-a');
    expect(
      compiledExactPrepackedOwnerKey({
        compiledTrackType: 'mRNA',
        requestedTrackType: 'mRNA',
        compiledThemeMode: 'dark',
        requestedThemeMode: 'light',
        compiledOwnerKey: 'owner-a',
      })
    ).toBeUndefined();
    expect(
      compiledExactPrepackedOwnerKey({
        compiledTrackType: 'transposon:Dm88',
        requestedTrackType: 'transposon:DM88',
        compiledThemeMode: 'light',
        requestedThemeMode: 'light',
        compiledOwnerKey: 'owner-a',
      })
    ).toBeUndefined();
  });
});

describe('resolvePrepackedPresentationResident', () => {
  it('prefers exact detail, then joined detail, then static exact, then compiled, then newest static', () => {
    const exact = { ownerKey: 'exact' };
    const joined = { ownerKey: 'joined' };
    const compiled = { ownerKey: 'compiled' };
    const other = { ownerKey: 'other' };
    expect(
      resolvePrepackedPresentationResident({
        exactDetail: exact,
        joinedDetail: joined,
        staticResidents: [other, compiled],
        exactOwnerKey: 'exact',
        exactCompiledOwnerKey: 'compiled',
      })
    ).toBe(exact);
    expect(
      resolvePrepackedPresentationResident({
        exactDetail: undefined,
        joinedDetail: undefined,
        staticResidents: [other, compiled],
        exactOwnerKey: 'missing',
        exactCompiledOwnerKey: 'compiled',
      })
    ).toBe(compiled);
    expect(
      resolvePrepackedPresentationResident({
        exactDetail: undefined,
        joinedDetail: undefined,
        staticResidents: [other],
        exactOwnerKey: undefined,
        exactCompiledOwnerKey: undefined,
      })
    ).toBe(other);
  });
});

describe('resolveLastCompletePrepackedResidents', () => {
  it('returns the last-complete roster only when every owner is still resident', () => {
    const residents = new Map([
      ['a', { ownerKey: 'a' }],
      ['b', { ownerKey: 'b' }],
    ]);
    expect(
      resolveLastCompletePrepackedResidents({
        lastCompleteOwnerKeys: ['a', 'b'],
        getResident: (key) => residents.get(key),
      })
    ).toEqual([{ ownerKey: 'a' }, { ownerKey: 'b' }]);
    expect(
      resolveLastCompletePrepackedResidents({
        lastCompleteOwnerKeys: ['a', 'missing'],
        getResident: (key) => residents.get(key),
      })
    ).toBeNull();
    expect(
      resolveLastCompletePrepackedResidents({
        lastCompleteOwnerKeys: [],
        getResident: () => undefined,
      })
    ).toBeNull();
  });
});
