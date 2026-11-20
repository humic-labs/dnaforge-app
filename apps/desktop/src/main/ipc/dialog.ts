import { rememberSelectedPreviewFile } from '../selected-preview-files';
import { handleGroup, mainIpc } from '../../shared/ipc-contract';
import { dialog, BrowserWindow } from 'electron';
import {
  issueLocalIndexedTrackAuthority,
  registerSelectedLocalIndexedTrackPaths,
} from '../local-indexed-track-authority';
import { sidecarSessionAuthority } from '../sidecar-session-runtime';
import { withSequencePackageSavePicker } from '../sequence-package-save-picker';
import { dialogContract } from '../../shared/ipc/dialog.contract';

export function registerDialogHandlers(): void {
  mainIpc.on('file-association:native-drop', (event, path) => {
    if (event.senderFrame === event.sender.mainFrame && BrowserWindow.fromWebContents(event.sender))
      rememberSelectedPreviewFile(path);
  });
  handleGroup(dialogContract, {
    open: async (event, options) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      const properties: Electron.OpenDialogOptions['properties'] = [];

      if (options.fileOrDirectory) properties.push('openFile', 'openDirectory');
      else if (options.directory) properties.push('openDirectory');
      else properties.push('openFile');
      if (options.multiple) properties.push('multiSelections');

      const result = await dialog.showOpenDialog(win, {
        title: options.title,
        properties,
        filters: options.filters,
      });

      if (result.canceled) return null;
      registerSelectedLocalIndexedTrackPaths(result.filePaths);
      for (const path of result.filePaths) rememberSelectedPreviewFile(path);
      return options.multiple ? result.filePaths : (result.filePaths[0] ?? null);
    },
    authorizeLocalIndexedTrack: async (_event, request) => {
      await sidecarSessionAuthority.waitForReadySnapshot();
      return issueLocalIndexedTrackAuthority(request);
    },
    save: async (event, options) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      const packagePicker = options.purpose === 'edited-sequence-package';
      const show = () =>
        dialog.showSaveDialog(win, {
          ...(packagePicker ? { title: 'Save Edited Sequence Package' } : {}),
          defaultPath: options.defaultPath,
          filters: options.filters,
        });
      const result = packagePicker
        ? await withSequencePackageSavePicker(event.sender, show)
        : await show();
      return result.canceled ? null : (result.filePath ?? null);
    },
  });
}
