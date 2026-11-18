import { lazy } from "react";
import { api } from "../convex/_generated/api";
import ChatExamples from "./chat/ChatExamples";

const ChatBasic = lazy(() => import("./chat/ChatBasic"));
const ChatStreaming = lazy(() => import("./chat/ChatStreaming"));
const ChatApproval = lazy(() => import("./chat/ChatApproval"));
const ChatAssistantUI = lazy(() => import("./chat/ChatAssistantUI"));
const FilesImages = lazy(() => import("./files/FilesImages"));
const RagBasic = lazy(() => import("./rag/RagBasic"));
const RateLimiting = lazy(() => import("./rate_limiting/RateLimiting"));
const WeatherFashion = lazy(async () => ({
  default: (await import("./workflows/weatherFashion")).WeatherFashion,
}));
const StreamArray = lazy(() => import("./objects/StreamArray"));
const GenerateObject = lazy(() => import("./objects/GenerateObject"));
const JevDecision = lazy(() => import("./decisions/JevDecision"));
const AgentAsTool = lazy(() => import("./tools/AgentAsTool"));
const AbortExamples = lazy(() => import("./chat/AbortExamples"));
const HttpStreaming = lazy(() => import("./chat/HttpStreaming"));
const StreamWithoutDeltas = lazy(() => import("./chat/StreamWithoutDeltas"));
const HumanAgents = lazy(() => import("./chat/HumanAgents"));
const UsageTracking = lazy(() => import("./usage_tracking/UsageTracking"));
const Chaining = lazy(() => import("./workflows/Chaining"));
const Threads = lazy(() => import("./threads/Threads"));
const Playground = lazy(() => import("./playground/Playground"));
const AutoSaveImage = lazy(async () => ({
  default: (await import("./files/FileExamples")).AutoSaveImage,
}));
const GenerateImage = lazy(async () => ({
  default: (await import("./files/FileExamples")).GenerateImage,
}));
const FileMaintenance = lazy(async () => ({
  default: (await import("./files/FileExamples")).FileMaintenance,
}));

