import { app, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { googleSpreadsheetIdSchema, googleWorksheetIdSchema } from '../../shared/google-sheets';
import { googleSheetsContract } from '../../shared/ipc/google-sheets.contract';
import { handleGroup, sendRendererIpc } from '../../shared/ipc-contract';
import { subscribeAuthState } from '../auth/controller';
import { createNativeGoogleSheetsController } from '../google-sheets/native';
import type { GoogleSheetsController } from '../google-sheets/controller';
import { isTrustedRendererUrl } from '../security';

const requestSchema = z
  .object({ grantId: z.string().uuid(), spreadsheetId: googleSpreadsheetIdSchema })
  .strict();
const worksheetSchema = requestSchema.extend({ sheetId: googleWorksheetIdSchema });
export function registerGoogleSheetsHandlers(input: {
  trustedRendererUrl(): string | null;
  controller?: GoogleSheetsController;
  onReady?(
    controller: GoogleSheetsController,
    assertRenderer: (event: IpcMainInvokeEvent) => void
  ): void;
}): () => void {
  const controller = input.controller ?? createNativeGoogleSheetsController();
  const ownedContents = new Set<number>();
  function trusted(event: IpcMainInvokeEvent): number {
    const expected = input.trustedRendererUrl();
    if (
      !expected ||
      event.sender.isDestroyed() ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame ||
      !isTrustedRendererUrl(event.senderFrame.url, expected)
    )
      throw new Error('Untrusted Google Sheets sender');
    return event.sender.id;
  }
  input.onReady?.(controller, (event) => {
    trusted(event);
  });
  const remove = handleGroup(googleSheetsContract, {
    status: (event) => {
      trusted(event);
      return controller.status();
    },
    connect: (event) => {
      const id = trusted(event);
      if (!ownedContents.has(id)) {
        ownedContents.add(id);
        event.sender.once('destroyed', () => {
          ownedContents.delete(id);
          controller.windowClosed(id);
        });
      }
      return controller.start(id);
    },
    cancel: (event, id: unknown) => controller.cancel(z.string().uuid().parse(id), trusted(event)),
    forget: (event, id: unknown) => {
      trusted(event);
      return controller.forget(z.string().uuid().parse(id));
    },
    spreadsheet: (event, request: unknown) => {
      trusted(event);
      return controller.spreadsheet(requestSchema.parse(request));
    },
    worksheet: (event, request: unknown) => {
      trusted(event);
      return controller.worksheet(worksheetSchema.parse(request));
    },
  });
  const unsubscribe = controller.subscribe(() => {
    const expected = input.trustedRendererUrl();
    if (!expected) return;
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = window.webContents;
      if (!contents.isDestroyed() && isTrustedRendererUrl(contents.getURL(), expected))
        sendRendererIpc(contents, 'googleSheets:onChanged');
    }
  });
  const unsubscribeAuth = subscribeAuthState(() => {
    void controller.ownerChanged();
  });
  const shutdown = () => {
    void controller.dispose();
  };
  app.once('before-quit', shutdown);
  return () => {
    remove();
    unsubscribe();
    unsubscribeAuth();
    app.removeListener('before-quit', shutdown);
    void controller.dispose();
  };
}
