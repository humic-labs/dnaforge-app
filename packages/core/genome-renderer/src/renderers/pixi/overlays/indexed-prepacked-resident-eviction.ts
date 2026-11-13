export function pickDisposableCachedResident<
  TResident extends { ownerKey: string; lastUsed: number },
>(residents: readonly TResident[], protectedOwnerKeys: ReadonlySet<string>): TResident | undefined {
  return [...residents]
    .filter((entry) => !protectedOwnerKeys.has(entry.ownerKey))
    .sort(
      (left, right) => left.lastUsed - right.lastUsed || left.ownerKey.localeCompare(right.ownerKey)
    )[0];
}

export function selectProtectedInteractionResident<
  TResident extends { ownerKey: string; lastUsed: number },
>(input: {
  candidates: readonly TResident[];
  compiledCandidateOwnerKey?: string;
  compiledOwnerKey?: string;
}): TResident | undefined {
  return (
    input.candidates.find((entry) => entry.ownerKey === input.compiledCandidateOwnerKey) ??
    input.candidates.find((entry) => entry.ownerKey === input.compiledOwnerKey) ??
    [...input.candidates].sort(
      (left, right) => right.lastUsed - left.lastUsed || left.ownerKey.localeCompare(right.ownerKey)
    )[0]
  );
}
