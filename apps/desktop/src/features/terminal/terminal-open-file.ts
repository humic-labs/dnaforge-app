import { openDocument } from '../document-opening/public/open-document';
import { useCanvasStore } from '../canvas/public/store';

export interface TerminalFileQuery {
  query: string;
  line?: number;
  column?: number;
}

export function parseTerminalFileQuery(text: string): TerminalFileQuery {
  const normalized = text.trim();
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(normalized);
  const line = Number(match?.[2]);
  const column = match?.[3] ? Number(match[3]) : undefined;
  return match &&
    Number.isSafeInteger(line) &&
    line >= 1 &&
    (column === undefined || (Number.isSafeInteger(column) && column >= 1))
    ? { query: match[1]!, line, column }
    : { query: normalized };
}

export function terminalFileQueryCandidates(text: string): TerminalFileQuery[] {
  const literal = { query: text.trim() };
  const normalized = parseTerminalFileQuery(
    text
      .trim()
      .replace(/:[^\\/\d][^\d]*$/, '')
      .replace(/\.$/, '')
  );
  return literal.query === normalized.query && normalized.line === undefined
    ? [literal]
    : [literal, normalized];
}

export async function openTerminalFile(
  path: string,
  query: TerminalFileQuery,
  onOpened: () => void
): Promise<void> {
  const result = await openDocument({ target: { kind: 'file', path } });
  if (result.status !== 'presented') return;
  onOpened();
  if (!query.line) return;
  const canvas = useCanvasStore.getState();
  const panel = Object.values(canvas.panels).find((candidate) =>
    candidate.tabs.some((tab) => tab.id === result.tabId)
  );
  if (panel)
    canvas.setTabViewState(panel.id, result.tabId, {
      textCursor: { line: query.line, column: query.column ?? 1, requestId: crypto.randomUUID() },
    });
}
