import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type {
  NativeNotebookRequest,
  NotebookDocumentSnapshot,
} from '../../shared/notebook-document';
import type { NativeNotebookWorkingCopyOwner } from '../notebook-document-owner';
import type { MarkdownNotebookImporter } from '../markdown-notebook-import';
import { NativeDocumentCommandError } from '../../shared/native-document-error';
import { registerNotebookOwnerHandlers } from './notebook';

type ExecuteHandler = (
  event: { sender: WebContents },
  request: NativeNotebookRequest
) => Promise<NotebookDocumentSnapshot>;

const { handlers, capture } = vi.hoisted(() => ({
  handlers: new Map<string, ExecuteHandler>(),
  capture: vi.fn(),
}));
vi.mock('../../shared/ipc-contract', () => ({
  handleGroup: (_contract: unknown, implementation: { execute: ExecuteHandler }) => {
    handlers.set('execute', implementation.execute);
  },
  sendRendererIpc: vi.fn(),
}));
vi.mock('../analytics', () => ({ trackEvent: capture }));

describe('caught native notebook operation telemetry', () => {
  beforeEach(() => {
    handlers.clear();
    capture.mockReset();
  });

  it('records each rejected save attempt with its exact safe reason and preserves the error', async () => {
    const sender = { isDestroyed: () => false } as WebContents;
    const failure = new NativeDocumentCommandError(
      'NOTEBOOK_EXTERNAL_CONFLICT',
      'PRIVATE_NOTEBOOK /Users/private/notebook',
      false
    );
    const owner = {
      execute: vi.fn().mockRejectedValue(failure),
      subscribe: vi.fn(() => () => {}),
    } as NativeNotebookWorkingCopyOwner;
    registerNotebookOwnerHandlers(owner, () => sender, {} as MarkdownNotebookImporter);
    for (let index = 0; index < 8; index++) {
      await expect(
        handlers.get('execute')!(
          { sender },
          {
            documentId: 'PRIVATE_DOCUMENT',
            operation: { kind: 'capture-save' },
          }
        )
      ).rejects.toBe(failure);
    }
    const observations = capture.mock.calls.filter(
      ([event]) => event === 'notebook_operation_observed'
    );
    const failed = observations.filter(([, properties]) => properties.notebook_phase === 'failed');
    expect(failed).toHaveLength(8);
    expect(new Set(failed.map(([, properties]) => properties.operation_id)).size).toBe(8);
    for (const [, properties] of failed) {
      expect(properties).toMatchObject({
        feature_area: 'reliability',
        notebook_operation: 'capture-save',
        notebook_error_code: 'NOTEBOOK_EXTERNAL_CONFLICT',
        notebook_state_changed: 'no',
      });
      expect(
        observations.filter(([, candidate]) => candidate.operation_id === properties.operation_id)
      ).toHaveLength(2);
    }
    expect(JSON.stringify(observations)).not.toMatch(/PRIVATE|\/Users\/private/);
  });

  it('does not turn an observer failure into a notebook command failure', async () => {
    const sender = { isDestroyed: () => false } as WebContents;
    const snapshot = {
      documentId: 'PRIVATE_DOCUMENT',
      dirty: false,
      saving: false,
      readOnly: false,
      recovery: null,
    };
    capture.mockImplementation(() => {
      throw new Error('PRIVATE_OBSERVER');
    });
    const owner = {
      execute: vi.fn().mockResolvedValue(snapshot),
      subscribe: () => () => {},
    } as NativeNotebookWorkingCopyOwner;
    registerNotebookOwnerHandlers(owner, () => sender, {} as MarkdownNotebookImporter);
    await expect(
      handlers.get('execute')!(
        { sender },
        { documentId: 'PRIVATE_DOCUMENT', operation: { kind: 'inspect-copy' } }
      )
    ).resolves.toBe(snapshot);
  });
});
