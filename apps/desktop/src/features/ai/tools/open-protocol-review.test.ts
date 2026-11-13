import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { openProtocolReviewOutputSchema } from './paper-output-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { useCanvasStore } from '../../canvas/store';
import { execTool, mockUUID, resetCanvasStore } from './test-helpers';
import { createOpenProtocolReviewTool } from './open-protocol-review';

mockUUID();

const folders: WorkspaceFolder[] = [{ name: 'project', path: '/Users/me/project', addedAt: 1 }];

beforeEach(() => resetCanvasStore());

describe('open_protocol_review tool', () => {
  it('opens chat, the literal PDF, and the native protocol in three visible panels', async () => {
    useCanvasStore
      .getState()
      .openTab('main', { type: 'chat', entityId: 'conversation-1', label: 'Chat' });

    const result = await execTool<{
      pdfPanelId: string;
      protocolPanelId: string;
      chatPanelId: string;
    }>(createOpenProtocolReviewTool(folders), {
      pdfPath: 'papers/source.pdf',
      protocolPath: 'Protocols/Source/.forge/protocol.json',
    });

    assertMcpOutput(openProtocolReviewOutputSchema, result);
    const state = useCanvasStore.getState();
    expect(Object.keys(state.panels)).toHaveLength(3);
    expect(result.chatPanelId).toBe('main');
    expect(result.pdfPanelId).not.toBe(result.protocolPanelId);
    expect(state.panels.main.tabs).toEqual([expect.objectContaining({ type: 'chat' })]);
    expect(state.panels[result.pdfPanelId].tabs).toEqual([
      expect.objectContaining({ type: 'pdf', entityId: '/Users/me/project/papers/source.pdf' }),
    ]);
    expect(state.panels[result.protocolPanelId].tabs).toEqual([
      expect.objectContaining({
        type: 'scientific-document',
        entityId: '/Users/me/project/Protocols/Source/.forge/protocol.json',
      }),
    ]);
    expect(state.focusedPanelId).toBe('main');
  });

  it('reuses the same review panels and tabs on repeated calls', async () => {
    useCanvasStore
      .getState()
      .openTab('main', { type: 'chat', entityId: 'conversation-1', label: 'Chat' });
    const reviewTool = createOpenProtocolReviewTool(folders);
    const input = {
      pdfPath: 'papers/source.pdf',
      protocolPath: 'protocols/source.dnaforge-protocol.json',
    };

    const first = await execTool<{ pdfTabId: string; protocolTabId: string }>(reviewTool, input);
    const second = await execTool<{ pdfTabId: string; protocolTabId: string }>(reviewTool, input);

    const state = useCanvasStore.getState();
    expect(Object.keys(state.panels)).toHaveLength(3);
    expect(second).toMatchObject(first);
    expect(Object.values(state.panels).flatMap((panel) => panel.tabs)).toHaveLength(3);
  });

  it('rejects files with the wrong document kinds', async () => {
    useCanvasStore
      .getState()
      .openTab('main', { type: 'chat', entityId: 'conversation-1', label: 'Chat' });
    const reviewTool = createOpenProtocolReviewTool(folders);

    await expect(
      execTool(reviewTool, {
        pdfPath: 'papers/source.txt',
        protocolPath: 'protocols/source.dnaforge-protocol.json',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching('pdfPath must end with .pdf'),
      stateChanged: false,
      partialEffects: [],
    });
  });
});
