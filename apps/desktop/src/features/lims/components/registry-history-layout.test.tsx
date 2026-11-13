import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../../../shared/entity-schema';
import type { LimsEntityHistoryEntry } from '../../../shared/lims';
import { RegistryHistoryTimeline } from './registry-presenters';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const schema: ProjectableEntitySchemaRevisionSnapshot = {
  schemaId: 'sequence',
  schemaRevisionId: 'sequence-1',
  name: 'sequence',
  displayName: 'Sequence',
  baseKind: 'dna_sequence',
  version: 1,
  fields: [],
};

function history(): LimsEntityHistoryEntry[] {
  return [
    {
      eventSeq: 42,
      eventType: 'entity_updated',
      label: 'Edited',
      actor: null,
      at: Date.parse('2026-10-22T22:04:00Z'),
      changes: [
        {
          field: 'fields.description',
          label: 'Description',
          kind: 'changed',
          before: '',
          after: 'test',
        },
        {
          field: 'fields.notes',
          label: 'Notes',
          kind: 'removed',
          before: 'Native sequence persistence check',
        },
        {
          field: 'fields.geneticCode',
          label: 'Genetic code',
          kind: 'changed',
          before: '3 — Yeast Mitochondrial',
          after: '1 — Standard',
        },
        {
          field: 'fields.sequence',
          label: 'Sequence',
          kind: 'changed',
          description: 'Sequence changed',
        },
      ],
    },
    {
      eventSeq: 41,
      eventType: 'entity_updated',
      label: 'Edited',
      actor: null,
      at: Date.parse('2026-10-22T20:38:00Z'),
      changes: [],
    },
    {
      eventSeq: 39,
      eventType: 'entity_registered',
      label: 'Registered',
      actor: null,
      at: Date.parse('2026-10-22T18:27:00Z'),
      changes: [{ field: 'name', label: 'Name', kind: 'added', after: 'pUC19 sequence' }],
    },
  ];
}

function renderHistory(entries = history()) {
  return render(
    <>
      <section aria-label="Metadata">
        <RegistryHistoryTimeline entries={entries} schema={schema} loading={false} error={false} />
      </section>
      <section aria-label="Registry Details">
        <RegistryHistoryTimeline entries={entries} schema={schema} loading={false} error={false} />
      </section>
    </>
  );
}

describe('shared inline metadata history', () => {
  it('retains every accepted event, complete date, value and semantic description in both hosts', () => {
    const entries = history();
    const original = structuredClone(entries);
    renderHistory(entries);
    for (const timeline of screen.getAllByTestId('lims-registry-history')) {
      expect(timeline).toHaveAttribute('data-layout', 'flow');
      const events = [...timeline.querySelectorAll('[data-testid^="lims-history-entry-"]')];
      expect(events.map((entry) => entry.getAttribute('data-testid'))).toEqual([
        'lims-history-entry-42',
        'lims-history-entry-41',
        'lims-history-entry-39',
      ]);
      expect([...timeline.querySelectorAll('time')].map((time) => time.dateTime)).toEqual(
        entries.map((entry) => new Date(entry.at).toISOString())
      );
      expect(events[0].querySelector('time')).toHaveTextContent(/Oct 22, 2026/);
      expect(within(timeline).getByText('Sequence changed')).toBeVisible();
      const changed = within(timeline).getByTestId('lims-history-change-42-2');
      expect(changed.querySelector('[data-history-field]')).toHaveTextContent('Genetic code:');
      expect(changed.querySelector('[data-history-value="before"]')).toHaveTextContent(
        '3 — Yeast Mitochondrial'
      );
      expect(changed.querySelector('[data-history-value="after"]')).toHaveTextContent(
        '1 — Standard'
      );
      expect(within(changed).getByText('→')).toBeVisible();
      expect(within(timeline).queryByRole('columnheader')).toBeNull();
      expect(within(timeline).queryByText(/^(Field|Before|After)$/)).toBeNull();
    }
    expect(entries).toEqual(original);
  });

  it('distinguishes empty, added and removed values without dropping either side', () => {
    renderHistory();
    for (const timeline of screen.getAllByTestId('lims-registry-history')) {
      for (const [id, before, after] of [
        ['42-0', 'Empty', 'test'],
        ['42-1', 'Native sequence persistence check', 'Empty'],
        ['39-0', 'Empty', 'pUC19 sequence'],
      ]) {
        const row = within(timeline).getByTestId(`lims-history-change-${id}`);
        expect(row.querySelector('[data-history-value="before"]')).toHaveTextContent(
          `Previous value: ${before}`
        );
        expect(row.querySelector('[data-history-value="after"]')).toHaveTextContent(
          `New value: ${after}`
        );
        expect(within(row).getByText('→')).toBeVisible();
      }
    }
  });

  it('uses the same inline presentation in production', () => {
    vi.stubEnv('DEV', false);
    renderHistory();
    for (const timeline of screen.getAllByTestId('lims-registry-history')) {
      expect(timeline).toHaveAttribute('data-layout', 'flow');
      expect(within(timeline).getByTestId('lims-history-change-42-0')).toHaveTextContent(
        'Description:'
      );
    }
  });
});
