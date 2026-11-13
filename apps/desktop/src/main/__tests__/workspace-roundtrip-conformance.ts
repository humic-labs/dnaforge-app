import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

export const REQUIRED_WORKSPACE_ROUNDTRIP_REFUSALS = [
  'traversal',
  'case-fold-collision',
  'reserved-name',
  'symlink',
  'incomplete-package',
  'unsupported-authority',
] as const;

export type RequiredRefusalName = (typeof REQUIRED_WORKSPACE_ROUNDTRIP_REFUSALS)[number];

export interface WorkspaceRoundTripFixture<Source, Projection> {
  source: Source;
  expectedAdmittedFiles: ReadonlyMap<string, Uint8Array>;
  expectedProjection: Projection;
  excludedCanaries: readonly string[];
  cleanup(): Promise<void>;
}

export interface WorkspaceRoundTripCapture<Portable> {
  portable: Portable;
  admittedFiles: ReadonlyMap<string, Uint8Array>;
  observables: readonly unknown[];
}

export interface WorkspaceRoundTripRefusalCase {
  attempt(): Promise<unknown>;
  expectedError: RegExp;
}

export interface MaterializedWorkspace<Materialized> {
  value: Materialized;
  files: ReadonlyMap<string, Uint8Array>;
}

export interface PublicationCandidate<Portable> {
  readonly id: string;
  readonly baseVersionId: string | null;
  readonly portable: Portable;
}

export interface PortablePublication<Portable> {
  reserve(
    baseVersionId: string | null,
    portable: Portable
  ): Promise<PublicationCandidate<Portable>>;
  persist(candidate: PublicationCandidate<Portable>): Promise<void>;
  finalize(
    candidate: PublicationCandidate<Portable>
  ): Promise<{ status: 'ready'; versionId: string } | { status: 'stale' }>;
  latest(): Promise<{ versionId: string; portable: Portable } | null>;
  observables(): readonly unknown[];
}

export interface WorkspaceRoundTripAdapter<Source, Portable, Materialized, Projection> {
  createFixture(): Promise<WorkspaceRoundTripFixture<Source, Projection>>;
  capture(source: Source): Promise<WorkspaceRoundTripCapture<Portable>>;
  encode(portable: Portable): Promise<unknown>;
  decode(encoded: unknown): Promise<Portable>;
  materialize(portable: Portable): Promise<MaterializedWorkspace<Materialized>>;
  project(materialized: Materialized): Promise<Projection>;
  invalidCases(
    source: Source,
    portable: Portable
  ): Promise<ReadonlyMap<RequiredRefusalName, WorkspaceRoundTripRefusalCase>>;
  createPublication(): PortablePublication<Portable>;
}

export function defineWorkspaceRoundTripConformance<Source, Portable, Materialized, Projection>(
  name: string,
  createAdapter: () => WorkspaceRoundTripAdapter<Source, Portable, Materialized, Projection>,
  options: { timeout?: number } = {}
): void {
  describe(`${name} workspace round-trip conformance`, options, () => {
    it('round-trips every admitted path, byte, identity, and relationship', async () => {
      const adapter = createAdapter();
      const fixture = await adapter.createFixture();
      try {
        const captured = await adapter.capture(fixture.source);
        expect(captured.admittedFiles.size).toBeGreaterThan(0);
        expect(canonicalFileMap(captured.admittedFiles)).toEqual(
          canonicalFileMap(fixture.expectedAdmittedFiles)
        );
        const encoded = await adapter.encode(captured.portable);
        const decoded = await adapter.decode(encoded);
        const publication = adapter.createPublication();
        const candidate = await publication.reserve(null, decoded);
        await publication.persist(candidate);
        await expect(publication.finalize(candidate)).resolves.toEqual({
          status: 'ready',
          versionId: candidate.id,
        });
        const latest = await publication.latest();
        expect(latest?.versionId).toBe(candidate.id);
        if (!latest) throw new Error('A finalized publication was not visible as latest.');
        const materialized = await adapter.materialize(latest.portable);

        expect(canonicalFileMap(materialized.files)).toEqual(
          canonicalFileMap(captured.admittedFiles)
        );
        await expect(adapter.project(materialized.value)).resolves.toEqual(
          fixture.expectedProjection
        );

        const observableBytes = observationText([
          ...captured.observables,
          encoded,
          ...publication.observables(),
        ]);
        for (const canary of fixture.excludedCanaries) {
          expect(observableBytes).not.toContain(canary);
          expect(observableBytes).not.toContain(Buffer.from(canary).toString('base64'));
        }
      } finally {
        await fixture.cleanup();
      }
    });

    it('never advances latest for an interrupted publication', async () => {
      const adapter = createAdapter();
      const fixture = await adapter.createFixture();
      try {
        const captured = await adapter.capture(fixture.source);
        const publication = adapter.createPublication();
        const candidate = await publication.reserve(null, captured.portable);
        await publication.persist(candidate);

        await expect(publication.latest()).resolves.toBeNull();
      } finally {
        await fixture.cleanup();
      }
    });

    it('does not let a stale writer replace a newer ready version', async () => {
      const adapter = createAdapter();
      const fixture = await adapter.createFixture();
      try {
        const captured = await adapter.capture(fixture.source);
        const publication = adapter.createPublication();
        const first = await publication.reserve(null, captured.portable);
        const stale = await publication.reserve(null, captured.portable);
        await publication.persist(first);
        await publication.persist(stale);
        await expect(publication.finalize(first)).resolves.toMatchObject({ status: 'ready' });
        await expect(publication.finalize(stale)).resolves.toEqual({ status: 'stale' });
        await expect(publication.latest()).resolves.toMatchObject({ versionId: first.id });
      } finally {
        await fixture.cleanup();
      }
    });

    it('fails closed for every required hostile or unsupported state', async () => {
      const adapter = createAdapter();
      const fixture = await adapter.createFixture();
      try {
        const captured = await adapter.capture(fixture.source);
        const cases = await adapter.invalidCases(fixture.source, captured.portable);
        expect([...cases.keys()].sort()).toEqual([...REQUIRED_WORKSPACE_ROUNDTRIP_REFUSALS].sort());
        for (const refusal of REQUIRED_WORKSPACE_ROUNDTRIP_REFUSALS) {
          const hostileCase = cases.get(refusal);
          if (!hostileCase) throw new Error(`Missing required hostile case: ${refusal}`);
          await expect(hostileCase.attempt()).rejects.toThrow(hostileCase.expectedError);
        }
      } finally {
        await fixture.cleanup();
      }
    });
  });
}

function canonicalFileMap(files: ReadonlyMap<string, Uint8Array>): Array<[string, string]> {
  return [...files.entries()]
    .map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')] as [string, string])
    .sort(([left], [right]) => left.localeCompare(right));
}

function observationText(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Uint8Array) return Buffer.from(item).toString('base64');
    return item;
  });
}
