import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';

export interface SequencePackageFixtureDocumentInput {
  id: string;
  name: string;
  productFile: string;
  updatedAt?: string;
}

export function sequencePackageFixtureDocument({
  id,
  name,
  productFile,
  updatedAt = '2026-08-18T00:00:00.000Z',
}: SequencePackageFixtureDocumentInput): string {
  return serializeSequencePackageDocument(
    buildSequencePackageDocument({
      id,
      name,
      updatedAt,
      product: {
        file: productFile,
        topology: 'circular',
      },
      members: [],
    })
  );
}
