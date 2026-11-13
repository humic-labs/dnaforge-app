export interface PrimerLegacyBindingProjectionInput {
  id: string;
  sequenceId: number;
  bindingStart: number;
  bindingEnd: number;
  strand: 1 | -1;
  source: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface PrimerLegacyProjectionInput {
  artifactRevision?: number;
  retireArtifact?: { artifactPath: string; expectedArtifactRevision: number };
  registryRelationships?: { relativePath: string; contentHash: string };
  id: string;
  catalogNumber: string;
  name: string;
  sequence: string;
  length: number;
  tm: number | null;
  gcPercent: number;

  origin: string;
  status?: string;
  originDetails: Record<string, unknown>;
  vendor: string | null;
  modifications: string | null;
  orderDate?: number | null;
  scale?: string | null;
  purification?: string | null;
  stockLocation?: string | null;
  concentration?: number | null;
  application: string | null;
  notes: string | null;
  workspaceId: number | null;
  createdAt: number;
  updatedAt: number;
  bindings: PrimerLegacyBindingProjectionInput[];
}
