import { Component, useMemo, type ReactNode } from 'react';
import { reportErrorForDisplay } from '../../../startup/error-details';
import { reportErrorBoundary } from '../../../lib/report-error-boundary';

interface TabErrorBoundaryProps {
  label: string;
  onRetry?: () => void;
  onClose?: () => void;
  children: ReactNode;
}

interface TabErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class TabErrorBoundary extends Component<TabErrorBoundaryProps, TabErrorBoundaryState> {
  constructor(props: TabErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): TabErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(`[${this.props.label} Error]`, error, errorInfo);
    console.error('Full stack:', error.stack);
    reportErrorBoundary(error);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
    this.props.onRetry?.();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-full flex items-center justify-center p-4 text-error">
          <div className="text-center max-w-md">
            <div className="text-lg font-medium mb-2">
              {this.props.label} couldn&apos;t be shown
            </div>
            <div className="text-sm text-fg-muted mb-2">
              Retry usually fixes this. Your other tabs aren&apos;t affected.
            </div>
            <details className="text-left text-xs text-fg-muted">
              <summary className="cursor-pointer select-none text-center">Show details</summary>
              <ErrorSummary error={this.state.error} label={this.props.label} />
            </details>
            <div className="mt-4 flex gap-2 justify-center">
              <button
                onClick={this.handleRetry}
                className="px-3 py-1 text-sm bg-accent text-white rounded hover:bg-accent/80"
              >
                Retry
              </button>
              {this.props.onClose && (
                <button
                  onClick={this.props.onClose}
                  className="px-3 py-1 text-sm bg-bg-muted text-fg-muted rounded hover:bg-bg hover:text-fg border border-border"
                >
                  Close Tab
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function ErrorSummary({ error, label }: { error: Error | null; label: string }) {
  const report = useMemo(() => reportErrorForDisplay(error, `tab ${label}`), [error, label]);
  return (
    <p className="mt-2 bg-bg-muted p-2 rounded font-mono">
      {report.summary} · {report.reference}
    </p>
  );
}
