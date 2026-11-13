import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron';
import {
  UserMessageError,
  resolveUserMessage,
  type UserMessageInput,
} from '@waypoint/user-messages';

export type UserMessageBoxOptions = Omit<
  MessageBoxOptions,
  'title' | 'message' | 'detail' | 'buttons'
> & {
  title?: UserMessageInput;
  buttons?: UserMessageInput[];
  message: UserMessageInput;
  detail?: UserMessageInput;
};

export function createUserDialogs(native: Dialog) {
  const publicOptions = (options: UserMessageBoxOptions): MessageBoxOptions => {
    const { message, title, detail, buttons, ...nativeOptions } = options;
    return {
      ...nativeOptions,
      message: resolveUserMessage(message, 'operation.attention'),
      ...(title === undefined ? {} : { title: resolveUserMessage(title, 'operation.failedTitle') }),
      ...(detail === undefined
        ? {}
        : { detail: resolveUserMessage(detail, 'operation.attention') }),
      ...(buttons === undefined
        ? {}
        : { buttons: buttons.map((label) => resolveUserMessage(label, 'dialog.continue')) }),
    };
  };
  function showMessageBox(options: UserMessageBoxOptions): ReturnType<Dialog['showMessageBox']>;
  function showMessageBox(
    window: BrowserWindow,
    options: UserMessageBoxOptions
  ): ReturnType<Dialog['showMessageBox']>;
  function showMessageBox(
    owner: BrowserWindow | UserMessageBoxOptions,
    options?: UserMessageBoxOptions
  ) {
    if ('message' in owner) return native.showMessageBox(publicOptions(owner));
    if (!options) throw new UserMessageError('operation.failed');
    return native.showMessageBox(owner, publicOptions(options));
  }
  function showMessageBoxSync(options: UserMessageBoxOptions): number;
  function showMessageBoxSync(window: BrowserWindow, options: UserMessageBoxOptions): number;
  function showMessageBoxSync(
    owner: BrowserWindow | UserMessageBoxOptions,
    options?: UserMessageBoxOptions
  ) {
    if ('message' in owner) return native.showMessageBoxSync(publicOptions(owner));
    if (!options) throw new UserMessageError('operation.failed');
    return native.showMessageBoxSync(owner, publicOptions(options));
  }
  return {
    showMessageBox,
    showMessageBoxSync,
    showErrorBox: (title: UserMessageInput, content: UserMessageInput) =>
      native.showErrorBox(
        resolveUserMessage(title, 'operation.failedTitle'),
        resolveUserMessage(content)
      ),
  };
}
