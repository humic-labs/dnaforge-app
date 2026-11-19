import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, type MutableRefObject, type Dispatch, type SetStateAction } from 'react';
import { applyZoomLevel } from '../lib/applyZoomLevel';
import { isDesktopRuntime, isHostedBrowserRuntime } from '../utils/environment';
import { startMocloFactoryStageOutputSync } from '../features/design';
import {
  failClosedAnalyticsForSession,
  hasTelemetryDestination,
  readAnalyticsConsentPolicy,
  setAnalyticsConsent,
} from '../lib/analytics';
import { setUsageAnalyticsChoice } from '../lib/usage-analytics-setting-source';
import {
  DESKTOP_ANALYTICS_OPT_IN_MESSAGE,
  DESKTOP_ANALYTICS_TOAST_MESSAGE,
} from '@waypoint/analytics-policy';
import { getSetting } from '../db';
import { readNoticeVersion, rememberNotice } from '../lib/desktop-notice-history';
import { useToastStore } from '../stores/toast-store';
import {
  PRIVACY_POLICY_UPDATED_MESSAGE,
  PRIVACY_POLICY_UPDATED_ON,
  PRIVACY_POLICY_URL,
} from '../lib/privacy-policy-update';

type DevScenarioReplayWindow = Window & {
  __WAYPOINT_DEV_SCENARIO_REPLAY_EPOCH__?: number;
  __WAYPOINT_DEV_SCENARIO_REPLAY_SETTLED_EPOCH__?: number;
};

type DevTestWindow = Window & {
  __shellPreparedAt?: number;
  __webglMapRenderCount?: number;
};

type AppStartupOptions = {
  readonly shellPrepared: boolean;
  readonly setShellPrepared: Dispatch<SetStateAction<boolean>>;
  readonly shellError: string | null;
  readonly setShellError: Dispatch<SetStateAction<string | null>>;
  readonly workspaceRestored: boolean;
  readonly setWorkspaceRestored: Dispatch<SetStateAction<boolean>>;
  readonly workspaceLoading: boolean;
  readonly workspaceError: string | null;
  readonly libraryLoaded: boolean;
  readonly projectCollectionRestoredRef: MutableRefObject<boolean>;
  readonly onShellReady?: () => Promise<void>;
  readonly optionalSetupStarted: MutableRefObject<boolean>;
  readonly getDevTestWindow: () => DevTestWindow | null;
  readonly devScenarioRuntimeEnabled: boolean;
  readonly devScenarioReplayEpoch: number;
  readonly getE2E: () => { e2e?: boolean };
};

function acknowledgeAnalyticsNotice(): Promise<void> {
  return rememberNotice('usage-analytics', 'true');
}

