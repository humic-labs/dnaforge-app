import { describe, expect, it } from 'vitest';
import { parseSequencePackageDocument } from '../../db/sequence-package';
import { getDevScenarioPresetById } from './dev-presets';
import {
  SEQUENCE_METADATA_META_PATH,
  SEQUENCE_METADATA_PACKAGE_ROOT,
  SEQUENCE_METADATA_PRODUCT_PATH,
  sequencePackageMetadata,
} from './sequence-package-metadata';

describe('sequencePackageMetadata', () => {
  it('opens a managed package-ID tab with the sparse metadata drawer', () => {
    const scenario = sequencePackageMetadata();
    const tab = scenario.canvas?.tabs[0];

    expect(tab?.entityId).toBe(tab?.sequenceDocument?.packageId);
    expect(tab?.sequenceDocument).toMatchObject({
      kind: 'managed-sequence',
      packageRoot: SEQUENCE_METADATA_PACKAGE_ROOT,
    });
    expect(tab?.entityId).not.toBe(SEQUENCE_METADATA_PRODUCT_PATH);
    expect(scenario.openSequenceDrawer).toBe('metadata');

    const marker = parseSequencePackageDocument(
      String(scenario.files?.[SEQUENCE_METADATA_META_PATH])
    );
    expect(marker.id).toBe(tab?.entityId);
    expect(marker.product.file).toBe('physical-pUC19.gb');
    expect(marker.entity.schema.baseKind).toBe('sequence');
  });

  it('is exposed as a one-click, non-replaying DevPanel preset', () => {
    const preset = getDevScenarioPresetById('sequence-package-metadata');
    expect(preset?.factory).toBe(sequencePackageMetadata);
    expect(preset?.noAutoReplay).toBe(true);
  });
});
