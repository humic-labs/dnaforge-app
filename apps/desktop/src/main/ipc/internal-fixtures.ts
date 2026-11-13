import { app } from 'electron';
import { join } from 'node:path';
import { handleGroup } from '../../shared/ipc-contract';
import { registerSelectedLocalIndexedTrackPaths } from '../local-indexed-track-authority';
import { retainTrackSource } from '../retained-track-source';
import { INTERNAL_TRACK_FIXTURES } from '../../shared/internal-track-fixtures';
import { internalTrackFixturePath, missingInternalTrackPath } from '../internal-track-recovery';

import type {
  InternalAssemblyFixtureMaterializeRequest,
  InternalAssemblyFixtureMaterializeResult,
  InternalAssemblyFixtureStatusRequest,
  InternalAssemblyFixtureStatusResult,
} from '../../shared/internal-fixtures';
import { internalFixturesContract } from '../../shared/ipc/internal-fixtures.contract';

declare const __INTERNAL_FIXTURES_ENABLED__: boolean | undefined;

const INTERNAL_FIXTURES_ENABLED =
  typeof __INTERNAL_FIXTURES_ENABLED__ === 'boolean' && __INTERNAL_FIXTURES_ENABLED__;

export function registerInternalFixtureHandlers(): void {
  handleGroup(internalFixturesContract, {
    retainTrack: async (_event, request) => {
      if (!INTERNAL_FIXTURES_ENABLED || app.isPackaged)
        throw new Error('Retaining internal track fixtures is only available in development.');
      const fixture = Object.values(INTERNAL_TRACK_FIXTURES).find(
        (item) => item.relativePath === request.relativePath
      );
      if (!fixture) throw new Error('Unknown internal track fixture.');
      const path = await retainTrackSource(join(app.getPath('userData'), 'Track assets'), {
        path: internalTrackFixturePath([process.cwd(), app.getAppPath()], fixture.relativePath),
        sha256: fixture.sha256,
        sizeBytes: fixture.sizeBytes,
      });
      registerSelectedLocalIndexedTrackPaths([path]);
      return { path };
    },
    recoverTrack: async (_event, request) => {
      if (!INTERNAL_FIXTURES_ENABLED || app.isPackaged)
        throw new Error('Recovering internal track fixtures is only available in development.');
      const fixture = Object.values(INTERNAL_TRACK_FIXTURES).find(
        (item) => item.relativePath === request.relativePath
      );
      if (!fixture) throw new Error('Unknown internal track fixture.');
      if (!(await missingInternalTrackPath(request.previousPath, fixture.relativePath)))
        return { path: null };
      const path = await retainTrackSource(join(app.getPath('userData'), 'Track assets'), {
        path: internalTrackFixturePath([process.cwd(), app.getAppPath()], fixture.relativePath),
        sha256: fixture.sha256,
        sizeBytes: fixture.sizeBytes,
      });
      registerSelectedLocalIndexedTrackPaths([path]);
      return { path };
    },
    materialize: async (
      _event,
      request: InternalAssemblyFixtureMaterializeRequest
    ): Promise<InternalAssemblyFixtureMaterializeResult> => {
      if (!INTERNAL_FIXTURES_ENABLED || app.isPackaged) {
        throw new Error('Internal assembly fixture loaders are only available in development.');
      }

      const modules = (
        import.meta as ImportMeta & {
          glob: (pattern: string) => Record<string, () => Promise<unknown>>;
        }
      ).glob('../../../../../scripts/lib/assembly-fixtures/materialize-assembly-fixtures.ts');
      const load =
        modules['../../../../../scripts/lib/assembly-fixtures/materialize-assembly-fixtures.ts'];
      if (!load) throw new Error('Internal fixture materializer is unavailable.');
      const { materializeInternalAssemblyFixtureLibrary } = (await load()) as {
        materializeInternalAssemblyFixtureLibrary: (
          request: InternalAssemblyFixtureMaterializeRequest
        ) =>
          | Promise<InternalAssemblyFixtureMaterializeResult>
          | InternalAssemblyFixtureMaterializeResult;
      };
      return materializeInternalAssemblyFixtureLibrary(request);
    },
    status: async (
      _event,
      request: InternalAssemblyFixtureStatusRequest
    ): Promise<InternalAssemblyFixtureStatusResult> => {
      if (!INTERNAL_FIXTURES_ENABLED || app.isPackaged) {
        throw new Error('Internal assembly fixture loaders are only available in development.');
      }
      const { getInternalAssemblyFixtureLibraryStatus } =
        await import('../internal-fixtures/internal-fixture-cache');
      return getInternalAssemblyFixtureLibraryStatus(request);
    },
  });
}
