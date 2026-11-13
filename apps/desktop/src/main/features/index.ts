import { entityNavigationFeature } from './entity-navigation';
import { scientificRecoveryFeature } from './scientific-recovery';
import type { BrowserWindow } from 'electron';
import { appendBootLog } from '../boot-log';
import type {
  MainAgentToolsContext,
  MainFeature,
  MainFeatureContext,
  MainFeatureProfileContext,
  MainFeatureShutdownStep,
  MainProtocolUrlContext,
} from './main-feature';
import { appHealthFeature } from './app-health';
import { authFeature } from './auth';
import { credentialStorageFeature } from './credential-storage';
import { benchlingMigrationFeature } from './benchling-migration';
import { betaAttributionFeature } from './beta-attribution';
import { memoryPressureFeature } from './memory-pressure';
import { referenceAssetsFeature } from './reference-assets';
import { remoteHostsFeature } from './remote-hosts';
import { shareLinksFeature } from './share-links';
import { thirdPartyNoticesFeature } from './third-party-notices';
import { externalAgentToolsFeature } from './external-agent-tools';
import { fileAssociationsFeature } from './file-associations';
import { trackStoreFeature } from './track-store';
import { administrationFeature } from './administration';
import { enforcesStartupPhases, formatStartupPhases, markStartupPhase } from './startup-phases';
export { agentToolsBridge } from './agent-tools-bridge';
export { fileAssociations } from './file-associations';
export { workspaceSync } from './workspace-sync';
export { crashLoopBreaker, exitTelemetry, processExitSnapshot } from '../crash-loop-runtime';
export { startMcpHttpServices } from './mcp-http';
export { nativeDocuments } from './native-documents';
export { prepareNativeAdministration } from './administration';
export { createNativeDocumentQuitSaver } from './native-document-quit';
export {
  captureStartupDatabaseDialogForTest,
  createStartupWindowTestBarrier,
  holdAtStartupWindowTestBarrier,
  skipsStartupRecoveryRelaunchForTest,
  testRendererBridgeOptions,
  withNativeDocumentSettlementTestSeam,
} from './test-hooks';

if (enforcesStartupPhases()) markStartupPhase('features-loaded');

export function assertUniqueMainFeatures(features: readonly MainFeature[]): void {
  const ids = new Set<string>();
  const shutdownNames = new Set<string>();
  for (const feature of features) {
    if (ids.has(feature.id)) throw new Error(`Main feature "${feature.id}" is registered twice.`);
    ids.add(feature.id);
    const name = feature.shutdown?.name;
    if (name === undefined) continue;
    if (shutdownNames.has(name)) {
      throw new Error(`Main features share the shutdown step name "${name}".`);
    }
    shutdownNames.add(name);
  }
}

export const MAIN_FEATURES: readonly MainFeature[] = [
  credentialStorageFeature,
  scientificRecoveryFeature,
  benchlingMigrationFeature,
  trackStoreFeature,
  remoteHostsFeature,
  thirdPartyNoticesFeature,
  externalAgentToolsFeature,
  referenceAssetsFeature,
  entityNavigationFeature,
  authFeature,
  memoryPressureFeature,
  betaAttributionFeature,
  shareLinksFeature,
  fileAssociationsFeature,
  appHealthFeature,
  administrationFeature,
];
assertUniqueMainFeatures(MAIN_FEATURES);

export function configureMainFeatureProfile(
  context: MainFeatureProfileContext,
  features: readonly MainFeature[] = MAIN_FEATURES
): void {
  for (const feature of features) feature.configureProfile?.(context);
}

export function prepareMainFeatureProfile(
  profilePath: string,
  features: readonly MainFeature[] = MAIN_FEATURES
): void {
  for (const feature of features) feature.prepareProfile?.(profilePath);
}

export async function prepareMainFeatures(
  context: MainFeatureContext,
  features: readonly MainFeature[] = MAIN_FEATURES
): Promise<void> {
  for (const feature of features) await feature.prepare?.(context);
  if (enforcesStartupPhases()) markStartupPhase('features-prepared');
}

export function registerMainFeatureIpc(
  features: readonly MainFeature[] = MAIN_FEATURES
): () => void {
  const disposers = features.flatMap((feature) =>
    feature.registerIpc ? [feature.registerIpc()] : []
  );
  if (enforcesStartupPhases()) {
    markStartupPhase('feature-ipc-registered');
    appendBootLog(formatStartupPhases());
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}

export function startMainFeaturesWithWindow(
  window: BrowserWindow,
  context: MainFeatureContext,
  features: readonly MainFeature[] = MAIN_FEATURES
): void {
  for (const feature of features) feature.onMainWindow?.(window, context);
  if (enforcesStartupPhases()) {
    markStartupPhase('main-window-ready');
    appendBootLog(formatStartupPhases());
  }
}

export function openMainFeatureProtocolUrl(
  url: string,
  context: MainFeatureContext,
  features: readonly MainFeature[] = MAIN_FEATURES
): boolean {
  for (const feature of features) {
    for (const route of feature.protocolRoutes ?? []) {
      if (!route.matches(url)) continue;
      route.open(url, context);
      return true;
    }
  }
  return false;
}

export function mainFeaturesSignedIn(
  context: MainFeatureContext,
  features: readonly MainFeature[] = MAIN_FEATURES
): void {
  for (const feature of features) feature.onSignedIn?.(context);
}

export function mainFeaturesWillQuit(features: readonly MainFeature[] = MAIN_FEATURES): void {
  for (const feature of features) feature.willQuit?.();
}

export function mainFeatureShutdownSteps(
  features: readonly MainFeature[] = MAIN_FEATURES
): MainFeatureShutdownStep[] {
  return features.flatMap((feature) => (feature.shutdown ? [feature.shutdown] : []));
}

export async function startMainAgentTools(
  context: MainAgentToolsContext,
  features: readonly MainFeature[] = MAIN_FEATURES
): Promise<void> {
  for (const feature of features) await feature.startAgentTools?.(context);
}

export function routeMainFeatureProtocolUrl(
  url: string,
  context: MainProtocolUrlContext,
  features: readonly MainFeature[] = MAIN_FEATURES
): boolean {
  return features.some((feature) => feature.onProtocolUrl?.(url, context) === true);
}

export function findMainFeatureProtocolUrlInArgv(
  argv: readonly string[],
  features: readonly MainFeature[] = MAIN_FEATURES
): string | null {
  for (const feature of features) {
    const url = feature.findProtocolUrlInArgv?.(argv);
    if (url) return url;
  }
  return null;
}
