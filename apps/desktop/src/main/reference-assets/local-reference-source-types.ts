export interface LocalReferenceIdentityOverrideV1 {
  readonly name?: string;
  readonly organism?: string;
  readonly taxId?: number;
  readonly accession?: string;
  readonly description?: string;
  readonly provenance?: Readonly<{
    provider: string;
    datasetId: string;
    datasetVersion?: string;
    sourceUrl?: string;
  }>;
}

export interface ResolvedLocalReferenceSources {
  readonly kind: 'generic-folder' | 'standalone-fasta' | 'ncbi-datasets' | 'hub-genome';
  readonly sourcePaths: readonly [string] | readonly [string, string];
  readonly identity?: LocalReferenceIdentityOverrideV1;
}

export interface LocalReferenceSourceSelection {
  readonly path: string;
}
