import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { serviceManager } from '../../../services/service-manager';
import { sidecarFetch } from '../../../services/sidecar-session';
import { getGeneDatabaseReferences, type GeneDatabaseReference } from './gene-database-references';

type Fact = { label: string; value: string };
type Result = { reference: GeneDatabaseReference; facts?: Fact[]; error?: boolean };

export function GeneDatabaseFacts({ attributes }: { attributes: Record<string, string[]> }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const references = useMemo(() => getGeneDatabaseReferences(attributes), [attributes]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <>
      <button ref={trigger} type="button" className="text-accent hover:underline" aria-expanded={open}
        onClick={() => setOpen(!open)}>Database facts</button>
      {open && createPortal(
        <FactsPanel references={references} onClose={close} />,
        document.body
      )}
    </>
  );
}

function FactsPanel({ references, onClose }: {
  references: GeneDatabaseReference[];
  onClose: () => void;
}) {
  const [results, setResults] = useState<Result[]>(() => references.map(reference => ({ reference })));
  const closeButton = useRef<HTMLButtonElement>(null);
  // The panel mounts only after an explicit click. Only public record identifiers are sent.
  useEffect(() => {
    closeButton.current?.focus();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let active = true;
    for (const reference of references) {
      const query = new URLSearchParams({ database: reference.database, identifier: reference.identifier });
      void (async () => {
        try {
          const response = await sidecarFetch(`${serviceManager.getExternalLookupBaseUrl()}/external/gene-facts?${query}`, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error('Lookup failed');
          const data: unknown = await response.json();
          if (!data || typeof data !== 'object' || !('facts' in data) || !Array.isArray(data.facts)) {
            throw new Error('Invalid facts response');
          }
          const facts = data.facts.filter((fact): fact is Fact =>
            fact !== null && typeof fact === 'object' && typeof fact.label === 'string' && typeof fact.value === 'string');
          if (active) setResults(current => current.map(result => result.reference === reference ? { reference, facts } : result));
        } catch {
          if (active) setResults(current => current.map(result => result.reference === reference ? { reference, error: true } : result));
        }
      })();
    }
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
    // References are fixed for this panel instance; selecting another feature remounts its owner.
  }, [references]);

  return (
    <div className="fixed inset-0 z-[90]" onMouseDown={onClose}>
      <section role="region" aria-label="Gene database facts"
        className="absolute right-4 top-20 max-h-[70vh] w-[min(32rem,calc(100vw-2rem))] overflow-auto rounded-lg border border-border bg-bg-subtle p-4 text-sm text-fg shadow-xl"
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
        <div className="mb-3 flex items-center justify-between gap-4">
          <h3 className="font-semibold">Gene database facts</h3>
          <button ref={closeButton} type="button" onClick={onClose} className="text-fg-muted hover:text-fg">Close</button>
        </div>
        {references.length === 0 ? (
          <p className="text-fg-muted">No supported database identifiers are available for this feature. NCBI Gene, Ensembl and UniProt identifiers are supported.</p>
        ) : (
          <div className="space-y-4" aria-live="polite">
            {results.map(({ reference, facts, error }) => (
              <div key={`${reference.database}:${reference.identifier}`}>
                <a href={reference.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                  {reference.label} · {reference.identifier} ↗
                </a>
                {error ? <p className="mt-1 text-fg-muted">Facts unavailable. Open the source record, or close and reopen to retry.</p>
                  : !facts ? <p className="mt-1 text-fg-muted">Loading facts…</p>
                  : facts.length === 0 ? <p className="mt-1 text-fg-muted">No facts returned for this record.</p>
                  : <dl className="mt-2 space-y-2">{facts.map((fact, index) => (
                    <div key={`${fact.label}:${index}`}><dt className="font-medium">{fact.label}</dt><dd className="whitespace-pre-wrap break-words text-fg-muted">{fact.value}</dd></div>
                  ))}</dl>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
