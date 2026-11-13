import { toUserMessage } from '@waypoint/user-messages';
import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { reportErrorBoundary } from '../../../lib/report-error-boundary';

interface Props {
  children: ReactNode;
  documentLabel?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class SequenceErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[SequenceViewer] Rendering error:', error, errorInfo);
    reportErrorBoundary(error);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-full bg-bg">
          <div className="text-center max-w-md p-6">
            <div className="text-4xl mb-4">
              <span role="img" aria-label="warning">
                !
              </span>
            </div>
            <h2 className="text-lg font-medium text-fg mb-2">
              Sequence viewer encountered an error
            </h2>
            <p className="text-sm text-fg-muted mb-4">
              {toUserMessage(
                this.state.error,
                'failure.an-unexpected-error-occurred-while-rendering-the-sequence'
              )}
            </p>
            {this.props.documentLabel && (
              <p className="text-xs text-fg-muted mb-4">Sequence: {this.props.documentLabel}</p>
            )}
            <div className="space-x-2">
              <button
                onClick={this.handleRetry}
                className="px-4 py-2 bg-accent text-white rounded text-sm hover:bg-accent/90 transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
