import { describe, expect, test } from "vitest";
import {
  lookupWeatherForLocation,
  WeatherLookupRetryableError,
} from "./weather";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchSequence(responses: Response[]): typeof fetch {
  return (async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected fetch call");
    }
    return response;
  }) as typeof fetch;
}

const bogotaGeocoding = {
  results: [{ latitude: 4.60971, longitude: -74.08175, name: "Bogota" }],
};

const openMeteoWeather = {
  current: {
    temperature_2m: 61.2,
    apparent_temperature: 61,
    relative_humidity_2m: 76,
    wind_speed_10m: 3.2,
    wind_gusts_10m: 10.7,
    weather_code: 3,
  },
};

const wttrWeather = {
  current_condition: [
    {
      FeelsLikeF: "65",
      humidity: "68",
      temp_F: "65",
      weatherDesc: [{ value: "Overcast" }],
      windspeedMiles: "3",
    },
  ],
};

describe("lookupWeatherForLocation", () => {
  test("returns live Open-Meteo weather", async () => {
    const weather = await lookupWeatherForLocation(
      "bogota",
      fetchSequence([jsonResponse(bogotaGeocoding), jsonResponse(openMeteoWeather)]),
    );

    expect(weather).toMatchObject({
      type: "live",
      source: "open-meteo",
      locationName: "Bogota",
      temperature: "61.2°F",
      description: "Overcast",
    });
  });

  test("falls back to wttr.in after Open-Meteo rate limit", async () => {
    const weather = await lookupWeatherForLocation(
      "bogota",
      fetchSequence([
        jsonResponse(bogotaGeocoding),
        jsonResponse({
          error: true,
          reason: "Daily API request limit exceeded. Please try again tomorrow.",
        }),
        jsonResponse(wttrWeather),
      ]),
    );

    expect(weather).toMatchObject({
      type: "live",
      source: "wttr.in",
      locationName: "Bogota",
      temperature: "65°F",
      description: "Overcast",
    });
  });

  test("returns unavailable when providers are rate limited", async () => {
    const weather = await lookupWeatherForLocation(
      "bogota",
      fetchSequence([
        jsonResponse(bogotaGeocoding),
        jsonResponse({
          error: true,
          reason: "Daily API request limit exceeded. Please try again tomorrow.",
        }),
        jsonResponse({ error: "rate limited" }, 429),
      ]),
    );

    expect(weather).toMatchObject({
      type: "unavailable",
      requestedLocation: "bogota",
      locationName: "Bogota",
    });
  });

  test("returns location_not_found for unknown locations", async () => {
    const weather = await lookupWeatherForLocation(
      "not a real place",
      fetchSequence([jsonResponse({ results: [] })]),
    );

    expect(weather).toEqual({
      type: "location_not_found",
      requestedLocation: "not a real place",
      reason: "Location 'not a real place' was not found.",
    });
  });

  test("throws retryable errors when all provider failures are transient", async () => {
    await expect(
      lookupWeatherForLocation(
        "bogota",
        fetchSequence([
          jsonResponse(bogotaGeocoding),
          jsonResponse({ error: "temporary" }, 503),
          jsonResponse({ error: "temporary" }, 502),
        ]),
      ),
    ).rejects.toBeInstanceOf(WeatherLookupRetryableError);
  });
});
