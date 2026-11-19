/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents_approval from "../agents/approval.js";
import type * as agents_config from "../agents/config.js";
import type * as agents_fashion from "../agents/fashion.js";
import type * as agents_simple from "../agents/simple.js";
import type * as agents_story from "../agents/story.js";
import type * as agents_weather from "../agents/weather.js";
import type * as chat_approval from "../chat/approval.js";
import type * as chat_basic from "../chat/basic.js";
import type * as chat_human from "../chat/human.js";
import type * as chat_streamAbort from "../chat/streamAbort.js";
import type * as chat_streaming from "../chat/streaming.js";
import type * as chat_streamingReasoning from "../chat/streamingReasoning.js";
import type * as chat_withoutAgent from "../chat/withoutAgent.js";
import type * as crons from "../crons.js";
import type * as debugging_rawRequestResponseHandler from "../debugging/rawRequestResponseHandler.js";
import type * as debugging_telemetry from "../debugging/telemetry.js";
import type * as decisions_jev from "../decisions/jev.js";
import type * as easygov_case_answers from "../easygov/case/answers.js";
import type * as easygov_case_data from "../easygov/case/data.js";
import type * as easygov_case_public from "../easygov/case/public.js";
import type * as easygov_packs_data from "../easygov/packs/data.js";
import type * as easygov_plans_data from "../easygov/plans/data.js";
import type * as easygov_plans_decide from "../easygov/plans/decide.js";
import type * as easygov_plans_steps from "../easygov/plans/steps.js";
import type * as easygov_stages_collect_data from "../easygov/stages/collect/data.js";
import type * as easygov_stages_collect_events from "../easygov/stages/collect/events.js";
import type * as easygov_stages_collect_workflow from "../easygov/stages/collect/workflow.js";
import type * as easygov_stages_deliver_data from "../easygov/stages/deliver/data.js";
import type * as easygov_stages_deliver_workflow from "../easygov/stages/deliver/workflow.js";
import type * as easygov_stages_fill_data from "../easygov/stages/fill/data.js";
import type * as easygov_stages_fill_workflow from "../easygov/stages/fill/workflow.js";
import type * as easygov_stages_intake_agent from "../easygov/stages/intake/agent.js";
import type * as easygov_stages_intake_data from "../easygov/stages/intake/data.js";
import type * as easygov_stages_intake_events from "../easygov/stages/intake/events.js";
import type * as easygov_stages_intake_workflow from "../easygov/stages/intake/workflow.js";
import type * as easygov_stages_legalReferral_data from "../easygov/stages/legalReferral/data.js";
import type * as easygov_stages_legalReferral_workflow from "../easygov/stages/legalReferral/workflow.js";
import type * as easygov_stages_registry from "../easygov/stages/registry.js";
import type * as easygov_stages_review_data from "../easygov/stages/review/data.js";
import type * as easygov_stages_review_events from "../easygov/stages/review/events.js";
import type * as easygov_stages_review_workflow from "../easygov/stages/review/workflow.js";
import type * as easygov_stages_selectProcessPack_agent from "../easygov/stages/selectProcessPack/agent.js";
import type * as easygov_stages_selectProcessPack_data from "../easygov/stages/selectProcessPack/data.js";
import type * as easygov_stages_selectProcessPack_events from "../easygov/stages/selectProcessPack/events.js";
import type * as easygov_stages_selectProcessPack_workflow from "../easygov/stages/selectProcessPack/workflow.js";
import type * as easygov_stages_shared from "../easygov/stages/shared.js";
import type * as evals_cases from "../evals/cases.js";
import type * as evals_fixtures from "../evals/fixtures.js";
import type * as evals_grading from "../evals/grading.js";
import type * as evals_runner from "../evals/runner.js";
import type * as evals_tables from "../evals/tables.js";
import type * as files_addFile from "../files/addFile.js";
import type * as files_autoSave from "../files/autoSave.js";
import type * as files_generateImage from "../files/generateImage.js";
import type * as files_maintenance from "../files/maintenance.js";
import type * as files_vacuum from "../files/vacuum.js";
import type * as http from "../http.js";
import type * as modelsForDemo from "../modelsForDemo.js";
import type * as objects_generateObject from "../objects/generateObject.js";
import type * as objects_streamArray from "../objects/streamArray.js";
import type * as playground from "../playground.js";
import type * as rag_ragAsPrompt from "../rag/ragAsPrompt.js";
import type * as rag_ragAsTools from "../rag/ragAsTools.js";
import type * as rag_tables from "../rag/tables.js";
import type * as rag_utils from "../rag/utils.js";
import type * as rate_limiting_rateLimiting from "../rate_limiting/rateLimiting.js";
import type * as rate_limiting_tables from "../rate_limiting/tables.js";
import type * as rate_limiting_utils from "../rate_limiting/utils.js";
import type * as threads from "../threads.js";
import type * as tools_agentAsTool from "../tools/agentAsTool.js";
import type * as tools_chat from "../tools/chat.js";
import type * as tools_searchMessages from "../tools/searchMessages.js";
import type * as tools_updateThreadTitle from "../tools/updateThreadTitle.js";
import type * as tools_weather from "../tools/weather.js";
import type * as usage_tracking_dashboard from "../usage_tracking/dashboard.js";
import type * as usage_tracking_invoicing from "../usage_tracking/invoicing.js";
import type * as usage_tracking_tables from "../usage_tracking/tables.js";
import type * as usage_tracking_usageHandler from "../usage_tracking/usageHandler.js";
import type * as utils from "../utils.js";
import type * as workflows_chaining from "../workflows/chaining.js";
import type * as workflows_outfit from "../workflows/outfit.js";
import type * as workflows_prompts from "../workflows/prompts.js";
import type * as workflows_tables from "../workflows/tables.js";
import type * as workflows_weatherFashion from "../workflows/weatherFashion.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "agents/approval": typeof agents_approval;
  "agents/config": typeof agents_config;
  "agents/fashion": typeof agents_fashion;
  "agents/simple": typeof agents_simple;
  "agents/story": typeof agents_story;
  "agents/weather": typeof agents_weather;
  "chat/approval": typeof chat_approval;
  "chat/basic": typeof chat_basic;
  "chat/human": typeof chat_human;
  "chat/streamAbort": typeof chat_streamAbort;
  "chat/streaming": typeof chat_streaming;
  "chat/streamingReasoning": typeof chat_streamingReasoning;
  "chat/withoutAgent": typeof chat_withoutAgent;
  crons: typeof crons;
  "debugging/rawRequestResponseHandler": typeof debugging_rawRequestResponseHandler;
  "debugging/telemetry": typeof debugging_telemetry;
  "decisions/jev": typeof decisions_jev;
  "easygov/case/answers": typeof easygov_case_answers;
  "easygov/case/data": typeof easygov_case_data;
  "easygov/case/public": typeof easygov_case_public;
  "easygov/packs/data": typeof easygov_packs_data;
  "easygov/plans/data": typeof easygov_plans_data;
  "easygov/plans/decide": typeof easygov_plans_decide;
  "easygov/plans/steps": typeof easygov_plans_steps;
  "easygov/stages/collect/data": typeof easygov_stages_collect_data;
  "easygov/stages/collect/events": typeof easygov_stages_collect_events;
  "easygov/stages/collect/workflow": typeof easygov_stages_collect_workflow;
  "easygov/stages/deliver/data": typeof easygov_stages_deliver_data;
  "easygov/stages/deliver/workflow": typeof easygov_stages_deliver_workflow;
  "easygov/stages/fill/data": typeof easygov_stages_fill_data;
  "easygov/stages/fill/workflow": typeof easygov_stages_fill_workflow;
  "easygov/stages/intake/agent": typeof easygov_stages_intake_agent;
  "easygov/stages/intake/data": typeof easygov_stages_intake_data;
  "easygov/stages/intake/events": typeof easygov_stages_intake_events;
  "easygov/stages/intake/workflow": typeof easygov_stages_intake_workflow;
  "easygov/stages/legalReferral/data": typeof easygov_stages_legalReferral_data;
  "easygov/stages/legalReferral/workflow": typeof easygov_stages_legalReferral_workflow;
  "easygov/stages/registry": typeof easygov_stages_registry;
  "easygov/stages/review/data": typeof easygov_stages_review_data;
  "easygov/stages/review/events": typeof easygov_stages_review_events;
  "easygov/stages/review/workflow": typeof easygov_stages_review_workflow;
  "easygov/stages/selectProcessPack/agent": typeof easygov_stages_selectProcessPack_agent;
  "easygov/stages/selectProcessPack/data": typeof easygov_stages_selectProcessPack_data;
  "easygov/stages/selectProcessPack/events": typeof easygov_stages_selectProcessPack_events;
  "easygov/stages/selectProcessPack/workflow": typeof easygov_stages_selectProcessPack_workflow;
  "easygov/stages/shared": typeof easygov_stages_shared;
  "evals/cases": typeof evals_cases;
  "evals/fixtures": typeof evals_fixtures;
  "evals/grading": typeof evals_grading;
  "evals/runner": typeof evals_runner;
  "evals/tables": typeof evals_tables;
  "files/addFile": typeof files_addFile;
  "files/autoSave": typeof files_autoSave;
  "files/generateImage": typeof files_generateImage;
  "files/maintenance": typeof files_maintenance;
  "files/vacuum": typeof files_vacuum;
  http: typeof http;
  modelsForDemo: typeof modelsForDemo;
  "objects/generateObject": typeof objects_generateObject;
  "objects/streamArray": typeof objects_streamArray;
  playground: typeof playground;
  "rag/ragAsPrompt": typeof rag_ragAsPrompt;
  "rag/ragAsTools": typeof rag_ragAsTools;
  "rag/tables": typeof rag_tables;
  "rag/utils": typeof rag_utils;
  "rate_limiting/rateLimiting": typeof rate_limiting_rateLimiting;
  "rate_limiting/tables": typeof rate_limiting_tables;
  "rate_limiting/utils": typeof rate_limiting_utils;
  threads: typeof threads;
  "tools/agentAsTool": typeof tools_agentAsTool;
  "tools/chat": typeof tools_chat;
  "tools/searchMessages": typeof tools_searchMessages;
  "tools/updateThreadTitle": typeof tools_updateThreadTitle;
  "tools/weather": typeof tools_weather;
  "usage_tracking/dashboard": typeof usage_tracking_dashboard;
  "usage_tracking/invoicing": typeof usage_tracking_invoicing;
  "usage_tracking/tables": typeof usage_tracking_tables;
  "usage_tracking/usageHandler": typeof usage_tracking_usageHandler;
  utils: typeof utils;
  "workflows/chaining": typeof workflows_chaining;
  "workflows/outfit": typeof workflows_outfit;
  "workflows/prompts": typeof workflows_prompts;
  "workflows/tables": typeof workflows_tables;
  "workflows/weatherFashion": typeof workflows_weatherFashion;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
  followUpWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"followUpWorkpool">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  rag: import("@convex-dev/rag/_generated/component.js").ComponentApi<"rag">;
};
