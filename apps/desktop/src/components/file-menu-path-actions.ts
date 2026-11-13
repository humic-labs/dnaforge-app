import { openIntegratedTerminal } from '../features/terminal/terminal-events';
import { platform } from '../platform';

export function fileMenuPathActions(filePath: string, relativePath?: string | null) {
  const copy = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
    } catch (error) {
      console.error('[FileBrowser] Failed to copy path:', error);
    }
  };
  return {
    onOpenInTerminal: platform().terminal
      ? () => {
          void platform()
            .fs.stat(filePath)
            .then((stat) => {
              const cwd = stat.isDirectory
                ? filePath
                : filePath.replace(/[\\/][^\\/]*$/, '') || '/';
              openIntegratedTerminal(cwd);
            })
            .catch((error: unknown) => console.error('[Terminal] Could not open folder', error));
        }
      : undefined,
    onCopyPath: () => copy(filePath),
    onCopyRelativePath: relativePath ? () => copy(relativePath) : undefined,
    onRevealInFinder: async () => {
      try {
        await platform().shell.revealItemInDir(filePath);
      } catch (error) {
        console.error('[FileBrowser] Failed to reveal in Finder:', error);
      }
    },
  };
}
