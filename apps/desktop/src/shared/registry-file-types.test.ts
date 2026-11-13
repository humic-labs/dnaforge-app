import { describe, expect, it } from 'vitest';
import {
  REGISTRY_FILE_TYPES,
  TREE_HIDDEN_COMPOUND_SUFFIXES,
  registryFileType,
} from './registry-file-types';
import { PRIMER_ARTIFACT_EXTENSION } from './primer-artifacts/primer-artifact';
import { stripDisplayExtension } from '../utils/fileTypes';

describe('registry-file-types SSOT', () => {
  it('enumerates every compound-suffix registry file type as tree-hidden', () => {
    expect(TREE_HIDDEN_COMPOUND_SUFFIXES).toEqual(
      expect.arrayContaining([
        '.primer.json',
        '.entity.json',
        '.wpselection.json',
        '.wpdesign.json',
        '.wpnote.json',
      ])
    );
  });

  it('orders hidden suffixes longest-first so a specific suffix wins a prefix overlap', () => {
    const lengths = TREE_HIDDEN_COMPOUND_SUFFIXES.map((s) => s.length);
    const sorted = [...lengths].sort((a, b) => b - a);
    expect(lengths).toEqual(sorted);
  });

  it('primer default dir + suffix match the file-authoritative artifact constant', () => {
    const primer = registryFileType('primer');
    expect(primer?.storage).toBe('flat-file');
    expect(primer?.defaultDir).toBe('primers');
    expect(primer?.suffix).toBe(PRIMER_ARTIFACT_EXTENSION);
  });

  it('notebooks are a dir-package (the directory name is the clean label)', () => {
    const notebook = registryFileType('notebook');
    expect(notebook?.storage).toBe('dir-package');
    expect(notebook?.suffix).toBe('.forge/notebook.json');
    expect(notebook?.treeHiddenCompoundSuffix).toBeUndefined();
  });

  it('generic schema-backed Registry records use one authoritative file per entity', () => {
    const record = registryFileType('entity-record');
    expect(record).toMatchObject({
      storage: 'flat-file',
      suffix: '.entity.json',
      defaultDir: 'records',
      registryProjected: true,
    });
  });

  it('treats a saved genome view as a file-backed Registry entity with a clean tree name', () => {
    expect(registryFileType('track-view')).toMatchObject({
      storage: 'flat-file',
      suffix: '.dnaforge-track-view.json',
      treeHiddenCompoundSuffix: '.dnaforge-track-view.json',
      registryProjected: true,
    });
    expect(stripDisplayExtension('My locus.dnaforge-track-view.json')).toBe('My locus');
  });
});

describe('stripDisplayExtension consumes the SSOT', () => {
  it('hides the .primer.json suffix WHOLE (foo.primer.json → foo, not foo.primer)', () => {
    expect(stripDisplayExtension('IDT-oPC-0001.primer.json')).toBe('IDT-oPC-0001');
  });

  it('hides the .wpselection.json suffix', () => {
    expect(stripDisplayExtension('active-site.abc123.wpselection.json')).toBe('active-site.abc123');
  });

  it('hides the .entity.json suffix whole', () => {
    expect(stripDisplayExtension('DH5alpha-1234.entity.json')).toBe('DH5alpha-1234');
  });

  it('leaves a real entity name with dots untouched', () => {
    expect(stripDisplayExtension('Construct v2.1')).toBe('Construct v2.1');
  });

  it('every registry file type has a unique id', () => {
    const ids = REGISTRY_FILE_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
