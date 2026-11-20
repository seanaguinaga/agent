import { strToU8, zipSync } from "fflate";
import type { CaseView } from "../../convex/easygov/autopilot";

export type PacketEvidence = { key?: string; name: string; url?: string };
type Artifact = NonNullable<CaseView["artifact"]>;

export async function packetArchive(
  artifact: Artifact,
  urls: Record<string, string>,
  evidence: PacketEvidence[],
): Promise<Blob> {
  const items: { key: string; name: string; text?: string; url?: string }[] =
    [];
  if (artifact.letter)
    items.push({ key: "letter", name: "Letter.txt", text: artifact.letter });
  const documents = [
    ...(artifact.document
      ? [{ ...artifact.document, code: "Official form" }]
      : []),
    ...(artifact.documents ?? []),
  ];
  for (const document of documents)
    items.push({
      key: document.code,
      name: document.code + ".pdf",
      url: urls[document.storageId],
    });
  for (const file of evidence)
    items.push({ key: file.key ?? file.name, name: file.name, url: file.url });
  const rank = (key: string) => {
    const index = artifact.filingOrder?.indexOf(key) ?? -1;
    return index < 0 ? Infinity : index;
  };
  items.sort((a, b) => rank(a.key) - rank(b.key));
  const files: Record<string, Uint8Array> = {};
  const instructions = [
    `Packet revision ${artifact.revision ?? 1}`,
    ...(artifact.checklist ?? []),
    ...(artifact.eligibility ?? []).map(
      (rule) => `${rule.condition}: ${rule.outcome} (${rule.sourceUrl})`,
    ),
    ...(artifact.openItems ?? []),
    ...documents.flatMap((doc) => [
      ...doc.toComplete.map((item) => `${doc.code}: ${item.note}`),
      ...doc.omissions.map(
        (item) => `${doc.code}, ${item.label}: ${item.reason}`,
      ),
    ]),
    ...(artifact.sources ?? []),
  ];
  const manifest = [];
  for (const [index, item] of items.entries()) {
    const name =
      String(index + 1).padStart(3, "0") +
      " " +
      item.name.replace(/[^\p{L}\p{N}. _-]/gu, "_").slice(0, 150);
    manifest.push(name);
    if (item.text !== undefined) files[name] = strToU8(item.text);
    else {
      if (!item.url)
        throw new Error(
          `Could not load ${item.name}. Reopen the packet and try again.`,
        );
      const response = await fetch(item.url);
      if (!response.ok) throw new Error(`Could not download ${item.name}.`);
      files[name] = new Uint8Array(await response.arrayBuffer());
    }
  }
  files["000 Packet instructions.txt"] = strToU8(
    [...instructions, "", "Packet contents", ...manifest].join("\n"),
  );
  return new Blob([zipSync(files, { level: 0 }).slice().buffer], {
    type: "application/zip",
  });
}
