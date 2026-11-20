import { userMessage } from '@waypoint/user-messages';
import type {
  FileAssociationDefaultAction,
  FileAssociationDefaultRequestResult,
  FileAssociationHandlerStatus,
} from '../../shared/file-association-ipc';
import {
  HANDLER_FAMILIES,
  handlerFamily,
  type HandlerFamilyId,
} from '../../shared/file-associations';

export interface MacHandlerIdentity {
  readonly bundleId: string | null;
  readonly name: string | null;
  readonly path: string | null;
  readonly mixedHandlers?: FileAssociationHandlerStatus['mixedHandlers'];
}

export type WindowsHandlers = Readonly<Record<string, { progId: string; name: string } | null>>;

export interface DefaultHandlerServiceDependencies {
  readonly platform: NodeJS.Platform;
  readonly appBundleId: string;
  readonly queryMacHandler: (familyId: HandlerFamilyId) => Promise<MacHandlerIdentity | null>;
  readonly setMacHandler: (
    familyId: HandlerFamilyId
  ) => Promise<{ readonly ok: boolean; readonly detail: string | null }>;
  readonly queryWindowsProgIds: () => Promise<WindowsHandlers>;
  readonly openWindowsDefaultApps: () => Promise<void>;
  readonly windowsDefaultAction?: FileAssociationDefaultAction;
  readonly macDefaultAction?: FileAssociationDefaultAction;
}

export interface DefaultHandlerService {
  readonly queryAll: () => Promise<FileAssociationHandlerStatus[]>;
  readonly requestDefault: (
    familyId: HandlerFamilyId
  ) => Promise<FileAssociationDefaultRequestResult>;
}

function unavailableStatus(
  familyId: HandlerFamilyId,
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
  familyId: HandlerFamilyId,
  dependencies: DefaultHandlerServiceDependencies
): Promise<FileAssociationHandlerStatus> {
  const family = handlerFamily(familyId);
  const defaultAction = dependencies.macDefaultAction ?? 'native';
  try {
    const handler = await dependencies.queryMacHandler(family.id);
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
      ...(handler.mixedHandlers && { mixedHandlers: handler.mixedHandlers }),
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

function queryWindowsFamily(
  familyId: HandlerFamilyId,
  dependencies: DefaultHandlerServiceDependencies,
  defaults: WindowsHandlers
): FileAssociationHandlerStatus {
  const family = handlerFamily(familyId);
  try {
    const progIds = family.extensions.map((extension) => {
      if (!(extension in defaults)) throw new Error(`No Windows query result for .${extension}.`);
      return defaults[extension]?.progId ?? null;
    });
    const unique = new Set(progIds.map((value) => value?.toLowerCase() ?? null));
    const allDnaForge = progIds.every(
      (progId) => progId?.toLowerCase() === family.windows.progId.toLowerCase()
    );
    const allUnset = progIds.every((progId) => progId === null);
    const mixed = unique.size > 1;
    return {
      familyId,
      state: allDnaForge ? 'default' : allUnset ? 'none' : 'other',
      handlerName: allDnaForge
        ? 'DNAForge'
        : mixed
          ? 'Multiple applications'
          : (defaults[family.extensions[0] ?? '']?.name ?? null),
      handlerPath: null,
      ...(mixed && {
        mixedHandlers: family.extensions.map((extension) => ({
          extension,
          handlerName: defaults[extension]?.name ?? null,
        })),
      }),
      defaultAction: dependencies.windowsDefaultAction ?? 'system-settings',
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
          HANDLER_FAMILIES.map((family) => queryMacFamily(family.id, dependencies))
        );
      }
      if (dependencies.platform === 'win32') {
        try {
          const defaults = await dependencies.queryWindowsProgIds();
          return HANDLER_FAMILIES.map((family) =>
            queryWindowsFamily(family.id, dependencies, defaults)
          );
        } catch (error) {
          return HANDLER_FAMILIES.map((family) =>
            unavailableStatus(
              family.id,
              error instanceof Error ? error.message : 'Windows handler query failed.'
            )
          );
        }
      }
      return HANDLER_FAMILIES.map((family) => ({
        familyId: family.id,
        state: 'unsupported' as const,
        handlerName: null,
        handlerPath: null,
        defaultAction: 'none' as const,
        detail: userMessage('fileAssociations.unsupportedPlatform'),
      }));
    },
    requestDefault: async (familyId) => {
      const family = handlerFamily(familyId);
      if (dependencies.platform === 'darwin') {
        const result = await dependencies.setMacHandler(family.id);
        return {
          familyId,
          outcome: result.ok ? 'requested' : 'instructions',
          detail: result.detail,
        };
      }
      if (dependencies.platform === 'win32') {
        if (dependencies.windowsDefaultAction === 'none') {
          return {
            familyId,
            outcome: 'unavailable',
            detail: 'Use installed DNAForge to change default applications.',
          };
        }
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
