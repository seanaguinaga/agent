import { Component, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

export function ExamplePage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
      <div>
        <Link className="link-text text-sm" to="/">
          ← All examples
        </Link>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-gray-600">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function Result({ value }: { value: unknown }) {
  return value === undefined ? null : (
    <pre
      className="overflow-auto whitespace-pre-wrap break-words rounded-xl border bg-gray-50 p-4 text-sm"
      aria-label="Result"
    >
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function useExampleTask<T = unknown>() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<T>();
  async function run(task: () => Promise<T>) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    setResult(undefined);
    try {
      const value = await task();
      setResult(value);
      return value;
    } catch (error) {
      console.error(error);
      setError(
        "This example could not finish. Check its provider requirements and the local Convex logs, then retry. Your inputs have been kept.",
      );
    } finally {
      setPending(false);
    }
  }
  return { pending, error, result, run };
}

export function TaskError({ error }: { error?: string }) {
  return error ? (
    <p
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
    >
      {error}
    </p>
  ) : null;
}

export class ExampleBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
  }
  render() {
    return this.state.failed ? (
      <div
        role="alert"
        className="space-y-3 rounded-xl border border-red-200 p-5"
      >
        <p>This example could not load. Check the local backend, then retry.</p>
        <button
          className="demo-button"
          onClick={() => this.setState({ failed: false })}
        >
          Retry
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
