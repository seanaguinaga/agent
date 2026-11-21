// See the docs at https://docs.convex.dev/agents/debugging
import { OpenTelemetry } from "@ai-sdk/otel";
import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { registerTelemetry } from "ai";
import { v } from "convex/values";
import { action } from "../_generated/server";
import { agent } from "../agents/simple";
import { authorizeThreadAccess } from "../threads";
import { spanBuffer } from "./spanBuffer";

const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;

export const tracerProvider = new BasicTracerProvider({
  resource: resourceFromAttributes({ "service.name": "convex-agent" }),
  spanProcessors: [
    // Spans tagged with a thread are also kept for `saveTelemetry` to save
    // to the `spans` table (see spans.ts).
    new SimpleSpanProcessor(spanBuffer),
    // Without an endpoint the exporter retries a default localhost URL, and
    // every `forceFlush` blocks its action for seconds. Export nothing instead.
    ...(tracesEndpoint
      ? [
          new SimpleSpanProcessor(
            new OTLPTraceExporter({
              url: tracesEndpoint,
              headers: {
                Authorization: `Bearer ${process.env.OTEL_EXPORTER_OTLP_TRACES_TOKEN}`,
              },
            }),
          ),
        ]
      : []),
  ],
});
trace.setGlobalTracerProvider(tracerProvider);
registerTelemetry(new OpenTelemetry());

export const generateTextWithTelemetry = action({
  args: { prompt: v.string(), threadId: v.string() },
  handler: async (ctx, { prompt, threadId }) => {
    await authorizeThreadAccess(ctx, threadId);
    const result = await agent.generateText(
      ctx,
      { threadId },
      {
        prompt,
        telemetry: {
          functionId: "debugging/telemetry",
        },
      },
    );
    await tracerProvider.forceFlush();
    return result.text;
  },
});
