// See the docs at https://docs.convex.dev/agents/tools
import { tool } from "ai";
import { v } from "convex/values";
import { z } from "zod/v3";

export const vWeatherLookupResult = v.union(
  v.object({
    type: v.literal("live"),
    source: v.union(v.literal("open-meteo"), v.literal("wttr.in")),
    requestedLocation: v.optional(v.string()),
    locationName: v.string(),
    latitude: v.number(),
    longitude: v.number(),
    temperature: v.string(),
    feelsLike: v.string(),
    humidity: v.string(),
    windSpeed: v.string(),
    windGust: v.optional(v.string()),
    description: v.string(),
  }),
  v.object({
    type: v.literal("unavailable"),
    requestedLocation: v.string(),
    locationName: v.optional(v.string()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    reason: v.string(),
    fallbackGuidance: v.string(),
  }),
  v.object({
    type: v.literal("location_not_found"),
    requestedLocation: v.string(),
    reason: v.string(),
  }),
);

export type WeatherLookupResult =
  | {
      type: "live";
      source: "open-meteo" | "wttr.in";
      requestedLocation?: string;
      locationName: string;
      latitude: number;
      longitude: number;
      temperature: string;
      feelsLike: string;
      humidity: string;
      windSpeed: string;
      windGust?: string;
      description: string;
    }
  | {
      type: "unavailable";
      requestedLocation: string;
      locationName?: string;
      latitude?: number;
      longitude?: number;
      reason: string;
      fallbackGuidance: string;
    }
  | {
      type: "location_not_found";
      requestedLocation: string;
      reason: string;
    };

type Fetcher = typeof fetch;

type GeocodingResult =
  | {
      type: "geocoded";
      requestedLocation: string;
      locationName: string;
      latitude: number;
      longitude: number;
    }
  | Extract<WeatherLookupResult, { type: "location_not_found" }>
  | Extract<WeatherLookupResult, { type: "unavailable" }>;

type ProviderWeatherResult =
  | Omit<
      Extract<WeatherLookupResult, { type: "live" }>,
      "requestedLocation" | "locationName" | "latitude" | "longitude"
    >
  | { type: "unavailable"; reason: string }
  | { type: "transient"; reason: string };

export class WeatherLookupRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeatherLookupRetryableError";
  }
}

export const getGeocoding = tool({
  description: "Get the latitude and longitude of a location",
  inputSchema: z.object({
    location: z
      .string()
      .describe("The location to get the geocoding for, e.g. 'San Francisco'"),
  }),
  execute: async ({ location }) => {
    const result = await geocodeLocation(location);
    if (result.type !== "geocoded") {
      return result;
    }
    return {
      latitude: result.latitude,
      longitude: result.longitude,
      name: result.locationName,
    };
  },
});

export const getWeather = tool({
  description: "Get the weather for a location",
  inputSchema: z.object({
    latitude: z.number(),
    longitude: z.number(),
    locationName: z.string().optional(),
  }),
  execute: async (args) => {
    return await lookupWeatherByCoordinates({
      latitude: args.latitude,
      longitude: args.longitude,
      locationName: args.locationName ?? "Requested coordinates",
    });
  },
});

export async function lookupWeatherForLocation(
  location: string,
  fetcher: Fetcher = fetch,
): Promise<WeatherLookupResult> {
  const geocoding = await geocodeLocation(location, fetcher);
  if (geocoding.type !== "geocoded") {
    return geocoding;
  }
  return await lookupWeatherByCoordinates(geocoding, fetcher);
}

export async function lookupWeatherByCoordinates(
  args: {
    requestedLocation?: string;
    locationName: string;
    latitude: number;
    longitude: number;
  },
  fetcher: Fetcher = fetch,
): Promise<WeatherLookupResult> {
  const transientReasons: string[] = [];
  const unavailableReasons: string[] = [];

  const primary = await getOpenMeteoWeather(args, fetcher);
  if (primary.type === "live") {
    return { ...args, ...primary };
  }
  if (primary.type === "transient") {
    transientReasons.push(primary.reason);
  } else {
    unavailableReasons.push(primary.reason);
  }

  const fallback = await getWttrWeather(args, fetcher);
  if (fallback.type === "live") {
    return { ...args, ...fallback };
  }
  if (fallback.type === "transient") {
    transientReasons.push(fallback.reason);
  } else {
    unavailableReasons.push(fallback.reason);
  }

  if (transientReasons.length > 0) {
    throw new WeatherLookupRetryableError(
      `Live weather providers failed transiently: ${transientReasons.join("; ")}`,
    );
  }

  const result: WeatherLookupResult = {
    type: "unavailable",
    requestedLocation: args.requestedLocation ?? args.locationName,
    locationName: args.locationName,
    latitude: args.latitude,
    longitude: args.longitude,
    reason:
      unavailableReasons.join("; ") ||
      "Live weather services are temporarily unavailable.",
    fallbackGuidance:
      "Give a practical fallback answer using the location, season, elevation, and known climate patterns. Clearly say it is not live weather.",
  };
  return result;
}

