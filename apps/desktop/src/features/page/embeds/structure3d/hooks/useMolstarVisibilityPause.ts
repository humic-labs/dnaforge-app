import { useEffect, type RefObject } from 'react';
import { findScrollParent } from '../utils/findScrollParent';
import { scheduleMolstarFrameKicks } from '../molstar/viewerFrameKicks';

type Canvas3dLike = {
  pause?: (noDraw?: boolean) => void;
  resume?: () => void;
};

type PluginLike = {
  canvas3d?: Canvas3dLike | null;
};

export function useMolstarVisibilityPause(options: {
  wrapperRef: RefObject<HTMLElement | null>;
  viewerReady: boolean;
  getPlugin: () => PluginLike | null | undefined;
  isCurrent?: () => boolean;
  pauseWhileScrolling?: boolean;
}): void {
  const { wrapperRef, viewerReady, getPlugin, isCurrent, pauseWhileScrolling = false } = options;

  useEffect(() => {
    if (!viewerReady) return;
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof IntersectionObserver === 'undefined') return;

    const root = findScrollParent(wrapper);
    let phase: 'active' | 'retired' = 'active';
    const ownsVisibility = () => phase === 'active' && (isCurrent?.() ?? true);
    let paused = false;
    let offscreen = false;
    let scrolling = false;
    let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelResumeKicks: (() => void) | null = null;

    const setPaused = (shouldPause: boolean) => {
      const plugin = getPlugin();
      const canvas3d = plugin?.canvas3d;
      if (!canvas3d) return;
      if (shouldPause === paused) return;
      paused = shouldPause;
      if (shouldPause) {
        cancelResumeKicks?.();
        cancelResumeKicks = null;
        try {
          canvas3d.pause?.(true);
        } catch {}
        return;
      }
      try {
        canvas3d.resume?.();
      } catch {}
      if (plugin) {
        cancelResumeKicks?.();
        cancelResumeKicks = scheduleMolstarFrameKicks(plugin, {
          isCurrent: ownsVisibility,
          mode: 'visibility-resume',
        });
      }
    };

    const syncPause = () => {
      if (!ownsVisibility()) return;
      setPaused(offscreen || scrolling);
    };

    const markScrolling = () => {
      if (!ownsVisibility()) return;
      scrolling = true;
      syncPause();
      if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
      scrollIdleTimer = setTimeout(() => {
        scrolling = false;
        syncPause();
      }, 120);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        offscreen = !entry.isIntersecting;
        syncPause();
      },
      { root, rootMargin: '80px 0px', threshold: 0 }
    );
    observer.observe(wrapper);

    if (root && pauseWhileScrolling) {
      root.addEventListener('scroll', markScrolling, { passive: true });
      root.addEventListener('wheel', markScrolling, { passive: true });
    }

    return () => {
      phase = 'retired';
      observer.disconnect();
      cancelResumeKicks?.();
      if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
      if (root && pauseWhileScrolling) {
        root.removeEventListener('scroll', markScrolling);
        root.removeEventListener('wheel', markScrolling);
      }
      if (paused) {
        setPaused(false);
        cancelResumeKicks?.();
      }
    };
  }, [wrapperRef, viewerReady, getPlugin, isCurrent, pauseWhileScrolling]);
}
