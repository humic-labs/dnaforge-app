import type Database from 'better-sqlite3';
import { handleGroup } from '../../shared/ipc-contract';
import {
  parseDeepSharePublishRequest,
  parseDeepShareSelectionRequest,
  type DeepShareErrorResult,
  type DeepSharePreflightResult,
} from '../../shared/deep-share-ipc';
import {
  buildDeepSharePreflight,
  DeepSharePreflightError,
  type DeepSharePreflight,
} from '../deep-share/preflight';
import {
  publishReviewedDeepShare,
  toDeepShareReview,
  type PublishReviewedDeepShareDeps,
} from '../deep-share/publish';
import { cloudSyncDeepShareContract } from '../../shared/ipc/cloud-sync-deep-share.contract';

export interface RegisterDeepShareHandlersDeps {
  getDb(): Database.Database;
  forceSync(workspaceUuid: string): Promise<{ ok: boolean; message?: string }>;
  appVersion: string;
  buildPreflight?: typeof buildDeepSharePreflight;
  publish?: typeof publishReviewedDeepShare;
}

export function registerDeepShareHandlers(deps: RegisterDeepShareHandlersDeps): void {
  handleGroup(cloudSyncDeepShareContract, {
    preflightDeepShare: async (_event, value: unknown) => {
      let request;
      try {
        request = parseDeepShareSelectionRequest(value);
      } catch (error) {
        return invalidRequest(error);
      }
      try {
        const preflight = await (deps.buildPreflight ?? buildDeepSharePreflight)(
          deps.getDb(),
          request
        );
        return {
          ok: true,
          review: toDeepShareReview(preflight),
        } satisfies DeepSharePreflightResult;
      } catch (error) {
        return preflightError(error);
      }
    },
    publishDeepShare: async (_event, value: unknown) => {
      let request;
      try {
        request = parseDeepSharePublishRequest(value);
      } catch (error) {
        return invalidRequest(error);
      }
      const publish = deps.publish ?? publishReviewedDeepShare;
      const publishDeps: PublishReviewedDeepShareDeps = {
        forceSync: deps.forceSync,
        buildPreflight: deps.buildPreflight,
        appVersion: deps.appVersion,
      };
      return publish(deps.getDb(), request, publishDeps);
    },
    cancelDeepShare: async () => ({ ok: true as const }),
  });
}

function preflightError(error: unknown): DeepSharePreflightResult {
  if (error instanceof DeepSharePreflightError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return {
    ok: false,
    code: 'PUBLISH_FAILED',
    message: error instanceof Error ? error.message : 'Could not prepare Deep Share review.',
  };
}

function invalidRequest(error: unknown): DeepShareErrorResult {
  return {
    ok: false,
    code: 'INVALID_REQUEST',
    message: error instanceof Error ? error.message : 'Invalid Deep Share request.',
  };
}

export function deepShareReviewForTest(preflight: DeepSharePreflight) {
  return toDeepShareReview(preflight);
}
