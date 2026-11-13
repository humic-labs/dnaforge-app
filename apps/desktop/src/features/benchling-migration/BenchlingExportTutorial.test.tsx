import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BenchlingExportTutorial } from './BenchlingExportTutorial';

describe('BenchlingExportTutorial', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('opens the recording as an automatic loop and turns the trigger into close', () => {
    render(<BenchlingExportTutorial />);

    const trigger = screen.getByRole('button', { name: 'Watch how to export' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');
    expect(screen.queryByTestId('benchling-export-video')).not.toBeInTheDocument();

    fireEvent.click(trigger);

    const video = screen.getByTestId<HTMLVideoElement>('benchling-export-video');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls');
    expect(trigger).toHaveTextContent('Close video');
    expect(video.getAttribute('src')).toContain('benchling-export-flow.mp4');
    expect(video.controls).toBe(false);
    expect(video.autoplay).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.muted).toBe(true);
    expect(video).toHaveAttribute('playsinline');
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(video).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText(/silent, looping demonstration/i)).toHaveClass('sr-only');
  });

  it('unmounts and resets playback when the trigger is clicked again', () => {
    render(<BenchlingExportTutorial />);

    const trigger = screen.getByRole('button', { name: 'Watch how to export' });
    fireEvent.click(trigger);
    expect(screen.getByTestId('benchling-export-video')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Close video' }));

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('benchling-export-video')).not.toBeInTheDocument();
  });

  it('opens above its close control by default on the first migration screen', () => {
    render(<BenchlingExportTutorial presentation="intake" />);

    const video = screen.getByTestId('benchling-export-video');
    const close = screen.getByRole('button', { name: 'Close video' });

    expect(video).toBeVisible();
    expect(close).toHaveAttribute('aria-expanded', 'true');
    expect(video.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Watch how to export' })).not.toBeInTheDocument();
  });

  it('remembers a closed first-screen video and remembers when it is reopened', () => {
    const first = render(<BenchlingExportTutorial presentation="intake" />);

    fireEvent.click(screen.getByRole('button', { name: 'Close video' }));
    expect(screen.queryByTestId('benchling-export-video')).not.toBeInTheDocument();
    first.unmount();

    const second = render(<BenchlingExportTutorial presentation="intake" />);
    expect(screen.queryByTestId('benchling-export-video')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Watch how to export' }));
    expect(screen.getByTestId('benchling-export-video')).toBeVisible();
    second.unmount();

    render(<BenchlingExportTutorial presentation="intake" />);
    expect(screen.getByTestId('benchling-export-video')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close video' })).toBeVisible();
  });

  it('shows a useful fallback only after a real playback error', () => {
    render(<BenchlingExportTutorial presentation="intake" />);

    fireEvent.error(screen.getByTestId('benchling-export-video'));

    expect(screen.queryByTestId('benchling-export-video')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'The tutorial video could not play. You can continue with the written export steps.'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close video' }));
    fireEvent.click(screen.getByRole('button', { name: 'Watch how to export' }));

    expect(screen.getByTestId('benchling-export-video')).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
