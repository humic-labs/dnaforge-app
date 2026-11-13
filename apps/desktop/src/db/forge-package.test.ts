// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  FORGE_PACKAGE_MARKER_DIR,
  forgePackagePaths,
  isForgePackageMemberRelativePath,
  isForgePackageMetaPath,
} from './forge-package';

describe('forge-package', () => {
  describe('forgePackagePaths', () => {
    it('derives root, stem, meta dir and meta path from a posix root', () => {
      expect(forgePackagePaths('/lab/Lab notes', 'notebook.json')).toEqual({
        root: '/lab/Lab notes',
        stem: 'Lab notes',
        sep: '/',
        metaDir: '/lab/Lab notes/.forge',
        metaPath: '/lab/Lab notes/.forge/notebook.json',
      });
    });

    it('parameterizes the meta filename per package kind', () => {
      expect(forgePackagePaths('/lab/pMyConstruct', 'plasmid.json').metaPath).toBe(
        '/lab/pMyConstruct/.forge/plasmid.json'
      );
    });

    it('strips trailing slashes so a dir path with or without a slash agrees', () => {
      expect(forgePackagePaths('/lab/pUC19', 'plasmid.json').metaPath).toBe(
        '/lab/pUC19/.forge/plasmid.json'
      );
      expect(forgePackagePaths('/lab/pUC19//', 'plasmid.json')).toEqual(
        forgePackagePaths('/lab/pUC19', 'plasmid.json')
      );
    });

    it('keeps backslash separators for a pure-windows root', () => {
      expect(forgePackagePaths('C:\\lab\\pUC19', 'plasmid.json')).toEqual({
        root: 'C:\\lab\\pUC19',
        stem: 'pUC19',
        sep: '\\',
        metaDir: 'C:\\lab\\pUC19\\.forge',
        metaPath: 'C:\\lab\\pUC19\\.forge\\plasmid.json',
      });
    });

    it('exposes the marker dir as the single source of truth', () => {
      expect(FORGE_PACKAGE_MARKER_DIR).toBe('.forge');
    });
  });

  describe('isForgePackageMetaPath', () => {
    it('matches an absolute meta path for the given kind only', () => {
      expect(isForgePackageMetaPath('/lab/Lab notes/.forge/notebook.json', 'notebook.json')).toBe(
        true
      );
      expect(isForgePackageMetaPath('/lab/pUC19/.forge/plasmid.json', 'plasmid.json')).toBe(true);
      expect(isForgePackageMetaPath('/lab/Lab notes/.forge/notebook.json', 'plasmid.json')).toBe(
        false
      );
    });

    it('matches a bare relative meta path', () => {
      expect(isForgePackageMetaPath('.forge/plasmid.json', 'plasmid.json')).toBe(true);
    });

    it('normalizes windows separators and case', () => {
      expect(isForgePackageMetaPath('C:\\lab\\pUC19\\.forge\\Plasmid.JSON', 'plasmid.json')).toBe(
        true
      );
    });

    it('rejects a non-meta path', () => {
      expect(isForgePackageMetaPath('/lab/Lab notes.md', 'notebook.json')).toBe(false);
      expect(isForgePackageMetaPath('/lab/pUC19/pUC19.gb', 'plasmid.json')).toBe(false);
      expect(isForgePackageMetaPath('/lab/.forge/nested/plasmid.json', 'plasmid.json')).toBe(false);
    });
  });

  describe('isForgePackageMemberRelativePath', () => {
    const notebook = { metaName: 'notebook.json', memberDirs: ['assets'], stemExtensions: ['.md'] };
    const plasmid = {
      metaName: 'plasmid.json',
      memberDirs: ['primers', 'assets'],
      stemExtensions: ['.gb', '.gbk', '.genbank'],
    };

    it('matches the meta file', () => {
      expect(isForgePackageMemberRelativePath('Lab notes/.forge/notebook.json', notebook)).toBe(
        true
      );
      expect(isForgePackageMemberRelativePath('pUC19/.forge/plasmid.json', plasmid)).toBe(true);
    });

    it('matches the primary file whose stem equals its parent folder', () => {
      expect(isForgePackageMemberRelativePath('Lab notes/Lab notes.md', notebook)).toBe(true);
      expect(isForgePackageMemberRelativePath('pUC19/pUC19.gb', plasmid)).toBe(true);
      expect(isForgePackageMemberRelativePath('pUC19/pUC19.genbank', plasmid)).toBe(true);
    });

    it('matches files under a reserved member dir', () => {
      expect(isForgePackageMemberRelativePath('Lab notes/assets/fig.png', notebook)).toBe(true);
      expect(isForgePackageMemberRelativePath('pUC19/primers/pUC19.primers.csv', plasmid)).toBe(
        true
      );
      expect(isForgePackageMemberRelativePath('pUC19/assets/gel.png', plasmid)).toBe(true);
    });

    it('matches a NESTED file under a reserved member dir (whole subtree belongs)', () => {
      expect(isForgePackageMemberRelativePath('Lab notes/assets/images/fig.png', notebook)).toBe(
        true
      );
      expect(isForgePackageMemberRelativePath('pUC19/primers/batch1/order.csv', plasmid)).toBe(
        true
      );
    });

    it('does not treat a member dir OUTSIDE a package as a member', () => {
      expect(isForgePackageMemberRelativePath('assets/fig.png', notebook)).toBe(false);
    });

    it('rejects a bare file and a stem/parent mismatch', () => {
      expect(isForgePackageMemberRelativePath('readme.md', notebook)).toBe(false);
      expect(isForgePackageMemberRelativePath('other/notes.md', notebook)).toBe(false);
      expect(isForgePackageMemberRelativePath('pUC19/something-else.gb', plasmid)).toBe(false);
    });

    it('does not let one kind claim the other kind"s primary file', () => {
      expect(isForgePackageMemberRelativePath('pUC19/pUC19.md', plasmid)).toBe(false);
      expect(isForgePackageMemberRelativePath('Lab notes/Lab notes.gb', notebook)).toBe(false);
    });
  });
});
