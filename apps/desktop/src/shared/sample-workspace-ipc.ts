export const STANDARD_SAMPLE_WORKSPACE_MANIFEST = {
  templateId: 'standard-samples',
  version: 'v7',
  displayName: 'DNAForge Samples',
  assets: [
    {
      id: 'ecoli-mg1655',
      label: 'E. coli MG1655 genome',
      path: 'sequences/genomes/ecoli-mg1655',
    },
    {
      id: 'puc19',
      label: 'pUC19 plasmid',
      path: 'sequences/plasmids/pUC19',
    },
  ],
} as const;

export const SAMPLE_WORKSPACE_TEMPLATE_IDS = [
  STANDARD_SAMPLE_WORKSPACE_MANIFEST.templateId,
] as const;

export function isBundledSampleWorkspaceOriginPath(originPath: string | null): boolean {
  return (
    originPath
      ?.replace(/\\/g, '/')
      .toLowerCase()
      .includes(`/sample workspaces/${STANDARD_SAMPLE_WORKSPACE_MANIFEST.templateId}/`) ?? false
  );
}

export type SampleWorkspaceTemplateId = (typeof SAMPLE_WORKSPACE_TEMPLATE_IDS)[number];

export type SampleWorkspaceMode = 'reuse' | 'fresh';

export interface SampleWorkspaceAsset {
  id: string;
  label: string;
  path: string;
}

export interface SampleWorkspaceManifest {
  templateId: string;
  version: string;
  displayName: string;
  assets: readonly SampleWorkspaceAsset[];
}

export interface CreateSampleWorkspaceInstanceRequest {
  templateId: string;
  mode?: SampleWorkspaceMode;
}

export interface SampleWorkspaceInstanceResult {
  id: string;
  templateId: string;
  version: string;
  displayName: string;
  rootPath: string;
  markerPath: string;
  manifest: SampleWorkspaceManifest;
  writable: boolean;
  createdAt: number;
}
