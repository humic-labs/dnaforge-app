import { describe, expect, it } from 'vitest';
import { publicAgentTraceDisplay } from './agent-trace-display';

describe('tool activity display projection', () => {
  it.each([
    ['search_skills', 'Search skills'],
    ['search_new_reference_windows', 'Search new reference windows'],
    ['lab-robot:pipette', 'Lab robot pipette'],
  ])('preserves an older idless %s action across process serialization', (name, title) => {
    const initial = publicAgentTraceDisplay({
      kind: 'tool',
      title: 'Using tool',
      status: 'running',
      text: name,
    });
    const reloaded = publicAgentTraceDisplay(JSON.parse(JSON.stringify(initial)));

    expect(initial.title).toBe(title);
    expect(reloaded.title).toBe(title);
    expect(reloaded.status).toBe('In progress');
    expect(reloaded.title).not.toBe('Assistant action');
  });

  it.each([
    'platform.trackViews.list is not available in the hosted browser runtime.',
    'UCSC tracks: VITE_API_URL is not set',
    'Bearer dna4335-private-test-credential',
    'fa891caf-1fba-4c69-8d47-90d7632cd7f0',
  ])('rejects arbitrary diagnostic text as an older action identity', (text) => {
    const display = publicAgentTraceDisplay({
      kind: 'tool',
      title: 'Using tool',
      status: 'failed',
      text,
    });

    expect(display.title).toBe('Assistant action');
    expect(JSON.stringify(display)).not.toContain(text);
  });
});
