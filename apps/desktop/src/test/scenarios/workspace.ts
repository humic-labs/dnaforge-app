import { PUC19_GENBANK, GFP_FASTA } from '../fixtures/sequences';
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

export function withStandardWorkspace(scenario: AppScenario): AppScenario {
  return withWorkspaceFolder(
    withWorkspaceFolder(scenario, '/workspace/plasmids', [
      { name: 'pUC19.gb', content: PUC19_GENBANK },
    ]),
    '/workspace/sequences',
    [{ name: 'gfp.fasta', content: GFP_FASTA }]
  );
}

export function withEmptyWorkspace(scenario: AppScenario, folderPath = '/workspace'): AppScenario {
  return withWorkspaceFolder(scenario, folderPath);
}