export function useAppStartup({
  shellPrepared,
  setShellPrepared,
  shellError,
  setShellError,
  workspaceRestored,
  setWorkspaceRestored,
  workspaceLoading,
  workspaceError,
  libraryLoaded,
  projectCollectionRestoredRef,
  onShellReady,
  optionalSetupStarted,
  getDevTestWindow,
  devScenarioRuntimeEnabled,
  devScenarioReplayEpoch,
  getE2E,
}: AppStartupOptions): void {
  useEffect(() => {
    if (!optionalSetupStarted.current) {
      optionalSetupStarted.current = true;
      void applyZoomLevel().catch((error) =>
        console.warn('[Startup] Display zoom unavailable:', error)
      );
      startMocloFactoryStageOutputSync();
    }
    const testWindow = getDevTestWindow();
    if (testWindow) testWindow.__shellPreparedAt = performance.now();
    setShellPrepared(true);
    if (isHostedBrowserRuntime()) setWorkspaceRestored(true);
  }, [getDevTestWindow, optionalSetupStarted, setShellPrepared, setWorkspaceRestored]);

  useEffect(() => {
    if (isHostedBrowserRuntime()) {
      setWorkspaceRestored(true);
      return;
    }
    const projectCollectionReady =
      !isDesktopRuntime() || getE2E().e2e || projectCollectionRestoredRef.current;
    if (!workspaceLoading && !workspaceError && projectCollectionReady) setWorkspaceRestored(true);
  }, [
    getE2E,
    projectCollectionRestoredRef,
    setWorkspaceRestored,
    workspaceError,
    workspaceLoading,
    libraryLoaded,
  ]);

  useEffect(() => {
    if (!shellPrepared || !workspaceRestored || shellError || !onShellReady) return;
    let cancelled = false;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (cancelled) return;
        void onShellReady().catch((error: unknown) => {
          if (!cancelled) setShellError(toUserMessage(error, 'operation.failed'));
        });
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [shellError, shellPrepared, setShellError, onShellReady, workspaceRestored]);

  useEffect(() => {
    if (!shellPrepared) return;
    const shellPreparedAt = getDevTestWindow()?.__shellPreparedAt ?? performance.now();
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const webglRenders = getDevTestWindow()?.__webglMapRenderCount ?? 0;
        console.log(
          `[init-timing] first content frame painted +${(
            performance.now() - shellPreparedAt
          ).toFixed(0)}ms after shellPrepared; WebGLMap renders so far = ${webglRenders}`
        );
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [getDevTestWindow, shellPrepared]);

  useEffect(() => {
    if (!shellPrepared) return;

    async function showPrivacyPolicyUpdateOnce(): Promise<void> {
      if ((await readNoticeVersion('privacy-policy')) === PRIVACY_POLICY_UPDATED_ON) return;
      await rememberNotice('privacy-policy', PRIVACY_POLICY_UPDATED_ON);
      useToastStore.getState().addRichToast({
        definition: 'privacy-policy-updated',
        message: toUserMessage(PRIVACY_POLICY_UPDATED_MESSAGE),
        actions: [
          {
            label: 'Read it',
            onClick: () => window.open(PRIVACY_POLICY_URL, '_blank'),
          },
        ],
      });
    }

    async function initAnalytics(): Promise<void> {
      try {
        if (isHostedBrowserRuntime()) {
          await failClosedAnalyticsForSession();
          return;
        }
        const decision = await readAnalyticsConsentPolicy();
        if (!decision) {
          await failClosedAnalyticsForSession();
          return;
        }
        const bannerSeen = (await readNoticeVersion('usage-analytics')) === 'true';
        console.log(
          `[Analytics] Policy resolved: enabled=${decision.enabled}, disclosure=${decision.needsDisclosure}`
        );

        if (getE2E().e2e) {
          console.log('[Analytics] Non-telemetry E2E launch — resolving consent off');
          await setAnalyticsConsent(false);
          await acknowledgeAnalyticsNotice();
          return;
        }

        try {
          if (decision.consent === 'true' && (bannerSeen || !decision.needsDisclosure)) {
            await showPrivacyPolicyUpdateOnce();
          } else {
            await rememberNotice('privacy-policy', PRIVACY_POLICY_UPDATED_ON);
          }
        } catch (noticeError) {
          console.error('[Privacy] Policy update notice failed:', noticeError);
        }

        if (decision.enabled) {
          await setAnalyticsConsent(true, {
            resumeExistingEpisode: !decision.needsDisclosure,
          });
          if (!bannerSeen && (await hasTelemetryDestination())) {
            if (
              !decision.needsDisclosure &&
              (await getSetting('analytics_consent_basis')) === 'explicit'
            ) {
              await acknowledgeAnalyticsNotice();
              return;
            }
            try {
              useToastStore.getState().addRichToast({
                definition: 'data-privacy',
                message: toUserMessage(DESKTOP_ANALYTICS_TOAST_MESSAGE),
                onDismiss: acknowledgeAnalyticsNotice,
                actions: [
                  {
                    label: 'Privacy details',
                    onClick: () => window.open('https://dnaforge.com/privacy', '_blank'),
                  },
                ],
              });
            } catch (disclosureError) {
              console.error('[Analytics] Disclosure UI failed:', disclosureError);
            }
          }
          return;
        }

        if (decision.consent === 'false') {
          await setAnalyticsConsent(false);
          return;
        }

        await failClosedAnalyticsForSession();
        const optInPromptSeen =
          (await readNoticeVersion('usage-analytics-opt-in')) === 'true' ||
          (bannerSeen && (await getSetting('analytics_consent_basis')) !== 'default');
        if (!optInPromptSeen && decision.needsDisclosure && (await hasTelemetryDestination())) {
          useToastStore.getState().addRichToast({
            definition: 'data-privacy-opt-in',
            message: toUserMessage(DESKTOP_ANALYTICS_OPT_IN_MESSAGE),
            onDismiss: async () => {
              await rememberNotice('usage-analytics-opt-in', 'true');
              await acknowledgeAnalyticsNotice();
            },
            actions: [
              {
                label: 'Share',
                onClick: () => {
                  void setUsageAnalyticsChoice(true).catch((error) => {
                    console.error('[Analytics] Opt-in failed:', error);
                  });
                },
              },
              {
                label: "Don't share",
                onClick: () => {
                  void setUsageAnalyticsChoice(false).catch((error) => {
                    console.error('[Analytics] Opt-out failed:', error);
                  });
                },
              },
              {
                label: 'Privacy details',
                onClick: () => window.open('https://dnaforge.com/privacy', '_blank'),
              },
            ],
          });
        }
      } catch (error) {
        console.error('[Analytics] Init failed:', error);
        await failClosedAnalyticsForSession().catch((closeError) => {
          console.error('[Analytics] Failed to close session telemetry gates:', closeError);
        });
      }
    }
    void initAnalytics();
  }, [getE2E, shellPrepared]);

  useEffect(() => {
    if (!shellPrepared || !devScenarioRuntimeEnabled) return;

    const replayWindow = window as DevScenarioReplayWindow;
    if (replayWindow.__WAYPOINT_DEV_SCENARIO_REPLAY_EPOCH__ === devScenarioReplayEpoch) return;
    replayWindow.__WAYPOINT_DEV_SCENARIO_REPLAY_EPOCH__ = devScenarioReplayEpoch;
    delete replayWindow.__WAYPOINT_DEV_SCENARIO_REPLAY_SETTLED_EPOCH__;

    let cancelled = false;
    void import('../test/scenarios/apply-dev')
      .then(async (mod) => {
        const result = await mod.replayLastAppliedDevScenario();
        if (cancelled) return;
        if (result.status === 'applied') {
          console.info(
            `[DevScenarioReplay] Replayed ${result.label} (${result.presetId}) after renderer boot/HMR.`
          );
        } else if (result.status === 'missing') {
          console.warn(
            `[DevScenarioReplay] Cleared unknown persisted preset id: ${result.presetId}`
          );
        }
      })
      .catch((error) => {
        if (!cancelled)
          console.error('[DevScenarioReplay] Failed to replay persisted scenario:', error);
      })
      .finally(() => {
        if (replayWindow.__WAYPOINT_DEV_SCENARIO_REPLAY_EPOCH__ === devScenarioReplayEpoch) {
          replayWindow.__WAYPOINT_DEV_SCENARIO_REPLAY_SETTLED_EPOCH__ = devScenarioReplayEpoch;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [devScenarioReplayEpoch, devScenarioRuntimeEnabled, shellPrepared]);
}
