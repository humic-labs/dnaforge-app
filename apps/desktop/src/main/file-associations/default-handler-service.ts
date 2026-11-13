import { userMessage } from '@waypoint/user-messages';
import type {
  FileAssociationDefaultAction,
  FileAssociationDefaultRequestResult,
  FileAssociationHandlerStatus,
} from '../../shared/file-association-ipc';
import {
  FILE_ASSOCIATION_FAMILIES,
  fileAssociationFamily,
  type FileAssociationFamilyId,
} from '../../shared/file-associations';

export interface MacHandlerIdentity {
  readonly bundleId: string | null;
  readonly name: string | null;
  readonly path: string | null;
}

export interface DefaultHandlerServiceDependencies {
  readonly platform: NodeJS.Platform;
  readonly appBundleId: string;
  readonly queryMacHandler: (contentType: string) => Promise<MacHandlerIdentity | null>;
  readonly setMacHandler: (
    contentType: string
  ) => Promise<{ readonly ok: boolean; readonly detail: string | null }>;
  readonly queryWindowsProgId: (extension: string) => Promise<string | null>;
  readonly openWindowsDefaultApps: () => Promise<void>;
  readonly macDefaultAction?: FileAssociationDefaultAction;
}

export interface DefaultHandlerService {
  readonly queryAll: () => Promise<FileAssociationHandlerStatus[]>;
  readonly requestDefault: (
    familyId: FileAssociationFamilyId
  ) => Promise<FileAssociationDefaultRequestResult>;
}

function unavailableStatus(
  familyId: FileAssociationFamilyId,
  detail: string,
  defaultAction: FileAssociationDefaultAction = 'none'
): FileAssociationHandlerStatus {
  return {
    familyId,
    state: 'unavailable',
    handlerName: null,
    handlerPath: null,
    defaultAction,
    detail,
  };
}

async function queryMacFamily(
  familyId: FileAssociationFamilyId,
  dependencies: DefaultHandlerServiceDependencies
): Promise<FileAssociationHandlerStatus> {
  const family = fileAssociationFamily(familyId);
  const defaultAction = dependencies.macDefaultAction ?? 'native';
  try {
    const handler = await dependencies.queryMacHandler(family.macos.contentType);
    if (!handler) {
      return {
        familyId,
        state: 'none',
        handlerName: null,
        handlerPath: null,
        defaultAction,
        detail: 'macOS did not report a default application for this document type.',
      };
    }
    return {
      familyId,
      state: handler.bundleId === dependencies.appBundleId ? 'default' : 'other',
      handlerName: handler.name,
      handlerPath: handler.path,
      defaultAction,
      detail:
        handler.name === 'Multiple applications'
          ? `The registered ${family.displayName} extensions use different default applications.`
          : null,
    };
  } catch (error) {
    return unavailableStatus(
      familyId,
      error instanceof Error ? error.message : 'macOS handler query failed.',
      defaultAction
    );
  }
}

async function queryWindowsFamily(
  familyId: FileAssociationFamilyId,
  dependencies: DefaultHandlerServiceDependencies
): Promise<FileAssociationHandlerStatus> {
  const family = fileAssociationFamily(familyId);
  try {
    const progIds = await Promise.all(
      family.extensions.map((extension) => dependencies.queryWindowsProgId(extension))
    );
    const unique = new Set(progIds);
    const allDnaForge = progIds.every((progId) => progId === family.windows.progId);
    const allUnset = progIds.every((progId) => progId === null);
    const mixed = unique.size > 1;
    return {
      familyId,
      state: allDnaForge ? 'default' : allUnset ? 'none' : 'other',
      handlerName: allDnaForge
        ? 'DNAForge'
        : mixed
          ? 'Multiple applications'
          : (progIds[0] ?? null),
      handlerPath: null,
      defaultAction: 'system-settings',
      detail: mixed
        ? `The registered ${family.displayName} extensions use different default applications.`
        : null,
    };
  } catch (error) {
    return unavailableStatus(
      familyId,
      error instanceof Error ? error.message : 'Windows handler query failed.'
    );
  }
}

export function createDefaultHandlerService(
  dependencies: DefaultHandlerServiceDependencies
): DefaultHandlerService {
  return {
    queryAll: async () => {
      if (dependencies.platform === 'darwin') {
        return Promise.all(
          FILE_ASSOCIATION_FAMILIES.map((family) => queryMacFamily(family.id, dependencies))
        );
      }
      if (dependencies.platform === 'win32') {
        return Promise.all(
          FILE_ASSOCIATION_FAMILIES.map((family) => queryWindowsFamily(family.id, dependencies))
        );
      }
      return FILE_ASSOCIATION_FAMILIES.map((family) => ({
        familyId: family.id,
        state: 'unsupported' as const,
        handlerName: null,
        handlerPath: null,
        defaultAction: 'none' as const,
        detail: userMessage('fileAssociations.unsupportedPlatform'),
      }));
    },
    requestDefault: async (familyId) => {
      const family = fileAssociationFamily(familyId);
      if (dependencies.platform === 'darwin') {
        const result = await dependencies.setMacHandler(family.macos.contentType);
        return {
          familyId,
          outcome: result.ok ? 'requested' : 'instructions',
          detail: result.detail,
        };
      }
      if (dependencies.platform === 'win32') {
        try {
          await dependencies.openWindowsDefaultApps();
          return { familyId, outcome: 'opened-settings', detail: null };
        } catch (error) {
          return {
            familyId,
            outcome: 'unavailable',
            detail: error instanceof Error ? error.message : 'Windows Settings could not open.',
          };
        }
      }
      return {
        familyId,
        outcome: 'unavailable',
        detail: userMessage('fileAssociations.unsupportedPlatform'),
      };
    },
  };
}