// Routes and catalog cards share one list so every demo stays discoverable.
export const examples = [
  {
    path: "/chat-basic",
    group: "Chat",
    title: "Basic chat",
    description: "Optimistic messages and asynchronous AI replies.",
    source: "chat/basic.ts",
    element: <ChatBasic />,
  },
  {
    path: "/chat-action",
    group: "Chat",
    title: "Chat in a single action",
    description: "Wait for a complete reply from one action call.",
    source: "chat/basic.ts",
    element: (
      <ChatExamples
        kind="action"
        send={api.chat.basic.generateTextInAnAction}
        title="Chat in a single action"
        description="Generate a reply directly in an action. Messages are saved to the conversation as the action runs."
      />
    ),
  },
  {
    path: "/chat-streaming",
    group: "Chat",
    title: "Streaming chat",
    description:
      "Subscribe to persisted stream deltas with optimistic messages.",
    source: "chat/streaming.ts",
    element: <ChatStreaming />,
  },
  {
    path: "/chat-stream-one-shot",
    group: "Chat",
    title: "One-shot streaming",
    description: "Generate and subscribe to a stream from a single action.",
    source: "chat/streaming.ts",
    element: (
      <ChatExamples
        kind="action"
        send={api.chat.streaming.streamOneShot}
        title="One-shot streaming"
        description="Invoke the story agent in an action and observe persisted stream deltas in the conversation."
      />
    ),
  },
  {
    path: "/chat-without-agent",
    group: "Chat",
    title: "Chat without the Agent class",
    description: "Use the AI SDK with generation and persistence helpers.",
    source: "chat/withoutAgent.ts",
    element: (
      <ChatExamples
        kind="mutation"
        send={api.chat.withoutAgent.initiateGeneration}
        title="Chat without the Agent class"
        description="Save the prompt, then run the AI SDK asynchronously using startGeneration for context, tools, and persistence."
      />
    ),
  },
  {
    path: "/chat-http",
    group: "Chat",
    title: "HTTP streaming",
    description: "Receive text chunks directly over an HTTP connection.",
    source: "chat/streaming.ts",
    element: <HttpStreaming />,
  },
  {
    path: "/chat-without-deltas",
    group: "Chat",
    title: "Streaming without saved deltas",
    description: "Consume the server stream and inspect the final result.",
    source: "chat/streaming.ts",
    element: <StreamWithoutDeltas />,
  },
  {
    path: "/chat-reasoning",
    group: "Chat",
    title: "Streaming reasoning",
    description: "Inspect reasoning, tool calls, and text. Groq key required.",
    source: "chat/streamingReasoning.ts",
    element: (
      <ChatExamples
        kind="action"
        send={api.chat.streamingReasoning.streamReasoning}
        title="Streaming reasoning"
        description="Expand reasoning and tool parts as they stream through Convex AI Gateway."
        initialPrompt="What is the best flavor of ice cream? Ask a friend for their opinion."
      />
    ),
  },
  {
    path: "/chat-story",
    group: "Chat",
    title: "Story agent streaming",
    description: "The reasoning example's story-agent variant.",
    source: "chat/streamingReasoning.ts",
    element: (
      <ChatExamples
        kind="action"
        send={api.chat.streamingReasoning.streamOneShot}
        title="Story agent streaming"
        description="The story agent streams a complete answer in one action. Expand tool parts to inspect character-name calls."
      />
    ),
  },
  {
    path: "/chat-abort",
    group: "Chat",
    title: "Stop a stream",
    description: "Start a long response and stop an active stream by order.",
    source: "chat/streamAbort.ts",
    element: (
      <ChatExamples
        kind="mutation"
        send={api.chat.streaming.initiateAsyncStreaming}
        title="Stop a stream"
        description="Start a long story, then cancel an active stream. Very short replies may finish before you can stop them."
        abort
        initialPrompt="Write a long, detailed story about an expedition to the ocean floor."
      />
    ),
  },
  {
    path: "/chat-abort-methods",
    group: "Chat",
    title: "Automatic cancellation",
    description: "Compare first-chunk cancellation and AbortSignal.",
    source: "chat/streamAbort.ts",
    element: <AbortExamples />,
  },
  {
    path: "/chat-human",
    group: "Chat",
    title: "Human agents",
    description: "Reply as support and fulfill human-input tool requests.",
    source: "chat/human.ts",
    element: <HumanAgents />,
  },
  {
    path: "/chat-approval",
    group: "Tools & workflows",
    title: "Tool approval",
    description: "Approve or deny tool calls before they execute.",
    source: "chat/approval.ts",
    element: <ChatApproval />,
  },
  {
    path: "/chat-assistant-ui",
    group: "Tools & workflows",
    title: "assistant-ui chat",
    description:
      "Approvals, streaming, and history with assistant-ui primitives.",
    source: "chat/approval.ts",
    element: <ChatAssistantUI />,
  },
  {
    path: "/agent-as-tool",
    group: "Tools & workflows",
    title: "Agent as a tool",
    description: "Delegate work from a dispatch agent to a nested agent.",
    source: "tools/agentAsTool.ts",
    element: <AgentAsTool />,
  },
  {
    path: "/tool-chat",
    group: "Tools & workflows",
    title: "Message search & title tools",
    description: "Search past messages or rename the current thread.",
    source: "tools/chat.ts",
    element: (
      <ChatExamples
        kind="action"
        send={api.tools.chat.sendMessage}
        title="Message search & title tools"
        description="Ask the agent to rename this thread or recall an earlier message using vector search."
        initialPrompt="Rename this thread to Garden plans. Remember that my favorite flower is lavender."
      />
    ),
  },
  {
    path: "/agent-chaining",
    group: "Tools & workflows",
    title: "Agent chaining",
    description: "Run weather and fashion agents sequentially in an action.",
    source: "workflows/chaining.ts",
    element: <Chaining />,
  },
  {
    path: "/weather-fashion",
    group: "Tools & workflows",
    title: "Durable weather workflow",
    description:
      "Weather and outfit advice in a durable workflow with retries.",
    source: "workflows/chaining.ts",
    element: <WeatherFashion />,
  },
  {
    path: "/files-images",
    group: "Files & knowledge",
    title: "Files & images",
    description: "Upload a file, then ask the file-review agent a question.",
    source: "files/addFile.ts",
    element: <FilesImages />,
  },
  {
    path: "/files-autosave",
    group: "Files & knowledge",
    title: "Automatic image saving",
    description: "Pass image bytes directly and let the agent manage storage.",
    source: "files/autoSave.ts",
    element: <AutoSaveImage />,
  },
  {
    path: "/generate-image",
    group: "Files & knowledge",
    title: "Image generation",
    description: "Generate and save an assistant image. OpenAI key required.",
    source: "files/generateImage.ts",
    element: <GenerateImage />,
  },
  {
    path: "/files-cleanup",
    group: "Files & knowledge",
    title: "Unused file cleanup",
    description: "Inspect unreferenced files and the internal cleanup policy.",
    source: "files/vacuum.ts",
    element: <FileMaintenance />,
  },
  {
    path: "/rag-basic",
    group: "Files & knowledge",
    title: "RAG in the prompt",
    description:
      "Index documents and inspect answer context. OpenAI embeddings required.",
    source: "rag/ragAsPrompt.ts",
    element: <RagBasic />,
  },
  {
    path: "/rag-tools",
    group: "Files & knowledge",
    title: "RAG as tools",
    description: "Let the agent store and search knowledge through tools.",
    source: "rag/ragAsTools.ts",
    element: (
      <ChatExamples
        kind="action"
        send={api.rag.ragAsTools.sendMessage}
        title="RAG as tools"
        description="Ask the agent to remember information and retrieve it later from your own namespace."
        initialPrompt="Remember this: my favorite hiking trail is the Dipsea Trail. Store it so you can find it later."
      />
    ),
  },
  {
    path: "/generate-object",
    group: "Structured output",
    title: "Objects, arrays & enums",
    description: "Generate schema-validated structured results.",
    source: "objects/generateObject.ts",
    element: <GenerateObject />,
  },
  {
    path: "/jev-decisions",
    group: "Structured output",
    title: "Jev decision model",
    description:
      "Triage support tickets with priority choices, confidence, and human-review probabilities.",
    source: "decisions/jev.ts",
    element: <JevDecision />,
  },
  {
    path: "/stream-array",
    group: "Structured output",
    title: "Streaming arrays",
    description: "Watch party-supply items arrive through persisted deltas.",
    source: "objects/streamArray.ts",
    element: <StreamArray />,
  },
  {
    path: "/threads",
    group: "Operations",
    title: "Threads & history",
    description: "Browse conversations and generate titles and summaries.",
    source: "threads.ts",
    element: <Threads />,
  },
  {
    path: "/rate-limiting",
    group: "Operations",
    title: "Rate limiting",
    description: "Monitor message frequency and token consumption limits.",
    source: "rate_limiting/rateLimiting.ts",
    element: <RateLimiting />,
  },
  {
    path: "/usage-tracking",
    group: "Operations",
    title: "Usage & invoices",
    description: "Inspect token usage and existing demo-user invoices.",
    source: "usage_tracking/invoicing.ts",
    element: <UsageTracking />,
  },
  {
    path: "/debugging-logs",
    group: "Operations",
    title: "Raw request logging",
    description: "Run a request through the DEBUG-controlled logging hook.",
    source: "debugging/rawRequestResponseHandler.ts",
    element: (
      <ChatExamples
        kind="action"
        send={api.chat.basic.generateTextInAnAction}
        title="Raw request logging"
        description="Set DEBUG=true on your local Convex backend, then send a message. Request bodies and response headers appear in the running backend terminal. The hook is disabled otherwise."
      />
    ),
  },
  {
    path: "/debugging-telemetry",
    group: "Operations",
    title: "OpenTelemetry",
    description: "Generate a traced reply and flush spans to your collector.",
    source: "debugging/telemetry.ts",
    element: (
      <ChatExamples
        kind="action"
        send={api.debugging.telemetry.generateTextWithTelemetry}
        title="OpenTelemetry"
        description="Configure OTEL_EXPORTER_OTLP_TRACES_ENDPOINT and OTEL_EXPORTER_OTLP_TRACES_TOKEN on the backend, then send a message. Text appears here; verify span delivery in your collector."
      />
    ),
  },
  {
    path: "/playground",
    group: "Operations",
    title: "Agent playground",
    description: "Connect the existing playground to this backend.",
    source: "playground.ts",
    element: <Playground />,
  },
];
