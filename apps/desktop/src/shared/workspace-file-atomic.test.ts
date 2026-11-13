// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  serializeWorkspaceTextFileAtomicWriteFailure,
  unwrapWorkspaceTextFileAtomicWriteResponse,
  type WorkspaceTextFileAtomicWriteResponse,
} from './workspace-file-atomic';

describe('workspace atomic-write Electron IPC contract', () => {
  it('preserves a surviving temporary file through structured-clone serialization', () => {
    const mainProcessError = Object.assign(new Error('simulated commit outage'), {
      code: 'EIO',
      partialEffects: [
        {
          kind: 'temporary-workspace-file',
          path: '/workspace/selection.json.tmp-orphan',
          cleanupError: 'simulated cleanup outage',
        },
      ],
    });

    const rendererResponse = structuredClone(
      serializeWorkspaceTextFileAtomicWriteFailure(mainProcessError)
    ) as WorkspaceTextFileAtomicWriteResponse;

    expect(() => unwrapWorkspaceTextFileAtomicWriteResponse(rendererResponse)).toThrowError(
      expect.objectContaining({
        name: 'Error',
        message: 'simulated commit outage',
        code: 'EIO',
        partialEffects: [
          {
            kind: 'temporary-workspace-file',
            path: '/workspace/selection.json.tmp-orphan',
            cleanupError: 'simulated cleanup outage',
          },
        ],
      })
    );
  });

  it('returns a successful atomic write unchanged after structured clone', () => {
    const rendererResponse = structuredClone({
      ok: true,
      result: {
        path: '/workspace/selection.json',
        contentHash: 'sha256',
        cleanupWarning: 'temporary cleanup deferred',
      },
    }) as WorkspaceTextFileAtomicWriteResponse;

    expect(unwrapWorkspaceTextFileAtomicWriteResponse(rendererResponse)).toEqual({
      path: '/workspace/selection.json',
      contentHash: 'sha256',
      cleanupWarning: 'temporary cleanup deferred',
    });
  });
});
