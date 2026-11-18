import { userMessage } from '@waypoint/user-messages';
import { createUserDialogs } from '../user-dialogs';
import { getRedirectScheme } from '../auth/auth-config';
import { app, dialog, type BrowserWindow } from 'electron';
import { handleGroup, sendRendererIpc } from '../../shared/ipc-contract';
import { entityNavigationContract } from '../../shared/ipc/entity-navigation.contract';
import {
  findEntityNavigationUrlInArgv,
  isEntityNavigationUrl,
  parseEntityNavigationUrl,
  type EntityNavigationTarget,
} from '../../shared/entity-navigation';
import { focusWindowUnlessBackground } from '../background-window-mode';
import { EntityNavigationQueue } from '../entity-navigation';
import { createEntityNavigationProtocol } from '../entity-navigation-protocol';
import { isExplicitE2eTestRuntime } from '../config';
import type { MainFeature } from './main-feature';

const queue = new EntityNavigationQueue();
const protocol = createEntityNavigationProtocol({
  app,
  env: process.env,
  argv: process.argv,
  executable: process.execPath,
  testRuntime:
    isExplicitE2eTestRuntime(process.argv, process.env.WAYPOINT_TEST) ||
    process.env.NODE_ENV === 'test',
  defaultScheme: getRedirectScheme,
});
let boundWindow: BrowserWindow | null = null;

function bindWindow(window: BrowserWindow): void {
  if (boundWindow === window) return;
  boundWindow = window;
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) queue.markRendererLoading();
  });
  window.once('closed', () => {
    if (boundWindow !== window) return;
    boundWindow = null;
    queue.markRendererLoading();
  });
}

function queueTarget(target: EntityNavigationTarget, window: BrowserWindow | null) {
  if (window && !window.isDestroyed()) bindWindow(window);
  else queue.markRendererLoading();
  const targets = queue.enqueue(target);
  if (targets.length && window && !window.isDestroyed())
    sendRendererIpc(window.webContents, 'entity-navigation:open', targets);
}

export function requestEntityNavigation(target: EntityNavigationTarget) {
  queueTarget(target, boundWindow);
  if (boundWindow && !boundWindow.isDestroyed()) focusWindowUnlessBackground(boundWindow);
  else app.emit('activate');
}

export const entityNavigationFeature: MainFeature = {
  id: 'entity-navigation',
  findProtocolUrlInArgv: findEntityNavigationUrlInArgv,
  prepare: () => protocol.prepare(),
  registerIpc: () =>
    handleGroup(entityNavigationContract, {
      getScheme: () => protocol.getScheme(),
      takePending: () => queue.takePendingAndMarkReady(),
    }),
  onMainWindow: bindWindow,
  onProtocolUrl: (url, context) => {
    if (!isEntityNavigationUrl(url)) return false;
    if (!protocol.acceptsUrl(url)) {
      createUserDialogs(dialog).showErrorBox(
        userMessage('dialog.could-not-open-entity'),
        userMessage('dialog.this-link-belongs-to-another-dnaforge-development-instance')
      );
      return true;
    }
    const target = parseEntityNavigationUrl(url);
    if (!target) {
      createUserDialogs(dialog).showErrorBox(
        userMessage('dialog.could-not-open-entity'),
        userMessage('dialog.this-dnaforge-entity-link-is-invalid')
      );
      return true;
    }
    queueTarget(target, context.window);
    context.activate();
    return true;
  },
};
