import React, { Component, ErrorInfo, ReactNode } from "react";

interface Props {
    children?: ReactNode;
}

interface State {
    hasError: boolean;
    error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error("Uncaught error:", error, errorInfo);
    }

    public render() {
        if (this.state.hasError) {
            return (
                <div className="p-4 bg-red-50 border border-red-200 rounded text-red-900">
                    <h2 className="text-lg font-bold mb-2">Components Error</h2>
                    <p className="mb-2">Something went wrong in this section.</p>
                    <pre className="bg-red-100 p-2 rounded text-xs overflow-auto">
                        {this.state.error?.toString()}
                    </pre>
                    <button
                        className="mt-4 px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 text-sm"
                        onClick={() => this.setState({ hasError: false })}
                    >
                        Try Again
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
