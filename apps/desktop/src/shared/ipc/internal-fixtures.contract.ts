import type {
  InternalAssemblyFixtureMaterializeRequest,
  InternalAssemblyFixtureMaterializeResult,
  InternalAssemblyFixtureStatusRequest,
  InternalAssemblyFixtureStatusResult,
} from '../internal-fixtures';
import { defineGroup, invoke } from './contract';

export const internalFixturesContract = defineGroup('internalFixtures', {
  retainTrack: invoke<[request: { relativePath: string }], { path: string }>(),
  recoverTrack: invoke<
    [request: { relativePath: string; previousPath: string }],
    { path: string | null }
  >(),
  materialize: invoke<
    [request: InternalAssemblyFixtureMaterializeRequest],
    InternalAssemblyFixtureMaterializeResult
  >().channel('internal-fixtures:materialize'),
  status: invoke<
    [request: InternalAssemblyFixtureStatusRequest],
    InternalAssemblyFixtureStatusResult
  >().channel('internal-fixtures:status'),
});
