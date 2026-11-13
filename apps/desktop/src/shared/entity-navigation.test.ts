import { describe, expect, it } from 'vitest';
import {
  entityNavigationLink,
  entityNavigationUrl,
  findEntityNavigationUrlInArgv,
  isEntityNavigationScheme,
  parseEntityNavigationUrl,
} from './entity-navigation';

describe('general entity navigation URLs', () => {
  it('round-trips stable identity, project and a saved exact selection without an entity type', () => {
    const target = {
      entityId: "project::sequence-with-a-quote'&?",
      projectId: 'owning-project',
      referenceId: 'saved-selection',
    };
    const link = entityNavigationLink(target);
    expect(parseEntityNavigationUrl(link.externalUrl)).toEqual(target);
    expect(link.shellCommand).toBe(`open '${link.externalUrl}'`);
    expect(link.externalUrl).not.toContain('entityType');
    expect(link.externalUrl).not.toContain('dnaforge-chat');
  });

  it.each(['dnaforge', 'dnaforge-beta', 'dnaforge-dev'] as const)(
    'uses the same target contract in the %s channel',
    (scheme) => {
      const target = { entityId: 'entity', projectId: 'owner', referenceId: 'selection' };
      const link = entityNavigationLink(target, scheme);
      expect(parseEntityNavigationUrl(link.externalUrl)).toEqual(target);
      expect(link.externalUrl.startsWith(`${scheme}://`)).toBe(true);
    }
  );

  it('supports an installation-global identity without a fabricated project', () => {
    const target = { entityId: 'canonical-registry-oligo' };
    expect(parseEntityNavigationUrl(entityNavigationUrl(target))).toEqual(target);
  });

  it('uses the same target in an independently registered development runtime', () => {
    const target = { entityId: 'sequence', projectId: 'owning-project', referenceId: 'range' };
    const link = entityNavigationLink(target, 'dnaforge-dev-1827');
    expect(parseEntityNavigationUrl(link.externalUrl)).toEqual(target);
    expect(findEntityNavigationUrlInArgv(['Electron', 'entry.js', link.externalUrl])).toBe(
      link.externalUrl
    );
  });

  it.each([
    'dnaforge-dev-0',
    'dnaforge-dev-01827',
    'dnaforge-dev-65536',
    'dnaforge-dev-1.5',
    'https',
  ])('refuses an invalid runtime scheme %s', (scheme) => {
    expect(isEntityNavigationScheme(scheme)).toBe(false);
    expect(parseEntityNavigationUrl(`${scheme}://entity/open?entityId=one`)).toBeNull();
  });

  it.each([
    'https://entity/open?entityId=one',
    'dnaforge://entity/open?entityId=one&entityId=two',
    'dnaforge://entity/open?entityId=one&projectId=',
    'dnaforge://entity/open?entityId=one&entityType=sequence',
    'dnaforge://entity/open?entityId=',
    'dnaforge://entity/open?entityId=one%0Acommand',
    'dnaforge://entity/open?entityId=one#selection',
    'dnaforge://user:password@entity/open?entityId=one',
    'dnaforge://entity/not-open?entityId=one',
  ])('refuses an ambiguous or malformed target: %s', (url) => {
    expect(parseEntityNavigationUrl(url)).toBeNull();
  });
});
