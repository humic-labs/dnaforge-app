import { describe, expect, it } from 'vitest';
import {
  PendingOpenOrganizationsUrl,
  isOpenOrganizationsUrl,
} from './workspace-sync-open-organizations-url';

describe('open-organizations deep link', () => {
  it('accepts dnaforge scheme variants', () => {
    expect(isOpenOrganizationsUrl('dnaforge://open-organizations')).toBe(true);
    expect(isOpenOrganizationsUrl('dnaforge-dev://open-organizations')).toBe(true);
    expect(isOpenOrganizationsUrl('dnaforge://OPEN-ORGANIZATIONS')).toBe(true);
  });

  it('rejects other hosts and schemes', () => {
    expect(isOpenOrganizationsUrl('https://open-organizations')).toBe(false);
    expect(isOpenOrganizationsUrl('dnaforge://open-shared-project')).toBe(false);
    expect(isOpenOrganizationsUrl('not-a-url')).toBe(false);
  });

  it('holds one pending URL', () => {
    const pending = new PendingOpenOrganizationsUrl();
    expect(pending.replace('dnaforge://open-shared-project')).toBe(false);
    expect(pending.replace('dnaforge://open-organizations')).toBe(true);
    expect(pending.take()).toBe('dnaforge://open-organizations');
    expect(pending.take()).toBeNull();
  });
});
