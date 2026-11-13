import { supportsWheelMomentum } from '@waypoint/platform/wheel-motion';
import { toUserMessage } from '@waypoint/user-messages';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { WorkspaceEditorConfig } from '@waypoint/workspace-editor';
import {
  SequenceViewer,
  DEFAULT_EDITOR_CONFIG,
  MIN_ZOOM,
  MAX_ZOOM,
  deriveSequenceLodLevel,
} from '@waypoint/workspace-editor';

const FIXTURES = {
  puc19: '/harness-fixtures/puc19.gb',
  s288c_chr1: '/harness-fixtures/s288c_chr1.gb',
  s288c_chr4: '/harness-fixtures/s288c_chr4.gb',
  ecoli: '/harness-fixtures/ecoli.gb',
  linear: '/harness-fixtures/linear.gb',
  origin_introns: '/harness-fixtures/origin-introns.gb',
} as const;

type FixtureName = keyof typeof FIXTURES;

function isFixtureName(name: string): name is FixtureName {
  return name in FIXTURES;
}

interface HarnessState {
  status: 'loading' | 'ready' | 'error';
  sequence?: AnnotatedSequence;
  error?: string;
}

const SCROLL_CONTAINER_TESTID = 'sequence-scroll-container';

type HarnessScrollWrite = { t: number; from: number; to: number; stackTop: string };
type HarnessCanvasResize = { t: number; w: number; h: number };

type HarnessWindow = Window & {
  __benchInstalled?: boolean;
  __benchGetZoomLevel?: () => number;
  __scrollWriteLog?: HarnessScrollWrite[];
  __canvasResizeLog?: HarnessCanvasResize[];
  __workspaceEditor?: {
    getSelection: () => unknown;
    getHighlightedRange: () => unknown;
  };
  __harnessReady?: boolean;
  __harnessFixture?: string;
  __harnessState?: () => {
    zoomLevel: number | null;
    scrollTop: number;
    canvasWidth: number;
    canvasHeight: number;
    layoutVersion: number;
    t: number;
  };
  __layoutRecomputeCount?: number;
  __benchReset?: () => void;
};

function harnessWindow(): HarnessWindow {
  return window as HarnessWindow;
}

function installBenchmarkInstrumentation(getZoomLevel: () => number): void {
  if (typeof window === 'undefined') return;
  const w = harnessWindow();
  if (w.__benchInstalled) {
    w.__benchGetZoomLevel = getZoomLevel;
    return;
  }
  w.__benchInstalled = true;
  w.__benchGetZoomLevel = getZoomLevel;
  const scrollWriteLog: HarnessScrollWrite[] = [];
  const canvasResizeLog: HarnessCanvasResize[] = [];
  w.__scrollWriteLog = scrollWriteLog;
  w.__canvasResizeLog = canvasResizeLog;
  const t0 = performance.now();

  const desc =
    Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop') ??
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
  if (desc?.set && desc.get) {
    const origSet = desc.set;
    const origGet = desc.get;
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) {
        return origGet.call(this);
      },
      set(this: HTMLElement, v: number) {
        if (this.getAttribute?.('data-testid') === SCROLL_CONTAINER_TESTID) {
          const before = origGet.call(this) as number;
          const stack = (new Error().stack ?? '').split('\n').slice(2, 6).join(' | ');
          scrollWriteLog.push({
            t: performance.now() - t0,
            from: before,
            to: v,
            stackTop: stack,
          });
        }
        origSet.call(this, v);
      },
    });
  }

  const mo = new MutationObserver((muts) => {
    const seen = new Map<HTMLCanvasElement, { w: number; h: number }>();
    for (const m of muts) {
      if (m.type !== 'attributes') continue;
      const t = m.target;
      if (!(t instanceof HTMLCanvasElement)) continue;
      const container = t.closest(`[data-testid="${SCROLL_CONTAINER_TESTID}"]`);
      if (!container) continue;
      seen.set(t, { w: t.width, h: t.height });
    }
    const now = performance.now() - t0;
    for (const { w: cw, h: ch } of seen.values()) {
      canvasResizeLog.push({ t: now, w: cw, h: ch });
    }
  });
  const tryAttach = () => {
    const el = document.querySelector(`[data-testid="${SCROLL_CONTAINER_TESTID}"]`);
    if (el) {
      mo.observe(el, {
        subtree: true,
        attributes: true,
        attributeFilter: ['width', 'height'],
      });
    } else {
      setTimeout(tryAttach, 50);
    }
  };
  tryAttach();

  w.__harnessState = () => {
    const container = document.querySelector<HTMLElement>(
      `[data-testid="${SCROLL_CONTAINER_TESTID}"]`
    );
    const canvas = document.querySelector<HTMLCanvasElement>(
      `[data-testid="${SCROLL_CONTAINER_TESTID}"] canvas`
    );
    return {
      zoomLevel: w.__benchGetZoomLevel?.() ?? null,
      scrollTop: container?.scrollTop ?? -1,
      canvasWidth: canvas?.width ?? -1,
      canvasHeight: canvas?.height ?? -1,
      layoutVersion: w.__layoutRecomputeCount ?? 0,
      t: performance.now() - t0,
    };
  };

  w.__benchReset = () => {
    scrollWriteLog.length = 0;
    canvasResizeLog.length = 0;
    w.__scrollWriteLog = scrollWriteLog;
    w.__canvasResizeLog = canvasResizeLog;
  };
}

