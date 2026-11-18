import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { embed, generateImage } from "ai";
import { embeddingModel, imageModel, languageModel } from "./modelsForDemo";
import { streamingReasoningConfig } from "./agents/config";

const asyncSyscall = vi.fn();
beforeEach(() => {
  asyncSyscall.mockReset().mockResolvedValue(JSON.stringify("deployment-token"));
  vi.stubGlobal("Convex", { asyncSyscall });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("selects Gateway chat even when direct provider keys exist", async () => {
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY"]) {
    vi.stubEnv(name, "unused-direct-provider-key");
  }
  vi.resetModules();
  const { languageModel } = await import("./modelsForDemo");
  expect(languageModel.provider).toBe("convexGateway.chat");
  expect(languageModel.modelId).toBe("openai/gpt-6-luna");
});

test("propagates Gateway failures from generation and streaming", async () => {
  asyncSyscall.mockRejectedValueOnce(new Error("AiGatewayUnavailable"));
  await expect(languageModel.doGenerate({ prompt: [] })).rejects.toThrow(
    "AiGatewayUnavailable",
  );
  asyncSyscall.mockRejectedValueOnce(new Error("AiGatewayDisabled"));
  await expect(languageModel.doStream({ prompt: [] })).rejects.toThrow(
    "AiGatewayDisabled",
  );
});

test("embeds through Gateway while preserving the existing index model ID", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({ data: [{ embedding: [0.25, 0.5] }] }),
  );
  vi.stubGlobal("fetch", fetch);

  const result = await embed({ model: embeddingModel, value: "hello" });

  expect(result.embedding).toEqual([0.25, 0.5]);
  expect(embeddingModel.modelId).toBe("text-embedding-3-small");
  const [url, request] = fetch.mock.calls[0]!;
  expect(String(url)).toMatch(/\/v1\/embeddings$/);
  expect(new Headers(request?.headers).get("Authorization")).toBe(
    "Bearer deployment-token",
  );
  expect(asyncSyscall).toHaveBeenCalledWith(
    "1.0/createServiceToken",
    expect.stringContaining('"service":"ai-gateway"'),
  );
  expect(JSON.parse(String(request?.body))).toMatchObject({
    model: "openai/text-embedding-3-small",
    input: ["hello"],
  });
});

test("generates image bytes through Gateway", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({ data: [{ b64_json: "iVBORw0KGgo=" }] }),
  );
  vi.stubGlobal("fetch", fetch);

  const { image } = await generateImage({ model: imageModel, prompt: "A lake" });

  expect(image.mediaType).toBe("image/png");
  expect(image.uint8Array.byteLength).toBe(8);
  const [url, request] = fetch.mock.calls[0]!;
  expect(String(url)).toMatch(/\/v1\/images\/generations$/);
  expect(JSON.parse(String(request?.body))).toMatchObject({
    model: "openai/gpt-image-1-mini",
    prompt: "A lake",
  });
});

test("streams reasoning through Gateway with the reasoning config", async () => {
  const chunks = [
    { index: 0, delta: { reasoning: "Consider options." }, finish_reason: null },
    { index: 0, delta: { content: "Answer." }, finish_reason: "stop" },
  ];
  const events = chunks.map(
    (choice) => `data: ${JSON.stringify({ choices: [choice] })}\n\n`,
  );
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response([...events, "data: [DONE]\n\n"].join(""), {
      headers: { "Content-Type": "text/event-stream" },
    }),
  );
  vi.stubGlobal("fetch", fetch);

  const result = await streamingReasoningConfig.languageModel.doStream({
    prompt: [],
    providerOptions: streamingReasoningConfig.providerOptions,
  });
  const parts = await Array.fromAsync(result.stream);
  expect(parts).toContainEqual(
    expect.objectContaining({ type: "reasoning-delta", delta: "Consider options." }),
  );
  const [url, request] = fetch.mock.calls[0]!;
  expect(String(url)).toMatch(/\/v1\/chat\/completions$/);
  expect(JSON.parse(String(request?.body))).toMatchObject({
    model: "openai/gpt-oss-120b",
    reasoning_effort: "medium",
    stream: true,
  });
});
