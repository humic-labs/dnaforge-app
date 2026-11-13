import { useEffect, useMemo, useState } from 'react';
import { platform } from '../platform';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.dnaforge', 'dist', 'out']);
const MAX_FILES = 2500;
const MAX_DEPTH = 6;

export interface GoToFileDialogProps {
  folders: readonly { path: string }[];
  onOpen: (path: string) => void;
  onClose: () => void;
}

interface ListedFile {
  path: string;
  name: string;
}

async function listFiles(root: string): Promise<ListedFile[]> {
  const found: ListedFile[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (queue.length > 0 && found.length < MAX_FILES) {
    const current = queue.shift();
    if (!current || current.depth > MAX_DEPTH) continue;
    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }> = [];
    try {
      entries = await platform().fs.readDir(current.path);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const child = `${current.path.replace(/[\\/]$/, '')}/${entry.name}`;
      if (entry.isDirectory) {
        if (!SKIP_DIRS.has(entry.name)) queue.push({ path: child, depth: current.depth + 1 });
      } else if (entry.isFile) {
        found.push({ path: child, name: entry.name });
        if (found.length >= MAX_FILES) break;
      }
    }
  }
  return found;
}

export function GoToFileDialog({ folders, onOpen, onClose }: GoToFileDialogProps) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<ListedFile[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(folders.map((folder) => listFiles(folder.path))).then((groups) => {
      if (cancelled) return;
      setFiles(groups.flat().sort((a, b) => a.name.localeCompare(b.name)));
    });
    return () => {
      cancelled = true;
    };
  }, [folders]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return files.slice(0, 40);
    return files.filter((file) => file.path.toLowerCase().includes(needle)).slice(0, 40);
  }, [files, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const openActive = () => {
    const file = matches[active];
    if (!file) return;
    onOpen(file.path);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label="Go to file"
        className="w-[min(560px,92vw)] overflow-hidden rounded-lg border border-border bg-bg shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, Math.max(matches.length - 1, 0)));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              openActive();
            }
          }}
          placeholder="Go to file"
          aria-label="File name"
          className="w-full border-b border-border bg-bg px-3 py-2.5 text-sm text-fg outline-none"
        />
        <ul className="max-h-80 overflow-auto py-1">
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-xs text-fg-subtle">No files match.</li>
          ) : (
            matches.map((file, index) => (
              <li key={file.path}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => {
                    onOpen(file.path);
                    onClose();
                  }}
                  className={`flex w-full flex-col items-start px-3 py-1.5 text-left ${
                    index === active ? 'bg-bg-muted' : ''
                  }`}
                >
                  <span className="text-sm text-fg">{file.name}</span>
                  <span className="max-w-full truncate text-[11px] text-fg-subtle">
                    {file.path}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
