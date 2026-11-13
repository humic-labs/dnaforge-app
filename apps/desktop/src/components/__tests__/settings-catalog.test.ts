import { describe, expect, it } from 'vitest';
import { searchSettings, SETTINGS_SECTIONS } from '../settings-catalog';

describe('settings discovery', () => {
  it('has one Registry destination for independent schemas and organization registration', () => {
    expect(
      Object.entries(SETTINGS_SECTIONS)
        .filter(([, metadata]) => metadata.label === 'Registry')
        .map(([id]) => id)
    ).toEqual(['registry']);
    expect(searchSettings('organization registration', ['registry'])[0]?.section).toBe('registry');
  });

  it('discovers Registry schema management without requiring organization membership', () => {
    expect(searchSettings('registry schemas', ['registry'])[0]).toMatchObject({
      section: 'registry',
      available: true,
    });
  });

  it('finds desktop File Handling by supported formats and default-app intent', () => {
    for (const query of [
      'GenBank',
      'SnapGene',
      '.gbff',
      '.dna',
      'default app',
      'read only preview',
    ]) {
      expect(searchSettings(query, ['file-handling'])[0]).toMatchObject({
        section: 'file-handling',
        scope: 'This device',
        available: true,
      });
    }
    expect(searchSettings('GenBank', ['appearance'])).toEqual([]);
  });

  it('matches synonyms and multiple words without indexing private values', () => {
    expect(searchSettings(' ZOOM ', ['appearance'])[0]?.id).toBe('display-scale');
    expect(searchSettings('appearance color', ['appearance']).map((r) => r.id)).toContain('theme');
    expect(searchSettings('keyboard hotkeys', ['shortcuts'])[0]?.section).toBe('shortcuts');
    expect(searchSettings('/Users/scientist', ['workspace'])).toEqual([]);
    expect(searchSettings('    ', ['appearance'])).toEqual([]);
  });

  it('only returns permitted sections, including after permissions change', () => {
    expect(searchSettings('audit', ['organization-audit'])).toHaveLength(1);
    expect(searchSettings('audit', ['organization-general'])).toEqual([]);
    expect(searchSettings('profile', ['ai', 'appearance'])).toEqual([]);
    expect(searchSettings('migration', ['ai', 'appearance'])).toEqual([]);
  });

  it('keeps coming-soon controls honest and section-only results reachable', () => {
    expect(searchSettings('word wrap', ['editor'])[0]).toMatchObject({
      id: 'word-wrap',
      available: false,
      section: 'editor',
    });
    expect(searchSettings('registry', ['registry'])[0]).toMatchObject({
      section: 'registry',
    });
  });
  it('uses public provider descriptions supplied by the existing compute catalog', () => {
    const computeProviders = [
      { id: 'tamarind', displayName: 'Tamarind Bio', summary: 'Run bioinformatics workflows.' },
    ];
    expect(searchSettings('tamarind', ['integrations'], { computeProviders })[0]).toMatchObject({
      title: 'Tamarind Bio',
      targetId: 'compute-provider-tamarind',
    });
    expect(searchSettings('tamarind', ['appearance'], { computeProviders })).toEqual([]);
    expect(searchSettings('app permissions', ['ai'], { hostedBrowser: true })).toEqual([]);
    expect(
      searchSettings('bioinformatics workflows', ['integrations'], { computeProviders })[0]?.id
    ).toBe('compute-provider-tamarind');
  });

  it('finds AI and Integrations by keywords even though they show no subtitles', () => {
    for (const [query, section] of [
      ['credentials', 'ai'],
      ['conversations', 'ai'],
      ['provider account', 'integrations'],
      ['connections', 'integrations'],
    ] as const) {
      const result = searchSettings(query, [section]).find((r) => r.id === section);
      expect(result).toMatchObject({ section, title: expect.any(String) });
      expect(result?.scope).toBeUndefined();
      expect(result?.description).toBeUndefined();
    }
    const host = searchSettings('execution host', ['ai'])[0];
    expect(host).toMatchObject({ id: 'ai-host', title: 'Host' });
    expect(host?.description).toBeUndefined();
    expect(searchSettings('revoke apps scripts', ['ai'])[0]?.id).toBe('app-permissions');
  });
});
