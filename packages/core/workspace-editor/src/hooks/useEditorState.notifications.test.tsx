/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  createEditorSession,
  createInitialState,
  useEditorSessionState,
  useEditorState,
} from './useEditorState';

describe('useEditorState notifications (viewer-private draft)', () => {
  it('does not report a prop-driven sequence reset as an edit', async () => {
    const onSequenceChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ sequence }) => useEditorState(sequence, [], onSequenceChange),
      { initialProps: { sequence: 'ATCG' } }
    );

    expect(result.current.state.sequence).toBe('ATCG');
    expect(onSequenceChange).not.toHaveBeenCalled();

    rerender({ sequence: 'CGAT' });

    await waitFor(() => expect(result.current.state.sequence).toBe('CGAT'));
    expect(onSequenceChange).not.toHaveBeenCalled();
  });

  it('still reports real reducer edits', async () => {
    const onSequenceChange = vi.fn();
    const { result } = renderHook(() => useEditorState('ATCG', [], onSequenceChange));

    act(() => {
      result.current.dispatch({ type: 'INSERT', text: 'G' });
    });

    await waitFor(() => expect(onSequenceChange).toHaveBeenCalledWith('GATCG'));
  });
});

describe('useEditorState with a document-owned session', () => {
  it('renders the session state and dispatches into it instead of a private draft', () => {
    const session = createEditorSession(createInitialState('ATCG', []));
    const { result } = renderHook(() =>
      useEditorState('IGNORED', [], undefined, undefined, undefined, session)
    );

    expect(result.current.state.sequence).toBe('ATCG');

    act(() => {
      result.current.dispatch({ type: 'INSERT', text: 'G' });
    });

    expect(session.getState().sequence).toBe('GATCG');
    expect(result.current.state.sequence).toBe('GATCG');
  });

  it('never resets session edits when the incoming sequence prop changes', async () => {
    const session = createEditorSession(createInitialState('ATCG', []));
    const onSequenceChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ sequence }) =>
        useEditorState(sequence, [], onSequenceChange, undefined, undefined, session),
      { initialProps: { sequence: 'ATCG' } }
    );

    act(() => {
      result.current.dispatch({ type: 'INSERT', text: 'GG' });
    });
    expect(session.getState().sequence).toBe('GGATCG');

    rerender({ sequence: 'GGATCG' });
    rerender({ sequence: 'CGAT' });

    await waitFor(() => expect(result.current.state.sequence).toBe('GGATCG'));
    expect(session.getState().historyIndex).toBe(1);
    expect(onSequenceChange).not.toHaveBeenCalled();
  });

  it('re-renders when the session changes outside the viewer', () => {
    const session = createEditorSession(createInitialState('ATCG', []));
    const { result } = renderHook(() =>
      useEditorState('', [], undefined, undefined, undefined, session)
    );

    act(() => {
      session.dispatch({
        type: 'SET_ANNOTATIONS',
        annotations: [{ name: 'gene', type: 'CDS', start: 1, end: 2, direction: 1 }],
      });
    });

    expect(result.current.state.annotations).toEqual([
      { name: 'gene', type: 'CDS', start: 1, end: 2, direction: 1 },
    ]);
  });
});

describe('useEditorSessionState', () => {
  it('returns null without a session so callers fall back to their own content', () => {
    const { result } = renderHook(() => useEditorSessionState(undefined));
    expect(result.current).toBeNull();
  });

  it('follows the owner draft as it changes', () => {
    const session = createEditorSession(createInitialState('ATCG', []));
    const { result } = renderHook(() => useEditorSessionState(session));
    expect(result.current?.sequence).toBe('ATCG');

    act(() => {
      session.dispatch({ type: 'SET_CURSOR', position: 4 });
      session.dispatch({ type: 'INSERT', text: 'TT' });
    });
    expect(result.current?.sequence).toBe('ATCGTT');
    expect(result.current).toBe(session.getState());
  });
});
