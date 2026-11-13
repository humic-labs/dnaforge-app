import type { AppScenario } from './types';

export function withWorkspaceFolder(
  scenario: AppScenario,
  folderPath: string,
  files?: Array<{ name: string; content?: string }>
): AppScenario {
  const folders = [
    ...(scenario.workspace?.folders ?? []),
    { path: folderPath, name: folderPath.split('/').pop()! },
  ];
  const newFiles = { ...scenario.files };
  if (files) {
    for (const f of files) {
      if (f.content) {
        newFiles[`${folderPath}/${f.name}`] = f.content;
      }
    }
  }
  return {
    ...scenario,
    workspace: {
      ...scenario.workspace,
      folders,
    },
    files: newFiles,
  };
}

export function withEmptyWorkspace(scenario: AppScenario, folderPath = '/workspace'): AppScenario {
  return withWorkspaceFolder(scenario, folderPath);
}

export function withSequenceWorkspace(
  scenario: AppScenario,
  { puc19Genbank, gfpFasta }: { puc19Genbank: string; gfpFasta: string }
): AppScenario {
  return withWorkspaceFolder(
    withWorkspaceFolder(scenario, '/workspace/plasmids', [
      { name: 'pUC19.gb', content: puc19Genbank },
    ]),
    '/workspace/sequences',
    [{ name: 'gfp.fasta', content: gfpFasta }]
  );
}
