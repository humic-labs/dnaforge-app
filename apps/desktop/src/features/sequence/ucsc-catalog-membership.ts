interface CatalogAddress {
  readonly kind: string;
  readonly sourceKind?: string;
  readonly genome?: string;
  readonly track?: string;
  readonly hubUrl?: string;
}

interface CatalogMembershipSource {
  readonly provenance?: { readonly catalogId?: string };
  readonly request?: { readonly source?: CatalogAddress };
}

export interface CatalogMembershipLane {
  readonly source?: CatalogMembershipSource;
  readonly dataset: {
    readonly trackId: string;
    readonly remoteSignal?: { readonly durableSource?: CatalogMembershipSource };
  };
}

export function catalogIdFromAdmittedSource(
  source: CatalogMembershipSource | undefined
): string | null {
  const recorded = source?.provenance?.catalogId?.trim();
  if (recorded) return recorded;
  const address = source?.request?.source;
  if (address?.kind !== 'ucsc-track' || !address.sourceKind || !address.genome || !address.track) {
    return null;
  }
  return [address.sourceKind, address.genome, address.track, address.hubUrl ?? ''].join('\u0000');
}

export function catalogIdsInView(lanes: readonly CatalogMembershipLane[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const lane of lanes) {
    const id =
      catalogIdFromAdmittedSource(lane.source) ??
      catalogIdFromAdmittedSource(lane.dataset.remoteSignal?.durableSource);
    if (id) ids.add(id);
  }
  return ids;
}
