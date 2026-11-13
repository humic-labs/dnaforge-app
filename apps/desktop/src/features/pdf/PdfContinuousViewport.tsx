import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

type PdfPageSize = { width: number; height: number };
type PdfPagePosition = PdfPageSize & { pageNumber: number; top: number };
type ViewportGeometry = { top: number; height: number; width: number };

export type PdfContinuousViewportHandle = {
  goToPage: (pageNumber: number) => void;
};

type PdfContinuousViewportProps = {
  pageCount: number;
  scale: number;
  initialPage: number;
  viewportRef: RefObject<HTMLElement | null>;
  onPageChange: (pageNumber: number) => void;
  renderPage: (pageNumber: number, onSize: (width: number, height: number) => void) => ReactNode;
};

const PAGE_GAP = 24;
const DEFAULT_PAGE_SIZE: PdfPageSize = { width: 612, height: 792 };

export function pdfPagePositions(
  pageCount: number,
  scale: number,
  sizes: ReadonlyMap<number, PdfPageSize>
): PdfPagePosition[] {
  const estimated = sizes.get(1) ?? DEFAULT_PAGE_SIZE;
  let top = 0;
  return Array.from({ length: pageCount }, (_, index) => {
    const pageNumber = index + 1;
    const size = sizes.get(pageNumber) ?? estimated;
    const page = { pageNumber, top, width: size.width * scale, height: size.height * scale };
    top += page.height + PAGE_GAP;
    return page;
  });
}

