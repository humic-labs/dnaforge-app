import { useState, useEffect, useCallback, useRef } from 'react';
import {
  isApiError,
  toolboxHealthCheckToolboxHealthCapIdPost,
  toolboxRetryToolboxRetryCapIdPost,
  toolboxStatusToolboxStatusGet,
} from '@waypoint/api-client';
import { serviceManager } from '../services/service-manager';
import { rendererSidecarRequestAuthorityState } from '../services/sidecar-session';

interface ComponentStatus {
  id: string;
  label: string;
  status: string;
  version?: string;
  source: string;
  path?: string;
  progress?: { phase: string; percent: number; detail: string };
  size_mb?: number;
}

interface CapabilityStatus {
  id: string;
  label: string;
  status: string;
  source: string;
  tier: string;
  auto_install: boolean;
  components: ComponentStatus[];
}

interface ToolDownloadStatus {
  phase: 'pending' | 'downloading' | 'extracting' | 'done' | 'error';
  percent: number;
}

interface ToolboxData {
  capabilities: CapabilityStatus[];
  downloads?: Record<string, ToolDownloadStatus>;
}

type LoadState = 'loading' | 'loaded' | 'error' | 'unavailable';

export type ToolboxBadge = 'downloading' | 'error' | null;

let sharedData: ToolboxData | null = null;
let sharedLoadState: LoadState = 'loading';
const sharedListeners: Set<() => void> = new Set();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let subscriberCount = 0;
const ERROR_RETRY_MS = 1_000;
const DOWNLOADING_POLL_MS = 5_000;
const READY_POLL_MS = 30_000;

function notifyListeners() {
  sharedListeners.forEach((fn) => fn());
}

async function fetchToolboxStatus() {
  const authorityState = await rendererSidecarRequestAuthorityState();
  if (authorityState !== 'ready') {
    sharedLoadState = authorityState === 'unavailable' ? 'unavailable' : 'loading';
    updatePollRate();
    notifyListeners();
    return;
  }
  try {
    const response = await toolboxStatusToolboxStatusGet(serviceManager.client().options());
    sharedData = response.data as ToolboxData;
    sharedLoadState = 'loaded';
  } catch (error) {
    sharedLoadState = isApiError(error) && error.status === 401 ? 'unavailable' : 'error';
  }
  updatePollRate();
  notifyListeners();
}

function startPolling() {
  if (pollTimer) return;
  fetchToolboxStatus();
  updatePollRate();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

let currentRate = READY_POLL_MS;
function updatePollRate() {
  if (sharedLoadState === 'unavailable') {
    stopPolling();
    currentRate = READY_POLL_MS;
    return;
  }
  const isDownloading = sharedData?.capabilities.some((c) => c.status === 'downloading') ?? false;
  const targetRate =
    sharedLoadState === 'error' || sharedLoadState === 'loading'
      ? ERROR_RETRY_MS
      : isDownloading
        ? DOWNLOADING_POLL_MS
        : READY_POLL_MS;
  if (targetRate !== currentRate || !pollTimer) {
    stopPolling();
    currentRate = targetRate;
    pollTimer = setInterval(fetchToolboxStatus, currentRate);
  }
}

export function useToolboxStatus() {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const listener = () => {
      forceUpdate((n) => n + 1);
    };
    sharedListeners.add(listener);
    subscriberCount++;
    if (subscriberCount === 1) startPolling();
    return () => {
      sharedListeners.delete(listener);
      subscriberCount--;
      if (subscriberCount === 0) stopPolling();
    };
  }, []);

  const refetch = useCallback(() => {
    fetchToolboxStatus();
  }, []);

  const postToolboxAction = useCallback(
    async (action: (options: RequestInit) => Promise<unknown>) => {
      const authorityState = await rendererSidecarRequestAuthorityState();
      if (authorityState !== 'ready') {
        sharedLoadState = authorityState === 'unavailable' ? 'unavailable' : 'loading';
        updatePollRate();
        notifyListeners();
        return;
      }
      try {
        await action(serviceManager.client().options());
      } catch {}
      fetchToolboxStatus();
    },
    []
  );

  const retry = useCallback(
    (capId: string) =>
      postToolboxAction((options) => toolboxRetryToolboxRetryCapIdPost(capId, options)),
    [postToolboxAction]
  );

  const healthCheck = useCallback(
    (capId: string) =>
      postToolboxAction((options) => toolboxHealthCheckToolboxHealthCapIdPost(capId, options)),
    [postToolboxAction]
  );

  return {
    data: sharedData,
    loadState: sharedLoadState,
    refetch,
    retry,
    healthCheck,
  };
}

function computeBadge(data: ToolboxData | null): ToolboxBadge {
  const caps = data?.capabilities ?? [];
  if (caps.some((c) => c.status === 'downloading')) return 'downloading';
  if (caps.some((c) => c.status === 'error')) return 'error';
  return null;
}

export function useToolboxBadge(): ToolboxBadge {
  const badgeRef = useRef<ToolboxBadge>(computeBadge(sharedData));
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const listener = () => {
      const next = computeBadge(sharedData);
      if (next === badgeRef.current) return;
      badgeRef.current = next;
      forceUpdate((n) => n + 1);
    };
    sharedListeners.add(listener);
    subscriberCount++;
    if (subscriberCount === 1) startPolling();
    return () => {
      sharedListeners.delete(listener);
      subscriberCount--;
      if (subscriberCount === 0) stopPolling();
    };
  }, []);

  return badgeRef.current;
}

export function _resetToolboxState() {
  stopPolling();
  sharedData = null;
  sharedLoadState = 'loading';
  sharedListeners.clear();
  subscriberCount = 0;
  currentRate = READY_POLL_MS;
  devOverrideActive = false;
}

let devOverrideActive = false;

export function _setDevOverride(data: ToolboxData): void {
  stopPolling();
  devOverrideActive = true;
  sharedData = data;
  sharedLoadState = 'loaded';
  notifyListeners();
}

export function _clearDevOverride(): void {
  devOverrideActive = false;
  sharedData = null;
  sharedLoadState = 'loading';
  notifyListeners();
  if (subscriberCount > 0) startPolling();
}

export function _getDevOverrideState() {
  return {
    data: sharedData,
    loadState: sharedLoadState,
    isOverridden: devOverrideActive,
  };
}
