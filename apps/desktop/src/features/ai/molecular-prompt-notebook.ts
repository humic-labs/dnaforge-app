import type { JSONContent } from '@tiptap/core';
import { useCanvasStore } from '../canvas/public/store';
import { usePageStore } from '../page/public/store';

export const MOLECULAR_PROMPT_NOTEBOOK_ID = 'page-protein-prompt-trials-v1';
export const MOLECULAR_PROMPT_NOTEBOOK_TITLE = 'Protein run comparison';

const OLD_TITLE = 'Protein visualization prompt trials';
const OLD_INTRO =
  'Each row is a recorded agent chat with a frozen question, coordinate fixture, and prompt variant. Open an output or its chat to inspect the exact run. The prompt column contains the trial-specific instructions saved at the start; the complete resolved agent system prompt was not recorded for these runs.';
const PREVIOUS_INTRO =
  'Compare saved scenes below. Run records are read-only; the review table is editable.';
const RECENT_INTRO = 'Compare saved runs and views below. Add your notes directly to this page.';
const PRIOR_INTRO = 'Only runs with captured prompts and scene rules appear below.';
const INTRO = 'Captured-prompt runs and reviewed reference views.';
const REVIEW_TABLE_REF_ID = 'protein-run-review-notes';

const notebookContent: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: MOLECULAR_PROMPT_NOTEBOOK_TITLE }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: INTRO,
        },
      ],
    },
    {
      type: 'embed',
      attrs: {
        type: 'protein-prompt-history',
        version: 1,
        refId: 'protein-prompt-history',
        data: { pageId: MOLECULAR_PROMPT_NOTEBOOK_ID },
      },
    },
    { type: 'paragraph' },
  ],
};

function nodeText(node: JSONContent): string {
  return (node.content ?? []).map((part) => part.text ?? '').join('');
}

export function upgradedMolecularPromptNotebookContent(content: JSONContent): JSONContent | null {
  if (content.type !== 'doc' || !Array.isArray(content.content)) return null;
  const hasRunIndex = content.content.some(
    (node) => node.type === 'embed' && node.attrs?.refId === 'protein-prompt-history'
  );
  if (!hasRunIndex) return null;

  let changed = false;
  const nodes = content.content.map((node) => {
    if (node.type === 'heading' && nodeText(node) === OLD_TITLE) {
      changed = true;
      return { ...node, content: [{ type: 'text', text: MOLECULAR_PROMPT_NOTEBOOK_TITLE }] };
    }
    if (
      node.type === 'paragraph' &&
      [OLD_INTRO, PREVIOUS_INTRO, RECENT_INTRO, PRIOR_INTRO].includes(nodeText(node))
    ) {
      changed = true;
      return { ...node, content: [{ type: 'text', text: INTRO }] };
    }
    return node;
  });

  const reviewIndex = nodes.findIndex(
    (node) => node.type === 'embed' && node.attrs?.refId === REVIEW_TABLE_REF_ID
  );
  const review = reviewIndex >= 0 ? nodes[reviewIndex] : null;
  const cells: unknown = review?.attrs?.data?.cells;
  const isBlankGeneratedReview =
    Array.isArray(cells) &&
    cells.length > 0 &&
    cells.every(
      (row) =>
        Array.isArray(row) && row.every((cell) => cell?.type === 'text' && cell?.value === '')
    );
  if (reviewIndex >= 0 && isBlankGeneratedReview) {
    nodes.splice(reviewIndex, 1);
    if (
      nodes[reviewIndex - 1]?.type === 'heading' &&
      nodeText(nodes[reviewIndex - 1]) === 'Review notes'
    )
      nodes.splice(reviewIndex - 1, 1);
    if (nodes[nodes.length - 1]?.type === 'embed') nodes.push({ type: 'paragraph' });
    changed = true;
  }
  return changed ? { ...content, content: nodes } : null;
}

export async function ensureMolecularPromptNotebookCurrent(): Promise<void> {
  const store = usePageStore.getState();
  await store.initialize();
  const page = await store.fetchPage(MOLECULAR_PROMPT_NOTEBOOK_ID);
  if (!page || usePageStore.getState().dirtyIds.has(page.id)) return;
  const upgraded = upgradedMolecularPromptNotebookContent(page.content);
  if (upgraded) await store.savePage(page.id, upgraded);
  if (page.title === OLD_TITLE) {
    await store.updatePageTitle(page.id, MOLECULAR_PROMPT_NOTEBOOK_TITLE);
    const tab = useCanvasStore.getState().findTab('page', page.id);
    if (tab)
      useCanvasStore.getState().updateTab(tab.panelId, tab.tabId, {
        label: MOLECULAR_PROMPT_NOTEBOOK_TITLE,
      });
  }
}

export async function openMolecularPromptNotebook(
  sourceConversationId: string | null
): Promise<void> {
  const pageStore = usePageStore.getState();
  await pageStore.initialize();
  const existingPage = await pageStore.fetchPage(MOLECULAR_PROMPT_NOTEBOOK_ID);
  if (!existingPage) {
    await pageStore.createPage(MOLECULAR_PROMPT_NOTEBOOK_TITLE, MOLECULAR_PROMPT_NOTEBOOK_ID);
    await pageStore.savePage(MOLECULAR_PROMPT_NOTEBOOK_ID, notebookContent);
  } else {
    await ensureMolecularPromptNotebookCurrent();
  }

  const canvas = useCanvasStore.getState();
  const existingTab = canvas.findTab('page', MOLECULAR_PROMPT_NOTEBOOK_ID);
  if (existingTab) {
    canvas.setActiveTab(existingTab.panelId, existingTab.tabId);
    canvas.focusPanel(existingTab.panelId);
    return;
  }
  const chatPanel = sourceConversationId ? canvas.findTab('chat', sourceConversationId) : null;
  const panelId = chatPanel?.panelId ?? canvas.focusedPanelId ?? Object.keys(canvas.panels)[0];
  if (!panelId) throw new Error('No canvas panel is available for the trial notebook.');
  const tabId = canvas.openTab(panelId, {
    type: 'page',
    entityId: MOLECULAR_PROMPT_NOTEBOOK_ID,
    label: MOLECULAR_PROMPT_NOTEBOOK_TITLE,
  });
  if (!tabId) throw new Error('Could not open the trial notebook tab.');
  canvas.focusPanel(panelId);
}
