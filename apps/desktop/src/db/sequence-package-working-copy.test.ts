import { describe, expect, it } from 'vitest';
import { buildSequencePackageDocument } from './sequence-package';
import {
  ASSEMBLY_WORKING_COPY_RELATIVE_PATH,
  sequenceAssemblyWorkingCopyMember,
  sequenceAssemblyWorkingCopyPath,
  withSequenceAssemblyWorkingCopy,
  withoutSequenceAssemblyWorkingCopy,
} from './sequence-package-working-copy';

function packageDocument() {
  return buildSequencePackageDocument({
    id: 'sequence-1',
    name: 'Sequence 1',
    product: { file: 'sequence.gb' },
    members: [
      {
        id: 'read-1',
        role: 'sequencing-read',
        path: 'contents/read-1.ab1',
        replaceable: false,
        createdAt: '2026-09-29T00:00:00.000Z',
      },
    ],
  });
}

describe('package-owned assembly working copy', () => {
  it('registers one non-replaceable member under contents without changing other members', () => {
    const original = packageDocument();
    const next = withSequenceAssemblyWorkingCopy(original, 'draft-1', '2026-09-29T00:00:00.000Z');
    const member = sequenceAssemblyWorkingCopyMember(next);

    expect(member).toMatchObject({
      id: 'draft-1',
      role: 'assembly-working-copy',
      path: ASSEMBLY_WORKING_COPY_RELATIVE_PATH,
      replaceable: false,
    });
    expect(sequenceAssemblyWorkingCopyPath('/workspace/sequence-1', member!)).toBe(
      '/workspace/sequence-1/contents/assembly-working-copy.wpdesign.json'
    );
    expect(next.members).toContainEqual(original.members[0]);
    expect(original.members).toHaveLength(1);
  });

  it('does not replace an unfinished copy or select between competing copies', () => {
    const first = withSequenceAssemblyWorkingCopy(
      packageDocument(),
      'draft-1',
      '2026-09-29T00:00:00.000Z'
    );
    expect(() =>
      withSequenceAssemblyWorkingCopy(first, 'draft-2', '2026-09-29T01:00:00.000Z')
    ).toThrow(/already has an assembly working copy/);
    expect(() =>
      sequenceAssemblyWorkingCopyMember({
        ...first,
        members: [...first.members, { ...first.members[1], id: 'draft-2' }],
      })
    ).toThrow(/competing assembly working copies/);
  });

  it('retires only the named copy after publication', () => {
    const original = packageDocument();
    const first = withSequenceAssemblyWorkingCopy(original, 'draft-1', '2026-09-29T00:00:00.000Z');
    expect(() => withoutSequenceAssemblyWorkingCopy(first, 'other')).toThrow(/does not own/);
    expect(withoutSequenceAssemblyWorkingCopy(first, 'draft-1').members).toEqual(original.members);
  });
});
