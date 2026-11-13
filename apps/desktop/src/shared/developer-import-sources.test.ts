import { describe, expect, it } from 'vitest';
import {
  isDeveloperImportSourcePath,
  normalizeDeveloperImportSourceRoots,
  parseStoredDeveloperImportSourceRoots,
} from './developer-import-sources';

describe('explicit developer import-source paths', () => {
  it('keeps absolute source roots, removes duplicates, and normalizes trailing separators', () => {
    expect(
      normalizeDeveloperImportSourceRoots([
        '',
        'wp-assets',
        '/developer/wp-assets/',
        '/developer/wp-assets',
      ])
    ).toEqual(['/developer/wp-assets']);
  });

  it('matches the source and descendants without excluding neighboring projects', () => {
    const roots = ['/developer/wp-assets'];
    expect(isDeveloperImportSourcePath('/developer/wp-assets', roots)).toBe(true);
    expect(isDeveloperImportSourcePath('/developer/wp-assets/pDEMO421', roots)).toBe(true);
    expect(isDeveloperImportSourcePath('/developer/wp-assets-copy/pDEMO421', roots)).toBe(false);
    expect(isDeveloperImportSourcePath('/projects/imported/pDEMO421', roots)).toBe(false);
  });

  it('applies Windows casing and separator rules without treating POSIX paths as case insensitive', () => {
    expect(isDeveloperImportSourcePath('C:/Dev/WP-Assets/pDEMO421', ['c:\\dev\\wp-assets'])).toBe(
      true
    );
    expect(isDeveloperImportSourcePath('/Dev/WP-Assets/pDEMO421', ['/dev/wp-assets'])).toBe(false);
  });

  it('retains an absolute Windows drive root through storage and reload', () => {
    const roots = normalizeDeveloperImportSourceRoots(['C:\\']);
    expect(parseStoredDeveloperImportSourceRoots(JSON.stringify(roots))).toEqual(['C:/']);
    expect(isDeveloperImportSourcePath('C:\\wp-assets\\pDEMO421', roots)).toBe(true);
  });

  it('rejects malformed policy instead of silently admitting remembered sources', () => {
    expect(() => parseStoredDeveloperImportSourceRoots('{"root":"/developer"}')).toThrow(
      'Developer import-source configuration is invalid.'
    );
    expect(() => parseStoredDeveloperImportSourceRoots('[42]')).toThrow(
      'Developer import-source configuration is invalid.'
    );
  });
});
