import { toUserMessage } from '@waypoint/user-messages';
import type { AppScenario } from './types';
import { platform } from '../../platform';
import { useImportWizardStore } from '../../features/import-wizard/import-wizard-store';
import { useToastStore } from '../../stores/toast-store';

const ROOT = '/mock/test/workspace/import-readiness-review';
const SECOND_ROOT = '/mock/test/workspace/import-review-yeast';
const SGD_DNAS = Object.values(
  import.meta.glob<string>(
    '../../../../../test-fixtures/import-formats/S288C_YBR160W_CDC28_coding.dnas',
    { eager: true, query: '?raw', import: 'default' }
  )
)[0];

export function importReadinessReview(): AppScenario {
  return {
    dev: {
      scenarioId: `import-readiness-review-${crypto.randomUUID()}`,
      openDnaImportReview: true,
    },
    workspace: {
      folders: [
        { path: ROOT, name: 'Cloning' },
        { path: SECOND_ROOT, name: 'Yeast' },
      ],
      selectedPath: ROOT,
    },
    canvas: { tabs: [], layout: 'single' },
    files: {
      [`${ROOT}/README.md`]:
        '# Import review\n\nGenuine pUC19 SnapGene DNA and SGD CDC28 DNAS files. The generic FASTA is the same real SGD DNA without a molecule-type label.\n\nThe top destination control applies to all files. Use each row to override its project or folder. Checkboxes control what is imported. Confirm DNA resolves the generic FASTA after validation. Import creates editable packages. Cancel writes nothing. Reopen the scenario for fresh projects.\n',
      [`${ROOT}/Review destination/README.md`]: '# Alternate import destination\n',
      [`${ROOT}/Review destination/Plasmids/README.md`]: '# Nested import destination\n',
      [`${SECOND_ROOT}/Experiments/2026/README.md`]: '# Nested Yeast destination\n',
      [`${SECOND_ROOT}/README.md`]:
        '# Yeast\n\nSecond project for the multi-project import review.\n',
      ...(SGD_DNAS ? { '/mock/test/import-review-inputs/unknown-molecule.fa': SGD_DNAS } : {}),
    },
  };
}

export async function openDnaImportReview(scenario: AppScenario): Promise<void> {
  if (!SGD_DNAS) {
    throw new Error(
      'The real DNA import review needs the SGD import fixtures, which this checkout does not include.'
    );
  }
  const repo = await platform().path.projectRoot();
  const destination = scenario.workspace?.folders[0]?.path;
  const blocked = Object.keys(scenario.files ?? {}).find((path) =>
    path.endsWith('/unknown-molecule.fa')
  );
  if (!repo || !destination || !blocked) {
    throw new Error('The real DNA import review requires the Electron development app.');
  }
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
  const bridge = (
    window as Window & {
      __test?: { triggerTypedDnaImport?: (paths: string[], destination: string) => Promise<void> };
    }
  ).__test;
  if (!bridge?.triggerTypedDnaImport) throw new Error('The DNA import controller is not ready.');
  const paths = [
    `${repo}/test-fixtures/import-formats/pUC19.dna`,
    `${repo}/test-fixtures/import-formats/S288C_YBR160W_CDC28_coding.dnas`,
    blocked,
  ];
  let launchError: unknown;
  void bridge.triggerTypedDnaImport(paths, destination).catch((error: unknown) => {
    launchError = error;
    useToastStore.getState().addToast(toUserMessage(error, 'operation.failed'), {
      definition: 'file-import-result',
      variant: 'error',
    });
  });
  const deadline = performance.now() + 10_000;
  while (!useImportWizardStore.getState().request) {
    if (launchError) throw launchError;
    if (performance.now() > deadline) throw new Error('The DNA import review did not open.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
