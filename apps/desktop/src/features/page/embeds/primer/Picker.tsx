'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/shared/components/Button';
import { Input } from '@/shared/components/Input';
import type { PickerStageProps } from '../types';
import {
  searchPrimerReferencesByName,
  type PrimerReferenceCandidate,
} from '../../../../db/primer-reference-search';
import { useOptionalReferenceContext } from '../../entity-ref/reference-context';

interface PrimerItem {
  id: string;
  name: string;
  length: number;
  path: string | null;
  localOnly: boolean;
}

function candidateToItem(candidate: PrimerReferenceCandidate): PrimerItem {
  return {
    id: candidate.primerId,
    name: candidate.name || `Primer ${candidate.primerId}`,
    length: candidate.length,
    path: candidate.workspaceRelativePath,
    localOnly: candidate.localOnly,
  };
}

export function PrimerPicker({ onAdvance, onCancel }: PickerStageProps) {
  const referenceContext = useOptionalReferenceContext();
  const [query, setQuery] = useState('');
  const [primers, setPrimers] = useState<PrimerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PrimerItem | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadPrimers() {
      setLoading(true);
      try {
        const results = await searchPrimerReferencesByName({
          query,
          workspaceRoot: referenceContext?.owningRoot ?? null,
          limit: 20,
        });

        if (!cancelled) {
          setPrimers(results.map(candidateToItem));
        }
      } catch (error) {
        console.error('Failed to load primers:', error);
        if (!cancelled) {
          setPrimers([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    const timer = setTimeout(loadPrimers, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, referenceContext?.owningRoot]);

  const handleInsert = () => {
    if (selected) {
      onAdvance({
        primerId: selected.id,
        primerName: selected.name,
        path: selected.path,
        localOnly: selected.localOnly,
        owningRoot: referenceContext?.owningRoot ?? null,
      });
    }
  };

  return (
    <div className="space-y-3">
      <Input
        type="search"
        aria-label="Search primers"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(null);
          setLoading(true);
        }}
        placeholder="Search primers..."
        autoFocus
      />

      <div className="max-h-48 overflow-y-auto border border-border rounded-md divide-y divide-border">
        {loading ? (
          <div className="px-3 py-4 text-sm text-fg-muted text-center">Loading...</div>
        ) : primers.length === 0 ? (
          <div className="px-3 py-4 text-sm text-fg-muted text-center">
            {query.trim() ? 'No primers found' : 'Your primer library is empty'}
          </div>
        ) : (
          primers.map((primer) => (
            <button
              key={primer.id}
              type="button"
              aria-pressed={selected?.id === primer.id}
              onClick={() => setSelected(primer)}
              className={`w-full px-3 py-2 text-left wp-interactive transition-colors ${
                selected?.id === primer.id ? 'bg-accent-subtle text-fg' : ''
              }`}
            >
              <div className="font-medium text-sm">{primer.name}</div>
              <div className="text-xs text-fg-muted">{primer.length.toLocaleString()} bp</div>
            </button>
          ))
        )}
      </div>

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
