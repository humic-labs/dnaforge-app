import { lstat, readFile } from 'node:fs/promises';
import type { HostedReferenceCatalogDefinitionV1 } from './hosted-reference-catalog';
import { portablePreparedReferenceContentObjectKeyV1 } from './portable-prepared-reference-bundle';

export const HOSTED_REFERENCE_CATALOG_FIXTURE_ENV = 'DNAFORGE_E2E_HOSTED_REFERENCE_CATALOG_FIXTURE';

export async function hostedReferenceCatalogForRuntime(input: {
  readonly catalog: readonly HostedReferenceCatalogDefinitionV1[];
  readonly isPackaged: boolean;
  readonly explicitE2e: boolean;
  readonly fixturePath?: string;
}): Promise<readonly HostedReferenceCatalogDefinitionV1[]> {
  if (!input.fixturePath) return input.catalog;
  if (input.isPackaged || !input.explicitE2e)
    throw new Error(
      'Hosted reference catalog fixtures require an unpackaged explicit E2E runtime.'
    );
  const file = await lstat(input.fixturePath);
  if (!file.isFile() || file.isSymbolicLink() || file.size > 1024 * 1024)
    throw new Error('Invalid hosted reference catalog fixture file.');
  const patch = JSON.parse(
    await readFile(input.fixturePath, 'utf8')
  ) as Partial<HostedReferenceCatalogDefinitionV1>;
  const existing = input.catalog.find(({ id }) => id === patch.id);
  if (!existing || !patch.sources || !patch.preparedBundle)
    throw new Error('Invalid hosted reference catalog fixture.');
  for (const source of [
    patch.sources.fasta,
    patch.sources.annotations,
    patch.preparedBundle.manifest,
  ]) {
    if (
      !source ||
      !/^[0-9a-f]{64}$/.test(source.sha256) ||
      !Number.isSafeInteger(source.byteLength) ||
      source.byteLength <= 0 ||
      typeof source.relativePath !== 'string'
    )
      throw new Error('Invalid hosted reference catalog fixture source.');
  }
  if (
    patch.preparedBundle.manifest.relativePath !==
    portablePreparedReferenceContentObjectKeyV1(patch.preparedBundle.manifest.sha256)
  )
    throw new Error('Invalid hosted reference catalog fixture manifest.');
  return input.catalog.map((definition) =>
    definition === existing
      ? { ...definition, sources: patch.sources!, preparedBundle: patch.preparedBundle! }
      : definition
  );
}
