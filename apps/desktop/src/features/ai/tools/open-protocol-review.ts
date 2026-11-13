import { resultTool } from '../../agent-bridge/public/tool-result';
import { runPaperTool, type PaperToolEffects } from './paper-tool-result';
import { z } from 'zod';
import { scientificPackageKindForMetaPath } from '../../../shared/scientific-package';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { useCanvasStore } from '../../canvas/public/store';
import { resolveMultiRootPath } from './path-utils';

export const openProtocolReviewSchema = z
  .object({
    pdfPath: z.string().min(1).max(500).describe('Project path to the literal source PDF.'),
    protocolPath: z
      .string()
      .min(1)
      .max(500)
      .describe('Project path to a native Protocol package metadata file.'),
    pdfLabel: z.string().max(200).optional().describe('Optional source-paper tab label.'),
    protocolLabel: z.string().max(200).optional().describe('Optional protocol tab label.'),
  })
  .strict();

export type OpenProtocolReviewInput = z.infer<typeof openProtocolReviewSchema>;

type OpenProtocolReviewResult = {
  pdfTabId: string;
  protocolTabId: string;
  pdfPanelId: string;
  protocolPanelId: string;
  chatPanelId: string;
};

function leafName(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

function requireFileKind(filePath: string, suffix: string, label: string): void {
  if (!filePath.toLowerCase().endsWith(suffix)) {
    throw new Error(`${label} must end with ${suffix}.`);
  }
}

function requireProtocolPath(filePath: string): void {
  if (
    scientificPackageKindForMetaPath(filePath) !== 'protocol' &&
    !filePath.toLowerCase().endsWith('.dnaforge-protocol.json')
  ) {
    throw new Error('protocolPath must identify a native Protocol package.');
  }
}

export function openProtocolReviewInCanvas(
  input: OpenProtocolReviewInput,
  folders: WorkspaceFolder[],
  effects?: PaperToolEffects
): OpenProtocolReviewResult {
  const pdfPath = resolveMultiRootPath(folders, input.pdfPath).absolutePath;
  const protocolPath = resolveMultiRootPath(folders, input.protocolPath).absolutePath;
  requireFileKind(pdfPath, '.pdf', 'pdfPath');
  requireProtocolPath(protocolPath);

  let store = useCanvasStore.getState();
  const chat = Object.entries(store.panels).find(([, panel]) =>
    panel.tabs.some((tab) => tab.type === 'chat')
  );
  const chatPanelId = chat?.[0] ?? store.focusedPanelId ?? Object.keys(store.panels)[0];
  if (!chatPanelId) throw new Error('No canvas panel is available.');

  effects?.attemptedMutation();
  const placement = store.agentContentPlacement(chatPanelId);
  let pdfPanelId = placement.targetPanelId;
  store = useCanvasStore.getState();

  const existingPdf = store.findTab('pdf', pdfPath);
  let pdfTabId: string;
  if (existingPdf) {
    pdfTabId = existingPdf.tabId;
    if (existingPdf.panelId !== pdfPanelId) {
      store.moveTab(existingPdf.panelId, pdfPanelId, existingPdf.tabId);
    }
  } else {
    pdfTabId = store.openTab(pdfPanelId, {
      type: 'pdf',
      entityId: pdfPath,
      label: input.pdfLabel ?? leafName(pdfPath),
    });
  }

  store = useCanvasStore.getState();
  const currentPdf = store.findTab('pdf', pdfPath);
  if (!currentPdf) throw new Error('The PDF tab could not be opened.');
  pdfPanelId = currentPdf.panelId;
  store.setActiveTab(pdfPanelId, currentPdf.tabId);

  const existingProtocol = store.findTab('scientific-document', protocolPath);
  let protocolPanelId: string;
  let protocolTabId: string;
  if (
    existingProtocol &&
    existingProtocol.panelId !== pdfPanelId &&
    existingProtocol.panelId !== chatPanelId
  ) {
    protocolPanelId = existingProtocol.panelId;
    protocolTabId = existingProtocol.tabId;
  } else {
    protocolPanelId = store.splitPanel(pdfPanelId, 'vertical');
    protocolTabId =
      existingProtocol?.tabId ??
      store.openTab(protocolPanelId, {
        type: 'scientific-document',
        entityId: protocolPath,
        label: input.protocolLabel ?? leafName(protocolPath),
      });
    if (existingProtocol) {
      useCanvasStore
        .getState()
        .moveTab(existingProtocol.panelId, protocolPanelId, existingProtocol.tabId);
    }
  }

  store = useCanvasStore.getState();
  const currentProtocol = store.findTab('scientific-document', protocolPath);
  if (!currentProtocol) throw new Error('The protocol tab could not be opened.');
  protocolPanelId = currentProtocol.panelId;
  protocolTabId = currentProtocol.tabId;
  store.setActiveTab(protocolPanelId, protocolTabId);

  const chatTab = store.panels[chatPanelId]?.tabs.find((tab) => tab.type === 'chat');
  if (chatTab) store.setActiveTab(chatPanelId, chatTab.id);
  store.focusPanel(chatPanelId);

  return { pdfTabId, protocolTabId, pdfPanelId, protocolPanelId, chatPanelId };
}

export function createOpenProtocolReviewTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Open a linked paper-to-protocol review workspace: keep this chat visible, render the literal source PDF in its own panel, and open the native protocol editor in a third panel. Reuses existing tabs and panels when possible.',
    inputSchema: openProtocolReviewSchema,
    execute: async (input: OpenProtocolReviewInput) =>
      runPaperTool('OPEN_PROTOCOL_REVIEW_FAILED', async (effects) =>
        openProtocolReviewInCanvas(input, folders, effects)
      ),
  });
}

export { openProtocolReviewOutputSchema } from './paper-output-schemas';
