import { describe, expect, it } from 'vitest';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
  type SequencePackageMember,
} from './sequence-package';
import {
  prepareSequencePackageRevision,
  sequenceReferenceCheckpointId,
} from './sequence-package-versioning';

const DIGEST_ONE = `sha256:${'1'.repeat(64)}`;
const DIGEST_TWO = `sha256:${'2'.repeat(64)}`;
const PRODUCT_BYTES = 'Unchanged fixture product bytes';

const userMember: SequencePackageMember = {
  id: 'member-one',
  role: 'user',
  path: 'contents/user-note-one.txt',
  replaceable: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function newDocument() {
  return buildSequencePackageDocument({
    id: 'package-one',
    name: 'Package one',
    product: { file: 'package.gb', topology: 'linear' },
  });
}

describe('versioned user attachment contract', () => {
  it('captures full current associations in every new revision and retains removed member bytes', async () => {
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: newDocument(),
      nextProductContent: PRODUCT_BYTES,
      kind: 'sequence-save',
      operationId: 'initial',
      revisionId: 'initial',
    });
    const attached = buildSequencePackageDocument({
      id: first.document.id,
      name: first.document.name,
      product: first.document.product,
      members: [...first.document.members, userMember],
      userAttachments: { note: { memberId: userMember.id, sha256: DIGEST_ONE } },
      existing: first.document,
    });
    const second = await prepareSequencePackageRevision({
      current: first.document,
      currentProductContent: PRODUCT_BYTES,
      next: attached,
      nextProductContent: PRODUCT_BYTES,
      kind: 'member-update',
      operationId: 'attach-note',
      revisionId: 'attach-note',
    });
    const detached = buildSequencePackageDocument({
      id: second.document.id,
      name: second.document.name,
      product: second.document.product,
      userAttachments: {},
      existing: second.document,
    });
    const third = await prepareSequencePackageRevision({
      current: second.document,
      currentProductContent: PRODUCT_BYTES,
      next: detached,
      nextProductContent: PRODUCT_BYTES,
      kind: 'restore',
      operationId: 'detach-note',
      revisionId: 'detach-note',
      sources: { 'attachment:note': { revisionId: first.revision.id, valueSha256: DIGEST_TWO } },
    });

    expect(first.revision.state.userAttachments).toEqual({});
    expect(second.revision.state.userAttachments).toEqual({
      note: { memberId: userMember.id, sha256: DIGEST_ONE },
    });
    expect(third.revision.state.userAttachments).toEqual({});
    expect(third.document.members).toContainEqual(userMember);
    expect(sequenceReferenceCheckpointId(third.document)).toBe(first.revision.id);
    expect(
      parseSequencePackageDocument(serializeSequencePackageDocument(third.document)).userAttachments
    ).toEqual({});
  });

  it('migrates only current v7 user members as unattested, not old revision states', async () => {
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: newDocument(),
      nextProductContent: PRODUCT_BYTES,
      kind: 'sequence-save',
      operationId: 'v7-head',
      revisionId: 'v7-head',
    });
    const oldRecord = structuredClone(first.document) as unknown as Record<string, unknown>;
    oldRecord.formatVersion = 7;
    delete oldRecord.userAttachments;
    (oldRecord.members as SequencePackageMember[]).push(userMember);
    const history = oldRecord.versionHistory as {
      revisions: Array<{ state: Record<string, unknown> }>;
    };
    for (const revision of history.revisions) delete revision.state.userAttachments;

    const migrated = parseSequencePackageDocument(JSON.stringify(oldRecord));
    expect(migrated.userAttachments).toEqual({
      [userMember.id]: { memberId: userMember.id, sha256: null },
    });
    expect(migrated.versionHistory.revisions[0].state.userAttachments).toBeUndefined();
    expect(migrated.members).toContainEqual(userMember);
    expect(
      parseSequencePackageDocument(serializeSequencePackageDocument(migrated)).userAttachments
    ).toEqual(migrated.userAttachments);
  });

  it('rejects dropped historical members, mutable attested bytes, and digest changes', async () => {
    const member = { ...userMember };
    const initial = buildSequencePackageDocument({
      id: 'package-one',
      name: 'Package one',
      product: { file: 'package.gb' },
      members: [member],
      userAttachments: { note: { memberId: member.id, sha256: DIGEST_ONE } },
    });
    const first = await prepareSequencePackageRevision({
      current: null,
      currentProductContent: null,
      next: initial,
      nextProductContent: PRODUCT_BYTES,
      kind: 'member-update',
      operationId: 'initial-member',
      revisionId: 'initial-member',
    });
    const withoutMember = {
      ...first.document,
      members: first.document.members.filter((entry) => entry.id !== member.id),
    };
    expect(() => serializeSequencePackageDocument(withoutMember)).toThrow(/user member/);
    const mutableMember = {
      ...first.document,
      members: first.document.members.map((entry) =>
        entry.id === member.id ? { ...entry, replaceable: true } : entry
      ),
    };
    expect(() => serializeSequencePackageDocument(mutableMember)).toThrow(/immutable owned member/);
    const changedDigest = {
      ...first.document,
      userAttachments: { note: { memberId: member.id, sha256: DIGEST_TWO } },
    };
    expect(() => serializeSequencePackageDocument(changedDigest)).toThrow(
      /conflicting historical digests|published package head/
    );
  });
});
