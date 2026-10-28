import { Component, type ReactNode } from "react";

// What failed, in plain English, and what to do next.
export function ErrorState({ what, error, onRetry }: { what: string; error: string; onRetry?: () => void }) {
  return (
    <div className="panel error-state" role="alert">
      <p>
        Couldn't load {what}: {error}.
      </p>
      <div className="row">
        {onRetry && (
          <button className="secondary" onClick={onRetry}>
            Try again
          </button>
        )}
        <span className="muted small">If it keeps failing, check that the Cohort server is still running.</span>
      </div>
    </div>
  );
}

// Catches crashes in a page so the rest of the app keeps working.
export class PageBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel error-state" role="alert">
        <p>This page hit a problem and couldn't be shown.</p>
        <p className="muted small mono">{this.state.error.message}</p>
        <div className="row">
          <button className="secondary" onClick={() => location.reload()}>
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}
