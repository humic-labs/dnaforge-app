import { computeChecksum } from '@waypoint/sequence-utils';
import type { SequencePackageDocument } from '../../db/sequence-package';

export type AcceptedProductIntegrityStatus = 'verified' | 'drifted' | 'unavailable';

export type AcceptedProductIntegrity = {
  status: AcceptedProductIntegrityStatus;
  expectedGenBankChecksum: string | null;
  actualGenBankChecksum: string | null;
};

export class ReplaceProductConfirmationRequired extends Error {
  override readonly name = 'ReplaceProductConfirmationRequired';
  readonly constructId: string;
  readonly expectedGenBankChecksum: string | null;
  readonly actualGenBankChecksum: string | null;

  constructor(input: {
    constructId: string;
    expectedGenBankChecksum: string | null;
    actualGenBankChecksum: string | null;
  }) {
    super(
      'This plasmid file was edited after the last accepted construction. ' +
        'Finalizing will replace that DNA with the new assembly product. ' +
        'Retry with replaceProduct=true after confirming.'
    );
    this.constructId = input.constructId;
    this.expectedGenBankChecksum = input.expectedGenBankChecksum;
    this.actualGenBankChecksum = input.actualGenBankChecksum;
  }
}

export function expectedAcceptedProductGenBankChecksum(
  document: SequencePackageDocument
): string | null {
  const accepted = document.assembly?.accepted;
  if (accepted && typeof accepted === 'object') {
    const artifacts = (accepted as { artifacts?: { productGenBankChecksum?: unknown } }).artifacts;
    if (typeof artifacts?.productGenBankChecksum === 'string') {
      return artifacts.productGenBankChecksum;
    }
  }
  return document.product.genBankChecksum ?? null;
}

export async function inspectAcceptedProductIntegrity(input: {
  productPath: string;
  expectedGenBankChecksum?: string | null;
  exists: (path: string) => Promise<boolean>;
  readTextFile: (path: string) => Promise<string>;
}): Promise<AcceptedProductIntegrity> {
  const expectedGenBankChecksum = input.expectedGenBankChecksum ?? null;
  if (!expectedGenBankChecksum || !(await input.exists(input.productPath))) {
    return {
      status: 'unavailable',
      expectedGenBankChecksum,
      actualGenBankChecksum: null,
    };
  }
  const actualGenBankChecksum = await computeChecksum(await input.readTextFile(input.productPath));
  return {
    status: actualGenBankChecksum === expectedGenBankChecksum ? 'verified' : 'drifted',
    expectedGenBankChecksum,
    actualGenBankChecksum,
  };
}

export function assertReplaceProductAllowed(input: {
  constructId: string;
  integrity: AcceptedProductIntegrity;
  replaceProduct?: boolean;
}): void {
  if (input.integrity.status === 'drifted' && !input.replaceProduct) {
    throw new ReplaceProductConfirmationRequired({
      constructId: input.constructId,
      expectedGenBankChecksum: input.integrity.expectedGenBankChecksum,
      actualGenBankChecksum: input.integrity.actualGenBankChecksum,
    });
  }
}