async function geocodeLocation(
  location: string,
  fetcher: Fetcher = fetch,
): Promise<GeocodingResult> {
  console.log("getting geocoding for location", location);
  try {
    const geocodingUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
    const response = await fetcher(geocodingUrl);
    if (isRetryableStatus(response.status)) {
      throw new WeatherLookupRetryableError(
        `Geocoding request failed with status ${response.status}`,
      );
    }
    if (!response.ok || isRateLimitedStatus(response.status)) {
      return {
        type: "unavailable",
        requestedLocation: location,
        reason: `Geocoding request failed with status ${response.status}`,
        fallbackGuidance:
          "Ask for a more specific location or give conservative regional guidance if enough context is available. Clearly say live weather is unavailable.",
      };
    }

    const data = (await response.json()) as {
      error?: boolean;
      reason?: string;
      results?: {
        latitude: number;
        longitude: number;
        name: string;
      }[];
    };
    if (data.error) {
      if (isRateLimitReason(data.reason)) {
        return {
          type: "unavailable",
          requestedLocation: location,
          reason: data.reason ?? "Geocoding provider rate limit exceeded.",
          fallbackGuidance:
            "Ask for a more specific location or give conservative regional guidance if enough context is available. Clearly say live weather is unavailable.",
        };
      }
      throw new WeatherLookupRetryableError(
        data.reason ?? "Geocoding provider returned an error.",
      );
    }

    const result = data.results?.[0];
    if (!result) {
      return {
        type: "location_not_found",
        requestedLocation: location,
        reason: `Location '${location}' was not found.`,
      };
    }

    console.log(
      "got geocoding for location",
      result.name,
      result.latitude,
      result.longitude,
    );
    return {
      type: "geocoded",
      requestedLocation: location,
      locationName: result.name,
      latitude: result.latitude,
      longitude: result.longitude,
    };
  } catch (error) {
    if (error instanceof WeatherLookupRetryableError) {
      throw error;
    }
    throw new WeatherLookupRetryableError(
      `Geocoding request failed: ${String(error)}`,
    );
  }
}

