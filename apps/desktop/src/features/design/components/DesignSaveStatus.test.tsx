/**
 * @vitest-environment jsdom
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useDesignRecoveryStore } from '../design-recovery';
import { DesignSaveStatus } from './DesignSaveStatus';

afterEach(() => {
  cleanup();
  useDesignRecoveryStore.setState({ records: {} });
});

const design = { id: 'd1', name: 'Recovery B' };

describe('DesignSaveStatus', () => {
  it('stays quiet when the latest revision is saved', () => {
    useDesignRecoveryStore.setState({
      records: {
        d1: {
          design,
          revision: '{"id":"d1"}',
          base: '{"id":"d1"}',
          pending: false,
          status: 'saved',
          durable: true,
        },
      },
    });
    const { container } = render(<DesignSaveStatus designId="d1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows one delayed status for a durable unpublished revision', () => {
    useDesignRecoveryStore.setState({
      records: {
        d1: {
          design,
          revision: '{"id":"d1","name":"Recovery B"}',
          base: '{"id":"d1","name":"Recovery A"}',
          pending: true,
          status: 'delayed',
          durable: true,
        },
      },
    });
    render(<DesignSaveStatus designId="d1" />);
    expect(screen.getByTestId('design-save-status')).toHaveTextContent('Saving delayed');
    expect(screen.getByText(/recoverable on this device/)).toBeInTheDocument();
  });

  it('does not label in-memory-only edits as saved', () => {
    useDesignRecoveryStore.setState({
      records: {
        d1: {
          design,
          revision: '{"id":"d1"}',
          base: null,
          pending: true,
          status: 'delayed',
          durable: false,
        },
      },
    });
    render(<DesignSaveStatus designId="d1" />);
    expect(screen.getByTestId('design-save-status')).toHaveTextContent('Not saved');
  });
});
