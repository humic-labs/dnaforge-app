import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  clearRequestedSequenceDrawer,
  requestSequenceDrawer,
  takeRequestedSequenceDrawer,
  useRequestedSequenceDrawer,
} from './request-sequence-drawer';

describe('requestSequenceDrawer', () => {
  beforeEach(() => {
    clearRequestedSequenceDrawer();
  });

  afterEach(() => {
    clearRequestedSequenceDrawer();
  });

  it('holds one pending drawer until SequenceTab consumes it', () => {
    requestSequenceDrawer('alignments');
    expect(takeRequestedSequenceDrawer()).toBe('alignments');
    expect(takeRequestedSequenceDrawer()).toBeNull();
  });

  it('opens a pending drawer when the sequence tab mounts after apply', () => {
    const openDrawer = vi.fn();
    requestSequenceDrawer('alignments');

    renderHook(() => useRequestedSequenceDrawer(openDrawer));

    expect(openDrawer).toHaveBeenCalledWith('alignments');
    expect(takeRequestedSequenceDrawer()).toBeNull();
  });

  it('opens the drawer from a later request on an already-mounted tab', () => {
    const openDrawer = vi.fn();
    renderHook(() => useRequestedSequenceDrawer(openDrawer));

    act(() => {
      requestSequenceDrawer('alignments');
    });

    expect(openDrawer).toHaveBeenCalledWith('alignments');
  });
});
