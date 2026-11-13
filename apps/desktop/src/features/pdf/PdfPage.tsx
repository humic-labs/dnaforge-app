import { userMessage } from '@waypoint/user-messages';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ScientificPdfRect } from '../scientific-document/public/model';

export type PdfPageOverlay = {
  id: string;
  protocolPath: string;
  stepId: string;
  label: string;
  rects: ScientificPdfRect[];
  selected: boolean;
  highlighted: boolean;
};
export type PdfPageFailure = 'page' | 'canvas' | 'text';
export type PdfPageReport = {
  generationId: string;
  phase: 'canvas_complete' | 'ready' | 'presented' | 'failed';
  textAvailable?: boolean;
  failure?: PdfPageFailure;
};
export type PdfCitationTarget = { requestId: string; anchorId: string };
type PdfPageSource = Pick<
  Awaited<ReturnType<PDFDocumentProxy['getPage']>>,
  'getViewport' | 'getTextContent' | 'render'
>;
type PdfPageProps = {
  document: { getPage(pageNumber: number): Promise<PdfPageSource> };
  pageNumber: number;
  scale: number;
  generationId: string;
  isActive?: boolean;
  viewportRef?: RefObject<HTMLElement | null>;
  citationTarget?: PdfCitationTarget | null;
  onCitationPresented?: (generationId: string, requestId: string, anchorId: string) => void;
  overlays?: PdfPageOverlay[];
  onHoverStep?: (protocolPath: string, stepId: string, hovered: boolean) => void;
  onSelectStep?: (protocolPath: string, stepId: string) => void;
  onReport?: (report: PdfPageReport) => void;
  onRetry?: () => void;
  onReload?: () => void;
  onSize?: (width: number, height: number) => void;
};
type PdfPageStyle = CSSProperties & { '--total-scale-factor': number };
type RenderState = {
  generationId: string;
  phase: 'rendering' | 'paint_pending' | 'ready' | 'failed';
  textAvailable: boolean;
  failure?: PdfPageFailure;
};

