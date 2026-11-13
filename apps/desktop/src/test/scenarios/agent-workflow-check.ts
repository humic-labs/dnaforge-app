import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import TARGET_GENBANK from '../../../../../test-fixtures/agent-control/sequence-edit/Agent edit target.gb?raw';
import type { AppScenario } from './types';

export function agentWorkflowCheck(): AppScenario {
  const runId = crypto.randomUUID();
  const root = '/mock/test/workspace/agent-workflow-check';
  const packageRoot = `${root}/Agent edit target`;
  const packageId = `agent-workflow-sequence-${runId}`;
  const pageId = `agent-workflow-notes-${runId}`;
  const document = buildSequencePackageDocument({
    id: packageId,
    name: 'Agent edit target',
    product: { file: 'Agent edit target.gb', topology: 'linear' },
  });
  return {
    dev: {
      scenarioId: `agent-workflow-check-${runId}`,
      initializeGit: true,
      initialGitCommitMessage: 'Initialize agent workflow check',
    },
    workspace: {
      folders: [{ path: root, name: 'Agent workflow check' }],
      selectedPath: packageRoot,
    },
    files: {
      [`${packageRoot}/Agent edit target.gb`]: TARGET_GENBANK,
      [`${packageRoot}/.forge/plasmid.json`]: serializeSequencePackageDocument(document),
    },
    pages: {
      pages: [
        {
          id: pageId,
          title: 'Human notes',
          content: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Keep this human note.' }] },
            ],
          },
        },
      ],
    },
    canvas: {
      tabs: [
        {
          type: 'sequence',
          entityId: packageId,
          label: 'Agent edit target',
          sequenceDocument: { kind: 'managed-sequence', packageId, packageRoot },
        },
        { type: 'page', entityId: pageId, label: 'Human notes' },
      ],
      activeTabIndex: 0,
    },
    lims: {
      imports: [
        {
          sourceName: 'Agent workflow strains.csv',
          defaultKind: 'strain',
          actor: 'agent-workflow-check',
          text: 'name,genotypeCanonical\nDerived fixture strain,native fixture\nParent fixture strain,native fixture\nPreserved fixture strain,native fixture\n',
        },
      ],
    },
  };
}
