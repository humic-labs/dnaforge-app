export interface CompiledAnnotationInteractionTrackReceipt {
  readonly trackType: string;
  readonly interactionReadiness: string;
  readonly interactionOwnerKey: string | null;
  readonly compactInteractionStatus?: string;
  readonly compactInteractionOwnerKey?: string | null;
  readonly ownerReadinessScopeKey: string;
}

export interface CompiledAnnotationInteractionRosterReceipt {
  readonly contract: string;
  readonly readinessScopeKey: string;
  readonly selectedTrackTypes: readonly string[];
  readonly selectedBroadSetInteractive: boolean;
  readonly tracks: readonly CompiledAnnotationInteractionTrackReceipt[];
}

export interface CompiledAnnotationInteractionAuthority {
  readonly contract: 'compiled-annotation-interaction-authority.v1';
  readonly readinessScopeKey: string;
  readonly selectedTrackTypes: readonly string[];
  readonly expectedOwnerKeys: readonly string[];
  readonly residentRosterGeneration: number;
  readonly authorityKey: string;
}

export interface CompiledAnnotationDetailTrackReceipt {
  readonly trackType: string;
  readonly ownerReadinessScopeKey: string;
  readonly readinessRendererMatchesCurrent: boolean;
  readonly targetIdentityKey: string | null;
  readonly readinessTargetIdentityKey: string | null;
  readonly interactionReadiness: string;
  readonly interactionOwnerKey: string | null;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function compiledAnnotationBroadSetIsInteractive(
  receipt: Pick<
    CompiledAnnotationInteractionRosterReceipt,
    'contract' | 'readinessScopeKey' | 'selectedTrackTypes' | 'tracks'
  >
): boolean {
  const selectedTrackTypes = sortedUnique(receipt.selectedTrackTypes);
  const receiptTrackTypes = sortedUnique(receipt.tracks.map((track) => track.trackType));
  return Boolean(
    receipt.contract === 'compiled-annotation-resident-readiness.v1' &&
    receipt.readinessScopeKey.length > 0 &&
    selectedTrackTypes.length > 0 &&
    receipt.tracks.length === selectedTrackTypes.length &&
    receiptTrackTypes.length === selectedTrackTypes.length &&
    receiptTrackTypes.every((trackType, index) => trackType === selectedTrackTypes[index]) &&
    receipt.tracks.every(
      (track) =>
        track.ownerReadinessScopeKey === receipt.readinessScopeKey &&
        track.compactInteractionStatus === 'loaded' &&
        typeof track.interactionOwnerKey === 'string' &&
        track.interactionOwnerKey.length > 0 &&
        track.compactInteractionOwnerKey === track.interactionOwnerKey
    )
  );
}

export function compiledAnnotationDetailSetIsPrepared(input: {
  readonly readinessScopeKey: string;
  readonly selectedTrackTypes: readonly string[];
  readonly tracks: readonly CompiledAnnotationDetailTrackReceipt[];
}): boolean {
  const selectedTrackTypes = sortedUnique(input.selectedTrackTypes);
  const receiptTrackTypes = sortedUnique(input.tracks.map((track) => track.trackType));
  return Boolean(
    input.readinessScopeKey.length > 0 &&
    selectedTrackTypes.length > 0 &&
    input.tracks.length === selectedTrackTypes.length &&
    receiptTrackTypes.length === selectedTrackTypes.length &&
    receiptTrackTypes.every((trackType, index) => trackType === selectedTrackTypes[index]) &&
    input.tracks.every(
      (track) =>
        track.ownerReadinessScopeKey === input.readinessScopeKey &&
        track.readinessRendererMatchesCurrent &&
        track.targetIdentityKey !== null &&
        track.readinessTargetIdentityKey === track.targetIdentityKey &&
        track.interactionReadiness === 'loaded-hit' &&
        track.interactionOwnerKey !== null
    )
  );
}

export function qualifyCompiledAnnotationInteractionAuthority(input: {
  readonly receipt: CompiledAnnotationInteractionRosterReceipt;
  readonly rendererCompactOwnerKeys: readonly string[];
  readonly rendererCompactRosterGeneration: number;
}): CompiledAnnotationInteractionAuthority | null {
  const { receipt } = input;
  const selectedTrackTypes = sortedUnique(receipt.selectedTrackTypes);
  const receiptTrackTypes = sortedUnique(receipt.tracks.map((track) => track.trackType));
  const ownerRoster = receipt.tracks
    .flatMap((track) =>
      typeof track.interactionOwnerKey === 'string' && track.interactionOwnerKey.length > 0
        ? [[track.trackType, track.interactionOwnerKey] as const]
        : []
    )
    .sort(([leftTrack], [rightTrack]) => leftTrack.localeCompare(rightTrack));
  const expectedOwnerKeys = sortedUnique(ownerRoster.map(([, ownerKey]) => ownerKey));
  const rendererCompactOwnerKeys = new Set(input.rendererCompactOwnerKeys);
  if (
    receipt.contract !== 'compiled-annotation-resident-readiness.v1' ||
    receipt.readinessScopeKey.length === 0 ||
    receipt.selectedBroadSetInteractive !== true ||
    !compiledAnnotationBroadSetIsInteractive(receipt) ||
    selectedTrackTypes.length === 0 ||
    receipt.tracks.length !== selectedTrackTypes.length ||
    receiptTrackTypes.length !== selectedTrackTypes.length ||
    receiptTrackTypes.some((trackType, index) => trackType !== selectedTrackTypes[index]) ||
    expectedOwnerKeys.length !== selectedTrackTypes.length ||
    !Number.isSafeInteger(input.rendererCompactRosterGeneration) ||
    input.rendererCompactRosterGeneration <= 0 ||
    receipt.tracks.some(
      (track) =>
        track.ownerReadinessScopeKey !== receipt.readinessScopeKey ||
        track.interactionOwnerKey === null ||
        track.compactInteractionStatus !== 'loaded' ||
        track.compactInteractionOwnerKey !== track.interactionOwnerKey ||
        !rendererCompactOwnerKeys.has(track.interactionOwnerKey)
    )
  ) {
    return null;
  }

  const authorityKey = JSON.stringify([
    'compiled-annotation-interaction-authority.v1',
    receipt.readinessScopeKey,
    input.rendererCompactRosterGeneration,
    ownerRoster,
  ]);
  return Object.freeze({
    contract: 'compiled-annotation-interaction-authority.v1' as const,
    readinessScopeKey: receipt.readinessScopeKey,
    selectedTrackTypes: Object.freeze(selectedTrackTypes),
    expectedOwnerKeys: Object.freeze(expectedOwnerKeys),
    residentRosterGeneration: input.rendererCompactRosterGeneration,
    authorityKey,
  });
}
