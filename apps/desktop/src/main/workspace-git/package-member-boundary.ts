import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

function isContained(root: string, candidate: string): boolean {
  const member = relative(root, candidate);
  return (
    member === '' ||
    (!isAbsolute(member) &&
      member !== '..' &&
      !member.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  );
}

export async function assertPhysicalPackageMember(
  packageRoot: string,
  candidatePath: string
): Promise<string> {
  return assertPhysicalDescendant(packageRoot, candidatePath, true);
}

export async function assertPhysicalWriteDestination(
  root: string,
  candidatePath: string
): Promise<string> {
  return assertPhysicalDescendant(root, candidatePath, false);
}

async function assertPhysicalDescendant(
  packageRoot: string,
  candidatePath: string,
  followLeaf: boolean
): Promise<string> {
  if (!isAbsolute(packageRoot) || !isAbsolute(candidatePath)) {
    throw new Error('PACKAGE_MEMBER_PATH: package roots and members must be absolute.');
  }

  const lexicalRoot = resolve(packageRoot);
  const lexicalCandidate = resolve(candidatePath);
  if (!isContained(lexicalRoot, lexicalCandidate) || lexicalCandidate === lexicalRoot) {
    throw new Error(`PACKAGE_MEMBER_OUTSIDE: "${candidatePath}" is outside the package root.`);
  }
  const lexicalMember = relative(lexicalRoot, lexicalCandidate);
  const physicalRoot = await realpath(lexicalRoot);

  let physicalCandidate: string;
  let existingAncestor = followLeaf ? lexicalCandidate : dirname(lexicalCandidate);
  for (;;) {
    try {
      const physicalAncestor = await realpath(existingAncestor);
      physicalCandidate = resolve(physicalAncestor, relative(existingAncestor, lexicalCandidate));
      break;
    } catch (ancestorError) {
      if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT') throw ancestorError;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw ancestorError;
      existingAncestor = parent;
    }
  }

  if (!isContained(physicalRoot, physicalCandidate)) {
    throw new Error(
      `PACKAGE_MEMBER_OUTSIDE: "${candidatePath}" resolves outside package "${packageRoot}".`
    );
  }
  const physicalMember = relative(physicalRoot, physicalCandidate);
  if (physicalMember !== lexicalMember) {
    throw new Error(
      `PACKAGE_MEMBER_SYMLINK: "${candidatePath}" traverses a symbolic link inside the package.`
    );
  }
  return lexicalMember.replace(/\\/g, '/');
}
