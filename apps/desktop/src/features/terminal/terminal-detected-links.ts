import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { LinkComputer, strictUrlRegex } from './upstream/terminal-web-links';
import type { TerminalDetectedLink } from './terminal-links';

export interface DetectedTerminalLinks {
  links: TerminalDetectedLink[];
  atLimit: boolean;
}

function localLinks(provider: ILinkProvider, row: number, signal: AbortSignal): Promise<ILink[]> {
  return new Promise((resolve, reject) => {
    const finish = (links?: ILink[]) => {
      signal.removeEventListener('abort', cancel);
      resolve(links ?? []);
    };
    const cancel = () => finish();
    if (signal.aborted) return finish();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      provider.provideLinks(row, finish);
    } catch (error) {
      signal.removeEventListener('abort', cancel);
      reject(error);
    }
  });
}

export async function collectTerminalLinks(
  terminal: Pick<Terminal, 'buffer' | 'rows'>,
  provider: ILinkProvider,
  signal: AbortSignal,
  all: boolean,
  openWebLink: (event: MouseEvent, uri: string) => void
): Promise<DetectedTerminalLinks> {
  const buffer = terminal.buffer.active;
  const start = all ? 0 : buffer.viewportY;
  const end = all ? buffer.length : Math.min(buffer.length, start + terminal.rows);
  const found = new Map<string, ILink>();
  for (let cursor = end - 1; cursor >= start; cursor -= 8) {
    if (signal.aborted) return { links: [], atLimit: false };
    const rows = Array.from({ length: Math.min(8, cursor - start + 1) }, (_, i) => cursor - i);
    const batches = await Promise.all(
      rows.map(async (row) => {
        const web = LinkComputer.computeLink(row + 1, strictUrlRegex, terminal, openWebLink);
        const local =
          row === end - 1 || !buffer.getLine(row + 1)?.isWrapped
            ? await localLinks(provider, row + 1, signal)
            : [];
        return [...web, ...local];
      })
    );
    if (signal.aborted) return { links: [], atLimit: false };
    for (const links of batches)
      for (const link of links) {
        if (!found.has(link.text)) found.set(link.text, link);
        if (found.size >= 1000) return { links: [...found.values()], atLimit: true };
      }
    if ((end - cursor) % 64 === 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return {
    links: [...found.values()].sort(
      (a, b) => b.range.start.y - a.range.start.y || b.range.start.x - a.range.start.x
    ),
    atLimit: false,
  };
}
