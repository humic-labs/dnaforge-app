import { handleGroup } from '../../shared/ipc-contract';
import { feedbackContract } from '../../shared/ipc/feedback.contract';
import { app } from 'electron';
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

import type {
  FeedbackPayload,
  FeedbackResult,
  FeedbackTelemetryOrigin,
  FeedbackReceipt,
} from '../../shared/feedback';
import {
  cancelFeedback,
  drainFeedback,
  submitFeedback,
  configureFeedbackTelemetry,
  replayFeedbackTelemetry,
} from '../feedback-queue';
import { isCommunityBuild } from '../distribution';

const INSTALL_ID_FILE = 'install-id';

const DEFAULT_FEEDBACK_URL = 'https://dnaforge.com/api/feedback';
const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const installIdCache = new Map<string, string>();

export function getInstallId(appDataPath: string): string {
  const filePath = join(appDataPath, INSTALL_ID_FILE);
  const cached = installIdCache.get(filePath);
  if (cached) return cached;

  try {
    if (existsSync(filePath)) {
      const persisted = readFileSync(filePath, 'utf-8').trim();
      if (INSTALL_ID_RE.test(persisted)) {
        const normalized = persisted.toLowerCase();
        installIdCache.set(filePath, normalized);
        try {
          chmodSync(filePath, 0o600);
        } catch {
          void 0;
        }
        return normalized;
      }
    }
  } catch {
    void 0;
  }

  const id = randomUUID().toLowerCase();
  installIdCache.set(filePath, id);
  try {
    writeInstallIdAtomically(filePath, id);
  } catch {
    void 0;
  }
  return id;
}

function writeInstallIdAtomically(filePath: string, id: string): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, id, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      renameSync(tempPath, filePath);
    } catch (error) {
      if (!existsSync(filePath)) throw error;
      unlinkSync(filePath);
      renameSync(tempPath, filePath);
    }
    chmodSync(filePath, 0o600);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

export function sendFeedback(
  payload: FeedbackPayload,
  feedbackUrl: string,
  appDataPath: string
): Promise<FeedbackResult> {
  return submitFeedback(payload, feedbackUrl, appDataPath, () => getInstallId(appDataPath));
}

export function flushPendingFeedback(feedbackUrl: string, appDataPath: string): Promise<void> {
  return drainFeedback(feedbackUrl, appDataPath);
}

export function registerFeedbackHandlers(metrics?: {
  captureOrigin(): FeedbackTelemetryOrigin | null;
  record(receipt: FeedbackReceipt, readCommitted?: () => FeedbackReceipt | null): boolean | void;
}): () => void {
  configureFeedbackTelemetry(metrics ?? null);
  if (isCommunityBuild()) {
    handleGroup(feedbackContract, {
      send: async (): Promise<FeedbackResult> => ({ success: false, error: 'service_unavailable' }),
      cancel: (_event, id) => cancelFeedback(app.getPath('userData'), id),
    });
    return () => undefined;
  }
  const feedbackUrl = process.env['FEEDBACK_URL'] || DEFAULT_FEEDBACK_URL;
  handleGroup(feedbackContract, {
    send: (_event, payload) => sendFeedback(payload, feedbackUrl, app.getPath('userData')),
    cancel: (_event, id) => cancelFeedback(app.getPath('userData'), id),
  });

  void flushPendingFeedback(feedbackUrl, app.getPath('userData'));

  return () => replayFeedbackTelemetry(app.getPath('userData'));
}
