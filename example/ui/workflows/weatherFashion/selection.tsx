// Which thread is on screen, and the data hooks that change it.
import { usePaginatedQuery } from "convex-helpers/react";
import { useMutation } from "convex/react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "../../../convex/_generated/api";
import { weatherQuestion } from "../../../convex/workflows/prompts";

/**
 * `question` is the one just asked, shown until the thread can show it
 * itself, so it doesn't blink away while loading.
 */
export type Selection =
  | { kind: "none" }
  | { kind: "asking"; question: string }
  | { kind: "thread"; threadId: string; question?: string };

function useSelectionState() {
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  return useMemo(
    () => ({
      selection,
      ask: (question: string) => setSelection({ kind: "asking", question }),
      started: (threadId: string) =>
        setSelection((s) => ({
          kind: "thread",
          threadId,
          question: s.kind === "asking" ? s.question : undefined,
        })),
      // Only undo the ask; leave a thread picked in the meantime alone.
      failed: () =>
        setSelection((s) => (s.kind === "asking" ? { kind: "none" } : s)),
      select: (threadId: string) => setSelection({ kind: "thread", threadId }),
    }),
    [selection],
  );
}

const SelectionContext = createContext<ReturnType<
  typeof useSelectionState
> | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  return (
    <SelectionContext value={useSelectionState()}>{children}</SelectionContext>
  );
}

export function useSelection() {
  const value = useContext(SelectionContext);
  if (!value) throw new Error("useSelection must be inside <SelectionProvider>");
  return value;
}

/**
 * Starts a workflow for `location`. The question shows right away, the way
 * chat apps do; the server saves the same text in `startWorkflow`. Rejects
 * if the start fails, after undoing the ask.
 */
export function useStartWorkflow() {
  const { ask, started, failed } = useSelection();
  const startWorkflow = useMutation(api.workflows.chaining.startWorkflow);
  return useCallback(
    async (location: string) => {
      ask(weatherQuestion(location));
      try {
        const { threadId } = await startWorkflow({ location });
        started(threadId);
      } catch (error) {
        console.error(error);
        failed();
        throw error;
      }
    },
    [ask, started, failed, startWorkflow],
  );
}

export function useRecentThreads() {
  return usePaginatedQuery(api.threads.listThreads, {}, { initialNumItems: 10 })
    .results;
}
