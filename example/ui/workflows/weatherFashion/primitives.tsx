// Presentational pieces with no data access.
import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Outfit } from "../../../convex/workflows/outfit";

export function Question({ text }: { text: string }) {
  return (
    <p className="self-end max-w-lg rounded-lg bg-indigo-50 px-4 py-2 text-indigo-900">
      {text}
    </p>
  );
}

/** A question with the typing dots under it, before there's a thread to show. */
export function PendingTurn({ question }: { question: string }) {
  return (
    <section className="flex flex-col gap-3" aria-label="Workflow">
      <Question text={question} />
      <Typing label="Working…" />
    </section>
  );
}

/** Tailwind's `animate-bounce` runs for one second. */
const BOUNCE_MS = 1000;

/**
 * Three pulsing dots where the answer will appear, like chat apps use
 * instead of a status word. Screen readers still hear `label`.
 */
export function Typing({
  label,
  visible = false,
}: {
  label: string;
  visible?: boolean;
}) {
  // A new <Typing> mounts at each stage. Starting it mid-bounce, in step with
  // the clock, keeps the swap from restarting the animation visibly.
  const [phase] = useState(() => performance.now() % BOUNCE_MS);
  return (
    <p
      role="status"
      className="flex h-6 items-center gap-2 text-sm text-gray-500"
    >
      <span aria-hidden className="flex gap-1">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="size-1.5 animate-bounce rounded-full bg-gray-400"
            style={{ animationDelay: `${delay - phase}ms` }}
          />
        ))}
      </span>
      <span className={visible ? undefined : "sr-only"}>{label}</span>
    </p>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <article className="rounded-xl border border-indigo-100 bg-white p-5 shadow-xs">
      {children}
    </article>
  );
}

export function Markdown({
  children,
  className = "",
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={`prose prose-indigo max-w-none ${className}`}>
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}

export function OutfitCard({ outfit }: { outfit: Outfit }) {
  const rows: [string, string][] = [
    ["Hat", outfit.hat],
    ["Tops", outfit.tops],
    ["Bottoms", outfit.bottoms],
    ["Shoes", outfit.shoes],
  ];
  return (
    <dl
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2"
      aria-label="Outfit"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="font-medium text-indigo-700">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
