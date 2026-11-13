'use client';

import { toUserMessage } from '@waypoint/user-messages';
import { Component, ReactNode } from 'react';
import { Button } from './Button';
import { reportErrorBoundary } from '../../lib/report-error-boundary';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  reported: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, reported: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, reported: false };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);
    reportErrorBoundary(error);
  }

  private async reportToSentry(): Promise<void> {
    try {
      const { reportException } = await import('../../lib/sentry');
      if (this.state.error) {
        reportException(this.state.error);
        this.setState({ reported: true });
      }
    } catch {}
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex items-center justify-center h-full p-4">
          <div className="text-center">
            <h2 className="text-lg font-medium text-fg mb-2">Something went wrong</h2>
            <p className="text-sm text-fg-muted mb-4">
              {toUserMessage(this.state.error, 'failure.an-unexpected-error-occurred')}
            </p>
            <div className="flex gap-2 justify-center">
              <Button
                onClick={() =>
                  this.setState({ hasError: false, error: undefined, reported: false })
                }
              >
                Try again
              </Button>
              <Button
                variant="secondary"
                onClick={() => this.reportToSentry()}
                disabled={this.state.reported}
              >
                {this.state.reported ? 'Reported' : 'Report this'}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
