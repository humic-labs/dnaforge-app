export type AssemblyPrimerRecipeEntry = {
  id?: unknown;
  name?: unknown;
  sequence?: unknown;
};

export type AssemblyPrimerPinSelection = {
  resourceId: string;
  name: string;
  bases: string;
};

export type DeclaredAssemblyOligo = {
  primerId: string;
  oligoId: string;
};

export function declaredAssemblyOligos(value: unknown): DeclaredAssemblyOligo[] {
  if (!Array.isArray(value)) return [];
  const declared: DeclaredAssemblyOligo[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.primerId === 'string' && typeof record.oligoId === 'string')
      declared.push({ primerId: record.primerId, oligoId: record.oligoId });
  }
  return declared;
}

export function assertAssemblyPrimerPins(input: {
  designed: readonly AssemblyPrimerRecipeEntry[];
  selections: readonly AssemblyPrimerPinSelection[];
  declared: readonly DeclaredAssemblyOligo[];
}): void {
  const declaredOligoIds = new Map(input.declared.map((oligo) => [oligo.primerId, oligo.oligoId]));
  const pinnedByDeclaration = new Set<number>();
  const writtenForAssembly: AssemblyPrimerRecipeEntry[] = [];
  for (const primer of input.designed) {
    const oligoId = typeof primer.id === 'string' ? declaredOligoIds.get(primer.id) : undefined;
    if (!oligoId) {
      writtenForAssembly.push(primer);
      continue;
    }
    const index = input.selections.findIndex((selection) => selection.resourceId === oligoId);
    if (index < 0)
      throw new Error('The assembly does not pin the saved oligo its native recipe declares.');
    if (input.selections[index]!.bases !== String(primer.sequence).trim().toUpperCase())
      throw new Error('A pinned saved oligo does not have the bases its native recipe declares.');
    pinnedByDeclaration.add(index);
  }
  const expected = new Set(
    writtenForAssembly.map(
      (primer) => `${String(primer.name)}:${String(primer.sequence).trim().toUpperCase()}`
    )
  );
  const actual = new Set(
    input.selections
      .filter((_, index) => !pinnedByDeclaration.has(index))
      .map((selection) => `${selection.name}:${selection.bases}`)
  );
  if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key)))
    throw new Error('The exact assembly primer pins do not match its native recipe.');
}
