import { toUserMessage } from '@waypoint/user-messages';
import { useState } from 'react';
import { Button, TextField } from '../../../components/ui';

import type { HubGenomeReferenceSourceV1 } from '../../../shared/reference-assets-ipc';
import {
  describeUcscGenArkGenome,
  findUcscGenomes,
  inspectUcscHub,
  type UcscGenArkGenome,
  type UcscHubGenome,
} from '../ucsc-track-client';

type LookupResult =
  | {
      readonly kind: 'hub';
      readonly hubUrl: string;
      readonly genomes: ReadonlyArray<UcscHubGenome>;
    }
  | {
      readonly kind: 'genark';
      readonly query: string;
      readonly genomes: ReadonlyArray<UcscGenArkGenome>;
    };

export interface HubGenomeImportPanelProps {
  readonly disabled: boolean;
  readonly onImport: (source: HubGenomeReferenceSourceV1) => void;
}

export function isHubAddress(input: string): boolean {
  return /^https?:\/\/\S+$/iu.test(input.trim());
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function HubGenomeImportPanel({ disabled, onImport }: HubGenomeImportPanelProps) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LookupResult | null>(null);
  const locked = disabled || busy !== null;

  const lookup = async () => {
    const clean = input.trim();
    if (!clean) return;
    setBusy('lookup');
    setError(null);
    setResult(null);
    try {
      if (isHubAddress(clean)) {
        const hub = await inspectUcscHub(clean);
        setResult({ kind: 'hub', hubUrl: hub.hubUrl, genomes: hub.genomes });
      } else {
        setResult({ kind: 'genark', query: clean, genomes: await findUcscGenomes(clean) });
      }
    } catch (lookupError) {
      setError(
        toUserMessage(
          errorText(lookupError, 'UCSC could not answer this lookup.'),
          'failure.ucsc-could-not-answer-this-lookup'
        )
      );
    } finally {
      setBusy(null);
    }
  };

  const addHubGenome = (hubUrl: string, genome: UcscHubGenome) => {
    if (!genome.twoBitPath) return;
    setError(null);
    onImport({
      hubUrl,
      genome: genome.name,
      twoBitPath: genome.twoBitPath,
      provider: 'assembly-hub',
      ...(genome.organism ? { organism: genome.organism } : {}),
    });
  };

  const addGenArkGenome = async (genome: UcscGenArkGenome) => {
    setBusy(genome.accession);
    setError(null);
    try {
      const described = await describeUcscGenArkGenome(genome.accession);
      const hub = await inspectUcscHub(described.hubUrl);
      const entry =
        hub.genomes.find((candidate) => candidate.name === genome.accession) ??
        hub.genomes.find((candidate) => candidate.twoBitPath);
      if (!entry?.twoBitPath) {
        throw new Error(`The GenArk hub for ${genome.accession} publishes no sequence.`);
      }
      const organism = described.scientificName ?? genome.scientificName;
      onImport({
        hubUrl: hub.hubUrl,
        genome: entry.name,
        twoBitPath: entry.twoBitPath,
        provider: 'genark',
        ...(organism ? { organism } : {}),
        ...(described.assemblyName ? { assemblyName: described.assemblyName } : {}),
        ...(described.taxId ? { taxId: described.taxId } : {}),
      });
    } catch (resolveError) {
      setError(
        toUserMessage(
          errorText(resolveError, `UCSC could not describe ${genome.accession}.`),
          'tracks.loadFailed'
        )
      );
    } finally {
      setBusy(null);
    }
  };

  const rowClass = 'flex items-center gap-3 rounded bg-bg-subtle px-2.5 py-1.5 text-xs text-fg';
  const addButtonClass =
    'h-7 shrink-0 rounded bg-accent px-3 text-[11px] font-semibold text-white hover:brightness-95 disabled:cursor-wait disabled:opacity-60';

  return (
    <section
      aria-labelledby="hub-genome-heading"
      data-testid="reference-import-hub"
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <div>
        <h4 id="hub-genome-heading" className="text-sm font-medium text-fg">
          From a UCSC assembly hub or GenArk
        </h4>
        <p className="mt-1 text-xs text-fg-muted">
          Paste an assembly hub address, or search UCSC GenArk by organism or accession. DNAForge
          downloads the hub&apos;s sequence, unpacks it, and prepares it like a local FASTA.
        </p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void lookup();
        }}
        className="flex items-end gap-2"
      >
        <label
          htmlFor="hub-genome-lookup"
          className="block min-w-0 flex-1 text-xs font-medium text-fg"
        >
          Hub address or GenArk search
          <div className="mt-1">
            <TextField
              id="hub-genome-lookup"
              type="text"
              value={input}
              disabled={locked}
              onChange={(event) => setInput(event.target.value)}
              placeholder="https://example.org/hub.txt or Saccharomyces cerevisiae"
            />
          </div>
        </label>
        <Button type="submit" disabled={locked || !input.trim()}>
          {busy === 'lookup' ? 'Looking up…' : 'Look up'}
        </Button>
      </form>
      {error ? (
        <p
          role="alert"
          data-testid="reference-import-hub-error"
          className="rounded border border-red-300 bg-red-50 p-2.5 text-xs text-red-800 dark:border-red-700 dark:bg-red-950/50 dark:text-red-200"
        >
          {toUserMessage(error, 'tracks.loadFailed')}
        </p>
      ) : null}
      {result && result.genomes.length === 0 ? (
        <p role="status" className="text-xs text-fg-muted">
          {result.kind === 'hub'
            ? `${hostOf(result.hubUrl)} lists no assemblies.`
            : `UCSC GenArk has no assembly matching "${result.query}".`}
        </p>
      ) : null}
      {result && result.kind === 'hub' && result.genomes.length > 0 ? (
        <ul
          aria-label={`Assemblies in ${hostOf(result.hubUrl)}`}
          className="max-h-56 space-y-1 overflow-y-auto"
        >
          {result.genomes.map((genome) => (
            <li key={genome.name} className={rowClass}>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{genome.name}</span>
                {genome.organism ? (
                  <span className="text-fg-muted"> · {genome.organism}</span>
                ) : null}
                {genome.description ? (
                  <span className="block truncate text-fg-muted">{genome.description}</span>
                ) : null}
              </span>
              {genome.twoBitPath ? (
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => addHubGenome(result.hubUrl, genome)}
                  className={addButtonClass}
                >
                  Add {genome.name}
                </button>
              ) : (
                <span className="shrink-0 text-[11px] text-fg-subtle">
                  Track hub only, no sequence
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {result && result.kind === 'genark' && result.genomes.length > 0 ? (
        <ul aria-label="GenArk assemblies" className="max-h-56 space-y-1 overflow-y-auto">
          {result.genomes.map((genome) => (
            <li key={genome.accession} className={rowClass}>
              <span className="min-w-0 flex-1">
                <span className="font-medium">
                  {genome.commonName ?? genome.scientificName ?? genome.accession}
                </span>
                {genome.scientificName ? (
                  <span className="text-fg-muted"> · {genome.scientificName}</span>
                ) : null}
                <span className="block truncate font-mono text-fg-muted">
                  {genome.accession}
                  {genome.description ? ` · ${genome.description}` : ''}
                </span>
              </span>
              <button
                type="button"
                disabled={locked}
                onClick={() => void addGenArkGenome(genome)}
                className={addButtonClass}
              >
                {busy === genome.accession ? 'Resolving…' : `Add ${genome.accession}`}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
