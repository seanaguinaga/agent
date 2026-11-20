// A case as a test page holds it: the live row, and the calls a person makes.
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  pilot,
  type CaseEvent,
  type PilotOptions,
} from "../../convex/easygov/autopilot";

const cases = api.easygov.case.public;

/** What the backend said, word for word: these pages test its refusals. */
export function errorText(error: unknown): string {
  if (error instanceof ConvexError) {
    return typeof error.data === "string"
      ? error.data
      : JSON.stringify(error.data);
  }
  return error instanceof Error ? error.message : String(error);
}

/** The open case is in the URL (`?case=`); a guest's key stays in the tab. */
export function useCaseParam() {
  const [params, setParams] = useSearchParams();
  const caseId = (params.get("case") ?? undefined) as Id<"cases"> | undefined;
  const guestKey =
    (caseId && sessionStorage.getItem(`easygov-guest:${caseId}`)) || undefined;
  function open(id: Id<"cases"> | undefined, key?: string) {
    if (id && key) sessionStorage.setItem(`easygov-guest:${id}`, key);
    setParams(id ? { case: id } : {});
  }
  function forgetKey() {
    if (caseId) sessionStorage.removeItem(`easygov-guest:${caseId}`);
    setParams({ case: caseId! });
  }
  return { caseId, guestKey, open, forgetKey };
}

export type CaseSession = ReturnType<typeof useCaseSession>;

export function useCaseSession(
  caseId: Id<"cases"> | undefined,
  guestKey?: string,
) {
  const c = useQuery(cases.getCase, caseId ? { caseId, guestKey } : "skip");
  const sendEvent = useMutation(cases.send);
  const sendMessage = useMutation(cases.sendMessage);
  const uploadUrl = useMutation(cases.uploadUrl);
  return useMemo(() => {
    const id = caseId!;
    const send = (event: CaseEvent, expectedSeq: number) =>
      sendEvent({ caseId: id, guestKey, event, expectedSeq });
    return {
      caseId,
      guestKey,
      c,
      send,
      chat: (text: string) =>
        sendMessage({
          caseId: id,
          guestKey,
          text,
          messageKey: crypto.randomUUID(),
        }),
      /**
       * Uploads the file straight to storage, then attaches it to the case:
       * as the pack's document `key`, or without one as other evidence.
       */
      upload: async (file: Blob, expectedSeq: number, key?: string) => {
        const response = await fetch(
          await uploadUrl({ caseId: id, guestKey }),
          {
            method: "POST",
            headers: {
              "Content-Type": file.type || "application/octet-stream",
            },
            body: file,
          },
        );
        if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
        const { storageId } = (await response.json()) as {
          storageId: Id<"_storage">;
        };
        const name = file instanceof File ? file.name : undefined;
        await send({ type: "evidence.add", storageId, key, name }, expectedSeq);
      },
    };
  }, [caseId, guestKey, c, sendEvent, sendMessage, uploadUrl]);
}

/** Runs one call at a time and keeps what the backend said if it refused. */
export function useAct() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function run(task: () => Promise<unknown>) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await task();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending(false);
    }
  }
  return { pending, error, run };
}

/**
 * Plays the person's part (see `autopilot.ts`) until the options say to
 * stop, the case ends, or the backend refuses something.
 */
export function useAutopilot(session: CaseSession) {
  const [options, setOptions] = useState<PilotOptions>();
  const [error, setError] = useState<string>();
  // Bumped when a step lands, in case the case updated while it was in flight.
  const [tick, setTick] = useState(0);
  const busy = useRef(false);
  const sentAt = useRef(-1);
  const { c } = session;
  const next =
    options && c
      ? pilot(c, options, new Date().toISOString().slice(0, 10))
      : undefined;
  // Handed back: forget the options, so a later change doesn't restart it.
  if (next === "stop") setOptions(undefined);
  useEffect(() => {
    // A step sent at this `seq` hasn't shown up yet: don't send it twice.
    if (!c || !next || next === "wait" || next === "stop") return;
    if (busy.current || c.seq === sentAt.current) return;
    busy.current = true;
    sentAt.current = c.seq;
    const step =
      "event" in next
        ? session.send(next.event, c.seq)
        : session.upload(
            new File([`Test file for ${next.upload}`], `${next.upload}.txt`, {
              type: "text/plain",
            }),
            c.seq,
            next.upload,
          );
    void step
      .catch((error) => {
        const message = errorText(error);
        // A profile save reaches every open case, and may land between the
        // look and the send. That isn't a failure: look again.
        if (message.includes("The case has changed")) {
          sentAt.current = -1;
          return;
        }
        setError(message);
        setOptions(undefined);
      })
      .finally(() => {
        busy.current = false;
        setTick((tick) => tick + 1);
      });
    // `next` is rebuilt every render; the case's seq says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, options, tick]);
  return {
    running: options,
    error,
    start(options: PilotOptions) {
      setError(undefined);
      sentAt.current = -1;
      setOptions(options);
    },
    stop: () => setOptions(undefined),
  };
}
