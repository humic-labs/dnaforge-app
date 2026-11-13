import { platform } from '../../platform';
import { gitCommitPaths, isGitRepo } from '../workspace/public/git';
import * as core from './import-set-core';
export * from './import-set-core';
const defaults = (): core.ImportSetPersistenceDependencies => ({
  fs: platform().fs,
  isGitRepo,
  commitPaths: gitCommitPaths,
});
export const prepareImportSetSource = (
  input: core.PrepareImportSetSourceInput,
  dependencies?: Pick<core.ImportSetPersistenceDependencies, 'fs'>
) => core.prepareImportSetSource(input, dependencies ?? { fs: platform().fs });
export const writeImportSet = (
  input: Parameters<typeof core.writeImportSet>[0],
  dependencies = defaults()
) => core.writeImportSet(input, dependencies);
export const persistImportSet = (
  input: Parameters<typeof core.persistImportSet>[0],
  dependencies = defaults()
) => core.persistImportSet(input, dependencies);
