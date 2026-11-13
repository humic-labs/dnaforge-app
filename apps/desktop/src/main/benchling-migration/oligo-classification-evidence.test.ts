import { describe, expect, it } from 'vitest';
import { extractOligoClassificationEvidence } from './oligo-classification-evidence';
import { assessOligoClassification } from '../../shared/oligo-classification';

const target = 'seq_OLIGO001';
const url = (id = target) => `https://benchling.com/dnaforge-fixture/${id}-candidate/edit`;
const chip = (options: { id?: string; href?: string; iconId?: string | null } = {}) =>
  `<span class="internalLink" data-internal-link='${JSON.stringify({ id: options.id ?? target, iconId: options.iconId === null ? undefined : (options.iconId ?? 'oligo'), url: url(options.id ?? target) })}'><a href="${options.href ?? url(options.id ?? target)}">Candidate</a><svg data-test-key="oligo"></svg></span>`;
const block = (body: string) =>
  `<div data-test-component="EditableComponent" data-test-element="root">${body}</div>`;
const extract = (html: string) =>
  extractOligoClassificationEvidence({
    html,
    sourceObjectId: 'etr_NOTEBOOK01',
    sourceEntryPath: 'Lab/Experiment.html',
    sourceEntrySha256: `sha256:${'a'.repeat(64)}`,
  });

describe('bounded notebook oligo evidence', () => {
  it.each(['?', ' – not a primer', ' – possibly a primer'])(
    'does not ignore trailing uncertainty %s',
    (suffix) => {
      expect(
        extract(block(`Primer: ${chip()}${suffix}`)).facts.map((fact) => fact.channel)
      ).toEqual(['provider_display_type', 'authored_role_disputed']);
    }
  );
  it.each(['del', 's', 'q', 'strike'])('does not infer from %s text', (tag) => {
    expect(extract(`<${tag}>${block(`Primer: ${chip()}`)}</${tag}>`).facts).toEqual([]);
    expect(
      extract(block(`<${tag}>Primer:</${tag}> ${chip()}`)).facts.map((fact) => fact.channel)
    ).toEqual(['provider_display_type']);
  });
  it.each(['hidden', 'aria-hidden="true"', 'style="display: none"'])(
    'does not infer from an explicitly hidden block (%s)',
    (attr) => {
      expect(extract(`<div ${attr}>${block(`Primer: ${chip()}`)}</div>`).facts).toEqual([]);
    }
  );
  it('retains conflicting provider display types without counting generic types as roles', () => {
    expect(extract(block(chip({ iconId: 'plasmid' }))).facts).toMatchObject([
      { channel: 'provider_display_type', value: 'plasmid' },
    ]);
  });
  it('bounds the complete evidence packet even when an occurrence adds two facts', () => {
    const packet = extract(
      Array.from({ length: 255 }, () => block(chip())).join('') + block(`Primer: ${chip()}`)
    );
    expect(packet.limited).toBe(true);
    expect(packet.facts.length).toBeLessThanOrEqual(256);
  });
  it('captures the observed two-channel source shape', () => {
    expect(
      extract(block(`Redesigned forward primer – ${chip()} – with an overlap`)).facts
    ).toMatchObject([
      { channel: 'provider_display_type', targetSourceId: target, value: 'oligo' },
      {
        channel: 'authored_role',
        targetSourceId: target,
        value: 'primer',
        excerpt: 'Redesigned forward primer',
      },
    ]);
  });
  it.each([
    'Not a forward primer:',
    'Possible primer:',
    'Is this a forward primer?',
    '“Forward primer:”',
    'Amplify using this forward primer and the template',
    'Candidate is a primer:',
  ])('does not treat %s as a direct positive role declaration', (prefix) => {
    expect(
      extract(block(`${prefix} ${chip()}`)).facts.filter((fact) => fact.channel === 'authored_role')
    ).toEqual([]);
  });
  it('does not transfer a first-link role to a later chip', () => {
    const facts = extract(
      block(`Forward primer: ${chip()} and ${chip({ id: 'seq_OLIGO002' })}`)
    ).facts;
    expect(
      facts.filter((fact) => fact.channel === 'authored_role').map((fact) => fact.targetSourceId)
    ).toEqual([target]);
  });
  it('refuses disagreeing identities without choosing a name or icon', () => {
    expect(extract(block(`Forward primer: ${chip({ href: url('seq_CONFLICT1') })}`)).facts).toEqual(
      []
    );
  });
  it('does not turn the SVG or display label into a provider-type vote', () => {
    expect(extract(block(`Forward primer: ${chip({ iconId: null })}`)).facts).toMatchObject([
      { channel: 'authored_role' },
    ]);
  });
  it('does not treat quoted or code examples as role assertions', () => {
    expect(extract(`<blockquote>${block(`Forward primer: ${chip()}`)}</blockquote>`).facts).toEqual(
      []
    );
    expect(extract(`<pre>${block(`Forward primer: ${chip()}`)}</pre>`).facts).toEqual([]);
  });
  it.each(['not a primer', "isn't a primer", 'is no longer a primer', 'possibly a primer'])(
    'retains a conflicting declaration (%s) so another block cannot hide it',
    (suffix) => {
      const packet = extract(block(`Primer: ${chip()}`) + block(`Primer: ${chip()} — ${suffix}`));
      expect(
        assessOligoClassification({
          sequence: { molecule: 'dna', available: true, length: 24, topology: 'linear' },
          evidence: packet.facts,
          evidenceLimited: packet.limited,
          targetSourceId: target,
        })
      ).toMatchObject({ status: 'needs_review', reason: 'disputed_role' });
    }
  );
  it('marks traversal limits as incomplete rather than dropping a conflicting role', () => {
    const packet = extract(
      block(`Primer: ${chip()}`) + block(`Probe: ${chip()} ${'x'.repeat(5000)}`)
    );
    expect(packet.limited).toBe(true);
  });
  it('marks ancestor depth limits as incomplete and excludes styled deleted text', () => {
    expect(
      extract('<div>'.repeat(130) + block(`Primer: ${chip()}`) + '</div>'.repeat(130)).limited
    ).toBe(true);
    expect(
      extract(
        block(`<span style="text-decoration: line-through">Primer:</span> ${chip()}`)
      ).facts.map((fact) => fact.channel)
    ).toEqual(['provider_display_type']);
  });
});
