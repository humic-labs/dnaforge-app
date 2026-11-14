import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const SCOPED_GENERATION =
  /^owned-[a-f0-9]{24}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function ownerPrefix(publicationAssemblyRoot: string): string {
  return `owned-${createHash('sha256').update(resolve(publicationAssemblyRoot)).digest('hex').slice(0, 24)}-`;
}

export function createReferenceGenerationId(publicationAssemblyRoot: string): string {
  return `${ownerPrefix(publicationAssemblyRoot)}${randomUUID()}`;
}

export function isScopedReferenceGenerationId(generationId: string): boolean {
  return SCOPED_GENERATION.test(generationId);
}

export function isOwnedReferenceGenerationId(
  generationId: string,
  publicationAssemblyRoot: string
): boolean {
  return (
    isScopedReferenceGenerationId(generationId) &&
    generationId.startsWith(ownerPrefix(publicationAssemblyRoot))
  );
}
