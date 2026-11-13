import { describe, expect, it } from 'vitest';

import {
  PendingOpenSharedProjectUrl,
  isOpenSharedProjectUrl,
  parseOpenSharedProjectUrl,
} from './workspace-sync-open-shared-project-url';

const ID = '8a4d99e9-2347-4d04-a447-d3070f7a7f9a';

describe('open-shared-project deep link', () => {
  it('accepts the documented shape on every app scheme', () => {
    for (const scheme of ['dnaforge', 'dnaforge-beta', 'dnaforge-dev']) {
      expect(
        parseOpenSharedProjectUrl(`${scheme}://open-shared-project?workspaceId=${ID}`)
      ).toEqual({ remoteWorkspaceId: ID });
    }
    expect(
      parseOpenSharedProjectUrl(`dnaforge://OPEN-SHARED-PROJECT?workspaceId=${ID.toUpperCase()}`)
    ).toEqual({ remoteWorkspaceId: ID });
  });

  it('rejects other hosts, schemes, and malformed ids', () => {
    expect(isOpenSharedProjectUrl(`https://open-shared-project?workspaceId=${ID}`)).toBe(false);
    expect(isOpenSharedProjectUrl(`dnaforge://import-share?workspaceId=${ID}`)).toBe(false);
    expect(isOpenSharedProjectUrl('dnaforge://open-shared-project?workspaceId=not-a-uuid')).toBe(
      false
    );
    expect(isOpenSharedProjectUrl('dnaforge://open-shared-project')).toBe(false);
    expect(isOpenSharedProjectUrl('not a url')).toBe(false);
  });

  it('keeps only the latest pending request', () => {
    const pending = new PendingOpenSharedProjectUrl();
    expect(pending.replace('dnaforge://open-shared-project?workspaceId=nope')).toBe(false);
    expect(pending.replace(`dnaforge://open-shared-project?workspaceId=${ID}`)).toBe(true);
    expect(pending.peek()).toContain(ID);
    expect(pending.take()).toContain(ID);
    expect(pending.take()).toBeNull();
  });
});
