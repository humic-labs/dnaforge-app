'use client';

import { useState, useEffect } from 'react';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/components/Button';
import { Input } from '@/shared/components/Input';
import type { PickerStageProps } from '../types';
import { usePageStore } from '../../store';

interface PageItem {
  id: string;
  title: string;
  updatedAt: Date;
}

export function PagePicker({ onAdvance, onCancel }: PickerStageProps) {
  const { pages } = usePageStore();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const pageList: PageItem[] = Object.values(pages)
    .map((p) => ({ id: p.id, title: p.title, updatedAt: p.updatedAt }))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const filteredPages = query
    ? pageList.filter((p) => p.title.toLowerCase().includes(query.toLowerCase()))
    : pageList;

  useEffect(() => {
    if (!filteredPages.some((page) => page.id === selectedId)) {
      setSelectedId(filteredPages[0]?.id ?? null);
    }
  }, [filteredPages, selectedId]);

  const handleSelect = (page: PageItem) => {
    setSelectedId(page.id);
  };

  const handleConfirm = () => {
    const page = filteredPages.find((p) => p.id === selectedId);
    if (page) {
      onAdvance({
        pageId: page.id,
        pageName: page.title,
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && selectedId) {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const idx = filteredPages.findIndex((p) => p.id === selectedId);
      if (idx < filteredPages.length - 1) {
        setSelectedId(filteredPages[idx + 1].id);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = filteredPages.findIndex((p) => p.id === selectedId);
      if (idx > 0) {
        setSelectedId(filteredPages[idx - 1].id);
      }
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {}
      <Input
        type="search"
        aria-label="Search pages"
        placeholder="Search pages..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
      />

      {}
      <div className="max-h-48 overflow-y-auto border border-border rounded-md">
        {filteredPages.length === 0 ? (
          <div className="px-3 py-4 text-sm text-fg-muted text-center">
            {query ? 'No pages found' : 'No pages yet'}
          </div>
        ) : (
          filteredPages.map((page) => (
            <button
              key={page.id}
              type="button"
              aria-pressed={selectedId === page.id}
              onClick={() => handleSelect(page)}
              onDoubleClick={() => onAdvance({ pageId: page.id, pageName: page.title })}
              className={cn(
                'w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                selectedId === page.id ? 'bg-accent-subtle text-fg' : 'hover:bg-bg-muted'
              )}
            >
              <span>📄</span>
              <span className="truncate">{page.title || 'Untitled'}</span>
            </button>
          ))
        )}
      </div>

      {}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleConfirm}
          disabled={!filteredPages.some((page) => page.id === selectedId)}
        >
          Insert Link
        </Button>
      </div>
    </div>
  );
}