function readZoomStartParam(): number {
  const raw = new URLSearchParams(window.location.search).get('zoomStart');
  if (!raw) return 100;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 100;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, n));
}

export function HarnessPage(): JSX.Element {
  const [state, setState] = useState<HarnessState>({ status: 'loading' });
  const fixtureName = new URLSearchParams(window.location.search).get('harness');

  const [zoomLevel, setZoomLevel] = useState<number>(() => readZoomStartParam());
  const zoomLevelRef = useRef<number>(zoomLevel);
  zoomLevelRef.current = zoomLevel;

  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const [highlightedRange, setHighlightedRange] = useState<{
    start: number;
    end: number;
  } | null>(null);

  useEffect(() => {
    installBenchmarkInstrumentation(() => zoomLevelRef.current);
    const w = harnessWindow();
    w.__workspaceEditor = {
      getSelection: () => selectionRef.current,
      getHighlightedRange: () => highlightedRange,
    };
  }, [highlightedRange]);
  const config = useMemo<Partial<WorkspaceEditorConfig>>(() => {
    const s = zoomLevel / 100;
    const scaled = {
      charWidth: DEFAULT_EDITOR_CONFIG.charWidth * s,
      fontSize: DEFAULT_EDITOR_CONFIG.fontSize * s,
      rowHeight: DEFAULT_EDITOR_CONFIG.rowHeight * s,
    };
    const lodLevel = deriveSequenceLodLevel(scaled);
    const isDetailLod = lodLevel === 'detail';
    return {
      lodLevel,
      overviewLod: lodLevel === 'density',
      showAnnotations: DEFAULT_EDITOR_CONFIG.showAnnotations,
      showTranslation: isDetailLod ? DEFAULT_EDITOR_CONFIG.showTranslation : false,
      showReverseComplement: isDetailLod ? DEFAULT_EDITOR_CONFIG.showReverseComplement : false,
      showPrimers: lodLevel !== 'density' ? DEFAULT_EDITOR_CONFIG.showPrimers : false,
      showResidueNumbers: isDetailLod ? DEFAULT_EDITOR_CONFIG.showResidueNumbers : false,
      charWidth: scaled.charWidth,
      fontSize: scaled.fontSize,
      rowHeight: scaled.rowHeight,
    };
  }, [zoomLevel]);

  useEffect(() => {
    if (!fixtureName) {
      setState({ status: 'error', error: 'Missing ?harness=<name> URL parameter' });
      return;
    }
    if (!isFixtureName(fixtureName)) {
      setState({
        status: 'error',
        error: `Unknown fixture: ${fixtureName}. Known: ${Object.keys(FIXTURES).join(', ')}`,
      });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const url = FIXTURES[fixtureName];
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
        }
        const text = await res.text();
        const parsed = parseGenBankFull(text);
        if (!cancelled) {
          setState({ status: 'ready', sequence: parsed });
          harnessWindow().__harnessReady = true;
          harnessWindow().__harnessFixture = fixtureName;
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            error: toUserMessage(err, 'operation.failed'),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fixtureName]);

  if (state.status === 'loading') {
    return (
      <div data-testid="harness-loading" style={loadingStyle}>
        Loading fixture {fixtureName ?? '(none)'}...
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div data-testid="harness-error" style={errorStyle}>
        <h3>Harness error</h3>
        <p>{toUserMessage(state.error, 'operation.failed')}</p>
      </div>
    );
  }

  return (
    <div data-testid="harness-root" style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <SequenceViewer
        browserWheelGestureOwnership={supportsWheelMomentum()}
        sequence={state.sequence!}
        config={config}
        zoomLevel={zoomLevel}
        onZoomLevelChange={setZoomLevel}
        showMinimap={true}
        onSelectionChange={(sel) => {
          selectionRef.current =
            sel && typeof sel.start === 'number' && typeof sel.end === 'number'
              ? { start: sel.start, end: sel.end }
              : null;
        }}
        highlightedRange={highlightedRange}
        onHighlightedRangeChange={(range) => {
          setHighlightedRange(
            range && typeof range.start === 'number' && typeof range.end === 'number'
              ? { start: range.start, end: range.end }
              : null
          );
        }}
      />
    </div>
  );
}

const loadingStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100vh',
  fontFamily: 'monospace',
};

const errorStyle: React.CSSProperties = {
  padding: 24,
  fontFamily: 'monospace',
  color: 'red',
};
