import { FormBacking } from "./FormBacking";
import { useAct } from "./session";
import type { PacketEvidence } from "./packetArchive";
import type { CaseView } from "../../convex/easygov/autopilot";

export function PacketContents({
  artifact,
  urls,
  evidence,
}: {
  evidence: PacketEvidence[];
  artifact: NonNullable<CaseView["artifact"]>;
  urls: Record<string, string>;
}) {
  const act = useAct();
  const docs = [
    ...(artifact.document
      ? [{ ...artifact.document, code: "Official form" }]
      : []),
    ...(artifact.documents ?? []),
  ];
  return (
    <div className="space-y-3">
      <button
        className="demo-secondary"
        disabled={act.pending}
        onClick={() =>
          void act.run(async () => {
            const { packetArchive } = await import("./packetArchive");
            const url = URL.createObjectURL(
              await packetArchive(artifact, urls, evidence),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = `EasyGov-packet-v${artifact.revision ?? 1}.zip`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
          })
        }
      >
        Download packet
      </button>
      {act.error && <p role="alert">{act.error}</p>}
      {artifact.revision && (
        <p className="text-sm">Packet revision {artifact.revision}</p>
      )}
      {artifact.eligibility?.map((rule) => (
        <p key={rule.condition}>
          {rule.condition} · {rule.outcome}{" "}
          <a
            className="link-text"
            href={rule.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            Official instructions
          </a>
        </p>
      ))}
      {artifact.letter && (
        <pre className="whitespace-pre-wrap rounded-lg border p-3">
          {artifact.letter}
        </pre>
      )}
      {artifact.checklist?.map((step, i) => (
        <p key={i}>
          {i + 1}. {step}
        </p>
      ))}
      {docs.map((doc) => (
        <div className="rounded-lg border p-3" key={doc.storageId}>
          {urls[doc.storageId] ? (
            <a
              className="link-text"
              href={urls[doc.storageId]}
              target="_blank"
              rel="noreferrer"
            >
              Open filled {doc.code}
            </a>
          ) : (
            <span>{doc.code} · file unavailable</span>
          )}
          {"sourceUrl" in doc && (
            <FormBacking form={doc} pages={artifact.sources} />
          )}
          {doc.omissions.map((item, i) => (
            <p key={i}>
              {item.label} · {item.reason}
            </p>
          ))}
          {doc.toComplete.map((item, i) => (
            <p key={i}>Complete by hand · {item.note}</p>
          ))}
        </div>
      ))}
      {!!artifact.openItems?.length && (
        <div>
          <strong>Still to do</strong>
          <ul className="list-disc pl-5">
            {artifact.openItems.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
