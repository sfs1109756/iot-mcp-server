import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Shows a friendly message instead of a blank page if a component crashes. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel crash">
        <h2>Something went wrong</h2>
        <p className="muted">{this.state.error.message}</p>
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
