export function isAdmittedPrepackedPresentationCandidate(input: {
  admitted: boolean;
  trackType: string;
  themeMode: string;
  requestedTrackType: string;
  requestedThemeMode: string;
  coversRequestedLayer: boolean;
  emptyDetailPacket: boolean;
}): boolean {
  return (
    input.admitted &&
    input.trackType === input.requestedTrackType &&
    input.themeMode === input.requestedThemeMode &&
    (input.coversRequestedLayer || input.emptyDetailPacket)
  );
}

export function compiledExactPrepackedOwnerKey(input: {
  compiledTrackType: string | undefined;
  requestedTrackType: string;
  compiledThemeMode: string | undefined;
  requestedThemeMode: string;
  compiledOwnerKey: string | undefined;
}): string | undefined {
  return input.compiledTrackType === input.requestedTrackType &&
    input.compiledThemeMode === input.requestedThemeMode
    ? input.compiledOwnerKey
    : undefined;
}

export function resolvePrepackedPresentationResident<
  TResident extends { ownerKey: string },
>(input: {
  exactDetail: TResident | undefined;
  joinedDetail: TResident | undefined;
  staticResidents: readonly TResident[];
  exactOwnerKey: string | undefined;
  exactCompiledOwnerKey: string | undefined;
}): TResident | undefined {
  return (
    input.exactDetail ??
    input.joinedDetail ??
    input.staticResidents.find(({ ownerKey }) => ownerKey === input.exactOwnerKey) ??
    input.staticResidents.find(({ ownerKey }) => ownerKey === input.exactCompiledOwnerKey) ??
    input.staticResidents[0]
  );
}

export function resolveLastCompletePrepackedResidents<TResident>(input: {
  lastCompleteOwnerKeys: readonly string[];
  getResident: (ownerKey: string) => TResident | undefined;
}): TResident[] | null {
  const lastCompleteResidents = input.lastCompleteOwnerKeys.map((ownerKey) =>
    input.getResident(ownerKey)
  );
  if (
    lastCompleteResidents.length > 0 &&
    lastCompleteResidents.every((resident): resident is TResident => resident !== undefined)
  ) {
    return lastCompleteResidents;
  }
  return null;
}
