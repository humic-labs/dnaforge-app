export function selectCompiledBroadThemeOwner<
  TOwner extends { provenance: { themeMode?: 'light' | 'dark' } },
>(input: {
  requestedThemeMode: 'light' | 'dark';
  rosterHasExplicitThemeAuthority: boolean;
  currentOwner: TOwner | null;
  registeredCandidateOwner: TOwner | null;
}): {
  currentOwner: TOwner | null;
  candidateOwner: TOwner | null;
  owner: TOwner | null;
} {
  const candidateOwner =
    input.registeredCandidateOwner &&
    (!input.rosterHasExplicitThemeAuthority ||
      input.registeredCandidateOwner.provenance.themeMode === input.requestedThemeMode)
      ? input.registeredCandidateOwner
      : null;
  const currentThemeOwner =
    input.currentOwner &&
    (!input.rosterHasExplicitThemeAuthority ||
      input.currentOwner.provenance.themeMode === input.requestedThemeMode)
      ? input.currentOwner
      : null;
  return {
    currentOwner: input.currentOwner,
    candidateOwner,
    owner: candidateOwner ?? currentThemeOwner,
  };
}
