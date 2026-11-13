'use client';

import { useEffect, useState } from 'react';
import { usePageStore } from '../../store';
import type { Page } from '../../types';

interface PagePreviewProps {
  pageId: string;
}

type LoadingState = 'loading' | 'ready' | 'error' | 'not-found';

function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return date.toLocaleDateString();
}

function extractTextFromContent(content: unknown): string {
  if (!content || typeof content !== 'object') return '';

  const node = content as { type?: string; text?: string; content?: unknown[] };

  if (node.type === 'text' && node.text) {
    return node.text;
  }

  if (Array.isArray(node.content)) {
    return node.content.map(extractTextFromContent).join(' ');
  }

  return '';
}

function getExcerpt(page: Page, maxLength: number = 200): string {
  const text = extractTextFromContent(page.content).trim();
  if (!text) return 'No content';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trim() + '...';
}

export function PagePreview({ pageId }: PagePreviewProps) {
  const [state, setState] = useState<LoadingState>('loading');
  const [page, setPage] = useState<Page | null>(null);
  const fetchPage = usePageStore((s) => s.fetchPage);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const result = await fetchPage(pageId);
        if (!mounted) return;

        if (result) {
          setPage(result);
          setState('ready');
        } else {
          setState('not-found');
        }
      } catch {
        if (mounted) setState('error');
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [pageId, fetchPage]);

  if (state === 'loading') {
    return (
      <div className="w-80 max-w-[calc(100vw-16px)] bg-bg text-fg border border-border rounded-lg shadow-lg p-4">
        <div className="flex items-center gap-2 text-fg-muted">
          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Loading...</span>
        </div>
      </div>
    );
  }

  if (state === 'not-found') {
    return (
      <div className="w-80 max-w-[calc(100vw-16px)] bg-bg text-fg border border-border rounded-lg shadow-lg p-4">
        <div className="flex items-center gap-2 text-fg-muted">
          <span className="text-base">🚫</span>
          <span className="text-sm">Page not found</span>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="w-80 max-w-[calc(100vw-16px)] bg-bg text-fg border border-border rounded-lg shadow-lg p-4">
        <div className="flex items-center gap-2 text-error">
          <span className="text-base">⚠️</span>
          <span className="text-sm">Failed to load page</span>
        </div>
      </div>
    );
  }

  if (!page) return null;

  const excerpt = getExcerpt(page);

  return (
    <div className="w-80 max-w-[calc(100vw-16px)] bg-bg text-fg border border-border rounded-lg shadow-lg overflow-hidden">
      {}
      <header className="tab-chrome-surface px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-base shrink-0">📄</span>
          <span className="font-medium truncate">{page.title}</span>
        </div>
        <div className="text-xs text-fg-muted mt-0.5">Updated {formatDate(page.updatedAt)}</div>
      </header>

      {}
      <div className="p-3">
        <p className="text-sm text-fg-muted line-clamp-4">{excerpt}</p>
      </div>

      {}
      <footer className="px-3 py-2 border-t border-border bg-bg-subtle">
        <div className="text-xs text-fg-muted">Click to open</div>
      </footer>
    </div>
  );
}
