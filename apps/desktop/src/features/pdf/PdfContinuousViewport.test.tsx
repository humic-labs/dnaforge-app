import { createRef, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PdfContinuousViewport,
  pdfPagePositions,
  visiblePdfPages,
  type PdfContinuousViewportHandle,
} from './PdfContinuousViewport';

describe('continuous PDF page layout', () => {
  it('keeps every page reachable while retaining only intersecting pages', () => {
    const pages = pdfPagePositions(400, 1, new Map());
    expect(pages).toHaveLength(400);
    expect(
      visiblePdfPages(pages, pages[289].top + 700, 600).map((page) => page.pageNumber)
    ).toEqual([290, 291]);
  });

  it('lays out learned mixed page sizes and scales page content without scaling the gap', () => {
    const sizes = new Map([
      [1, { width: 600, height: 800 }],
      [2, { width: 900, height: 300 }],
    ]);
    expect(pdfPagePositions(3, 1.2, sizes)).toEqual([
      { pageNumber: 1, top: 0, width: 720, height: 960 },
      { pageNumber: 2, top: 984, width: 1080, height: 360 },
      { pageNumber: 3, top: 1368, width: 720, height: 960 },
    ]);
  });

  it('includes both pages while the viewport straddles a page boundary', () => {
    const pages = pdfPagePositions(3, 1, new Map());
    expect(visiblePdfPages(pages, 700, 400).map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(visiblePdfPages(pages, 816, 400).map((page) => page.pageNumber)).toEqual([2]);
  });
});

describe('continuous PDF viewport navigation', () => {
  afterEach(() => vi.restoreAllMocks());

  function setup(initialPage = 1) {
    const navigation = createRef<PdfContinuousViewportHandle>();
    const pageChange = vi.fn();
    let hidden = false;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (hidden) return new DOMRect();
      const viewport = window.document.querySelector<HTMLElement>('[data-testid="viewport"]');
      return this.dataset.testid === 'pdf-continuous-pages'
        ? new DOMRect(0, -(viewport?.scrollTop ?? 0), 800, 100_000)
        : new DOMRect(0, 0, 800, 400);
    });
    function Page({
      pageNumber,
      onSize,
      scale,
    }: {
      pageNumber: number;
      onSize: (w: number, h: number) => void;
      scale: number;
    }) {
      useEffect(() => onSize(600 * scale, 800 * scale), [onSize, scale]);
      return <div data-testid={`page-${pageNumber}`} />;
    }
    function Harness({ scale }: { scale: number }) {
      const viewportRef = useRef<HTMLElement>(null);
      const [currentPage, setCurrentPage] = useState(initialPage);
      return (
        <main ref={viewportRef} data-testid="viewport">
          <PdfContinuousViewport
            initialPage={currentPage}
            onPageChange={(number) => {
              pageChange(number);
              setCurrentPage(number);
            }}
            pageCount={40}
            ref={navigation}
            renderPage={(pageNumber, onSize) => (
              <Page onSize={onSize} pageNumber={pageNumber} scale={scale} />
            )}
            scale={scale}
            viewportRef={viewportRef}
          />
        </main>
      );
    }
    const result = render(<Harness scale={1} />);
    return {
      ...result,
      navigation,
      pageChange,
      Harness,
      setHidden(next: boolean) {
        hidden = next;
        if (hidden) screen.getByTestId('viewport').scrollTop = 0;
        fireEvent.resize(window);
      },
    };
  }

  it('mounts the requested distant page immediately without a native scroll event', () => {
    const { navigation, pageChange } = setup();
    act(() => navigation.current?.goToPage(32));
    expect(screen.getByTestId('page-32')).toBeInTheDocument();
    expect(screen.queryByTestId('page-1')).not.toBeInTheDocument();
    expect(pageChange).toHaveBeenLastCalledWith(32);
  });

  it('mounts adjacent pages on scroll and preserves the reading page during zoom', () => {
    const { pageChange, rerender, Harness } = setup();
    const viewport = screen.getByTestId('viewport');
    viewport.scrollTop = 700;
    fireEvent.scroll(viewport);
    expect(screen.getByTestId('page-1')).toBeInTheDocument();
    expect(screen.getByTestId('page-2')).toBeInTheDocument();
    expect(pageChange).toHaveBeenLastCalledWith(2);
    viewport.scrollTop = 824 + 100;
    fireEvent.scroll(viewport);
    rerender(<Harness scale={1.2} />);
    expect(viewport.scrollTop).toBe(984 + 120);
    expect(screen.getByTestId('page-2')).toBeInTheDocument();
  });

  it('restores the intended page when the document viewport remounts', () => {
    setup(25);
    expect(screen.getByTestId('page-25')).toBeInTheDocument();
    expect(screen.queryByTestId('page-1')).not.toBeInTheDocument();
  });

  it('retains the reading position through hidden layout and defers hidden zoom scrolling', () => {
    const { navigation, pageChange, rerender, Harness, setHidden } = setup();
    act(() => navigation.current?.goToPage(2));
    const viewport = screen.getByTestId('viewport');
    viewport.scrollTop = 824 + 240;
    fireEvent.scroll(viewport);
    expect(pageChange).toHaveBeenLastCalledWith(2);
    setHidden(true);
    expect(pageChange).toHaveBeenLastCalledWith(2);
    expect(screen.getByTestId('page-2')).toBeInTheDocument();
    rerender(<Harness scale={1.2} />);
    expect(viewport.scrollTop).toBe(0);
    setHidden(false);
    expect(viewport.scrollTop).toBe(984 + 288);
    expect(pageChange).toHaveBeenLastCalledWith(2);
    expect(screen.getByTestId('page-2')).toBeInTheDocument();
  });

  it('leaves the native scroll position at zero when scrolling back to the first page', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.dataset.testid === 'pdf-continuous-pages' ? 24 : 0;
    });
    const { navigation } = setup();
    act(() => navigation.current?.goToPage(2));
    const viewport = screen.getByTestId('viewport');
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(0);
  });

  it('keeps a scroll that arrives in the same commit as a learned page size', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 800, 400)
    );
    const pageChange = vi.fn();
    const sizeReports = new Map<number, (width: number, height: number) => void>();
    const pendingScroll: { top: number | null } = { top: null };
    const bump: { current: () => void } = { current: () => {} };
    function Scroller({
      revision,
      viewportRef,
    }: {
      revision: number;
      viewportRef: RefObject<HTMLElement | null>;
    }) {
      useLayoutEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport || pendingScroll.top === null) return;
        viewport.scrollTop = pendingScroll.top;
        pendingScroll.top = null;
        viewport.dispatchEvent(new Event('scroll'));
      }, [revision, viewportRef]);
      return null;
    }
    function Harness() {
      const viewportRef = useRef<HTMLElement>(null);
      const [revision, setRevision] = useState(0);
      bump.current = () => setRevision((value) => value + 1);
      return (
        <main ref={viewportRef} data-testid="viewport">
          <PdfContinuousViewport
            initialPage={1}
            onPageChange={pageChange}
            pageCount={40}
            renderPage={(pageNumber, onSize) => {
              sizeReports.set(pageNumber, onSize);
              return <div data-testid={`page-${pageNumber}`} />;
            }}
            scale={1}
            viewportRef={viewportRef}
          />
          <Scroller revision={revision} viewportRef={viewportRef} />
        </main>
      );
    }
    render(<Harness />);
    const viewport = screen.getByTestId('viewport');

    act(() => {
      sizeReports.get(1)?.(600, 900);
      pendingScroll.top = 1000;
      bump.current();
    });

    expect(viewport.scrollTop).toBe(1000);
    expect(pageChange).toHaveBeenLastCalledWith(2);
    expect(screen.getByTestId('page-2')).toBeInTheDocument();
    expect(screen.queryByTestId('page-1')).not.toBeInTheDocument();
  });
});
