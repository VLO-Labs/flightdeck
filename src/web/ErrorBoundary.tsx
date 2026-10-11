// Keeps one broken screen from blanking the whole app: shows what failed and a way back.
import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('[flightdeck] screen crashed:', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty">
        <div className="crash">
          <p>This screen hit an error and stopped.</p>
          <pre>{this.state.error.message}</pre>
          <button onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    );
  }
}
