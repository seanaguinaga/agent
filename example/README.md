# Agent Example

This is an example app that uses the `@convex-dev/agent` package.

See the [Agent docs](https://docs.convex.dev/agents) for documentation.

The backend usage is in `convex/`, with folders to organize usecases. The
frontend usage is in `ui/`.

The example exercises many usecases, with the underlying code organized into
folders by category.

The main difference from your app will be:

- What models you use (currently uses `modelsForDemo.ts`)
- Usage handling - currently configures agents to use `usageHandler.ts`
- How you handle auth - currently has an example `authorizeThreadAccess`
  function.

## Running the example

```bash
git clone https://github.com/convex/agent.git
cd agent
npm run setup
npm run dev
```

## assistant-ui chat

`/chat-assistant-ui` renders the tool approval agent with
[assistant-ui](https://www.assistant-ui.com/) primitives. It uses the same
backend as the Tool Approval example (`convex/chat/approval.ts`).

- `ui/chat/assistant-ui/useConvexRuntime.ts` connects `useUIMessages` to
  `useExternalStoreRuntime`. Sending runs `sendMessage` with
  `optimisticallySendMessage`, and approvals go through `submitApproval`, which
  resumes generation once every approval in the step is answered. Stop calls
  `abortStreamByOrder`.
- `ui/chat/assistant-ui/convertMessage.ts` maps `UIMessage` parts to
  assistant-ui parts, keyed by the message's stable `key`.
- `ui/chat/assistant-ui/Thread.tsx` composes the UI from assistant-ui
  primitives.

Without a provider key, the examples use the Convex AI Gateway with the model
configured in `convex/modelsForDemo.ts`. Link a local backend to a project on a
paid Convex team with `npx convex login --link-deployments`, then restart
`npx convex dev`. Gateway failures are reported as errors; the examples never
silently substitute mock responses. The approval tools simulate deletion and
transfers; they do not delete real files or move money.

## Example screens

The example frontend at `http://127.0.0.1:5173` has a searchable catalog of 33
screens. Run `npm run dev` for the local backend and component watcher, and
`npm run dev:frontend` in another terminal for the UI.

| Backend examples | Frontend routes |
| --- | --- |
| `chat/basic.ts` | `/chat-basic`, `/chat-action` |
| `chat/streaming.ts` | `/chat-streaming`, `/chat-stream-one-shot`, `/chat-http`, `/chat-without-deltas` |
| `chat/withoutAgent.ts` | `/chat-without-agent` |
| `chat/streamingReasoning.ts` | `/chat-reasoning`, `/chat-story` |
| `chat/streamAbort.ts` | `/chat-abort`, `/chat-abort-methods` |
| `chat/human.ts` | `/chat-human` |
| `chat/approval.ts`, `agents/approval.ts` | `/chat-approval`, `/chat-assistant-ui` |
| `files/addFile.ts`, `files/autoSave.ts`, `files/generateImage.ts` | `/files-images`, `/files-autosave`, `/generate-image` |
| `files/vacuum.ts`, `crons.ts` | `/files-cleanup` (read-only preview) |
| `rag/ragAsPrompt.ts`, `rag/utils.ts` | `/rag-basic` |
| `rag/ragAsTools.ts` | `/rag-tools` |
| `objects/generateObject.ts`, `objects/streamArray.ts` | `/generate-object`, `/stream-array` |
| `decisions/jev.ts` | `/jev-decisions` |
| `tools/agentAsTool.ts` | `/agent-as-tool` |
| `tools/searchMessages.ts`, `tools/updateThreadTitle.ts` | `/tool-chat` |
| `workflows/chaining.ts`, `tools/weather.ts`, `agents/weather.ts`, `agents/fashion.ts` | `/agent-chaining`, `/weather-fashion` |
| `threads.ts` | `/threads` |
| `rate_limiting/` | `/rate-limiting` |
| `usage_tracking/` | `/usage-tracking` (read-only usage and invoices) |
| `debugging/` | `/debugging-logs`, `/debugging-telemetry` |
| `playground.ts` | `/playground` links to the existing playground; start it with `npm run dev --workspace playground -- --port 5174` |

The simple and story agents are exercised by the chat screens. Schema, config,
model selection, table declarations, and internal helpers support these screens;
they are not exposed as arbitrary browser commands. File cleanup and invoicing
remain internal. The app retains the repository's shared `test user` demo
identity, so this is a development example rather than a production auth system.

Provider requirements appear on the relevant screens. Reasoning uses Groq;
image generation and RAG embeddings require OpenAI configuration. The prompt-RAG
screen shows setup instructions until embeddings are available. Debug logs stay
in the backend terminal; OpenTelemetry spans go to the configured collector.

## Jev decision model

Open `/jev-decisions` to triage a support ticket with `typesafe/jev-1.13`.
The action in `convex/decisions/jev.ts` sends one request to the Convex AI
Gateway's [Decisions endpoint](https://docs.convex.dev/ai-gateway/api#post-alphadecisions).
It asks a native `choice` question for priority and a `noul` question for the
probability that human review is needed. Choice confidence and human-review
probability describe different questions and are displayed separately.

This uses `getServiceToken("ai-gateway")` inside the action, so no provider key
or browser token is needed. A paid Convex team with gateway access and a local
deployment linked to its project are required. Each evaluation is a paid model
request. The UI shows provider-reported usage and cost when available; omitted
values remain unknown. Results are not stored in a thread or the usage tables.

The example calls the HTTP API directly because the installed gateway provider
version has no `evaluationModel` method. It validates the response, rejects
empty or oversized tickets, and does not retry requests or substitute mock
decisions on gateway failure. The frontend keeps the ticket for manual retry.
The endpoint is in alpha and its format may change. This demo only displays
judgments; it does not route a ticket or execute the model's decision.

## Human inbox

The Human agents page (`/chat-human`) includes an inbox of unanswered `askHuman`
tool calls across the demo user's conversations. Select a request to open its
conversation and expand its reply form inside the inbox. **Send reply** saves
the human answer and resumes the AI. The chat shows a compact **Waiting for
support** card with **Cancel request**, followed by **Support replied** and the
actual answer when support responds. Ordinary human-support messages do not
resolve tool requests.

The inbox derives its contents from saved tool calls and tool results, so
existing requests appear without a migration or a second request table. Older
conversations load automatically; an empty state appears only after scanning is complete. Each checked
conversation scans its complete message history, including requests older than
100 messages. This is appropriate for the demo; larger histories should use
an indexed inbox to stay within Convex query read limits.

**Cancel request** in the chat status card saves an explicit cancellation tool result,
then resumes the AI once sibling requests are resolved. It supplies no human
answer or approval and retains the conversation. **Delete conversation** in the
inbox or selected conversation deletes the thread, messages, and streams using
the Agent component's deletion API and clears the selected thread from the URL.

Customer messages invoke the support agent by default. The agent uses the same
human-inbox instructions before and after a handoff, and asks staff to clarify
unclear replies. Other message examples remain available in the expandable
section. Detailed staff questions and reply drafts stay in the inbox. The
customer chat shows handoff status and support replies without tool IDs,
provider metadata, or raw JSON. Use the Agent playground for developer inspection.
