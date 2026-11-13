import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { platform } from '../../platform';
import { openTerminalFile, type TerminalFileQuery } from './terminal-open-file';
import { COMMAND_IDS, type CommandRegistryContextValue } from '../../commands';
import { detectLinks, removeLinkQueryString } from './upstream/terminalLinkParsing';
import { OperatingSystem } from './upstream/platform';
import { convertLinkRangeToBuffer } from './upstream/link-range';
import { resolveTerminalLinkPath } from './upstream/terminal-link-path';
import { parseTerminalWords } from './upstream/terminal-word-links';

export interface TerminalDetectedLink extends ILink {
  kind?: 'search';
}

export function createTerminalFileLinkProvider(
  terminal: Terminal,
  currentDirectory: () => string,
  dispatchCommand: CommandRegistryContextValue['dispatchCommand'],
  report: (error: unknown) => void,
  userHome: () => string | undefined = () => undefined,
  onDocumentOpened: () => void = () => undefined,
  enabled: () => boolean = () => true,
  searchFiles?: (query: TerminalFileQuery) => void,
  wordSeparators: () => string = () => ' ()[]{}\',"`'
): ILinkProvider {
  const os = navigator.platform.startsWith('Win')
    ? OperatingSystem.Windows
    : OperatingSystem.Macintosh;
  return {
    provideLinks: (lineNumber, callback) => {
      if (!enabled()) {
        callback([]);
        return;
      }
      const buffer = terminal.buffer.active;
      let start = lineNumber - 1;
      while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;
      const lines: IBufferLine[] = [];
      let text = '';
      for (let index = start; index < buffer.length; index += 1) {
        const line = buffer.getLine(index);
        if (!line || (index > start && !line.isWrapped)) break;
        lines.push(line);
        text += line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
      }
      const cwd = currentDirectory();
      const home = userHome();
      const parsedLinks = detectLinks(text, os);
      void Promise.all(
        parsedLinks.map(async (parsed): Promise<ILink | null> => {
          let path = removeLinkQueryString(parsed.path.text);
          if (path.startsWith('file://')) {
            try {
              path = decodeURIComponent(new URL(path).pathname);
            } catch {
              return null;
            }
            if (os === OperatingSystem.Windows && /^\/[A-Za-z]:/.test(path)) path = path.slice(1);
          }
          if (/^[a-z]+:\/\//i.test(path)) return null;
          const resolved = resolveTerminalLinkPath(path, cwd, home);
          if (!resolved) return null;
          path = resolved;
          const stat = await platform()
            .fs.stat(path)
            .catch(() => null);
          if (!stat || (!stat.isFile && !stat.isDirectory)) return null;
          const end = parsed.suffix
            ? parsed.suffix.suffix.index + parsed.suffix.suffix.text.length
            : parsed.path.index + parsed.path.text.length;
          const range = convertLinkRangeToBuffer(
            lines,
            terminal.cols,
            {
              startLineNumber: 1,
              endLineNumber: 1,
              startColumn: parsed.path.index + 1,
              endColumn: end + 1,
            },
            start
          );
          return {
            text: text.slice(parsed.path.index, end),
            range,
            activate: (event) => {
              if (!enabled() || !(event.metaKey || event.ctrlKey)) return;
              if (stat.isDirectory) {
                dispatchCommand(COMMAND_IDS.workspaceRevealPath, {
                  source: 'ui',
                  payload: { path, openOutsideFolder: true },
                });
                return;
              }
              void openTerminalFile(
                path,
                { query: path, line: parsed.suffix?.row, column: parsed.suffix?.col },
                onDocumentOpened
              ).catch(report);
            },
          };
        })
      )
        .then((links) => {
          if (!enabled()) return callback([]);
          const detected: TerminalDetectedLink[] = links.filter(
            (link): link is ILink => link !== null
          );
          if (searchFiles)
            for (const word of parseTerminalWords(text, wordSeparators())) {
              if (/^[a-z][a-z\d+.-]*:\/\//i.test(word.text)) continue;
              const range = convertLinkRangeToBuffer(
                lines,
                terminal.cols,
                {
                  startLineNumber: 1,
                  endLineNumber: 1,
                  startColumn: word.startIndex + 1,
                  endColumn: word.endIndex + 1,
                },
                start
              );
              if (
                detected.some(
                  (link) =>
                    (range.start.y > link.range.start.y ||
                      (range.start.y === link.range.start.y &&
                        range.start.x >= link.range.start.x)) &&
                    (range.end.y < link.range.end.y ||
                      (range.end.y === link.range.end.y && range.end.x <= link.range.end.x))
                )
              )
                continue;
              const parsed = parsedLinks.find(
                (link) =>
                  link.path.index === word.startIndex &&
                  word.text.startsWith(link.path.text) &&
                  link.suffix?.row
              );
              const query: TerminalFileQuery = parsed
                ? { query: parsed.path.text, line: parsed.suffix?.row, column: parsed.suffix?.col }
                : { query: word.text };
              detected.push({
                text: word.text,
                kind: 'search',
                range,
                activate: (event) => {
                  if (enabled() && (event.metaKey || event.ctrlKey)) searchFiles(query);
                },
              });
            }
          callback(detected);
        })
        .catch(() => callback(undefined));
    },
  };
}
