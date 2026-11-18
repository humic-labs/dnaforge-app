import { expect, it } from 'vitest';
import { workRemoteAck, workRemoteView } from './work-reminder-wire';

it('keeps public reminder responses independent of database row fields', () => {
  const consent = { inbox_enabled: true, email_enabled: false, revision: 1 };
  const subscription = {
    id: 'calendar',
    generation: 1,
    roles: ['deadline'],
    state: 'active',
    expires_at: '2028-01-02',
  };
  const rows = workRemoteView.parse({
    consent: { ...consent, account_id: 'member', updated_at: '2028-01-01' },
    subscriptions: [{ ...subscription, workspace_id: 'project', token_sha256: 'digest' }],
    rules: [],
    inbox: [],
    deliveries: [],
    dispatch: null,
    tasks: [{ private: true }],
  });
  expect(rows).toEqual({
    consent,
    subscriptions: [subscription],
    rules: [],
    inbox: [],
    deliveries: [],
    dispatch: null,
  });
  expect(workRemoteAck.parse({ ...subscription, token_sha256: 'digest' })).toEqual({
    id: 'calendar',
    state: 'active',
  });
});
