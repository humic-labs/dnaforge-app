const LOCAL_STORAGE_KEY = 'dnaforge:transcript_glyph_v2';

let cachedValue: boolean | null = null;

function readEnv(): boolean | null {
  try {
    const env = import.meta.env as Record<string, string | undefined>;
    const raw = env.VITE_TRANSCRIPT_GLYPH_V2;
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

function readLocalStorage(): boolean | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const value = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (value === '1' || value === 'true') return true;
    if (value === '0' || value === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

const DEFAULT_VALUE = true;

function resolveFlag(): boolean {
  const env = readEnv();
  if (env !== null) return env;
  const local = readLocalStorage();
  if (local !== null) return local;
  return DEFAULT_VALUE;
}

export function isTranscriptGlyphV2Enabled(): boolean {
  if (cachedValue !== null) return cachedValue;
  cachedValue = resolveFlag();
  return cachedValue;
}

export function refreshTranscriptGlyphV2Flag(): boolean {
  cachedValue = resolveFlag();
  return cachedValue;
}
