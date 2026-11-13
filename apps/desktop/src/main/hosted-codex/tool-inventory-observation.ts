export interface HostedToolInventoryCounts {
  readonly projectionSequence: number;
  readonly authorizationCatalogDefinitionCount: number;
  readonly registeredChildDefinitionCount: number;
  readonly childOfferedDefinitionCount: number;
  readonly gatewayBaseDefinitionCount: number;
  readonly gatewayForwardedDefinitionCount: number;
  readonly retainedDefinitionCount: number;
  readonly maxRetainedDefinitionCount: number;
  readonly acceptedDiscoveryPageCount: number;
  readonly lastAcceptedDiscoveryPageDefinitionCount: number;
  readonly maxAcceptedDiscoveryPageDefinitionCount: number;
}

export type HostedToolInventoryObservation =
  | (HostedToolInventoryCounts & { readonly status: 'observed'; readonly requestSequence: number })
  | { readonly status: 'incomplete' | 'invalid' };

export type HostedToolInventorySummaryCounts = Pick<
  HostedToolInventoryCounts,
  | 'authorizationCatalogDefinitionCount'
  | 'registeredChildDefinitionCount'
  | 'retainedDefinitionCount'
  | 'maxRetainedDefinitionCount'
  | 'acceptedDiscoveryPageCount'
  | 'lastAcceptedDiscoveryPageDefinitionCount'
  | 'maxAcceptedDiscoveryPageDefinitionCount'
> & {
  readonly projectionCount: number;
};
export type HostedToolInventorySummaryObservation =
  | (HostedToolInventorySummaryCounts & { readonly status: 'observed' })
  | { readonly status: 'incomplete' | 'invalid' };

const COUNT_FIELDS = [
  'projectionSequence',
  'authorizationCatalogDefinitionCount',
  'registeredChildDefinitionCount',
  'childOfferedDefinitionCount',
  'gatewayBaseDefinitionCount',
  'gatewayForwardedDefinitionCount',
  'retainedDefinitionCount',
  'maxRetainedDefinitionCount',
  'acceptedDiscoveryPageCount',
  'lastAcceptedDiscoveryPageDefinitionCount',
  'maxAcceptedDiscoveryPageDefinitionCount',
] as const;

function hasCountFields<Field extends string>(
  record: Record<string, unknown>,
  fields: readonly Field[]
): record is Record<string, unknown> & Record<Field, number> {
  return fields.every((field) => {
    const value = record[field];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  });
}

export function copyHostedToolInventoryObservation(value: unknown): HostedToolInventoryObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'invalid' };
  const record = value as Record<string, unknown>;
  if (record.status === 'incomplete') return { status: 'incomplete' };
  if (record.status !== 'observed' || !hasCountFields(record, [...COUNT_FIELDS, 'requestSequence']))
    return { status: 'invalid' };
  const counts = record;
  return {
    status: 'observed',
    requestSequence: counts.requestSequence,
    projectionSequence: counts.projectionSequence,
    authorizationCatalogDefinitionCount: counts.authorizationCatalogDefinitionCount,
    registeredChildDefinitionCount: counts.registeredChildDefinitionCount,
    childOfferedDefinitionCount: counts.childOfferedDefinitionCount,
    gatewayBaseDefinitionCount: counts.gatewayBaseDefinitionCount,
    gatewayForwardedDefinitionCount: counts.gatewayForwardedDefinitionCount,
    retainedDefinitionCount: counts.retainedDefinitionCount,
    maxRetainedDefinitionCount: counts.maxRetainedDefinitionCount,
    acceptedDiscoveryPageCount: counts.acceptedDiscoveryPageCount,
    lastAcceptedDiscoveryPageDefinitionCount: counts.lastAcceptedDiscoveryPageDefinitionCount,
    maxAcceptedDiscoveryPageDefinitionCount: counts.maxAcceptedDiscoveryPageDefinitionCount,
  };
}

export function observeHostedToolInventory(
  requestSequence: number,
  counts: HostedToolInventoryCounts
): HostedToolInventoryObservation {
  return copyHostedToolInventoryObservation({ ...counts, status: 'observed', requestSequence });
}

export function copyHostedToolInventorySummary(
  value: unknown
): HostedToolInventorySummaryObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'invalid' };
  const record = value as Record<string, unknown>;
  if (record.status === 'incomplete') return { status: 'incomplete' };
  const fields = [
    'projectionCount',
    'authorizationCatalogDefinitionCount',
    'registeredChildDefinitionCount',
    'retainedDefinitionCount',
    'maxRetainedDefinitionCount',
    'acceptedDiscoveryPageCount',
    'lastAcceptedDiscoveryPageDefinitionCount',
    'maxAcceptedDiscoveryPageDefinitionCount',
  ] as const;
  if (record.status !== 'observed' || !hasCountFields(record, fields)) return { status: 'invalid' };
  const counts = record;
  return {
    status: 'observed',
    projectionCount: counts.projectionCount,
    authorizationCatalogDefinitionCount: counts.authorizationCatalogDefinitionCount,
    registeredChildDefinitionCount: counts.registeredChildDefinitionCount,
    retainedDefinitionCount: counts.retainedDefinitionCount,
    maxRetainedDefinitionCount: counts.maxRetainedDefinitionCount,
    acceptedDiscoveryPageCount: counts.acceptedDiscoveryPageCount,
    lastAcceptedDiscoveryPageDefinitionCount: counts.lastAcceptedDiscoveryPageDefinitionCount,
    maxAcceptedDiscoveryPageDefinitionCount: counts.maxAcceptedDiscoveryPageDefinitionCount,
  };
}

export function readHostedToolInventorySummary(
  read: () => HostedToolInventorySummaryCounts | undefined
): HostedToolInventorySummaryObservation {
  try {
    const counts = read();
    return counts === undefined
      ? { status: 'incomplete' }
      : copyHostedToolInventorySummary({ ...counts, status: 'observed' });
  } catch {
    return { status: 'invalid' };
  }
}