export function PdfPage({
  document,
  pageNumber,
  scale,
  generationId,
  isActive = true,
  viewportRef,
  citationTarget,
  onCitationPresented,
  overlays = [],
  onHoverStep,
  onSelectStep,
  onReport,
  onRetry,
  onReload,
  onSize,
}: PdfPageProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const current = useRef(generationId);
  current.current = generationId;
  const report = useRef(onReport);
  report.current = onReport;
  const reportSize = useRef(onSize);
  reportSize.current = onSize;
  const active = useRef(isActive);
  active.current = isActive;
  const citationReport = useRef(onCitationPresented);
  citationReport.current = onCitationPresented;
  const presentedGeneration = useRef<string | null>(null);
  const arrivedRequest = useRef<string | null>(null);
  const [size, setSize] = useState<{ generationId: string; width: number; height: number } | null>(
    null
  );
  const [state, setState] = useState<RenderState>({
    generationId,
    phase: 'rendering',
    textAvailable: false,
  });

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    let ownedText: HTMLDivElement | null = null;
    const isCurrent = () => !cancelled && current.current === generationId;
    const render = async () => {
      const canvas = canvasRef.current;
      const container = textLayerRef.current;
      if (!canvas || !container) return;
      let failure: PdfPageFailure = 'page';
      setState({ generationId, phase: 'rendering', textAvailable: false });
      try {
        const page = await document.getPage(pageNumber);
        if (import.meta.env.MODE === 'test')
          await (await import('./pdf-test-controls')).waitPdfPhase('page');
        if (!isCurrent()) return;
        const viewport = page.getViewport({ scale });
        const outputScale = window.devicePixelRatio || 1;
        failure = 'canvas';
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('PDF canvas unavailable');
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        setSize({ generationId, width: viewport.width, height: viewport.height });
        reportSize.current?.(viewport.width, viewport.height);
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        await renderTask.promise;
        if (import.meta.env.MODE === 'test')
          await (await import('./pdf-test-controls')).waitPdfPhase('canvas');
        if (!isCurrent()) return;
        report.current?.({ generationId, phase: 'canvas_complete' });
        failure = 'text';
        const content = await page.getTextContent();
        if (import.meta.env.MODE === 'test')
          await (await import('./pdf-test-controls')).waitPdfPhase('text');
        if (!isCurrent()) return;
        ownedText = window.document.createElement('div');
        ownedText.className = 'pdf-owned-text-generation';
        container.replaceChildren(ownedText);
        textLayer = new TextLayer({ container: ownedText, textContentSource: content, viewport });
        await textLayer.render();
        if (!isCurrent()) return;
        const textAvailable = content.items.some(
          (item) => 'str' in item && item.str.trim().length > 0
        );
        setState({ generationId, phase: 'paint_pending', textAvailable });
      } catch {
        if (!isCurrent()) return;
        setState({ generationId, phase: 'failed', textAvailable: false, failure });
        report.current?.({ generationId, phase: 'failed', failure });
      }
    };
    void render();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      ownedText?.remove();
    };
  }, [document, pageNumber, scale, generationId]);

  useLayoutEffect(() => {
    if (state.generationId !== generationId || state.phase !== 'paint_pending') return;
    let cancelled = false;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (cancelled || current.current !== generationId) return;
        setState({ ...state, phase: 'ready' });
        report.current?.({ generationId, phase: 'ready', textAvailable: state.textAvailable });
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [state, generationId]);

  const owned = state.generationId === generationId;
  const ready = owned && state.phase === 'ready';
  const painted = owned && (state.phase === 'paint_pending' || ready);
  const failed = owned && state.phase === 'failed';
  useLayoutEffect(() => {
    const page = pageRef.current;
    const viewport = viewportRef?.current;
    if (!ready || !isActive || !page || !viewport) return;
    let retired = false;
    let firstFrame = 0;
    let secondFrame = 0;
    let revealed = false;
    const isCurrent = () => !retired && active.current && current.current === generationId;
    const inspect = () => {
      if (
        !isCurrent() ||
        window.document.visibilityState !== 'visible' ||
        !visibleInViewport(page, viewport)
      )
        return;
      if (presentedGeneration.current !== generationId) {
        presentedGeneration.current = generationId;
        report.current?.({ generationId, phase: 'presented' });
      }
      if (!citationTarget || arrivedRequest.current === citationTarget.requestId) return;
      const target = Array.from(
        page.querySelectorAll<HTMLButtonElement>('[data-pdf-evidence-anchor]')
      ).find((element) => element.dataset.pdfEvidenceAnchor === citationTarget.anchorId);
      if (!target || !displayed(target)) return;
      if (!revealed) {
        const rect = target.getBoundingClientRect();
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          !Number.isFinite(rect.top + rect.bottom + rect.left + rect.right)
        )
          return;
        const bounds = visibleBounds(viewport);
        if (!bounds) return;
        viewport.scrollTop += (rect.top + rect.bottom - bounds.top - bounds.bottom) / 2;
        viewport.scrollLeft += (rect.left + rect.right - bounds.left - bounds.right) / 2;
        revealed = true;
        schedule();
        return;
      }
      if (!visibleInViewport(target, viewport) || !isCurrent()) return;
      arrivedRequest.current = citationTarget.requestId;
      citationReport.current?.(generationId, citationTarget.requestId, citationTarget.anchorId);
    };
    const schedule = () => {
      if (!isCurrent() || firstFrame || secondFrame) return;
      firstFrame = requestAnimationFrame(() => {
        firstFrame = 0;
        if (!isCurrent()) return;
        secondFrame = requestAnimationFrame(() => {
          secondFrame = 0;
          inspect();
        });
      });
    };
    window.document.addEventListener('scroll', schedule, true);
    window.document.addEventListener('visibilitychange', schedule);
    window.addEventListener('resize', schedule);
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resize?.observe(page);
    resize?.observe(viewport);
    const intersection =
      typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(schedule);
    intersection?.observe(page);
    const mutations = new MutationObserver(schedule);
    for (let element: HTMLElement | null = page; element; element = element.parentElement) {
      mutations.observe(element, {
        attributes: true,
        subtree: element === page,
        attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
      });
    }
    schedule();
    return () => {
      retired = true;
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      window.document.removeEventListener('scroll', schedule, true);
      window.document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('resize', schedule);
      resize?.disconnect();
      intersection?.disconnect();
      mutations.disconnect();
    };
  }, [ready, isActive, generationId, viewportRef, citationTarget, overlays]);
  const ownedSize = size?.generationId === generationId ? size : null;
  const style: PdfPageStyle = {
    width: ownedSize?.width,
    height: ownedSize?.height,
    '--total-scale-factor': scale,
  };
  const failureText =
    state.failure === 'text'
      ? userMessage('pdf.textFailed')
      : state.failure === 'canvas'
        ? userMessage('pdf.canvasFailed')
        : userMessage('pdf.pageFailed');
  return (
    <div
      ref={pageRef}
      aria-label={`PDF page ${pageNumber}`}
      className="pdf-page relative min-h-24 bg-white shadow-[0_1px_5px_rgb(0_0_0/0.22)]"
      data-pdf-page={pageNumber}
      data-testid="pdf-page"
      data-render-generation={generationId}
      data-render-phase={owned ? state.phase : 'rendering'}
      style={style}
    >
      <canvas
        key={`canvas-${generationId}`}
        aria-hidden="true"
        className="block"
        data-testid="pdf-page-canvas"
        ref={canvasRef}
        style={{ visibility: painted ? 'visible' : 'hidden' }}
      />
      <div
        key={`text-${generationId}`}
        className="pdf-text-layer textLayer"
        ref={textLayerRef}
        style={{ visibility: painted ? 'visible' : 'hidden' }}
      />
      {ready && (
        <div aria-label="Protocol evidence" className="pointer-events-none absolute inset-0 z-[3]">
          {overlays.flatMap((overlay) =>
            overlay.rects.map((rect, index) => (
              <button
                aria-label={overlay.label}
                aria-pressed={overlay.selected}
                className={`pointer-events-auto absolute border transition-colors ${overlay.selected ? 'border-accent bg-accent/25' : overlay.highlighted ? 'border-accent/80 bg-accent/15' : 'border-accent/50 bg-accent/10'}`}
                data-pdf-evidence-step={overlay.stepId}
                data-pdf-evidence-anchor={overlay.id}
                key={`${overlay.id}-${index}`}
                onClick={() => onSelectStep?.(overlay.protocolPath, overlay.stepId)}
                onMouseEnter={() => onHoverStep?.(overlay.protocolPath, overlay.stepId, true)}
                onMouseLeave={() => onHoverStep?.(overlay.protocolPath, overlay.stepId, false)}
                style={{
                  height: `${rect.height * 100}%`,
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.width * 100}%`,
                }}
                title={overlay.label}
                type="button"
              />
            ))
          )}
        </div>
      )}
      {ready && !state.textAvailable && (
        <div
          role="status"
          className="absolute bottom-0 left-0 right-0 bg-white/90 px-3 py-1 text-xs text-fg-muted"
        >
          This page has no selectable text.
        </div>
      )}
      {!painted && !failed && (
        <div
          role="status"
          className="absolute inset-0 grid place-items-center text-sm text-fg-muted"
        >
          Rendering PDF page…
        </div>
      )}
      {failed && (
        <div
          role="alert"
          data-testid="pdf-page-error"
          className="absolute inset-0 grid place-items-center bg-white px-8 text-center text-sm text-red-700"
        >
          <div>
            <p>{failureText}</p>
            <div className="mt-3 flex justify-center gap-3">
              {onRetry && (
                <button type="button" onClick={onRetry}>
                  Retry page
                </button>
              )}
              {onReload && (
                <button type="button" onClick={onReload}>
                  Reload PDF
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function displayed(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      node.hidden ||
      node.getAttribute('aria-hidden') === 'true' ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0' ||
      style.getPropertyValue('content-visibility') === 'hidden'
    )
      return false;
  }
  return true;
}

function visibleInViewport(element: HTMLElement, viewport: HTMLElement): boolean {
  return viewport.contains(element) && visibleBounds(element, viewport) !== null;
}

function visibleBounds(
  element: HTMLElement,
  viewport?: HTMLElement
): { left: number; right: number; top: number; bottom: number } | null {
  if (!displayed(element)) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(window.innerWidth, rect.right);
  let bottom = Math.min(window.innerHeight, rect.bottom);
  for (let node: HTMLElement | null = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const bounds = node.getBoundingClientRect();
    if (node === viewport || /(auto|scroll|hidden|clip)/.test(style.overflowX || style.overflow)) {
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    if (node === viewport || /(auto|scroll|hidden|clip)/.test(style.overflowY || style.overflow)) {
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
  }
  return Number.isFinite(left + right + top + bottom) && right > left && bottom > top
    ? { left, right, top, bottom }
    : null;
}
