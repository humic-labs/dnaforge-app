import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN } from '../../features/sequence/annotation-layer-identity';
import { HOSTED_REFERENCE_CATALOG_V1 } from './hosted-reference-catalog';
import {
  installedBundleLegacyLayerIdentityContract,
  readReferenceVersionHistory,
  recordReferenceVersionIdentity,
} from './installed-hosted-reference';

it('retains admitted identity facts and excludes malformed history records', async () => {
  const familyRoot = await mkdtemp(join(tmpdir(), 'reference-version-history-'));
  const admitted = {
    bundleFingerprint: 'a'.repeat(64),
    sequenceIdentity: 'b'.repeat(64),
    annotationIdentity: 'c'.repeat(64),
    assetGenerations: [{ sourceFingerprint: 'd'.repeat(24), inventoryFingerprint: 'e'.repeat(64) }],
  };
  try {
    await recordReferenceVersionIdentity(familyRoot, admitted);
    const corrupted = {
      ...admitted,
      bundleFingerprint: 'f'.repeat(64),
      sequenceIdentity: [admitted.sequenceIdentity],
    };
    await writeFile(
      join(familyRoot, '.reference-version-history', `${corrupted.bundleFingerprint}.json`),
      JSON.stringify(corrupted)
    );
    expect(await readReferenceVersionHistory(familyRoot)).toEqual([admitted]);
  } finally {
    await rm(familyRoot, { recursive: true, force: true });
  }
});

it('re-admits a retired legacy bundle with its own layer identity contract', () => {
  const grch38 = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'grch38')!;
  const retiredGrch38Manifest = 'b0ded75b20e8f710de10d1526eb43f95ae767782483f3b7d18b8f53b9c4b9063';
  expect(grch38.preparedBundle?.legacyLayerIdentityContract).toBeUndefined();
  expect(installedBundleLegacyLayerIdentityContract(grch38, retiredGrch38Manifest)).toBe(
    ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN
  );
  expect(
    installedBundleLegacyLayerIdentityContract(grch38, grch38.preparedBundle!.manifest.sha256)
  ).toBeUndefined();
  expect(installedBundleLegacyLayerIdentityContract(grch38, 'f'.repeat(64))).toBeUndefined();

  const sacCer3 = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'sacCer3')!;
  expect(
    installedBundleLegacyLayerIdentityContract(sacCer3, sacCer3.preparedBundle!.manifest.sha256)
  ).toBe(sacCer3.preparedBundle!.legacyLayerIdentityContract);
});