async function getOpenMeteoWeather(
  args: { latitude: number; longitude: number },
  fetcher: Fetcher,
): Promise<ProviderWeatherResult> {
  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${args.latitude}&longitude=${args.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code&wind_speed_unit=mph&temperature_unit=fahrenheit`;
  try {
    const response = await fetcher(weatherUrl);
    if (isRetryableStatus(response.status)) {
      return {
        type: "transient",
        reason: `Open-Meteo failed with status ${response.status}`,
      };
    }

    let data: {
      error?: boolean;
      reason?: string;
      current?: {
        temperature_2m?: number;
        apparent_temperature?: number;
        relative_humidity_2m?: number;
        wind_speed_10m?: number;
        wind_gusts_10m?: number;
        weather_code?: number;
      };
    };
    try {
      data = (await response.json()) as typeof data;
    } catch (error) {
      return {
        type: "transient",
        reason: `Open-Meteo returned invalid JSON: ${String(error)}`,
      };
    }

    if (!response.ok || data.error) {
      return {
        type: "unavailable",
        reason:
          data.reason ?? `Open-Meteo failed with status ${response.status}`,
      };
    }
    const current = data.current;
    if (
      !current ||
      current.temperature_2m === undefined ||
      current.apparent_temperature === undefined ||
      current.relative_humidity_2m === undefined ||
      current.wind_speed_10m === undefined ||
      current.weather_code === undefined
    ) {
      return {
        type: "transient",
        reason: "Open-Meteo response was missing current conditions",
      };
    }

    const weather: ProviderWeatherResult = {
      type: "live",
      source: "open-meteo",
      temperature: `${current.temperature_2m}°F`,
      feelsLike: `${current.apparent_temperature}°F`,
      humidity: `${current.relative_humidity_2m}%`,
      windSpeed: `${current.wind_speed_10m} mph`,
      description: nameOfWeatherCode(current.weather_code),
    };
    if (current.wind_gusts_10m !== undefined) {
      weather.windGust = `${current.wind_gusts_10m} mph`;
    }
    return weather;
  } catch (error) {
    return {
      type: "transient",
      reason: `Open-Meteo request failed: ${String(error)}`,
    };
  }
}

async function getWttrWeather(
  args: { latitude: number; longitude: number },
  fetcher: Fetcher,
): Promise<ProviderWeatherResult> {
  try {
    const response = await fetcher(
      `https://wttr.in/${args.latitude},${args.longitude}?format=j1`,
    );
    if (isRetryableStatus(response.status)) {
      return {
        type: "transient",
        reason: `wttr.in failed with status ${response.status}`,
      };
    }
    if (!response.ok || isRateLimitedStatus(response.status)) {
      return {
        type: "unavailable",
        reason: `wttr.in failed with status ${response.status}`,
      };
    }

    let data: {
      current_condition?: {
        FeelsLikeF?: string;
        humidity?: string;
        temp_F?: string;
        weatherDesc?: { value?: string }[];
        windspeedMiles?: string;
      }[];
    };
    try {
      data = (await response.json()) as typeof data;
    } catch (error) {
      return {
        type: "transient",
        reason: `wttr.in returned invalid JSON: ${String(error)}`,
      };
    }
    const current = data.current_condition?.[0];
    if (!current?.temp_F) {
      return {
        type: "transient",
        reason: "wttr.in response was missing current conditions",
      };
    }

    return {
      type: "live",
      source: "wttr.in",
      temperature: `${current.temp_F}°F`,
      feelsLike: current.FeelsLikeF ? `${current.FeelsLikeF}°F` : "Unknown",
      humidity: current.humidity ? `${current.humidity}%` : "Unknown",
      windSpeed: current.windspeedMiles
        ? `${current.windspeedMiles} mph`
        : "Unknown",
      windGust: "Unknown",
      description: current.weatherDesc?.[0]?.value ?? "Unknown",
    };
  } catch (error) {
    return {
      type: "transient",
      reason: `wttr.in request failed: ${String(error)}`,
    };
  }
}

function isRetryableStatus(status: number) {
  return status === 408 || status >= 500;
}

function isRateLimitedStatus(status: number) {
  return status === 429;
}

function isRateLimitReason(reason: string | undefined) {
  return /rate limit|request limit|too many requests|quota/i.test(reason ?? "");
}

/**
 * Weather from https://open-meteo.com/en/docs?hourly=temperature_2m,weather_code
 * @param code WMO code
 * @returns text description of the weather
 */
function nameOfWeatherCode(code: number) {
  switch (code) {
    case 0:
      return "Clear";
    case 1:
      return "Mainly clear";
    case 2:
      return "Partly cloudy";
    case 3:
      return "Overcast";
    case 45:
      return "Fog and depositing rime fog";
    case 48:
      return "Fog and depositing rime fog";
    case 51:
      return "Drizzle: Light";
    case 53:
      return "Drizzle: Moderate";
    case 55:
      return "Drizzle: Dense intensity";
    case 56:
      return "Freezing Drizzle: Light and dense intensity";
    case 57:
      return "Freezing Drizzle: Dense intensity";
    case 61:
      return "Light Rain";
    case 63:
      return "Moderate Rain";
    case 65:
      return "Heavy Rain";
    case 66:
      return "Light Freezing Rain";
    case 67:
      return "Heavy Freezing Rain";
    case 71:
      return "Lightly Snow";
    case 73:
      return "Snowing";
    case 75:
      return "Snowing heavily";
    case 77:
      return "Snow grains";
    case 80:
      return "Rain showers: Slight";
    case 81:
      return "Rain showers: Moderate";
    case 82:
      return "Rain showers: Violent";
    case 85:
      return "Snow showers: Slight";
    case 86:
      return "Snow showers: Heavy";
    case 95:
      return "Thunderstorm";
    case 96:
      return "Thunderstorm with light hail";
    case 99:
      return "Thunderstorm with heavy hail";
    default:
      return "Unknown";
  }
}
