import { createHash } from 'node:crypto';
import { act, fireEvent, getConfig, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAttachmentManifest } from '../shared/agent-attachments';
import {
  FullChatView,
  getFullChatViewHarness,
  platform,
  resetFullChatViewHarness,
} from './FullChatView.test-harness';

const { mockAISettingsState, mockChatState } = getFullChatViewHarness();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function attachment(index: number, size = 7): AgentAttachmentManifest {
  const sha256 = createHash('sha256').update(`count-${index}`).digest('hex');
  return {
    id: `attachment-${sha256}`,
    sha256,
    name: `count-${index}.txt`,
    kind: 'text',
    mediaType: 'text/plain',
    size,
  };
}

function installCaptures(manifests: AgentAttachmentManifest[]) {
  type Result = Awaited<ReturnType<ReturnType<typeof platform>['agentAttachments']['capture']>>;
  const calls = manifests.map(() => ({ started: deferred<void>(), result: deferred<Result>() }));
  const capture = vi.fn<ReturnType<typeof platform>['agentAttachments']['capture']>(({ path }) => {
    const index = Number(path.match(/drop-(\d+)\.txt$/)?.[1]) - 1;
    if (!calls[index]) throw new Error(`Unexpected attachment path: ${path}`);
    calls[index].started.resolve();
    return calls[index].result.promise;
  });
  const current = platform();
  vi.mocked(platform).mockReturnValue({
    ...current,
    agentAttachments: { ...current.agentAttachments, capture },
  });
  return { calls, capture };
}

function drop(composer: HTMLElement, index: number) {
  const name = `drop-${index}.txt`;
  const file = new File([`drop-${index}`], name, { type: 'text/plain' });
  Object.defineProperty(file, 'path', { value: `/workspace/${name}` });
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { files: [file], types: ['Files'] },
  });
  composer.dispatchEvent(event);
}

async function burst(
  composer: HTMLElement,
  manifests: AgentAttachmentManifest[],
  calls: ReturnType<typeof installCaptures>['calls']
) {
  vi.stubGlobal('event', undefined);
  try {
    await getConfig().asyncWrapper(async () => {
      for (let index = 0; index < manifests.length; index += 1) {
        drop(composer, index + 1);
        if (index < manifests.length - 2) {
          await calls[index].started.promise;
          calls[index].result.resolve({ ok: true, attachment: manifests[index] });
          await calls[index].result.promise;
          for (let microtask = 0; microtask < 10; microtask += 1) await Promise.resolve();
        }
      }
      for (let index = Math.max(0, manifests.length - 2); index < manifests.length; index += 1) {
        await calls[index].started.promise;
        calls[index].result.resolve({ ok: true, attachment: manifests[index] });
        await calls[index].result.promise;
        for (let microtask = 0; microtask < 10; microtask += 1) await Promise.resolve();
      }
    });
    await act(async () => {});
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('FullChatView attachment admission during consecutive drops', () => {
  beforeEach(() => {
    resetFullChatViewHarness();
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.agentTransport = 'codex-sdk';
    mockChatState.currentConversationId = 'other-conversation';
    mockChatState.conversations = [
      { id: 'visible-conversation', title: 'Visible conversation', workspacePath: '/workspace' },
      { id: 'other-conversation', title: 'Other conversation', workspacePath: '/other-workspace' },
    ] as typeof mockChatState.conversations;
    mockChatState.setComposerDraft.mockImplementation((id, draft) => {
      mockChatState.composerDrafts.set(id, draft);
    });
  });

  it('retains the first eight distinct captures and sends their exact visible-conversation draft', async () => {
    const manifests = Array.from({ length: 9 }, (_, index) => attachment(index + 1));
    const { calls, capture } = installCaptures(manifests);
    mockChatState.composerDrafts.set('visible-conversation', {
      text: 'Keep these exact attachment snapshots.',
      attachments: [],
      references: [],
    });
    render(<FullChatView workspacePath="/workspace" conversationId="visible-conversation" />);
    expect(screen.getByTestId('ai-input')).toHaveValue('Keep these exact attachment snapshots.');

    await burst(screen.getByTestId('chat-composer'), manifests, calls);

    expect(capture.mock.calls.map(([request]) => request.path)).toEqual(
      manifests.map((_, index) => `/workspace/drop-${index + 1}.txt`)
    );
    expect(screen.getAllByText(/^count-\d+\.txt$/).map((node) => node.textContent)).toEqual(
      manifests.slice(0, 8).map((file) => file.name)
    );
    expect(screen.queryByText('count-9.txt', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-error')).toHaveTextContent('at most 8 files');
    expect(mockChatState.composerDrafts.get('visible-conversation')).toMatchObject({
      text: 'Keep these exact attachment snapshots.',
      attachments: manifests.slice(0, 8),
    });
    expect(mockChatState.composerDrafts.has('other-conversation')).toBe(false);
    expect(mockChatState.currentConversationId).toBe('other-conversation');

    fireEvent.click(screen.getByTestId('chat-send-button'));
    await waitFor(() => expect(mockChatState.sendMessage).toHaveBeenCalledOnce());
    expect(mockChatState.sendMessage).toHaveBeenCalledWith(
      'Keep these exact attachment snapshots.',
      '/workspace',
      'visible-conversation',
      [],
      expect.objectContaining({ attachments: manifests.slice(0, 8) })
    );
  });

  it('deduplicates identical immutable snapshots without consuming another admission slot', async () => {
    const first = attachment(1);
    const manifests = [first, first, attachment(2)];
    const { calls, capture } = installCaptures(manifests);
    render(<FullChatView workspacePath="/workspace" conversationId="visible-conversation" />);

    await burst(screen.getByTestId('chat-composer'), manifests, calls);

    expect(capture).toHaveBeenCalledTimes(3);
    expect(screen.getAllByText(/^count-\d+\.txt$/).map((node) => node.textContent)).toEqual([
      'count-1.txt',
      'count-2.txt',
    ]);
    expect(screen.queryByTestId('ai-error')).not.toBeInTheDocument();
    expect(mockChatState.composerDrafts.get('visible-conversation')?.attachments).toEqual([
      first,
      manifests[2],
    ]);
  });

  it('retains four distinct 1 MiB snapshots and rejects the next byte', async () => {
    const manifests = Array.from({ length: 5 }, (_, index) =>
      attachment(index + 1, index < 4 ? 1024 * 1024 : 1)
    );
    const { calls } = installCaptures(manifests);
    render(<FullChatView workspacePath="/workspace" conversationId="visible-conversation" />);

    await burst(screen.getByTestId('chat-composer'), manifests, calls);

    expect(screen.getAllByText(/^count-\d+\.txt$/).map((node) => node.textContent)).toEqual(
      manifests.slice(0, 4).map((file) => file.name)
    );
    expect(screen.queryByText('count-5.txt', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-error')).toHaveTextContent('4 MiB or smaller in total');
    expect(mockChatState.composerDrafts.get('visible-conversation')?.attachments).toEqual(
      manifests.slice(0, 4)
    );
  });
});
