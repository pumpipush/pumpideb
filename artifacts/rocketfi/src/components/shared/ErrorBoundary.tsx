import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error:    Error | null;
}

/**
 * Top-level React ErrorBoundary.
 * Catches render-time exceptions so a crash in one subtree (e.g. BubbleMap
 * or ChartCanvas) doesn't blank the whole SPA.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error("[ErrorBoundary] Render error caught:", error, info.componentStack);
    }
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex flex-col items-center justify-center min-h-[200px] gap-3 p-8 text-center">
          <p className="text-muted-foreground text-sm">Something went wrong rendering this section.</p>
          <button
            className="text-xs text-primary underline"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
