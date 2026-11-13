import { describe, expect, it } from 'vitest';

import { buildSequencePackageDocument } from './sequence-package';
import {
  prepareSequenceUserAttachmentMutation,
  verifyPreparedUserAttachmentAsset,
} from './sequence-package-user-attachment-mutation';

const MEMBER_ONE = '11111111-1111-4111-8111-111111111111';
const MEMBER_TWO = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = '2026-01-01T00:00:00.000Z';

function document() {
  return buildSequencePackageDocument({
    id: 'package-one',
    name: 'Package one',
    product: { file: 'package.gb' },
    members: [
      {
        id: 'retained-evidence',
        role: 'evidence-result',
        path: 'contents/evidence/retained.json',
        replaceable: false,
        createdAt: CREATED_AT,
      },
    ],
  });
}

describe('package-owned user attachment mutation preparation', () => {
  it('attaches exact binary bytes under contents/ without changing the input document', async () => {
    const before = document();
    const content = new Uint8Array([0, 255, 1, 128]);
    const prepared = await prepareSequenceUserAttachmentMutation(before, {
      kind: 'attach',
      attachmentId: 'note',
      memberId: MEMBER_ONE,
      fileName: 'trace.bin',
      content,
      mediaType: 'application/octet-stream',
      createdAt: CREATED_AT,
    });

    expect(before.userAttachments).toEqual({});
    expect(before.members).toHaveLength(1);
    expect(prepared.nextDocument.userAttachments.note).toEqual({
      memberId: MEMBER_ONE,
      sha256: prepared.asset?.sha256,
    });
    expect(prepared.asset?.path).toBe(`contents/user-attachment-${MEMBER_ONE}-trace.bin`);
    expect(prepared.asset?.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(prepared.nextDocument.members).toContainEqual(
      expect.objectContaining({
        id: MEMBER_ONE,
        role: 'user',
        path: prepared.asset?.path,
        replaceable: false,
      })
    );
    expect(prepared.nextDocument.members[0]).toEqual(before.members[0]);
    content[1] = 0;
    expect(prepared.asset?.content).toEqual(new Uint8Array([0, 255, 1, 128]));
    await verifyPreparedUserAttachmentAsset(prepared.asset!);
  });

  it('replaces one logical slot, then detaches it, retaining both physical members', async () => {
    const first = await prepareSequenceUserAttachmentMutation(document(), {
      kind: 'attach',
      attachmentId: 'note',
      memberId: MEMBER_ONE,
      fileName: 'note.bin',
      content: new Uint8Array([1]),
      createdAt: CREATED_AT,
    });
    const second = await prepareSequenceUserAttachmentMutation(first.nextDocument, {
      kind: 'replace',
      attachmentId: 'note',
      memberId: MEMBER_TWO,
      fileName: 'note.bin',
      content: new Uint8Array([2]),
      createdAt: CREATED_AT,
    });
    expect(second.nextDocument.userAttachments.note.memberId).toBe(MEMBER_TWO);
    expect(second.nextDocument.members.map((member) => member.id)).toEqual([
      'retained-evidence',
      MEMBER_ONE,
      MEMBER_TWO,
    ]);

    const third = await prepareSequenceUserAttachmentMutation(second.nextDocument, {
      kind: 'detach',
      attachmentId: 'note',
      createdAt: CREATED_AT,
    });
    expect(third.asset).toBeNull();
    expect(third.nextDocument.userAttachments).toEqual({});
    expect(third.nextDocument.members).toEqual(second.nextDocument.members);
  });

  it('rejects ambiguous or unsafe operations before returning a member path', async () => {
    const first = await prepareSequenceUserAttachmentMutation(document(), {
      kind: 'attach',
      attachmentId: 'note',
      memberId: MEMBER_ONE,
      fileName: 'note.bin',
      content: new Uint8Array([1]),
      createdAt: CREATED_AT,
    });
    await expect(
      prepareSequenceUserAttachmentMutation(first.nextDocument, {
        kind: 'attach',
        attachmentId: 'note',
        memberId: MEMBER_TWO,
        fileName: 'another.bin',
        content: new Uint8Array([2]),
        createdAt: CREATED_AT,
      })
    ).rejects.toThrow(/already exists/);
    await expect(
      prepareSequenceUserAttachmentMutation(first.nextDocument, {
        kind: 'replace',
        attachmentId: 'note',
        memberId: MEMBER_ONE,
        fileName: 'note.bin',
        content: new Uint8Array([2]),
        createdAt: CREATED_AT,
      })
    ).rejects.toThrow(/already exists/);
    await expect(
      prepareSequenceUserAttachmentMutation(document(), {
        kind: 'attach',
        attachmentId: 'note',
        memberId: MEMBER_ONE,
        fileName: '../escape.bin',
        content: new Uint8Array([1]),
        createdAt: CREATED_AT,
      })
    ).rejects.toThrow(/unsafe/);
    await expect(
      prepareSequenceUserAttachmentMutation(document(), {
        kind: 'detach',
        attachmentId: 'missing',
        createdAt: CREATED_AT,
      })
    ).rejects.toThrow(/no longer exists/);
  });
});
