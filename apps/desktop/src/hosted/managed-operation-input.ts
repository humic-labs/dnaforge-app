import type { OperationAcceptedWorkspaceInput } from '@waypoint/api-client';
import type { WorkspaceSessionControllerState } from '@waypoint/domain-services';
import { workspaceSyncManifestHashInput } from '@waypoint/share-bundle/protocol';
import type { ManagedOperationInputFile } from '../services/managed-operations';
import { sha256Hex } from './api';
import { parseHostedFsPath } from './paths';
import type { HostedSyncRecord } from './sync-store';

interface InputAuthority {
  getState(): WorkspaceSessionControllerState;
  flush(workspaceId: string): Promise<void>;
  load(accountId: string, workspaceId: string): Promise<HostedSyncRecord | undefined>;
  subscribe(listener: () => void): () => void;
}

export function createHostedAcceptedInputResolver(
  workspaceId: string,
  authority: InputAuthority,
  { requireSettledWorkspace = false }: { requireSettledWorkspace?: boolean } = {}
) {
  return async (
    inputs: readonly ManagedOperationInputFile[]
  ): Promise<OperationAcceptedWorkspaceInput> => {
    const accountId = authority.getState().principal?.id;
    const assertSession = () => {
      const current = authority.getState();
      if (
        !accountId ||
        current.principal?.id !== accountId ||
        current.activeWorkspaceId !== workspaceId
      ) {
        throw new Error('The account or project changed. Reopen the alignment before starting it.');
      }
    };
    assertSession();
    if (inputs.length === 0) throw new Error('Saved input files are required for hosted jobs.');
    const snapshot = authority.getState().snapshot;
    const expectedFiles = inputs.map(({ key, path }) => {
      const location = parseHostedFsPath(path);
      const file =
        location?.workspaceId === workspaceId && snapshot?.workspaceId === workspaceId
          ? snapshot.files.find((candidate) => candidate.path === location.relativePath)
          : undefined;
      if (!file?.resourceId || !file.contentSha256)
        throw new Error('An alignment input is not a saved file in this project.');
      return { key, ...file };
    });
    const ready = (record: HostedSyncRecord | undefined): boolean =>
      !!record?.accepted.revisionId &&
      (!requireSettledWorkspace || record.operations.length === 0) &&
      !record.operations.some(
        (operation) => operation.state === 'blocked' || operation.state === 'conflict'
      ) &&
      expectedFiles.every((expected) =>
        record.accepted.files.some(
          (file) =>
            file.path === expected.path &&
            file.resourceId === expected.resourceId &&
            file.contentSha256 === expected.contentSha256 &&
            file.sizeBytes === expected.sizeBytes
        )
      );

    let flushFailure: { error: unknown } | undefined;
    void authority.flush(workspaceId).catch((error: unknown) => {
      flushFailure = { error };
    });
    assertSession();
    const deadline = Date.now() + 30_000;
    let record = await authority.load(accountId!, workspaceId);
    while (!ready(record)) {
      assertSession();
      if (flushFailure) throw flushFailure.error;
      if (
        !record?.operations.length ||
        record.operations.some(
          (operation) => operation.state === 'blocked' || operation.state === 'conflict'
        ) ||
        Date.now() >= deadline
      )
        break;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        };
        const timer = setTimeout(finish, Math.min(1_000, deadline - Date.now()));
        const unsubscribe = authority.subscribe(finish);
      });
      record = await authority.load(accountId!, workspaceId);
    }
    assertSession();
    if (flushFailure) throw flushFailure.error;
    if (!record || !ready(record)) {
      throw new Error(
        'Save and sync your input files before starting this job. Resolve any pending sync conflict first.'
      );
    }
    const accepted = record.accepted;
    const files = expectedFiles.map(({ key, path }) => {
      const file = accepted.files.find((candidate) => candidate.path === path)!;
      return {
        key,
        resource_id: file.resourceId!,
        path: file.path,
        content_sha256: file.contentSha256!,
        size_bytes: file.sizeBytes,
      };
    });
    const manifestFiles = accepted.files.map((file) => {
      if (!file.contentSha256)
        throw new Error('The saved project is missing a file integrity claim.');
      return { ...file, contentSha256: file.contentSha256 };
    });
    const manifestSha256 = await sha256Hex(
      new TextEncoder().encode(
        workspaceSyncManifestHashInput({ schemaVersion: 1, files: manifestFiles })
      )
    );
    assertSession();
    return {
      workspace_id: workspaceId,
      version_id: accepted.revisionId!,
      manifest_sha256: manifestSha256,
      files,
    };
  };
}
