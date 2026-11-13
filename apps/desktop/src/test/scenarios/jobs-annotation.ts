import { parseGenBankFull } from '@waypoint/sequence-utils';
import type { AppScenario } from './types';
import PUC19 from '../../../../../test-fixtures/sequences/circular/pUC19.gb?raw';

const ROOT_PREFIX = '/mock/test/workspace/jobs-annotation';

export function jobsAnnotationWorkspace(): AppScenario {
  const scenarioId = `jobs-annotation-${crypto.randomUUID()}`;
  const root = `${ROOT_PREFIX}/${scenarioId}`;
  const source = `${root}/pUC19.gb`;
  const documentId = `fixture:sequence:${scenarioId}`;
  return {
    dev: {
      scenarioId,
      initializeGit: true,
      initialGitCommitMessage: 'Initialize Jobs annotation proof workspace',
    },
    workspace: {
      folders: [{ path: root, name: 'Jobs annotation proof' }],
      selectedPath: source,
    },
    files: {
      [source]: PUC19,
      [`${root}/PROOF.md`]: `# Jobs annotation proof

This is a fresh copy of the repository's pUC19 fixture in a real Git workspace.
The analysis service and annotation engine remain live. Their installed tools
and reference data are required; this scenario does not fabricate readiness.

1. Open the annotation drawer, select pLannotate, and start a run.
2. Close the sequence view while the run is active.
3. Select Jobs in the left sidebar. The same run should continue there.
4. When it finishes, open its result, review the candidates, and apply them.
5. Reopen the saved document and inspect its Git history.

Closing a view must not stop the run or delete its review. Jobs must distinguish
completed execution from a result that is still waiting for review. This desktop
execution owner lasts for the application session, not beyond application exit.
`,
    },
    sequences: { [documentId]: { ...parseGenBankFull(PUC19), id: documentId } },
    sequenceSources: { [documentId]: { sourcePath: source, name: 'pUC19.gb' } },
    canvas: {
      tabs: [
        {
          type: 'sequence',
          entityId: documentId,
          label: 'pUC19.gb',
          sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
        },
      ],
      activeTabIndex: 0,
      layout: 'single',
    },
  };
}

export function jobsAgentActionsRegistry(): AppScenario {
  const scenario = jobsAnnotationWorkspace();
  return {
    ...scenario,
    agentJobs: {
      jobs: [
        {
          id: 'action-fixture-running',
          tool_name: 'align_reads',
          duration: 'long-running',
          pool: 'cpu',
          state: 'running',
          cancelable: true,
          can_cancel: true,
          requested_at: '2026-09-16T08:00:00.000Z',
          completed_at: null,
          error_code: null,
          agent_identity: {
            id: 'local-in-app-chat',
            label: 'In-app agent',
            kind: 'desktop-chat',
          },
        },
      ],
      observedAtMs: Date.parse('2026-09-16T08:00:05.000Z'),
    },
  };
}
