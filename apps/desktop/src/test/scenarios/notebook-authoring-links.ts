import { parseGenBankFull } from '@waypoint/sequence-utils';
import type { JSONContent } from '@tiptap/core';
import PUC19 from '../../../../../test-fixtures/sequences/circular/pUC19.gb?raw';
import { serializeNotebookMarkdown } from '../../db/notebook-markdown-codec';
import {
  buildNotebookPackageMetadata,
  NOTEBOOK_PACKAGE_FORMAT_VERSION,
  serializeNotebookPackageMetadata,
} from '../../db/notebook-package';
import { assertToolOperationResult } from '../../features/agent-bridge/public/tool-result';
import type { AppScenario } from './types';

export const NOTEBOOK_AUTHORING_PRESET_ID = 'notebook-authoring-links';
export const NOTEBOOK_AUTHORING_PAGE_ID = 'fixture-notebook-authoring-links';
export const NOTEBOOK_AUTHORING_TITLE = 'Notebook authoring review';
export const NOTEBOOK_AUTHORING_ALPHA_ROOT = '/mock/test/workspace/notebook-authoring-alpha';
export const NOTEBOOK_AUTHORING_BETA_ROOT = '/mock/test/workspace/notebook-authoring-beta';

export function notebookAuthoringLinks(): AppScenario {
  const content: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: NOTEBOOK_AUTHORING_TITLE }],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Try @M13 Forward, @primer, /primer and /table. Search @pUC19 to distinguish Project Alpha from Project Beta.',
          },
        ],
      },
      { type: 'paragraph' },
    ],
  };
  const stem = 'Notebook-authoring-review';
  const packageRoot = `${NOTEBOOK_AUTHORING_ALPHA_ROOT}/${stem}`;
  const markdownFileName = `${stem}.md`;
  const serialized = serializeNotebookMarkdown({
    identity: {
      id: NOTEBOOK_AUTHORING_PAGE_ID,
      title: NOTEBOOK_AUTHORING_TITLE,
      formatVersion: NOTEBOOK_PACKAGE_FORMAT_VERSION,
    },
    content,
  });
  const metadata = buildNotebookPackageMetadata({
    id: NOTEBOOK_AUTHORING_PAGE_ID,
    title: NOTEBOOK_AUTHORING_TITLE,
    markdownFileName,
    updatedAt: '2026-11-14T12:00:00.000Z',
  });
  const sequence = parseGenBankFull(PUC19);
  const projects = [
    { path: NOTEBOOK_AUTHORING_ALPHA_ROOT, name: 'Project Alpha', id: 'fixture-link-alpha-puc19' },
    { path: NOTEBOOK_AUTHORING_BETA_ROOT, name: 'Project Beta', id: 'fixture-link-beta-puc19' },
  ];
  return {
    dev: {
      scenarioId: `${NOTEBOOK_AUTHORING_PRESET_ID}-${crypto.randomUUID()}`,
      initializeGit: true,
      initialGitCommitMessage: 'Initialize notebook authoring review projects',
    },
    workspace: {
      folders: projects.map(({ path, name }) => ({ path, name })),
      selectedPath: packageRoot,
    },
    files: {
      ...Object.fromEntries(projects.map(({ path }) => [`${path}/pUC19.gb`, PUC19])),
      [`${packageRoot}/.forge/notebook.json`]: serializeNotebookPackageMetadata(metadata),
      [`${packageRoot}/${markdownFileName}`]: serialized.markdown,
      ...Object.fromEntries(
        serialized.payloads.map((payload) => [
          `${packageRoot}/${payload.relativePath}`,
          payload.content,
        ])
      ),
    },
    sequences: Object.fromEntries(projects.map(({ id }) => [id, { ...sequence, id }])),
    sequenceSources: Object.fromEntries(
      projects.map(({ path, id }) => [id, { sourcePath: `${path}/pUC19.gb`, name: 'pUC19' }])
    ),
  };
}

export async function prepareNotebookAuthoringLinks(): Promise<void> {
  const [
    { useWorkspaceStore },
    { usePageStore },
    { createCreatePrimerTool },
    { openWorkspaceDocument },
  ] = await Promise.all([
    import('../../stores/workspaceStore'),
    import('../../features/page/store'),
    import('../../features/ai/tools/primer-lifecycle'),
    import('../../features/page/public/open-workspace-document'),
  ]);
  await usePageStore.getState().initialize();
  const folders = useWorkspaceStore.getState().folders;
  const project = folders.find((folder) => folder.name === 'Project Alpha');
  if (!project) throw new Error('Notebook authoring fixture has no Project Alpha.');
  const tool = createCreatePrimerTool(folders);
  const primers = [
    { name: 'M13 Forward', sequence: 'GTAAAACGACGGCCAGT' },
    { name: 'M13 Reverse', sequence: 'CAGGAAACAGCTATGAC' },
  ];
  for (const primer of primers) {
    const result = await tool.execute!(
      {
        workspace: project.path,
        name: primer.name,
        artifactPath: `primers/${primer.name.replaceAll(' ', '-')}.primer.json`,
        oligo: { vendor: 'idt', orderType: 'dna', notation: primer.sequence },
        notes: 'Notebook authoring review primer',
      },
      { toolCallId: `notebook-authoring-fixture-${primer.name}`, messages: [] }
    );
    assertToolOperationResult(result);
    if (!result.ok) throw new Error(result.error);
  }
  const opened = await openWorkspaceDocument({
    target: {
      kind: 'file',
      path: `${project.path}/Notebook-authoring-review`,
      tabType: 'page',
    },
    label: NOTEBOOK_AUTHORING_TITLE,
  });
  if (opened.status !== 'presented' || opened.tabType !== 'page') {
    throw new Error('Notebook authoring fixture did not open its native notebook.');
  }
}