function firstPageAt(pages: PdfPagePosition[], offset: number): number {
  let low = 0;
  let high = pages.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const page = pages[middle];
    if (page.top + page.height + PAGE_GAP <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function visiblePdfPages(
  pages: PdfPagePosition[],
  top: number,
  height: number
): PdfPagePosition[] {
  if (pages.length === 0) return [];
  const visible: PdfPagePosition[] = [];
  for (let index = firstPageAt(pages, top); index < pages.length; index += 1) {
    const page = pages[index];
    if (page.top >= top + height) break;
    if (page.top + page.height > top) visible.push(page);
  }
  return visible;
}

function mostVisiblePage(pages: PdfPagePosition[], top: number, height: number): number {
  const visible = visiblePdfPages(pages, top, height);
  return visible.reduce(
    (best, page) => {
      const visibleHeight =
        Math.min(top + height, page.top + page.height) - Math.max(top, page.top);
      return visibleHeight > best.height
        ? { pageNumber: page.pageNumber, height: visibleHeight }
        : best;
    },
    { pageNumber: pages[firstPageAt(pages, top)]?.pageNumber ?? 1, height: 0 }
  ).pageNumber;
}

function contentOrigin(content: HTMLElement, viewport: HTMLElement): number {
  return content.offsetParent === viewport || content.offsetParent === null
    ? content.offsetTop
    : content.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop;
}

function viewportSize(viewport: HTMLElement): PdfPageSize | null {
  const bounds = viewport.getBoundingClientRect();
  const width = viewport.clientWidth || bounds.width;
  const height = viewport.clientHeight || bounds.height;
  return width > 0 && height > 0 ? { width, height } : null;
}

export const PdfContinuousViewport = forwardRef<
  PdfContinuousViewportHandle,
  PdfContinuousViewportProps
>(function PdfContinuousViewport(
  { pageCount, scale, initialPage, viewportRef, onPageChange, renderPage },
  ref
) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<ReadonlyMap<number, PdfPageSize>>(() => new Map());
  const [geometry, setGeometry] = useState<ViewportGeometry>({
    top: (initialPage - 1) * (DEFAULT_PAGE_SIZE.height * scale + PAGE_GAP),
    height: 1,
    width: 0,
  });
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const pendingOffset = useRef<number | null>(null);
  const pages = useMemo(() => pdfPagePositions(pageCount, scale, sizes), [pageCount, scale, sizes]);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const previousPages = useRef<PdfPagePosition[] | null>(null);
  const pageChange = useRef(onPageChange);
  pageChange.current = onPageChange;
  const currentPage = useRef(initialPage);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const readGeometry = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const size = viewportSize(viewport);
    if (!size) {
      pendingOffset.current ??= geometryRef.current.top;
      return;
    }
    const origin = contentOrigin(content, viewport);
    if (pendingOffset.current !== null) {
      viewport.scrollTop = origin + pendingOffset.current;
      pendingOffset.current = null;
    }
    const style = getComputedStyle(viewport);
    const next = {
      top: Math.max(0, viewport.scrollTop - origin),
      height: size.height,
      width: Math.max(
        0,
        size.width -
          (Number.parseFloat(style.paddingLeft) || 0) -
          (Number.parseFloat(style.paddingRight) || 0)
      ),
    };
    setGeometry((previous) =>
      previous.top === next.top && previous.height === next.height && previous.width === next.width
        ? previous
        : next
    );
    const pageNumber = mostVisiblePage(pagesRef.current, next.top, next.height);
    if (currentPage.current !== pageNumber) {
      currentPage.current = pageNumber;
      pageChange.current(pageNumber);
    }
  }, [viewportRef]);

  const scrollToOffset = useCallback(
    (top: number) => {
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!viewport || !content) return;
      if (viewportSize(viewport)) {
        pendingOffset.current = null;
        viewport.scrollTop = contentOrigin(content, viewport) + top;
      } else {
        pendingOffset.current = top;
      }
      setGeometry((previous) => ({ ...previous, top }));
    },
    [viewportRef]
  );

  useImperativeHandle(
    ref,
    () => ({
      goToPage(pageNumber) {
        const bounded = Math.min(pageCount, Math.max(1, Math.trunc(pageNumber)));
        const page = pagesRef.current[bounded - 1];
        if (!page) return;
        currentPage.current = bounded;
        pageChange.current(bounded);
        scrollToOffset(page.top);
      },
    }),
    [pageCount, scrollToOffset]
  );

  useLayoutEffect(() => {
    const previous = previousPages.current;
    if (!previous || previous === pages) return;
    previousPages.current = pages;
    const previousTop = geometryRef.current.top;
    const oldPage = previous[firstPageAt(previous, previousTop)];
    const newPage = oldPage && pages[oldPage.pageNumber - 1];
    if (!oldPage || !newPage) return;
    const fraction = (previousTop - oldPage.top) / oldPage.height;
    scrollToOffset(newPage.top + fraction * newPage.height);
  }, [pages, scrollToOffset]);

  useEffect(() => {
    if (previousPages.current) return;
    previousPages.current = pages;
    const page = pages[Math.min(pageCount, Math.max(1, initialPage)) - 1];
    if (page) scrollToOffset(page.top);
  }, [pages, pageCount, initialPage, scrollToOffset]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    readGeometry();
    viewport.addEventListener('scroll', readGeometry, { passive: true });
    window.addEventListener('resize', readGeometry);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(readGeometry);
    observer?.observe(viewport);
    return () => {
      viewport.removeEventListener('scroll', readGeometry);
      window.removeEventListener('resize', readGeometry);
      observer?.disconnect();
    };
  }, [viewportRef, readGeometry]);

  const measurePage = useCallback((pageNumber: number, width: number, height: number) => {
    if (!Number.isFinite(width + height) || width <= 0 || height <= 0) return;
    const size = { width: width / scaleRef.current, height: height / scaleRef.current };
    setSizes((previous) => {
      const old = previous.get(pageNumber);
      if (old?.width === size.width && old.height === size.height) return previous;
      return new Map(previous).set(pageNumber, size);
    });
  }, []);

  const width = pages.reduce((maximum, page) => Math.max(maximum, page.width), geometry.width);
  const lastPage = pages.at(-1);
  const height = lastPage ? lastPage.top + lastPage.height : 0;
  return (
    <div
      aria-label="PDF document pages"
      className="relative"
      data-testid="pdf-continuous-pages"
      ref={contentRef}
      style={{ width, height }}
    >
      {visiblePdfPages(pages, geometry.top, geometry.height).map((page) => (
        <div
          data-pdf-slot={page.pageNumber}
          key={page.pageNumber}
          style={{
            position: 'absolute',
            top: page.top,
            left: Math.max(0, (width - page.width) / 2),
            width: page.width,
            height: page.height,
          }}
        >
          {renderPage(page.pageNumber, (pageWidth, pageHeight) =>
            measurePage(page.pageNumber, pageWidth, pageHeight)
          )}
        </div>
      ))}
    </div>
  );
});
