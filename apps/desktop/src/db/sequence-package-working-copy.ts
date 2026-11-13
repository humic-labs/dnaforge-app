import {
  buildSequencePackageDocument,
  fromPackageRelative,
  sequenceManagedMemberPath,
  type SequencePackageDocument,
  type SequencePackageMember,
} from './sequence-package';

export const ASSEMBLY_WORKING_COPY_ROLE = 'assembly-working-copy' as const;
export const ASSEMBLY_WORKING_COPY_FILE = 'assembly-working-copy.wpdesign.json' as const;
export const ASSEMBLY_WORKING_COPY_RELATIVE_PATH = sequenceManagedMemberPath(
  ASSEMBLY_WORKING_COPY_FILE
);

export function sequenceAssemblyWorkingCopyMember(
  document: SequencePackageDocument
): SequencePackageMember | null {
  const members = document.members.filter((member) => member.role === ASSEMBLY_WORKING_COPY_ROLE);
  if (members.length > 1) {
    throw new Error(`Sequence package ${document.id} has competing assembly working copies.`);
  }
  const member = members[0];
  if (!member) return null;
  if (member.replaceable) {
    throw new Error(`Assembly working copy in sequence package ${document.id} is replaceable.`);
  }
  return member;
}

export function sequenceAssemblyWorkingCopyPath(
  packageRoot: string,
  member: SequencePackageMember
): string {
  if (member.role !== ASSEMBLY_WORKING_COPY_ROLE) {
    throw new Error('Not an assembly working-copy member.');
  }
  return fromPackageRelative(member.path, packageRoot);
}

export function withSequenceAssemblyWorkingCopy(
  document: SequencePackageDocument,
  draftId: string,
  createdAt: string
): SequencePackageDocument {
  if (sequenceAssemblyWorkingCopyMember(document)) {
    throw new Error(`Sequence package ${document.id} already has an assembly working copy.`);
  }
  return buildSequencePackageDocument({
    id: document.id,
    name: document.name,
    product: document.product,
    assembly: document.assembly,
    members: [
      ...document.members,
      {
        id: draftId,
        role: ASSEMBLY_WORKING_COPY_ROLE,
        path: ASSEMBLY_WORKING_COPY_RELATIVE_PATH,
        replaceable: false,
        createdAt,
      },
    ],
    existing: document,
    updatedAt: createdAt,
  });
}

export function withoutSequenceAssemblyWorkingCopy(
  document: SequencePackageDocument,
  draftId: string
): SequencePackageDocument {
  const member = sequenceAssemblyWorkingCopyMember(document);
  if (!member || member.id !== draftId) {
    throw new Error(`Sequence package ${document.id} does not own assembly draft ${draftId}.`);
  }
  return buildSequencePackageDocument({
    id: document.id,
    name: document.name,
    product: document.product,
    assembly: document.assembly,
    members: document.members.filter((entry) => entry !== member),
    existing: document,
  });
}
