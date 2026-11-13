import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnnotationsDrawerContent } from './annotations-drawer';

const base = {
  filePath: '/t.gb',
  annotations: [],
  circular: true,
  sequenceLength: 3000,
  onAnnotationClick: vi.fn(),
  onAnnotationSave: vi.fn(),
  onAnnotationDelete: vi.fn(),
  plannotateStatus: 'idle' as const,
  sequenceVersion: 0,
  activeTab: 'plannotate' as const,
};

const runBtn = () => screen.getByRole('button', { name: /run plannotate/i });
const startField = () => screen.getByTestId('plannotate-range-start') as HTMLInputElement;
const endField = () => screen.getByTestId('plannotate-range-end') as HTMLInputElement;

describe('AnnotationsDrawerContent — pLannotate range control ', () => {
  it('is off by default and runs the full sequence', () => {
    const onRunPlannotate = vi.fn();
    render(
      <AnnotationsDrawerContent
        {...base}
        onRunPlannotate={onRunPlannotate}
        currentSelectionRange={{ start: 100, end: 150 }}
      />
    );
    expect((screen.getByTestId('plannotate-range-enabled') as HTMLInputElement).checked).toBe(
      false
    );
    fireEvent.click(runBtn());
    expect(onRunPlannotate).toHaveBeenCalledWith(undefined);
  });

  it('prefills from the selection and runs the subrange as 0-indexed half-open wire', () => {
    const onRunPlannotate = vi.fn();
    render(
      <AnnotationsDrawerContent
        {...base}
        onRunPlannotate={onRunPlannotate}
        currentSelectionRange={{ start: 100, end: 150 }}
      />
    );
    fireEvent.click(screen.getByTestId('plannotate-range-enabled'));
    expect(startField().value).toBe('100');
    expect(endField().value).toBe('150');
    fireEvent.click(runBtn());
    expect(onRunPlannotate).toHaveBeenCalledWith({ start: 99, end: 150 });
  });

  it('lets the user type a manual range when there is no selection', () => {
    const onRunPlannotate = vi.fn();
    render(
      <AnnotationsDrawerContent
        {...base}
        onRunPlannotate={onRunPlannotate}
        currentSelectionRange={null}
      />
    );
    fireEvent.click(screen.getByTestId('plannotate-range-enabled'));
    expect(startField().value).toBe('');
    fireEvent.change(startField(), { target: { value: '10' } });
    fireEvent.change(endField(), { target: { value: '20' } });
    fireEvent.click(runBtn());
    expect(onRunPlannotate).toHaveBeenCalledWith({ start: 9, end: 20 });
  });

  it('shows the wrapping affordance and falls back to full sequence', () => {
    const onRunPlannotate = vi.fn();
    render(
      <AnnotationsDrawerContent
        {...base}
        onRunPlannotate={onRunPlannotate}
        currentSelectionRange={null}
        currentSelectionWraps
      />
    );
    fireEvent.click(screen.getByTestId('plannotate-range-enabled'));
    expect(screen.getByTestId('plannotate-range-wraps-note')).toBeDefined();
    fireEvent.click(runBtn());
    expect(onRunPlannotate).toHaveBeenCalledWith(undefined);
  });

  it('honors an explicitly-typed range even if the live selection later wraps', () => {
    const onRunPlannotate = vi.fn();
    const { rerender } = render(
      <AnnotationsDrawerContent
        {...base}
        onRunPlannotate={onRunPlannotate}
        currentSelectionRange={null}
      />
    );
    fireEvent.click(screen.getByTestId('plannotate-range-enabled'));
    fireEvent.change(startField(), { target: { value: '5' } });
    fireEvent.change(endField(), { target: { value: '20' } });

    rerender(
      <AnnotationsDrawerContent
        {...base}
        onRunPlannotate={onRunPlannotate}
        currentSelectionRange={null}
        currentSelectionWraps
      />
    );
    expect(startField().value).toBe('5');
    expect(screen.queryByTestId('plannotate-range-wraps-note')).toBeNull();

    fireEvent.click(runBtn());
    expect(onRunPlannotate).toHaveBeenCalledWith({ start: 4, end: 20 });
  });

  it('live-syncs fields to a new selection until the user edits, then freezes', () => {
    const onRunPlannotate = vi.fn();
    const { rerender } = render(
      <AnnotationsDrawerContent
        {...base}
        onRunPlannotate={onRunPlannotate}
        currentSelectionRange={{ start: 100, end: 150 }}
      />
    );
    fireEvent.click(screen.getByTestId('plannotate-range-enabled'));
    expect(startField().value).toBe('100');

    rerender(
      <AnnotationsDrawerContent
        {...base}
        onRunPlannotate={onRunPlannotate}
        currentSelectionRange={{ start: 200, end: 250 }}
      />
    );
    expect(startField().value).toBe('200');

    fireEvent.change(startField(), { target: { value: '10' } });
    rerender(
      <AnnotationsDrawerContent
        {...base}
        onRunPlannotate={onRunPlannotate}
        currentSelectionRange={{ start: 300, end: 350 }}
      />
    );
    expect(startField().value).toBe('10');
  });
});
