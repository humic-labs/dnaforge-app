import { app } from 'electron';
import { join } from 'node:path';
import { QUICK_LOOK_PACKAGE_STORE_DIRECTORY } from '../../shared/file-associations';
import { FileActivationQueue } from '../file-activation';
import {
  createDefaultHandlerService,
  type DefaultHandlerService,
} from '../file-associations/default-handler-service';
import { createNativeDefaultHandlerDependencies } from '../file-associations/native-default-handler';
import { promoteQuickLookToDestination } from '../file-associations/quick-look-destination-promotion';
import { createQuickLookPackageStore } from '../file-associations/quick-look-package-store';
import { getDb } from '../ipc/database';
import {
  registerFileAssociationHandlers,
  type RegisterFileAssociationHandlersDeps,
} from '../ipc/file-associations';
import { managedRootDir } from '../ipc/workspace-git';
import {
  activatePreparedQuickLookDestinationWorkspace,
  discardPreparedQuickLookDestinationWorkspace,
  importQuickLookGenerationIntoWorkspaceRoot,
  prepareQuickLookDestinationWorkspace,
  recoverQuickLookDestinationWorkspaces,
  recoverQuickLookPackagePromotions,
} from '../workspace-git/import';
import type { MainFeature } from './main-feature';

export interface FileAssociationsConfiguration {
  readonly userDataPath: string;
  readonly helperSourcePath: string;
  readonly openExternal: (url: string) => Promise<void>;
}

interface ConfiguredFileAssociations {
  readonly packageStore: ReturnType<typeof createQuickLookPackageStore>;
  readonly promotionJournalRoot: string;
  readonly preparationJournalRoot: string;
  readonly defaultHandler: DefaultHandlerService;
}

export function createFileAssociations() {
  const activationQueue = new FileActivationQueue();
  let configured: ConfiguredFileAssociations | null = null;

  function configure({
    userDataPath,
    helperSourcePath,
    openExternal,
  }: FileAssociationsConfiguration): void {
    const promotionJournalRoot = join(
      userDataPath,
      QUICK_LOOK_PACKAGE_STORE_DIRECTORY,
      '.promotions'
    );
    configured = {
      packageStore: createQuickLookPackageStore(userDataPath),
      promotionJournalRoot,
      preparationJournalRoot: join(promotionJournalRoot, 'workspace-preparations'),
      defaultHandler: createDefaultHandlerService(
        createNativeDefaultHandlerDependencies({
          platform: process.platform,
          appBundleId: 'com.dnaforge.desktop',
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          execPath: process.execPath,
          helperSourcePath,
          userDataPath,
          openExternal,
        })
      ),
    };
  }

  function required(): ConfiguredFileAssociations {
    if (!configured) throw new Error('File associations were used before they were configured.');
    return configured;
  }

  async function recoverPromotions(): Promise<void> {
    const { promotionJournalRoot, preparationJournalRoot } = required();
    await recoverQuickLookPackagePromotions(promotionJournalRoot, {
      db: getDb(),
      managedRootDir: managedRootDir(),
    }).catch((error) => {
      console.warn('[main] Quick Look promotion recovery failed closed:', error);
    });
    await recoverQuickLookDestinationWorkspaces({
      db: getDb(),
      managedRootDir: managedRootDir(),
      preparationJournalRoot,
      packagePromotionJournalRoot: promotionJournalRoot,
    }).catch((error) => {
      console.warn('[main] Quick Look destination-workspace recovery failed closed:', error);
    });
  }

  function handlerDependencies(): RegisterFileAssociationHandlersDeps {
    const { packageStore, promotionJournalRoot, preparationJournalRoot, defaultHandler } =
      required();
    return {
      takePendingAndMarkReady: () => activationQueue.takePendingAndMarkReady(),
      defaultHandler,
      materializeQuickLookPackage: (request) => packageStore.materialize(request),
      prepareQuickLookPackage: (request) => packageStore.preparePackage(request.packageRoot),
      promoteQuickLookPackage: (request) => {
        const db = getDb();
        const managedRoot = managedRootDir();
        return promoteQuickLookToDestination(request, {
          prepareWorkspace: (name) =>
            prepareQuickLookDestinationWorkspace(name, {
              db,
              managedRootDir: managedRoot,
              preparationJournalRoot,
              packagePromotionJournalRoot: promotionJournalRoot,
            }),
          activateWorkspace: (workspace) =>
            activatePreparedQuickLookDestinationWorkspace(workspace, {
              db,
              managedRootDir: managedRoot,
              preparationJournalRoot,
              packagePromotionJournalRoot: promotionJournalRoot,
            }),
          promoteToRoot: (receipt, targetRoot) =>
            packageStore.promote({ receipt, targetRoot }, (snapshot, physicalTargetRoot) =>
              importQuickLookGenerationIntoWorkspaceRoot(snapshot, physicalTargetRoot, {
                db,
                managedRootDir: managedRoot,
                promotionJournalRoot,
              })
            ),
          discardWorkspace: (workspace) =>
            discardPreparedQuickLookDestinationWorkspace(workspace, {
              db,
              managedRootDir: managedRoot,
              preparationJournalRoot,
              packagePromotionJournalRoot: promotionJournalRoot,
            }),
        });
      },
    };
  }

  const feature: MainFeature = {
    id: 'file-associations',
    registerIpc: () => {
      registerFileAssociationHandlers(handlerDependencies());
      return () => undefined;
    },
  };

  return { activationQueue, configure, recoverPromotions, feature };
}

export const fileAssociations = createFileAssociations();
export const fileAssociationsFeature = fileAssociations.feature;
