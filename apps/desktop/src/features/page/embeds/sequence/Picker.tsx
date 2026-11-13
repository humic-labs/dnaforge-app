'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/shared/components/Button';
import { Input } from '@/shared/components/Input';
import type { PickerStageProps } from '../types';
import {
  searchCatalogReferencesByName,
  type CatalogReferenceCandidate,
} from '../../../../db/catalog-reference-search';
import { useOptionalReferenceContext } from '../../entity-ref/reference-context';

interface SequenceItem {
  entityId: string | null;
  name: string;
  path: string;
  contentHash: string | null;
  objectUuid: string | null;
}

function candidateToItem(candidate: CatalogReferenceCandidate): SequenceItem {
  return {
    entityId: candidate.entityId,
    name: candidate.name,
    path: candidate.workspaceRelativePath,
    contentHash: candidate.contentHash,
    objectUuid: candidate.objectUuid,
  };
}

export function SequencePicker({ onAdvance, onCancel }: PickerStageProps) {
  const referenceContext = useOptionalReferenceContext();
  const [query, setQuery] = useState('');
  const [sequences, setSequences] = useState<SequenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SequenceItem | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSequences() {
      setLoading(true);
      try {
        const results = await searchCatalogReferencesByName({
          query,
          entityType: 'sequence',
          workspaceRoot: referenceContext?.owningRoot ?? null,
          limit: 20,
        });

        if (!cancelled) {
          setSequences(results.map(candidateToItem));
        }
      } catch (error) {
        console.error('Failed to load sequences:', error);
        if (!cancelled) {
          setSequences([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    const timer = setTimeout(loadSequences, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, referenceContext?.owningRoot]);

  const handleSelect = (seq: SequenceItem) => {
    setSelected(seq);
  };

  const handleInsert = () => {
    if (selected) {
      onAdvance({
        entityId: selected.entityId,
        sequenceName: selected.name,
        path: selected.path,
        contentHash: selected.contentHash,
        objectUuid: selected.objectUuid,
        owningRoot: referenceContext?.owningRoot ?? null,
      });
    }
  };

  return (
    <div className="space-y-3">
      {}
      <Input
        type="search"
        aria-label="Search sequences"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(null);
          setLoading(true);
        }}
        placeholder="Search sequences..."
        autoFocus
      />

      {}
      <div className="max-h-48 overflow-y-auto border border-border rounded-md divide-y divide-border">
        {loading ? (
          <div className="px-3 py-4 text-sm text-fg-muted text-center">Loading...</div>
        ) : sequences.length === 0 ? (
          <div className="px-3 py-4 text-sm text-fg-muted text-center">
            {referenceContext
              ? query.trim()
                ? 'No sequences found'
                : 'No registered sequences in this project'
              : 'This page has no owning project, so a reference cannot be anchored'}
          </div>
        ) : (
          sequences.map((seq) => (
            <button
              key={seq.path}
              type="button"
              aria-pressed={selected?.path === seq.path}
              onClick={() => handleSelect(seq)}
              className={`w-full px-3 py-2 text-left hover:bg-bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
                selected?.path === seq.path ? 'bg-accent-subtle text-fg' : ''
              }`}
            >
              <div className="font-medium text-sm">{seq.name}</div>
              {}
              <div className="text-xs text-fg-muted truncate" title={seq.path}>
                {seq.path}
              </div>
            </button>
          ))
        )}
      </div>

      {}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={handleInsert} disabled={!selected}>
          Insert
        </Button>
      </div>
    </div>
  );
}
