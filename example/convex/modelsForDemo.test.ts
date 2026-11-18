import { afterEach, expect, test, vi } from "vitest";

const { gatewayModel, convexGateway } = vi.hoisted(() => {
  const gatewayModel = { doGenerate: vi.fn(), doStream: vi.fn() };
  return { gatewayModel, convexGateway: vi.fn(() => gatewayModel) };
});
vi.mock("@convex-dev/ai-sdk-provider", () => ({ convexGateway }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

test("uses the real gateway without provider keys and propagates gateway failures", async () => {
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY"]) {
    vi.stubEnv(name, "");
  }
  const { languageModel } = await import("./modelsForDemo");
  expect(convexGateway).toHaveBeenCalledWith(
    expect.stringMatching(/^openai\//),
  );
  expect(languageModel).toBe(gatewayModel);
  gatewayModel.doGenerate.mockRejectedValueOnce(
    new Error("AiGatewayUnavailable"),
  );
  await expect(languageModel.doGenerate({ prompt: [] })).rejects.toThrow(
    "AiGatewayUnavailable",
  );
  gatewayModel.doStream.mockRejectedValueOnce(new Error("AiGatewayDisabled"));
  await expect(languageModel.doStream({ prompt: [] })).rejects.toThrow(
    "AiGatewayDisabled",
  );
});
