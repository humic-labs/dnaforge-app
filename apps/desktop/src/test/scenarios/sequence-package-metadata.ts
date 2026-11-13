import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import REAL_PUC19_GB from '../../../../../test-fixtures/sequences/circular/pUC19.gb?raw';
import type { AppScenario } from './types';

export const SEQUENCE_METADATA_WORKSPACE_ROOT = '/mock/test/workspace/sequence-metadata';
export const SEQUENCE_METADATA_PACKAGE_ROOT = `${SEQUENCE_METADATA_WORKSPACE_ROOT}/sequences/pUC19-package`;
export const SEQUENCE_METADATA_PRODUCT_PATH = `${SEQUENCE_METADATA_PACKAGE_ROOT}/physical-pUC19.gb`;
export const SEQUENCE_METADATA_META_PATH = `${SEQUENCE_METADATA_PACKAGE_ROOT}/.forge/plasmid.json`;

export function sequencePackageMetadata(): AppScenario {
  const runId = crypto.randomUUID();
  const packageId = `dev-sequence-metadata-${runId}`;
  const document = buildSequencePackageDocument({
    id: packageId,
    name: 'pUC19 sequence',
    product: { file: 'physical-pUC19.gb', topology: 'circular' },
  });

  return {
    dev: {
      scenarioId: `sequence-package-metadata-${runId}`,
      initializeGit: true,
      initialGitCommitMessage: 'Initialize sequence metadata proof workspace',
    },
    workspace: {
      folders: [{ path: SEQUENCE_METADATA_WORKSPACE_ROOT, name: 'sequence-metadata' }],
      selectedPath: SEQUENCE_METADATA_PACKAGE_ROOT,
    },
    files: {
      [SEQUENCE_METADATA_PRODUCT_PATH]: REAL_PUC19_GB,
      [SEQUENCE_METADATA_META_PATH]: serializeSequencePackageDocument(document),
    },
    canvas: {
      tabs: [
        {
          type: 'sequence',
          entityId: packageId,
          label: document.name,
          sequenceDocument: {
            kind: 'managed-sequence',
            packageId,
            packageRoot: SEQUENCE_METADATA_PACKAGE_ROOT,
          },
        },
      ],
      activeTabIndex: 0,
    },
    openSequenceDrawer: 'metadata',
  };
}
