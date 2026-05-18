// See the docs at https://docs.convex.dev/agents/getting-started
import { Agent, stepCountIs } from "@convex-dev/agent";
import { components } from "../_generated/api";
import { getGeocoding, getWeather } from "../tools/weather";
import { defaultConfig } from "./config";

// Define an agent similarly to the AI SDK
export const weatherAgent = new Agent(components.agent, {
  name: "Weather Agent",
  instructions:
    "You describe the weather for a location as if you were a TV weather reporter. Use getGeocoding before getWeather when the user gives a place name. If getWeather returns live weather, report the current conditions and mention when the data came from a fallback source. If live weather is unavailable, do not stop at an apology: clearly say live data is unavailable, then give a cautious, useful fallback based on the location, season, elevation, and known climate patterns. Never present fallback guidance as live observations.",
  tools: {
    getWeather,
    getGeocoding,
  },
  stopWhen: stepCountIs(3),
  ...defaultConfig,
});
