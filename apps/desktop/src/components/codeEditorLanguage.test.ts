/** @vitest-environment node */

import { describe, it, expect } from 'vitest';
import { getCodeMirrorLanguage, hasLanguageSupport } from './codeEditorLanguage';
import { getLanguageForFile } from '../utils/fileTypes';

describe('getCodeMirrorLanguage', () => {
  const SCOPED_LANGUAGE_IDS = [
    'python',
    'javascript',
    'jsx',
    'typescript',
    'tsx',
    'json',
    'markdown',
    'bash',
    'css',
    'html',
    'yaml',
    'toml',
  ];

  it.each(SCOPED_LANGUAGE_IDS)('resolves a language extension for "%s"', (id) => {
    const ext = getCodeMirrorLanguage(id);
    expect(ext).not.toBeNull();
    expect(ext).toBeDefined();
    expect(hasLanguageSupport(id)).toBe(true);
  });

  it('returns null for the plaintext id (plain editing fallback)', () => {
    expect(getCodeMirrorLanguage('plaintext')).toBeNull();
    expect(hasLanguageSupport('plaintext')).toBe(false);
  });

  it('returns null for an unknown id', () => {
    expect(getCodeMirrorLanguage('definitely-not-a-language')).toBeNull();
    expect(hasLanguageSupport('definitely-not-a-language')).toBe(false);
  });

  it('resolves all four JavaScript-family IDs', () => {
    for (const id of ['javascript', 'jsx', 'typescript', 'tsx']) {
      expect(getCodeMirrorLanguage(id)).toBeTruthy();
    }
  });

  it('resolves representative systems and scripting IDs', () => {
    for (const id of ['go', 'rust', 'ruby', 'swift', 'r', 'c', 'cpp', 'java', 'xml', 'ini']) {
      expect(getCodeMirrorLanguage(id)).toBeTruthy();
    }
  });

  it('maps representative getLanguageForFile outputs', () => {
    expect(getCodeMirrorLanguage(getLanguageForFile('main.py'))).toBeTruthy();
    expect(getCodeMirrorLanguage(getLanguageForFile('app.tsx'))).toBeTruthy();
    expect(getCodeMirrorLanguage(getLanguageForFile('index.js'))).toBeTruthy();
    expect(getCodeMirrorLanguage(getLanguageForFile('config.json'))).toBeTruthy();
    expect(getCodeMirrorLanguage(getLanguageForFile('README.md'))).toBeTruthy();
    expect(getCodeMirrorLanguage(getLanguageForFile('notes.txt'))).toBeNull();
  });

  it('degrades gracefully (null, no throw) for ids the SSOT emits but the adapter does not map', () => {
    for (const path of ['index.php', 'data.csv', 'Makefile']) {
      const id = getLanguageForFile(path);
      expect(() => getCodeMirrorLanguage(id)).not.toThrow();
      expect(getCodeMirrorLanguage(id)).toBeNull();
    }
  });
});
