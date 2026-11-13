import { afterEach, expect, it } from 'vitest';
import { useSequenceStore } from '../features/sequence/public/store';
import { useSequenceEditModeStore } from './sequence-edit-mode-store';

afterEach(() => {
  useSequenceStore.getState().setLoading('pending-document', false);
  useSequenceStore.getState().setLoading('ready-document', false);
  useSequenceEditModeStore.setState({ active: false, editRequest: null });
});

it('admits an edit request only after its own native document finishes loading', () => {
  useSequenceStore.getState().setLoading('pending-document', true);
  useSequenceEditModeStore.getState().requestEdit('pending-document');
  expect(useSequenceEditModeStore.getState().editRequest).toBeNull();
  useSequenceEditModeStore.getState().requestEdit('ready-document');
  expect(useSequenceEditModeStore.getState().editRequest?.entityId).toBe('ready-document');
  const readyRequest = useSequenceEditModeStore.getState().editRequest!;
  useSequenceEditModeStore.getState().consumeEditRequest(readyRequest.requestId);
  useSequenceStore.getState().setLoading('pending-document', false);
  useSequenceEditModeStore.getState().requestEdit('pending-document');
  expect(useSequenceEditModeStore.getState().editRequest?.entityId).toBe('pending-document');
  expect(useSequenceEditModeStore.getState().editRequest!.requestId).toBeGreaterThan(
    readyRequest.requestId
  );
});
