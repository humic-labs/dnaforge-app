import { describe, it, expect } from 'vitest';
import { JETBRAINS_MONO_FONT_NAME, loadSequenceFonts, type SequenceFontSources } from './fonts';

describe('JETBRAINS_MONO_FONT_NAME', () => {
  it('is the single canonical spelling of the shared sequence-mono font name', () => {
    expect(JETBRAINS_MONO_FONT_NAME).toBe('JetBrains Mono');
  });
});

describe('sequence font readiness guard', () => {
  const sources: SequenceFontSources = {
    400: 'regular',
    500: 'medium',
    600: 'semibold',
    700: 'bold',
  };
  function registry(initial: FontFace[] = []) {
    const faces = new Set(initial);
    return {
      faces,
      fonts: {
        forEach: (callback: (face: FontFace) => void) => faces.forEach(callback),
        add: (face: FontFace) => faces.add(face),
      },
    };
  }
  function face(weight: string, fail = false): FontFace {
    const result = {
      family: 'JetBrains Mono',
      weight,
      style: 'normal',
      status: 'unloaded',
      async load() {
        if (fail) throw new Error('Missing asset');
        result.status = 'loaded';
        return result;
      },
    };
    return result as unknown as FontFace;
  }

  it('loads all drawing weights before declaring readiness', async () => {
    const { fonts, faces } = registry();
    await loadSequenceFonts(fonts, sources, (_source, weight) => face(weight));
    expect([...faces].map((value) => [value.weight, value.status])).toEqual([
      ['400', 'loaded'],
      ['500', 'loaded'],
      ['600', 'loaded'],
      ['700', 'loaded'],
    ]);
  });

  it('rejects a missing configuration rather than accepting system fallback', async () => {
    await expect(
      loadSequenceFonts(registry().fonts, undefined, (_source, weight) => face(weight))
    ).rejects.toThrow('not been configured');
  });

  it('rejects a missing drawing weight', async () => {
    await expect(
      loadSequenceFonts(registry().fonts, { ...sources, 600: '' }, (_source, weight) =>
        face(weight)
      )
    ).rejects.toThrow('Missing bundled sequence font: 600');
  });

  it('reports a broken asset loudly with its weight', async () => {
    await expect(
      loadSequenceFonts(registry().fonts, sources, (_source, weight) =>
        face(weight, weight === '400')
      )
    ).rejects.toThrow('Bundled sequence font could not load: 400');
  });

  it('rejects a global family collision while permitting the private wordmark', async () => {
    const wordmark = face('700');
    Object.defineProperty(wordmark, 'family', { value: 'DNAForge Wordmark Mono' });
    await expect(
      loadSequenceFonts(registry([wordmark]).fonts, sources, (_source, weight) => face(weight))
    ).resolves.toBeUndefined();
    await expect(
      loadSequenceFonts(registry([face('400'), face('400')]).fonts, sources, (_source, weight) =>
        face(weight)
      )
    ).rejects.toThrow('Conflicting sequence font registrations: 400');
  });
});
