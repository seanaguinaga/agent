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
import type * as debugging_spanBuffer from "../debugging/spanBuffer.js";
import type * as debugging_spans from "../debugging/spans.js";
import type * as debugging_tables from "../debugging/tables.js";
import type * as debugging_telemetry from "../debugging/telemetry.js";
import type * as decisions_jev from "../decisions/jev.js";
import type * as easygov_autopilot from "../easygov/autopilot.js";
import type * as easygov_case_agents from "../easygov/case/agents.js";
import type * as easygov_case_answers from "../easygov/case/answers.js";
import type * as easygov_case_data from "../easygov/case/data.js";
import type * as easygov_case_draft from "../easygov/case/draft.js";
import type * as easygov_case_events from "../easygov/case/events.js";
import type * as easygov_case_evidence from "../easygov/case/evidence.js";
import type * as easygov_case_locate from "../easygov/case/locate.js";
import type * as easygov_case_public from "../easygov/case/public.js";
import type * as easygov_case_reading from "../easygov/case/reading.js";
import type * as easygov_case_research from "../easygov/case/research.js";
import type * as easygov_case_selection from "../easygov/case/selection.js";
import type * as easygov_case_state from "../easygov/case/state.js";
import type * as easygov_case_workflow from "../easygov/case/workflow.js";
import type * as easygov_dates from "../easygov/dates.js";
import type * as easygov_decisions from "../easygov/decisions.js";
import type * as easygov_dev from "../easygov/dev.js";
import type * as easygov_evals_cases from "../easygov/evals/cases.js";
import type * as easygov_evals_grading from "../easygov/evals/grading.js";
import type * as easygov_evals_references from "../easygov/evals/references.js";
import type * as easygov_evals_runner from "../easygov/evals/runner.js";
import type * as easygov_evals_tables from "../easygov/evals/tables.js";
import type * as easygov_firms_data from "../easygov/firms/data.js";
import type * as easygov_firms_public from "../easygov/firms/public.js";
import type * as easygov_forms_actions from "../easygov/forms/actions.js";
import type * as easygov_forms_agents from "../easygov/forms/agents.js";
import type * as easygov_forms_browser from "../easygov/forms/browser.js";
import type * as easygov_forms_budget from "../easygov/forms/budget.js";
import type * as easygov_forms_data from "../easygov/forms/data.js";
import type * as easygov_forms_facts from "../easygov/forms/facts.js";
import type * as easygov_forms_governments from "../easygov/forms/governments.js";
import type * as easygov_forms_mapping from "../easygov/forms/mapping.js";
import type * as easygov_forms_open from "../easygov/forms/open.js";
import type * as easygov_forms_pdf from "../easygov/forms/pdf.js";
import type * as easygov_forms_sites from "../easygov/forms/sites.js";
import type * as easygov_forms_sources from "../easygov/forms/sources.js";
import type * as easygov_forms_words from "../easygov/forms/words.js";
import type * as easygov_hash from "../easygov/hash.js";
import type * as easygov_limits from "../easygov/limits.js";
import type * as easygov_operators from "../easygov/operators.js";
import type * as easygov_packs_data from "../easygov/packs/data.js";
import type * as easygov_packs_freshness from "../easygov/packs/freshness.js";
import type * as easygov_packs_public from "../easygov/packs/public.js";
import type * as easygov_profile_agents from "../easygov/profile/agents.js";
import type * as easygov_profile_data from "../easygov/profile/data.js";
import type * as easygov_profile_public from "../easygov/profile/public.js";
import type * as easygov_profile_vocabulary from "../easygov/profile/vocabulary.js";
import type * as easygov_review from "../easygov/review.js";
import type * as easygov_text from "../easygov/text.js";
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
  "debugging/spanBuffer": typeof debugging_spanBuffer;
  "debugging/spans": typeof debugging_spans;
  "debugging/tables": typeof debugging_tables;
  "debugging/telemetry": typeof debugging_telemetry;
  "decisions/jev": typeof decisions_jev;
  "easygov/autopilot": typeof easygov_autopilot;
  "easygov/case/agents": typeof easygov_case_agents;
  "easygov/case/answers": typeof easygov_case_answers;
  "easygov/case/data": typeof easygov_case_data;
  "easygov/case/draft": typeof easygov_case_draft;
  "easygov/case/events": typeof easygov_case_events;
  "easygov/case/evidence": typeof easygov_case_evidence;
  "easygov/case/locate": typeof easygov_case_locate;
  "easygov/case/public": typeof easygov_case_public;
  "easygov/case/reading": typeof easygov_case_reading;
  "easygov/case/research": typeof easygov_case_research;
  "easygov/case/selection": typeof easygov_case_selection;
  "easygov/case/state": typeof easygov_case_state;
  "easygov/case/workflow": typeof easygov_case_workflow;
  "easygov/dates": typeof easygov_dates;
  "easygov/decisions": typeof easygov_decisions;
  "easygov/dev": typeof easygov_dev;
  "easygov/evals/cases": typeof easygov_evals_cases;
  "easygov/evals/grading": typeof easygov_evals_grading;
  "easygov/evals/references": typeof easygov_evals_references;
  "easygov/evals/runner": typeof easygov_evals_runner;
  "easygov/evals/tables": typeof easygov_evals_tables;
  "easygov/firms/data": typeof easygov_firms_data;
  "easygov/firms/public": typeof easygov_firms_public;
  "easygov/forms/actions": typeof easygov_forms_actions;
  "easygov/forms/agents": typeof easygov_forms_agents;
  "easygov/forms/browser": typeof easygov_forms_browser;
  "easygov/forms/budget": typeof easygov_forms_budget;
  "easygov/forms/data": typeof easygov_forms_data;
  "easygov/forms/facts": typeof easygov_forms_facts;
  "easygov/forms/governments": typeof easygov_forms_governments;
  "easygov/forms/mapping": typeof easygov_forms_mapping;
  "easygov/forms/open": typeof easygov_forms_open;
  "easygov/forms/pdf": typeof easygov_forms_pdf;
  "easygov/forms/sites": typeof easygov_forms_sites;
  "easygov/forms/sources": typeof easygov_forms_sources;
  "easygov/forms/words": typeof easygov_forms_words;
  "easygov/hash": typeof easygov_hash;
  "easygov/limits": typeof easygov_limits;
  "easygov/operators": typeof easygov_operators;
  "easygov/packs/data": typeof easygov_packs_data;
  "easygov/packs/freshness": typeof easygov_packs_freshness;
  "easygov/packs/public": typeof easygov_packs_public;
  "easygov/profile/agents": typeof easygov_profile_agents;
  "easygov/profile/data": typeof easygov_profile_data;
  "easygov/profile/public": typeof easygov_profile_public;
  "easygov/profile/vocabulary": typeof easygov_profile_vocabulary;
  "easygov/review": typeof easygov_review;
  "easygov/text": typeof easygov_text;
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
