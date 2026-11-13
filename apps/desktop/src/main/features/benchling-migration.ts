import { join } from 'node:path';
import { app, shell } from 'electron';
import {
  captureOptionalTelemetryOrigin,
  enqueueOptionalAnalyticsEventFromReceipt,
  onAnalyticsIdentity,
} from '../analytics';
import { LocalBenchlingMigrationCoordinator } from '../benchling-migration/coordinator';
import { surveyImportDestinations } from '../benchling-migration/import-destination-survey';
import { prepareLocalBenchlingExportSource } from '../benchling-migration/local-export-source-preparation';
import { createRendererMigrationRenderValidator } from '../benchling-migration/renderer-validation';
import { registerBenchlingMigrationHandlers } from '../ipc/benchling-migration';
import { getDb } from '../ipc/database';
import { managedRootDir } from '../ipc/workspace-git';
import { resolveStoredProviderReference } from '../provider-reference-service';
import type { MainFeature, MainFeatureContext } from './main-feature';

let prepared: Readonly<{
  coordinator: LocalBenchlingMigrationCoordinator;
  getMainWindow: MainFeatureContext['getMainWindow'];
}> | null = null;

export function preparedBenchlingMigrationCoordinator(): LocalBenchlingMigrationCoordinator {
  if (!prepared) throw new Error('The Benchling migration feature has not been prepared.');
  return prepared.coordinator;
}

async function prepareBenchlingMigration(context: MainFeatureContext): Promise<void> {
  const coordinator = new LocalBenchlingMigrationCoordinator({
    globalDb: getDb(),
    managedRootDir: managedRootDir(),
    appVersion: app.getVersion(),
    telemetry: {
      captureOrigin: captureOptionalTelemetryOrigin,
      publish: enqueueOptionalAnalyticsEventFromReceipt,
    },
    renderValidator: createRendererMigrationRenderValidator(context.getMainWindow),
    discardWorkspace: (workspaceContainerPath) => shell.trashItem(workspaceContainerPath),
  });
  prepared = Object.freeze({ coordinator, getMainWindow: context.getMainWindow });
  await coordinator.getActiveRun().catch((error: unknown) => {
    console.error('[BenchlingMigration] startup recovery admission failed', error);
  });
}

function registerBenchlingMigrationIpc(): () => void {
  const coordinator = preparedBenchlingMigrationCoordinator();
  if (!prepared) throw new Error('The Benchling migration feature has not been prepared.');
  registerBenchlingMigrationHandlers({
    coordinator,
    getMainWindow: prepared.getMainWindow,
    prepareLocalExportSource: (sourcePath) =>
      prepareLocalBenchlingExportSource({
        sourcePath,
        stagingRootDir: join(app.getPath('temp'), 'dnaforge-benchling-prepared-exports'),
      }),
    resolveProviderReference: (request) => resolveStoredProviderReference(getDb(), request),
    surveyImportDestinations: (request) =>
      surveyImportDestinations({
        archivePath: request.archivePath,
        globalDb: getDb(),
        managedRootDir: managedRootDir(),
      }),
  });
  let disposed = false;
  const publishLater = () =>
    queueMicrotask(() => {
      if (!disposed) coordinator.publishTelemetry();
    });
  const stopIdentityListener = onAnalyticsIdentity(publishLater);
  publishLater();
  return () => {
    disposed = true;
    stopIdentityListener();
  };
}

export const benchlingMigrationFeature: MainFeature = {
  id: 'benchling-migration',
  prepare: prepareBenchlingMigration,
  registerIpc: registerBenchlingMigrationIpc,
};
