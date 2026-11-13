import { describe, expect, it, vi } from 'vitest';

const { reportErrorBoundary } = vi.hoisted(() => ({ reportErrorBoundary: vi.fn() }));
vi.mock('./report-error-boundary', async (importOriginal) => {
  const original = await importOriginal<typeof import('./report-error-boundary')>();
  return { ...original, reportErrorBoundary };
});

import { SequenceErrorBoundary } from '../features/sequence/components/SequenceErrorBoundary';
import { TabErrorBoundary } from '../features/canvas/components/TabErrorBoundary';
import { toSafeErrorClass } from './report-error-boundary';

describe('shared error-boundary reporting', () => {
  it('keeps the error class bounded and never derives it from the message', () => {
    expect(toSafeErrorClass('RangeError')).toBe('range_error');
    expect(toSafeErrorClass('123 $$$')).toBe('error');
    expect(toSafeErrorClass(`Type${'X'.repeat(100)}`)).toHaveLength(64);
  });

  it('reports errors swallowed by the sequence boundary', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new TypeError('DNA1598_PRIVATE_SEQUENCE_MESSAGE');
    const boundary = new SequenceErrorBoundary({ children: null });
    boundary.componentDidCatch(error, { componentStack: '' });
    expect(reportErrorBoundary).toHaveBeenCalledWith(error);
  });

  it('reports errors swallowed by the tab boundary', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('DNA1598_PRIVATE_TAB_MESSAGE');
    const boundary = new TabErrorBoundary({ label: 'Sequence', children: null });
    boundary.componentDidCatch(error, { componentStack: '' });
    expect(reportErrorBoundary).toHaveBeenCalledWith(error);
  });
});
