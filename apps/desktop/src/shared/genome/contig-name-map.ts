export interface AssemblyContigNaming {
  readonly name: string;
  readonly length: number;
  readonly aliases?: ReadonlyArray<string>;
}

export interface SourceContigNaming {
  readonly name: string;
  readonly length?: number;
}

export interface ContigNameMatch {
  readonly assemblyName: string;
  readonly sourceName: string;
  readonly how: 'exact' | 'declared-alias' | 'chr-prefix';
  readonly lengthConflict?: { readonly assembly: number; readonly source: number };
}

export interface ContigNameMap {
  readonly matches: ReadonlyArray<ContigNameMatch>;
  readonly unmatchedAssembly: ReadonlyArray<string>;
  readonly unmatchedSource: ReadonlyArray<string>;
  readonly ambiguousSource: ReadonlyArray<string>;
  sourceNameFor(assemblyName: string): string | undefined;
  assemblyNameFor(sourceName: string): string | undefined;
  matchForSource(sourceName: string): ContigNameMatch | undefined;
  matchForAssembly(assemblyName: string): ContigNameMatch | undefined;
}

function chrPrefixForm(name: string): string {
  const trimmed = name.trim().toLowerCase().replace(/^chr/u, '');
  return trimmed === 'm' || trimmed === 'mt' ? 'mt' : trimmed;
}

function declaredNames(contig: AssemblyContigNaming): ReadonlyArray<string> {
  const names: string[] = [];
  for (const alias of contig.aliases ?? []) {
    const clean = alias.trim();
    if (clean && clean !== contig.name) names.push(clean);
  }
  return names;
}

function addCandidate(index: Map<string, Set<string>>, key: string, assemblyName: string): void {
  const clean = key.trim();
  if (!clean) return;
  const existing = index.get(clean);
  if (existing) existing.add(assemblyName);
  else index.set(clean, new Set([assemblyName]));
}

export function buildContigNameMap(input: {
  readonly assembly: ReadonlyArray<AssemblyContigNaming>;
  readonly source: ReadonlyArray<SourceContigNaming>;
}): ContigNameMap {
  const byExactName = new Map<string, Set<string>>();
  const byDeclaredAlias = new Map<string, Set<string>>();
  const byChrPrefix = new Map<string, Set<string>>();
  const assemblyByName = new Map<string, AssemblyContigNaming>();

  for (const contig of input.assembly) {
    const name = contig.name.trim();
    if (!name) continue;
    assemblyByName.set(name, contig);
    addCandidate(byExactName, name, name);
    addCandidate(byChrPrefix, chrPrefixForm(name), name);
    for (const alias of declaredNames(contig)) {
      addCandidate(byDeclaredAlias, alias, name);
      addCandidate(byChrPrefix, chrPrefixForm(alias), name);
    }
  }

  const matches: ContigNameMatch[] = [];
  const ambiguousSource: string[] = [];
  const takenAssembly = new Set<string>();
  const claimedSource = new Set<string>();

  const sourceNames = input.source
    .map((contig) => ({ contig, name: contig.name.trim() }))
    .filter((entry) => entry.name.length > 0);

  const tiers: ReadonlyArray<[Map<string, Set<string>>, ContigNameMatch['how'], boolean]> = [
    [byExactName, 'exact', false],
    [byDeclaredAlias, 'declared-alias', false],
    [byChrPrefix, 'chr-prefix', true],
  ];

  for (const [index, how, canonical] of tiers) {
    for (const { contig, name } of sourceNames) {
      if (claimedSource.has(name)) continue;
      const candidates = index.get(canonical ? chrPrefixForm(name) : name);
      if (!candidates || candidates.size === 0) continue;
      claimedSource.add(name);
      if (candidates.size > 1) {
        ambiguousSource.push(name);
        continue;
      }
      const assemblyName = candidates.values().next().value;
      if (assemblyName === undefined) continue;
      if (takenAssembly.has(assemblyName)) {
        ambiguousSource.push(name);
        continue;
      }
      takenAssembly.add(assemblyName);
      const assemblyContig = assemblyByName.get(assemblyName);
      const lengthConflict =
        assemblyContig &&
        typeof contig.length === 'number' &&
        contig.length !== assemblyContig.length
          ? { assembly: assemblyContig.length, source: contig.length }
          : undefined;
      matches.push({
        assemblyName,
        sourceName: name,
        how,
        ...(lengthConflict ? { lengthConflict } : {}),
      });
    }
  }

  const unmatchedSource = sourceNames
    .map((entry) => entry.name)
    .filter((name) => !claimedSource.has(name));

  const bySource = new Map(matches.map((match) => [match.sourceName, match]));
  const byAssembly = new Map(matches.map((match) => [match.assemblyName, match]));
  return {
    matches,
    unmatchedAssembly: [...assemblyByName.keys()].filter((name) => !byAssembly.has(name)),
    unmatchedSource,
    ambiguousSource,
    sourceNameFor: (assemblyName) => byAssembly.get(assemblyName)?.sourceName,
    assemblyNameFor: (sourceName) => bySource.get(sourceName)?.assemblyName,
    matchForSource: (sourceName) => bySource.get(sourceName),
    matchForAssembly: (assemblyName) => byAssembly.get(assemblyName),
  };
}

export function assemblyContigNaming(
  chromosomes: ReadonlyArray<{
    readonly chrom: string;
    readonly length: number;
    readonly displayName?: string;
    readonly aliases?: {
      readonly refseq?: string;
      readonly genbank?: string;
      readonly ucsc?: string;
      readonly ensembl?: string;
    };
  }>
): ReadonlyArray<AssemblyContigNaming> {
  return chromosomes
    .filter((chromosome) => Number.isFinite(chromosome.length) && chromosome.length > 0)
    .map((chromosome) => {
      const names = new Set<string>();
      const aliases = chromosome.aliases;
      for (const value of [aliases?.refseq, aliases?.genbank, aliases?.ucsc, aliases?.ensembl]) {
        if (typeof value === 'string' && value.trim()) names.add(value.trim());
      }
      if (chromosome.displayName?.trim()) names.add(chromosome.displayName.trim());
      names.delete(chromosome.chrom);
      return {
        name: chromosome.chrom,
        length: chromosome.length,
        ...(names.size > 0 ? { aliases: [...names] } : {}),
      };
    });
}
