import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isTranscriptGlyphV2Enabled, refreshTranscriptGlyphV2Flag } from './transcript-glyph-flag';

describe('transcript-glyph-flag', () => {
  const realStorage = globalThis.localStorage;

  beforeEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('dnaforge:transcript_glyph_v2');
    }
    vi.stubEnv('VITE_TRANSCRIPT_GLYPH_V2', '');
    refreshTranscriptGlyphV2Flag();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('dnaforge:transcript_glyph_v2');
    }
    if (realStorage) {
      Object.defineProperty(globalThis, 'localStorage', { value: realStorage, configurable: true });
    }
    refreshTranscriptGlyphV2Flag();
  });

  it('defaults to TRUE when neither env nor localStorage is set (DNA-TG1 Phase 8)', () => {
    expect(isTranscriptGlyphV2Enabled()).toBe(true);
  });

  it('returns true when VITE_TRANSCRIPT_GLYPH_V2=1', () => {
    vi.stubEnv('VITE_TRANSCRIPT_GLYPH_V2', '1');
    refreshTranscriptGlyphV2Flag();
    expect(isTranscriptGlyphV2Enabled()).toBe(true);
  });

  it('returns true when VITE_TRANSCRIPT_GLYPH_V2=true', () => {
    vi.stubEnv('VITE_TRANSCRIPT_GLYPH_V2', 'true');
    refreshTranscriptGlyphV2Flag();
    expect(isTranscriptGlyphV2Enabled()).toBe(true);
  });

  it('returns true when localStorage key is set to 1', () => {
    localStorage.setItem('dnaforge:transcript_glyph_v2', '1');
    refreshTranscriptGlyphV2Flag();
    expect(isTranscriptGlyphV2Enabled()).toBe(true);
  });

  it('env=0 overrides the default-on (QA disable path)', () => {
    vi.stubEnv('VITE_TRANSCRIPT_GLYPH_V2', '0');
    refreshTranscriptGlyphV2Flag();
    expect(isTranscriptGlyphV2Enabled()).toBe(false);
  });

  it('env=false overrides the default-on', () => {
    vi.stubEnv('VITE_TRANSCRIPT_GLYPH_V2', 'false');
    refreshTranscriptGlyphV2Flag();
    expect(isTranscriptGlyphV2Enabled()).toBe(false);
  });

  it('localStorage=0 overrides the default-on (in-app toggle disable)', () => {
    localStorage.setItem('dnaforge:transcript_glyph_v2', '0');
    refreshTranscriptGlyphV2Flag();
    expect(isTranscriptGlyphV2Enabled()).toBe(false);
  });

  it('env override beats localStorage', () => {
    localStorage.setItem('dnaforge:transcript_glyph_v2', '0');
    vi.stubEnv('VITE_TRANSCRIPT_GLYPH_V2', '1');
    refreshTranscriptGlyphV2Flag();
    expect(isTranscriptGlyphV2Enabled()).toBe(true);
  });

  it('caches the value across calls (does NOT re-read env each call)', () => {
    vi.stubEnv('VITE_TRANSCRIPT_GLYPH_V2', '0');
    refreshTranscriptGlyphV2Flag();
    expect(isTranscriptGlyphV2Enabled()).toBe(false);
    vi.stubEnv('VITE_TRANSCRIPT_GLYPH_V2', '1');
    expect(isTranscriptGlyphV2Enabled()).toBe(false);
    refreshTranscriptGlyphV2Flag();
    expect(isTranscriptGlyphV2Enabled()).toBe(true);
  });
});
