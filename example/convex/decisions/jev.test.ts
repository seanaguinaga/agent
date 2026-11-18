import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getServiceToken } from "convex/server";
import { api } from "../_generated/api";
import { initConvexTest } from "../setup.test";

vi.mock("convex/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/server")>()),
  getServiceToken: vi.fn(),
}));

const response = {
  id: "decision-test",
  model: "typesafe/jev-1.13",
  answers: {
    priority: {
      type: "choice",
      choice: "urgent",
      confidence: 0.9,
      probabilities: { urgent: 0.9, normal: 0.08, low: 0.02 },
    },
    needsHuman: { type: "noul", noul: 0.8 },
  },
  usage: { input_tokens: 50, output_tokens: 3, cost: 0.00001 },
};
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.mocked(getServiceToken).mockReset().mockResolvedValue("test-token");
  fetchMock.mockReset().mockResolvedValue(Response.json(response));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

test("sends native Jev questions using a server token and returns validated decisions", async () => {
  const t = initConvexTest();
  const result = await t.action(api.decisions.jev.triage, {
    ticket: "  Everyone is locked out  ",
  });
  expect(result).toEqual(response);
  expect(getServiceToken).toHaveBeenCalledWith("ai-gateway");
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe("https://ai-gateway.convex.dev/alpha/decisions");
  expect(options?.headers).toMatchObject({
    Authorization: "Bearer test-token",
  });
  expect(JSON.parse(String(options?.body))).toMatchObject({
    model: "typesafe/jev-1.13",
    state: { ticket: "Everyone is locked out" },
    questions: { priority: { type: "choice" }, needsHuman: { type: "noul" } },
  });
  expect(JSON.stringify(result)).not.toContain("test-token");
});

test.each(["   ", "x".repeat(8001)])(
  "rejects invalid input before getting a token or making a request",
  async (ticket) => {
    await expect(
      initConvexTest().action(api.decisions.jev.triage, { ticket }),
    ).rejects.toThrow(/8,000/);
    expect(getServiceToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test("gateway authentication failure propagates without a mock fallback", async () => {
  vi.mocked(getServiceToken).mockRejectedValueOnce(
    new Error("AiGatewayUnavailable"),
  );
  await expect(
    initConvexTest().action(api.decisions.jev.triage, { ticket: "Help" }),
  ).rejects.toThrow(/AiGatewayUnavailable/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("HTTP failures return a safe error without retrying paid requests", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response("private provider detail", { status: 503 }),
  );
  await expect(
    initConvexTest().action(api.decisions.jev.triage, { ticket: "Help" }),
  ).rejects.toThrow(/HTTP 503/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test.each([
  { ...response, answers: {} },
  {
    ...response,
    answers: { ...response.answers, needsHuman: { type: "noul", noul: 1.2 } },
  },
  {
    ...response,
    answers: {
      ...response.answers,
      priority: { type: "choice", choice: "unknown" },
    },
  },
])("rejects missing or invalid model answers", async (invalid) => {
  fetchMock.mockResolvedValueOnce(Response.json(invalid));
  await expect(
    initConvexTest().action(api.decisions.jev.triage, { ticket: "Help" }),
  ).rejects.toThrow(/unexpected decision/);
});

test("optional confidence and usage remain unknown when the provider omits them", async () => {
  const minimal = {
    id: response.id,
    model: response.model,
    answers: {
      priority: { type: "choice", choice: "low" },
      needsHuman: { type: "noul", noul: 0 },
    },
  };
  fetchMock.mockResolvedValueOnce(Response.json(minimal));
  expect(
    await initConvexTest().action(api.decisions.jev.triage, {
      ticket: "Where are the docs?",
    }),
  ).toEqual(minimal);
});
