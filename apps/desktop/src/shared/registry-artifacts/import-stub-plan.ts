import type { LimsImportRecord, LimsImportUnresolvedLink, LimsRegisterEntityInput } from '../lims';

const DEFAULT_ENDPOINT_KIND = 'strain';

export interface UnresolvedEndpoint {
  name: string;
  kind: string;
}

function endpointKey(kind: string, name: string): string {
  return `${kind}\u0000${name.trim().toLowerCase()}`;
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function collectUnresolvedEndpoints(
  records: readonly LimsImportRecord[]
): UnresolvedEndpoint[] {
  const batchNames = new Set<string>();
  for (const record of records) {
    if (record.entity?.name) {
      batchNames.add(nameKey(record.entity.name));
    }
  }

  const seen = new Set<string>();
  const endpoints: UnresolvedEndpoint[] = [];
  for (const record of records) {
    const links: readonly LimsImportUnresolvedLink[] = record.unresolvedLinks ?? [];
    for (const link of links) {
      const name = link.label;
      if (!name || !name.trim()) {
        continue;
      }
      if (batchNames.has(nameKey(name))) {
        continue;
      }
      const kind = link.kind ?? DEFAULT_ENDPOINT_KIND;
      const key = endpointKey(kind, name);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      endpoints.push({ name, kind });
    }
  }
  return endpoints;
}

export function countCreatableStubs(endpoints: readonly UnresolvedEndpoint[]): number {
  return endpoints.length;
}

export function buildProvisionalStubRecords(
  endpoints: readonly UnresolvedEndpoint[]
): LimsImportRecord[] {
  return endpoints.map((endpoint): LimsImportRecord => {
    const entity: LimsRegisterEntityInput = {
      kind: endpoint.kind,
      name: endpoint.name,
      fields: { provisional: true },
    };
    return {
      id: `stub:${endpoint.kind}:${endpoint.name}`,
      action: 'register_entity',
      accepted: true,
      entity,
      links: [],
      unresolvedLinks: [],
      source: {},
      errors: [],
    };
  });
}

export function attachStubsToPlan(
  records: readonly LimsImportRecord[],
  stubs: readonly LimsImportRecord[]
): LimsImportRecord[] {
  const realKeys = new Set<string>();
  for (const record of records) {
    if (record.entity?.name) {
      realKeys.add(endpointKey(record.entity.kind, record.entity.name));
    }
  }

  const dedupedStubs = stubs.filter(
    (stub) => !realKeys.has(endpointKey(stub.entity.kind, stub.entity.name))
  );

  return [...dedupedStubs, ...records];
}
