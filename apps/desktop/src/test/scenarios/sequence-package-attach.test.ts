import { describe, expect, it } from 'vitest';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import { parseSequencePackageDocument } from '../../db/sequence-package';
import { SEQUENCE_PACKAGE_FORMAT_VERSION } from '../../db/sequence-package-contract';
import { getDevScenarioPresetById } from './dev-presets';
import {
  SEQUENCE_PACKAGE_ATTACH_DROP_A_PATH,
  SEQUENCE_PACKAGE_ATTACH_DROP_B_PATH,
  SEQUENCE_PACKAGE_ATTACH_GUIDE_PATH,
  SEQUENCE_PACKAGE_ATTACH_META_PATH,
  SEQUENCE_PACKAGE_ATTACH_PACKAGE_ROOT,
  SEQUENCE_PACKAGE_ATTACH_PRODUCT_PATH,
  SEQUENCE_PACKAGE_ATTACH_SESSION_NAME,
  SEQUENCE_PACKAGE_ATTACH_WORKSPACE_ROOT,
  sequencePackageAttachTwoClones,
} from './sequence-package-attach';

describe('sequencePackageAttachTwoClones', () => {
  it('defines a clean current-format package and two same-basename inbox FASTAs for the real attach path', () => {
    const scenario = sequencePackageAttachTwoClones();

    expect(scenario.dev?.scenarioId).toMatch(/^sequence-package-attach-/);
    const packageId = scenario.canvas?.tabs[0]?.entityId;
    expect(packageId).toMatch(/^dev-attach-/);
    expect(scenario.dev?.initializeGit).toBe(true);
    expect(scenario.openSequenceDrawer).toBe('alignments');
    expect(scenario.attachAlignmentQueries).toEqual({
      queryPaths: [SEQUENCE_PACKAGE_ATTACH_DROP_A_PATH, SEQUENCE_PACKAGE_ATTACH_DROP_B_PATH],
      sessionName: SEQUENCE_PACKAGE_ATTACH_SESSION_NAME,
      mode: 'one-per-clone',
      documentId: packageId,
      sourcePath: SEQUENCE_PACKAGE_ATTACH_PRODUCT_PATH,
    });
    expect(scenario.workspace).toEqual({
      folders: [
        {
          path: SEQUENCE_PACKAGE_ATTACH_WORKSPACE_ROOT,
          name: 'sequence-package-attach',
        },
      ],
      selectedPath: SEQUENCE_PACKAGE_ATTACH_PRODUCT_PATH,
    });
    expect(scenario.canvas?.tabs).toEqual([
      {
        type: 'sequence',
        entityId: packageId,
        label: 'pUC19.gb',
        sequenceDocument: {
          kind: 'managed-sequence',
          packageId,
          packageRoot: SEQUENCE_PACKAGE_ATTACH_PACKAGE_ROOT,
        },
      },
    ]);

    const source = scenario.files?.[SEQUENCE_PACKAGE_ATTACH_PRODUCT_PATH];
    expect(typeof source).toBe('string');
    expect(parseGenBankFull(source as string).sequence).toHaveLength(2686);

    const marker = parseSequencePackageDocument(
      String(scenario.files?.[SEQUENCE_PACKAGE_ATTACH_META_PATH])
    );
    expect(marker.formatVersion).toBe(SEQUENCE_PACKAGE_FORMAT_VERSION);
    expect(marker.product.file).toBe('pUC19.gb');
    expect(marker.members).toEqual([]);
    expect(
      scenario.files?.[
        '/mock/test/workspace/sequence-package-attach/sequences/pUC19/contents/clone-1.fasta'
      ]
    ).toBeUndefined();

    expect(SEQUENCE_PACKAGE_ATTACH_DROP_A_PATH.endsWith('/clone-1.fasta')).toBe(true);
    expect(SEQUENCE_PACKAGE_ATTACH_DROP_B_PATH.endsWith('/clone-1.fasta')).toBe(true);
    expect(String(scenario.files?.[SEQUENCE_PACKAGE_ATTACH_DROP_A_PATH])).toContain('>clone-1');
    expect(String(scenario.files?.[SEQUENCE_PACKAGE_ATTACH_DROP_B_PATH])).toContain(
      '>clone-1-collision'
    );
    const dropABases = String(scenario.files?.[SEQUENCE_PACKAGE_ATTACH_DROP_A_PATH])
      .replace(/>[^\n]*\n/g, '')
      .replace(/\s+/g, '');
    const dropBBases = String(scenario.files?.[SEQUENCE_PACKAGE_ATTACH_DROP_B_PATH])
      .replace(/>[^\n]*\n/g, '')
      .replace(/\s+/g, '');
    expect(dropABases).toHaveLength(2686);
    expect(dropBBases).toHaveLength(2686);
    expect(dropABases).not.toBe(dropBBases);
    const reference = parseGenBankFull(source as string).sequence.toUpperCase();
    for (const clone of [dropABases, dropBBases]) {
      expect([...clone].filter((base, index) => base !== reference[index])).toHaveLength(1);
    }
    expect(scenario.files?.[SEQUENCE_PACKAGE_ATTACH_GUIDE_PATH]).toEqual(
      expect.stringContaining('Two clone rows')
    );
  });

  it('uses a new materialization directory on every apply', () => {
    expect(sequencePackageAttachTwoClones().dev?.scenarioId).not.toBe(
      sequencePackageAttachTwoClones().dev?.scenarioId
    );
  });

  it('is registered as a one-click noAutoReplay DevPanel preset', () => {
    const preset = getDevScenarioPresetById('sequence-package-attach-two-clones');
    expect(preset?.label).toBe('sequencePackageAttachTwoClones');
    expect(preset?.noAutoReplay).toBe(true);
    expect(preset?.factory).toBe(sequencePackageAttachTwoClones);
  });
});
