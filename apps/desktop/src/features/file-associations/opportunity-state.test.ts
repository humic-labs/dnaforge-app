// @vitest-environment node

import type { FileAssociationHandlerStatus } from '../../shared/file-association-ipc';
import {
  createOpportunityState,
  evaluateOpportunity,
  markConfirmedDefault,
  parseOpportunityState,
  recordOpportunityDismissed,
  recordOpportunityPrompted,
  recordOpportunitySnoozed,
  selectOpportunityFamily,
} from './opportunity-state';

const NOW = Date.UTC(2026, 7, 26, 12);
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

function status(
  familyId: 'genbank' | 'snapgene',
  state: FileAssociationHandlerStatus['state'] = 'other'
): FileAssociationHandlerStatus {
  return {
    familyId,
    state,
    handlerName: state === 'other' ? 'Preview' : state === 'default' ? 'DNAForge' : null,
    handlerPath: null,
    defaultAction: familyId === 'genbank' ? 'native' : 'none',
    detail: null,
  };
}

describe(' default-app opportunity policy', () => {
  it('offers prompt-ready GenBank after successful non-default use', () => {
    const decision = evaluateOpportunity({
      state: createOpportunityState(),
      familyId: 'genbank',
      handlerStatus: status('genbank'),
      now: NOW,
      sessionPrompted: false,
    });
    expect(decision).toEqual({ eligible: true, reason: 'eligible' });
  });

  it('never automatically prompts SnapGene while format-validation-pending readiness is false', () => {
    expect(
      evaluateOpportunity({
        state: createOpportunityState(),
        familyId: 'snapgene',
        handlerStatus: status('snapgene'),
        now: NOW,
        sessionPrompted: false,
      })
    ).toEqual({ eligible: false, reason: 'not-ready' });
  });

  it('suppresses already-default, unavailable, and second-in-session opportunities', () => {
    const base = createOpportunityState();
    expect(
      evaluateOpportunity({
        state: base,
        familyId: 'genbank',
        handlerStatus: status('genbank', 'default'),
        now: NOW,
        sessionPrompted: false,
      }).reason
    ).toBe('already-default');
    expect(
      evaluateOpportunity({
        state: base,
        familyId: 'genbank',
        handlerStatus: status('genbank', 'unavailable'),
        now: NOW,
        sessionPrompted: false,
      }).reason
    ).toBe('handler-unavailable');
    expect(
      evaluateOpportunity({
        state: base,
        familyId: 'genbank',
        handlerStatus: status('genbank'),
        now: NOW,
        sessionPrompted: true,
      }).reason
    ).toBe('session-limit');
  });

  it('persists a 14-day snooze and allows the opportunity after expiry', () => {
    let state = recordOpportunityPrompted(createOpportunityState(), 'genbank', NOW);
    state = recordOpportunitySnoozed(state, 'genbank', NOW);
    expect(state.families.genbank?.snoozedUntil).toBe(NOW + FOURTEEN_DAYS_MS);
    expect(
      evaluateOpportunity({
        state,
        familyId: 'genbank',
        handlerStatus: status('genbank'),
        now: NOW + FOURTEEN_DAYS_MS - 1,
        sessionPrompted: false,
      }).reason
    ).toBe('snoozed');
    expect(
      evaluateOpportunity({
        state,
        familyId: 'genbank',
        handlerStatus: status('genbank'),
        now: NOW + FOURTEEN_DAYS_MS,
        sessionPrompted: false,
      }).eligible
    ).toBe(true);
  });

  it('caps prompts at three and persists permanent dismissal', () => {
    let capped = createOpportunityState();
    for (let count = 0; count < 3; count += 1) {
      capped = recordOpportunityPrompted(capped, 'genbank', NOW + count);
    }
    expect(
      evaluateOpportunity({
        state: capped,
        familyId: 'genbank',
        handlerStatus: status('genbank'),
        now: NOW + FOURTEEN_DAYS_MS,
        sessionPrompted: false,
      }).reason
    ).toBe('prompt-cap');

    const dismissed = recordOpportunityDismissed(createOpportunityState(), 'genbank');
    expect(parseOpportunityState(JSON.stringify(dismissed))).toEqual(dismissed);
    expect(
      evaluateOpportunity({
        state: dismissed,
        familyId: 'genbank',
        handlerStatus: status('genbank'),
        now: NOW,
        sessionPrompted: false,
      }).reason
    ).toBe('dismissed');
  });

  it('never re-nags after DNAForge was confirmed default and the user later changes away', () => {
    const state = markConfirmedDefault(createOpportunityState(), 'genbank', NOW);
    expect(
      evaluateOpportunity({
        state,
        familyId: 'genbank',
        handlerStatus: status('genbank', 'other'),
        now: NOW + FOURTEEN_DAYS_MS,
        sessionPrompted: false,
      }).reason
    ).toBe('previously-confirmed');
  });

  it('prioritizes the first eligible registry family without stacking prompts', () => {
    expect(
      selectOpportunityFamily({
        state: createOpportunityState(),
        handlerStatuses: [status('snapgene'), status('genbank')],
        successfulFamilies: new Set(['snapgene', 'genbank']),
        now: NOW,
        sessionPrompted: false,
      })
    ).toBe('genbank');
  });

  it('fails closed when persisted JSON is missing or malformed', () => {
    expect(parseOpportunityState(null)).toEqual(createOpportunityState());
    expect(parseOpportunityState('{broken')).toEqual(createOpportunityState());
    expect(parseOpportunityState('{"version":2,"families":{}}')).toEqual(createOpportunityState());
  });
});
