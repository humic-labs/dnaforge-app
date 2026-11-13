import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SequencePaneControls } from './SequencePaneControls';

describe('sequence pane controls', () => {
  it('keeps a slider input visible until the camera reports it, including its change event', () => {
    const onZoomChange = vi.fn();
    const { rerender } = render(
      <SequencePaneControls
        mode="2d"
        onModeChange={vi.fn()}
        zoom={10.6}
        onZoomChange={onZoomChange}
      />
    );
    const slider = screen.getByTestId('sequence-pane-zoom-slider') as HTMLInputElement;
    fireEvent.input(slider, { target: { value: '14.8' } });
    expect(slider.value).toBe('14.8');
    fireEvent.change(slider);
    expect(onZoomChange.mock.calls.map(([zoom]) => zoom)).toEqual([14.8]);
    rerender(
      <SequencePaneControls
        mode="2d"
        onModeChange={vi.fn()}
        zoom={14.8}
        onZoomChange={onZoomChange}
      />
    );
    expect(slider.value).toBe('14.8');
    rerender(
      <SequencePaneControls
        mode="2d"
        onModeChange={vi.fn()}
        zoom={15.2}
        onZoomChange={onZoomChange}
      />
    );
    expect(slider.value).toBe('15.2');
  });
  it('sends Home and End commands even before the preceding camera update renders', () => {
    const onZoomChange = vi.fn();
    render(
      <SequencePaneControls
        mode="2d"
        onModeChange={() => {}}
        zoom={100}
        onZoomChange={onZoomChange}
      />
    );
    const slider = screen.getByTestId('sequence-pane-zoom-slider');
    fireEvent.keyDown(slider, { key: 'Home' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onZoomChange.mock.calls.map(([zoom]) => zoom)).toEqual([0.2, 0.4, 120]);
  });
  it('keeps slider, buttons and keyboard at 120% while reset remains 100%', () => {
    const onZoomChange = vi.fn();
    render(
      <SequencePaneControls
        mode="2d"
        onModeChange={vi.fn()}
        zoom={100}
        onZoomChange={onZoomChange}
      />
    );
    const slider = screen.getByTestId('sequence-pane-zoom-slider') as HTMLInputElement;
    expect(slider.max).toBe('120');
    fireEvent.click(screen.getByTestId('toolbar-zoom-in'));
    expect(onZoomChange).toHaveBeenLastCalledWith(110);
    fireEvent.change(slider, { target: { value: '117.5' } });
    expect(onZoomChange).toHaveBeenLastCalledWith(117.5);
    fireEvent.keyDown(slider, { key: 'End' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onZoomChange).toHaveBeenLastCalledWith(120);
    fireEvent.click(screen.getByTestId('toolbar-zoom-display'));
    expect(onZoomChange).toHaveBeenLastCalledWith(100);
  });
  it('advances from a native Home input before its camera report is rendered', () => {
    const onZoomChange = vi.fn();
    render(
      <SequencePaneControls
        mode="2d"
        onModeChange={vi.fn()}
        zoom={100}
        onZoomChange={onZoomChange}
      />
    );
    const slider = screen.getByTestId('sequence-pane-zoom-slider') as HTMLInputElement;
    slider.value = '0.2';
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onZoomChange).toHaveBeenLastCalledWith(0.4);
  });
  it('steps from the actual fractional camera value after Cmd+scroll', () => {
    const onZoomChange = vi.fn();
    render(
      <SequencePaneControls
        mode="2d"
        onModeChange={vi.fn()}
        zoom={5.198415336679894}
        onZoomChange={onZoomChange}
      />
    );
    fireEvent.keyDown(screen.getByTestId('sequence-pane-zoom-slider'), { key: 'ArrowLeft' });
    expect(onZoomChange).toHaveBeenLastCalledWith(4.998415336679894);
    fireEvent.keyDown(screen.getByTestId('sequence-pane-zoom-slider'), { key: 'ArrowRight' });
    expect(onZoomChange.mock.calls.at(-1)?.[0]).toBeCloseTo(5.198415336679894, 12);
  });
  it('changes the real sequence zoom control in ten-percent steps', () => {
    const onZoomChange = vi.fn();
    render(
      <SequencePaneControls
        mode="2d"
        onModeChange={vi.fn()}
        zoom={40}
        onZoomChange={onZoomChange}
      />
    );
    fireEvent.click(screen.getByTestId('toolbar-zoom-in'));
    expect(onZoomChange).toHaveBeenLastCalledWith(44);
    fireEvent.click(screen.getByTestId('toolbar-zoom-out'));
    expect(onZoomChange).toHaveBeenLastCalledWith(40);
  });
  it('shows Wrap without a Tracks switch and keeps the zoom control', () => {
    render(
      <SequencePaneControls mode="2d" onModeChange={vi.fn()} zoom={100} onZoomChange={vi.fn()} />
    );
    expect(screen.getByText('Wrap')).toBeInTheDocument();
    expect(screen.queryByTestId('sequence-view-mode-toggle')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tracks' })).not.toBeInTheDocument();
    expect(screen.getByTestId('sequence-pane-zoom-slider')).toBeInTheDocument();
  });

  it('labels the preserved Sanger display without exposing a layout picker', () => {
    render(
      <SequencePaneControls
        mode="tracks"
        onModeChange={vi.fn()}
        zoom={100}
        onZoomChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('sequence-trace-mode')).toHaveTextContent('Sanger traces');
    expect(screen.queryByText('Wrap')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sequence-view-mode-toggle')).not.toBeInTheDocument();
  });
});
