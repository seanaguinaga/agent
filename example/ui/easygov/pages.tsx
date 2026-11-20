// The easygov test pages that run a case: the bare console, one page per
// stage of the workflow, and the whole pipeline with the firm beside it.
//
// A stage page gets a case to where the stage begins without touching the
// stages before it by hand: stage 2 starts on a landing page, and stage 3
// lets the autopilot answer and accept first.
import { useEffect, useRef } from "react";
import type { CaseView, PilotOptions } from "../../convex/easygov/autopilot";
import { AllReferrals, FirmDesk, FirmForm } from "./FirmDesk";
import { Launcher, PilotBar, SeedBar, type Opened } from "./Launch";
import { useAutopilot, useCaseParam, useCaseSession } from "./session";
import { CaseWorkbench, Page } from "./Workbench";

type Stage = {
  /** Whether the case has got as far as this stage. */
  entered: (c: CaseView) => boolean;
  /** Whether the case has left it, and what took over. */
  exited: (c: CaseView) => boolean;
  exit: string;
};

const accepted = (c: CaseView) =>
  c.selection?.status === "accepted" &&
  c.selection.goalVersion === c.goal?.version;

const AGREE: Stage = {
  entered: () => true,
  exited: accepted,
  exit: "A pack is accepted. Stage 2 takes over: the case collects answers (or, for legal advice, goes straight to consent).",
};
const COLLECT: Stage = {
  entered: accepted,
  exited: (c) => c.accepted !== undefined && c.waitingFor !== "review",
  exit: "The document is accepted. Stage 3 takes over: consent if a referral was offered, then delivery.",
};
const FINISH: Stage = {
  entered: (c) => c.accepted !== undefined || c.referral !== undefined,
  exited: (c) => c.status !== "active",
  exit: "The case has ended. Check delivery and the referral below.",
};

function StageBanner({ stage, c }: { stage: Stage; c: CaseView }) {
  const [tone, text] = stage.exited(c)
    ? [
        "border-green-200 bg-green-50 text-green-900",
        `Stage complete. ${stage.exit}`,
      ]
    : stage.entered(c)
      ? ["border-blue-200 bg-blue-50 text-blue-900", "In this stage."]
      : [
          "border-amber-200 bg-amber-50 text-amber-900",
          "Not at this stage yet: getting the case there.",
        ];
  return (
    <p className={`rounded-xl border p-3 text-sm ${tone}`} role="status">
      {text}
    </p>
  );
}

function CasePage({
  title,
  description,
  entry,
  source,
  stage,
  prompts,
  onStart,
  pilotBar,
  firm,
}: {
  title: string;
  description: string;
  entry: "any" | "chat" | "pack";
  source: string;
  stage?: Stage;
  prompts?: { label: string; text: string }[];
  /** Autopilot to run on each case this page starts, to reach the stage. */
  onStart?: PilotOptions;
  pilotBar?: Partial<PilotOptions>;
  firm?: boolean;
}) {
  const { caseId, guestKey, open, forgetKey } = useCaseParam();
  const session = useCaseSession(caseId, guestKey);
  const pilot = useAutopilot(session);
  // Only a case started here is driven; a reopened one is left as it is.
  const started = useRef<string | undefined>(undefined);
  const opened: Opened = (id, key, fresh) => {
    started.current = fresh ? id : undefined;
    open(id, key);
  };
  const { start } = pilot;
  useEffect(() => {
    if (onStart && caseId && started.current === caseId) {
      started.current = undefined;
      start(onStart);
    }
  }, [caseId, onStart, start]);

  const person = (
    <div className="space-y-4">
      <Launcher
        entry={entry}
        source={source}
        prompts={prompts}
        onOpen={opened}
      />
      {caseId && pilotBar && <PilotBar pilot={pilot} initial={pilotBar} />}
      {caseId && stage && session.c && (
        <StageBanner stage={stage} c={session.c} />
      )}
      {caseId && (
        <CaseWorkbench key={caseId} session={session} onClaimed={forgetKey} />
      )}
    </div>
  );
  return (
    <Page title={title} description={description} wide={firm}>
      <SeedBar />
      {firm ? (
        <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
          {person}
          <div className="space-y-4">
            <FirmDesk />
            <AllReferrals />
          </div>
        </div>
      ) : (
        person
      )}
      {!firm && stage === FINISH && caseId && <AllReferrals caseId={caseId} />}
    </Page>
  );
}

export function CaseConsole() {
  return (
    <CasePage
      title="easygov slice: case console"
      description="One case and nothing else: start it any way, read the row, its history and its thread, and send it any event with any seq to see what it takes and what it refuses."
      entry="any"
      source="test:console"
      pilotBar={{}}
    />
  );
}

export function StageAgree() {
  return (
    <CasePage
      title="easygov stage 1: agree on what to do"
      description="Intake chats until there's a goal, selection proposes a saved pack, a one-off draft, or a legal referral, and the person accepts or rejects it. This stage makes model calls."
      entry="chat"
      source="test:stage-agree"
      stage={AGREE}
      prompts={[
        {
          label: "Fits a seeded pack",
          text: "I moved and need to tell the IRS my new address.",
        },
        {
          label: "Fits a pack, with answers in it",
          text: "I'm Ada Lovelace. I moved from 1 Old Road, Oakland to 2 New Street, Berkeley and need to tell the IRS.",
        },
        {
          label: "No saved pack (draft)",
          text: "I need to contest a parking ticket I got in Oakland, California.",
        },
        {
          label: "Legal advice only",
          text: "I want a lawyer's advice about a dispute with my landlord in California.",
        },
        { label: "Too vague", text: "I got a letter." },
      ]}
    />
  );
}

export function StageCollect() {
  return (
    <CasePage
      title="easygov stage 2: collect, build, review"
      description="Starts on a landing page, so stage 1 is skipped and no model is called. Answer the questions, attach the files, review the document, and change an answer in review to go around again."
      entry="pack"
      source="test:stage-collect"
      stage={COLLECT}
      pilotBar={{ until: "review" }}
    />
  );
}

export function StageFinish() {
  return (
    <CasePage
      title="easygov stage 3: finish"
      description="The autopilot answers and accepts, then hands the case back: share or reject the referral if one was offered, and see delivery prepared. Start as a guest to see that sharing needs an account."
      entry="pack"
      source="test:stage-finish"
      stage={FINISH}
      onStart={{ until: "accepted", referral: "trigger", consent: "share" }}
      pilotBar={{ until: "accepted" }}
    />
  );
}

export function Pipeline() {
  return (
    <CasePage
      title="easygov: the whole pipeline"
      description="The person on the left, the firm on the right. Start from a landing page or from chat, drive it by hand or let the autopilot run to the end, then accept the referral as the firm and read the packet."
      entry="any"
      source="test:pipeline"
      pilotBar={{ until: "end" }}
      firm
    />
  );
}

export function Firms() {
  return (
    <Page
      title="easygov slice: firm desk"
      description="The firm side on its own: previews show nothing the person wrote, the first firm to accept gets the referral and owes its price, and passing hides it from that firm only."
      wide
    >
      <SeedBar />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <FirmDesk />
          <FirmForm />
        </div>
        <AllReferrals />
      </div>
    </Page>
  );
}
