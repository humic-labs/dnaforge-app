export type OligoOrderType = 'dna' | 'rna';

export function oligoOrderTypeLabel(orderType: OligoOrderType): string {
  return orderType === 'rna' ? 'RNA Oligo' : 'DNA Oligo';
}

export function oligoOrderTypeFromOriginDetails(originDetails: unknown): OligoOrderType {
  let value = originDetails;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return 'dna';
    }
  }
  if (typeof value !== 'object' || value === null) return 'dna';
  return 'oligoOrderType' in value && value.oligoOrderType === 'rna' ? 'rna' : 'dna';
}
