import { describe, expect, it } from 'vitest';
import { toUserMessage } from '@waypoint/user-messages';
import type { LimsRegistrySummary } from '../../shared/lims';
import { registryRecordEditAccess } from './registry-record-edit-access';

const summary = (path = '/projects/samples/pDEMO421'): LimsRegistrySummary =>
  ({
    id: 'package-1',
    name: 'pDEMO421',
    archived: false,
    representation: {
      kind: 'file_sequence',
      label: 'Sequence',
      canOpen: true,
      openTarget: {
        kind: 'managed_sequence',
        entityId: 'package-1',
        document: {
          kind: 'managed-sequence',
          packageId: 'package-1',
          packageRoot: path,
        },
      },
    },
  }) as LimsRegistrySummary;

describe('Registry record editing availability', () => {
  it('preserves the owned reference explanation through the product message boundary', () => {
    const access = registryRecordEditAccess(summary(), [
      { path: '/projects/samples', name: 'Dev Assets', pinned: true },
    ]);
    expect(access.canEdit).toBe(false);
    if (access.canEdit) throw new Error('Expected a read-only reference.');
    expect(toUserMessage(access.message, 'record.readOnly')).toBe(access.message);
    expect(access.message).toContain('Dev Assets');
    expect(access.message).toContain('reference folder');
  });
  it('keeps internal project diagnostics out of the reference explanation', () => {
    const access = registryRecordEditAccess(summary(), [
      { path: '/projects/samples', name: 'db.execute(secret)', pinned: true },
    ]);
    expect(access.canEdit).toBe(false);
    if (access.canEdit) throw new Error('Expected a read-only reference.');
    expect(toUserMessage(access.message, 'record.readOnly')).toContain('reference folder');
    expect(access.message).not.toContain('db.execute');
    expect(access.message).not.toContain('secret');
  });
  it('keeps a nested reference read-only under a writable parent', () => {
    const access = registryRecordEditAccess(summary(), [
      { path: '/projects', pinned: false },
      { path: '/projects/samples', name: 'Dev Assets', pinned: true },
    ]);
    expect(access).toMatchObject({ canEdit: false, reason: 'reference' });
    expect('message' in access && access.message).toContain('Dev Assets');
  });
  it('uses a writable nested project inside a reference root', () => {
    expect(
      registryRecordEditAccess(summary(), [
        { path: '/projects', pinned: true },
        { path: '/projects/samples', pinned: false },
      ])
    ).toEqual({ canEdit: true, workspaceRoot: '/projects/samples' });
  });
  it('requires a known owner for a package-backed record', () => {
    expect(registryRecordEditAccess(summary(), [])).toMatchObject({
      canEdit: false,
      reason: 'project_unavailable',
      message: expect.stringContaining('project is unavailable'),
    });
  });
  it('refuses conflicting entries for the same root', () => {
    expect(
      registryRecordEditAccess(summary(), [
        { path: '/projects/samples', pinned: true },
        { path: '/projects/samples/', pinned: false },
      ])
    ).toMatchObject({ canEdit: false, reason: 'ambiguous' });
  });
  it('uses Windows path boundaries without accepting a sibling prefix', () => {
    expect(
      registryRecordEditAccess(summary('C:\\Projects\\Samples\\pDEMO421'), [
        { path: 'c:/projects/samples', pinned: true },
      ])
    ).toMatchObject({ canEdit: false, reason: 'reference' });
    expect(
      registryRecordEditAccess(summary('/projects/samples-copy/pDEMO421'), [
        { path: '/projects/samples', pinned: false },
      ])
    ).toMatchObject({ canEdit: false, reason: 'project_unavailable' });
  });
  it('keeps record-only metadata editable without a sequence project', () => {
    expect(
      registryRecordEditAccess(
        {
          ...summary(),
          representation: {
            kind: 'none',
            label: 'Record',
            canOpen: false,
          },
        },
        []
      )
    ).toEqual({ canEdit: true });
  });
  it('keeps a shared managed record readable but refuses edits only while its current role is viewer', () => {
    expect(
      registryRecordEditAccess(summary(), [
        { path: '/projects/samples', sharedEditAccess: { kind: 'ready', role: 'viewer' } },
      ])
    ).toMatchObject({ canEdit: false, reason: 'viewer' });
    expect(
      registryRecordEditAccess(summary(), [
        { path: '/projects/samples', sharedEditAccess: { kind: 'ready', role: 'editor' } },
      ])
    ).toEqual({ canEdit: true, workspaceRoot: '/projects/samples' });
    expect(
      registryRecordEditAccess(summary(), [
        { path: '/projects/samples', sharedEditAccess: { kind: 'unavailable' } },
      ])
    ).toMatchObject({ canEdit: false, reason: 'project_unavailable' });
    expect(
      registryRecordEditAccess(summary(), [
        {
          path: '/projects/samples',
          pinned: true,
          sharedEditAccess: { kind: 'ready', role: 'editor' },
        },
      ])
    ).toMatchObject({ canEdit: false, reason: 'reference' });
  });
  it('requires archived records to be restored', () => {
    expect(
      registryRecordEditAccess({ ...summary(), archived: true }, [{ path: '/projects' }])
    ).toMatchObject({ canEdit: false, reason: 'archived' });
  });
});
