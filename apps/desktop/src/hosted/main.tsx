import React from 'react';
import { toUserMessage } from '@waypoint/user-messages';
import ReactDOM from 'react-dom/client';
import App from '../App';
import { CommandScopeProvider } from '../commands';
import { BrandWordmarkText } from '../components/BrandWordmark';
import { rebindCatalogFilePath } from '../db/workspace-catalog';
import { initPlatform } from '../platform';
import { configureHostedCatalogFileRebinder } from '../platform/hosted';
import { HostedWorkspaceApiError } from './api';
import {
  hostedWorkspaceSessionController,
  initializeHostedWorkspaceSession,
  startHostedBackgroundSync,
} from './controller';
import { isHostedDemoSession } from './capabilities';
import {
  carryDemoSessionIntoAccount,
  closeDemoTabs,
  startBrowserDemoSession,
  sweepAbandonedDemoSessions,
} from './demo-boot';
import { readDemoCarry, resolveDemoSessionId } from './demo-session';
import { startHostedFileProjections } from './file-projections';
import { useSequenceEditModeStore } from '../stores/sequence-edit-mode-store';
import { useSequenceStore } from '../features/sequence/store';
import { prepareHostedOfflineShell } from './offline-shell';
import { HostedStartupTrace, emitHostedStartupObservation } from './startup-telemetry';
import { StartupSurface, type StartupStage } from '../startup/StartupSurface';
import { prepareSequenceFonts } from '../startup/sequence-fonts';
import { Providers } from '../shared/context';
import '../index.css';
import './hosted.css';

document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
startHostedBackgroundSync(
  () =>
    !useSequenceEditModeStore.getState().active &&
    !Object.values(useSequenceStore.getState().dirtyPaths).some(Boolean)
);

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('DNAForge hosted root is missing.');

const root = ReactDOM.createRoot(rootElement);
void prepareHostedOfflineShell().catch((error: unknown) => {
  document.documentElement.dataset.hostedOfflineReady = 'false';
  console.warn('[Hosted offline access] The app shell could not be cached:', error);
});
let stage: StartupStage = 'fonts';
const startupTrace = new HostedStartupTrace(emitHostedStartupObservation);
root.render(<StartupSurface stage={stage} runtime="hosted-browser" />);

void (async () => {
  await startupTrace.run('sequence_fonts', prepareSequenceFonts);
  stage = 'platform';
  root.render(<StartupSurface stage={stage} runtime="hosted-browser" />);
  await startupTrace.run('platform_init', async () => {
    configureHostedCatalogFileRebinder(rebindCatalogFilePath);
    await initPlatform();
  });
  const { demoSessionId, carry } = await startupTrace.run('demo_state', () => ({
    demoSessionId: resolveDemoSessionId(),
    carry: readDemoCarry(),
  }));
  const carryingThisTab = Boolean(carry && (!demoSessionId || carry.sessionId === demoSessionId));
  if (demoSessionId && !carryingThisTab) {
    await startupTrace.run('demo_session', () => startBrowserDemoSession(demoSessionId));
  } else {
    void sweepAbandonedDemoSessions(carry ? [carry.sessionId] : []);
  }
  await startupTrace.run('file_projections', startHostedFileProjections);
  try {
    await startupTrace.run('workspace_session', initializeHostedWorkspaceSession);
  } catch (error: unknown) {
    if (error instanceof HostedWorkspaceApiError && error.status === 401) {
      if (demoSessionId && carryingThisTab) {
        await startupTrace.run('demo_session', () => startBrowserDemoSession(demoSessionId));
        await startupTrace.run('workspace_session', initializeHostedWorkspaceSession);
      } else {
        root.render(<HostedSignIn />);
        startupTrace.report('sign_in_required');
        return;
      }
    } else {
      throw error;
    }
  }
  const signedInAccountId = hostedWorkspaceSessionController.getState().principal?.id;
  if (carry && carryingThisTab && signedInAccountId && !isHostedDemoSession()) {
    try {
      await startupTrace.run('demo_carry', () =>
        carryDemoSessionIntoAccount(carry.sessionId, signedInAccountId)
      );
      closeDemoTabs();
    } catch (error: unknown) {
      console.error(
        '[Demo session] Demo projects were not copied yet; retrying on next load:',
        error
      );
    }
    await startupTrace.run('account_session', () => hostedWorkspaceSessionController.initialize());
  }
  await startupTrace.run('shell_render', () =>
    root.render(
      <React.StrictMode>
        <Providers>
          <CommandScopeProvider>
            <App />
          </CommandScopeProvider>
        </Providers>
      </React.StrictMode>
    )
  );
  startupTrace.report('shell_requested');
})().catch((error: unknown) => {
  console.error(`[Hosted startup] ${stage} failed:`, error);
  startupTrace.report('failed', error);
  root.render(
    <StartupSurface
      stage={stage}
      runtime="hosted-browser"
      error={toUserMessage(
        error,
        stage === 'platform' ? 'startup.hostedPlatformFailed' : 'startup.failed'
      )}
    />
  );
});

function HostedSignIn() {
  return (
    <div className="hosted-centered-state">
      <div className="hosted-centered-brand">
        <BrandWordmarkText />
      </div>
      <h1>Sign in to DNAForge</h1>
      <p>Your hosted projects use the same DNAForge account as the desktop app.</p>
      <a
        className="hosted-primary-button"
        data-testid="hosted-sign-in"
        href="/login?next=/hosted.html"
      >
        Sign in
      </a>
      <a className="hosted-text-button" data-testid="hosted-try-demo" href="/try">
        Try DNAForge without an account
      </a>
    </div>
  );
}
