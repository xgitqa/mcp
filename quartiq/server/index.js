#!/usr/bin/env node
// quartiq — free European neighbourhood intelligence MCP server
// Data: OpenStreetMap/Overpass, Nominatim, Open-Meteo, Eurostat GISCO
// No API key required.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const USER_AGENT = "quartiq/1.0.0 (https://github.com/xgitqa/quartiq)";

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, ...options.headers },
    ...options,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function overpassQuery(query) {
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return res.json();
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function qualLabel(score) {
  if (score >= 200) return "very high";
  if (score >= 160) return "high";
  if (score >= 100) return "moderate";
  if (score >= 60) return "low";
  return "very low";
}

// ── Tool: geocode_location ────────────────────────────────────────────────────

async function geocodeLocation({ address }) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&addressdetails=1`;
  const results = await fetchJson(url);
  if (!results.length) throw new Error(`No geocoding results for: ${address}`);
  const r = results[0];
  const a = r.address || {};
  return {
    latitude: parseFloat(r.lat),
    longitude: parseFloat(r.lon),
    display_name: r.display_name,
    address: {
      house_number: a.house_number ?? null,
      road: a.road ?? null,
      suburb: a.suburb ?? null,
      city: a.city ?? a.town ?? a.village ?? null,
      county: a.county ?? null,
      state: a.state ?? null,
      country: a.country ?? null,
      country_code: a.country_code ?? null,
      postcode: a.postcode ?? null,
    },
    osm_type: r.osm_type,
    osm_id: r.osm_id,
    data_source: "Nominatim / OpenStreetMap contributors (ODbL)",
  };
}

// ── Tool: get_vibe ────────────────────────────────────────────────────────────

async function getVibe({ latitude, longitude, radius = 800 }) {
  const lat = latitude,
    lon = longitude,
    r = radius;

  const q = `
[out:json][timeout:30];
(
  node["amenity"~"^(restaurant|cafe|bar|pub|fast_food|bakery)$"](around:${r},${lat},${lon});
  node["shop"](around:${r},${lat},${lon});
  node["amenity"~"^(supermarket|convenience|marketplace|greengrocer)$"](around:${r},${lat},${lon});
  node["public_transport"](around:${r},${lat},${lon});
  node["amenity"="bus_stop"](around:${r},${lat},${lon});
  node["railway"~"^(station|tram_stop|subway_entrance)$"](around:${r},${lat},${lon});
  way["leisure"~"^(park|garden|playground|nature_reserve)$"](around:${r},${lat},${lon});
  node["leisure"~"^(park|garden|playground)$"](around:${r},${lat},${lon});
  node["amenity"="dog_park"](around:${r},${lat},${lon});
  node["leisure"="dog_park"](around:${r},${lat},${lon});
  way["landuse"~"^(residential|commercial|industrial|retail|farmland|forest|grass|meadow)$"](around:${r},${lat},${lon});
  way["highway"~"^(motorway|trunk|primary)$"](around:${r},${lat},${lon});
);
out tags;`.trim();

  const data = await overpassQuery(q);
  const el = data.elements || [];

  const food = el.filter(
    (e) => e.tags && /^(restaurant|cafe|bar|pub|fast_food|bakery)$/.test(e.tags.amenity)
  ).length;
  const shops = el.filter(
    (e) =>
      e.tags &&
      (e.tags.shop || /^(supermarket|convenience|marketplace|greengrocer)$/.test(e.tags.amenity))
  ).length;
  const transit = el.filter(
    (e) =>
      e.tags &&
      (e.tags.public_transport ||
        e.tags.amenity === "bus_stop" ||
        /^(station|tram_stop|subway_entrance)$/.test(e.tags.railway))
  ).length;
  const parks = el.filter(
    (e) => e.tags && /^(park|garden|playground|nature_reserve)$/.test(e.tags.leisure)
  ).length;
  const dogParks = el.filter(
    (e) => e.tags && (e.tags.amenity === "dog_park" || e.tags.leisure === "dog_park")
  ).length;
  const industrial = el.filter((e) => e.tags && e.tags.landuse === "industrial").length;
  const nature = el.filter(
    (e) => e.tags && /^(farmland|forest|grass|meadow|nature_reserve)$/.test(e.tags.landuse)
  ).length;
  const majorRoads = el.filter(
    (e) => e.tags && /^(motorway|trunk|primary)$/.test(e.tags.highway)
  ).length;

  const walkRaw = food * 2 + shops * 1.5 + transit * 3;
  const walkability = clamp255((walkRaw * 255) / 80);

  const privacyRaw = Math.max(0, 70 - food * 1.5 - shops * 0.8 - transit * 2 - majorRoads * 12);
  const privacy = clamp255((privacyRaw * 255) / 70);

  const dogRaw = parks * 12 + dogParks * 60;
  const dogFriendly = clamp255((dogRaw * 255) / 150);

  const urbanDelta = food * 2 + shops + transit * 3 - nature * 10 - industrial * 5;
  const urbanRural = clamp255(128 + urbanDelta * 2);

  const appealRaw = 45 + parks * 8 + nature * 10 - industrial * 25 - majorRoads * 6;
  const visualAppeal = clamp255((appealRaw * 255) / 85);

  return {
    walkability: {
      score: walkability,
      description: `${qualLabel(walkability)} walkability — ${food} food/drink venues, ${shops} shops, ${transit} transit stops within ${r}m`,
    },
    privacy: {
      score: privacy,
      description: `${qualLabel(privacy)} privacy — ${majorRoads} major roads, ${food + shops} commercial amenities within ${r}m`,
    },
    dog_friendliness: {
      score: dogFriendly,
      description: `${qualLabel(dogFriendly)} dog-friendliness — ${parks} parks/gardens, ${dogParks} dedicated dog parks within ${r}m`,
    },
    urban_rural_character: {
      score: urbanRural,
      description:
        urbanRural >= 168
          ? "urban character"
          : urbanRural <= 88
            ? "rural character"
            : "suburban character",
      note: "Character scale: 0 = rural, 255 = urban — neither extreme is better",
    },
    visual_appeal: {
      score: visualAppeal,
      description: `${qualLabel(visualAppeal)} visual appeal estimate — ${parks + nature} green/natural features, ${industrial} industrial areas within ${r}m`,
      note: "Estimated from green space and land-use data — no photographic analysis",
    },
    radius_m: r,
    data_source: "OpenStreetMap contributors (ODbL) via Overpass API",
  };
}

// ── Tool: get_environment ─────────────────────────────────────────────────────

async function getEnvironment({ latitude, longitude }) {
  const lat = latitude,
    lon = longitude;

  const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=pm10,pm2_5,nitrogen_dioxide,ozone,european_aqi&timezone=auto&forecast_days=1`;
  const aqData = await fetchJson(aqUrl);

  const hours = aqData.hourly || {};
  const now = new Date();
  const currentHour = now.getUTCHours();
  const idx = Math.min(currentHour, (hours.time || []).length - 1);

  const latestAqi = (hours.european_aqi || [])[idx] ?? null;
  const pm25 = (hours.pm2_5 || [])[idx] ?? null;
  const pm10 = (hours.pm10 || [])[idx] ?? null;
  const no2 = (hours.nitrogen_dioxide || [])[idx] ?? null;
  const ozone = (hours.ozone || [])[idx] ?? null;

  const aqScore =
    latestAqi !== null ? clamp255(255 - Math.min(latestAqi, 100) * 2.55) : null;

  const aqDesc =
    latestAqi === null
      ? "unavailable"
      : latestAqi <= 20
        ? "good"
        : latestAqi <= 40
          ? "fair"
          : latestAqi <= 60
            ? "moderate"
            : latestAqi <= 80
              ? "poor"
              : "very poor";

  const noiseQ = `
[out:json][timeout:20];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"](around:300,${lat},${lon});
  way["railway"~"^(rail|subway|light_rail|tram)$"](around:300,${lat},${lon});
);
out count;`.trim();

  const noiseData = await overpassQuery(noiseQ);
  const countEl = (noiseData.elements || []).find((e) => e.type === "count");
  const roadCount = countEl ? parseInt(countEl.tags?.total ?? "0", 10) : 0;
  const noiseScore = clamp255(255 - roadCount * 25);

  const indQ = `
[out:json][timeout:20];
(
  way["landuse"~"^(industrial|brownfield|quarry)$"](around:2000,${lat},${lon});
);
out count;`.trim();

  const indData = await overpassQuery(indQ);
  const indCountEl = (indData.elements || []).find((e) => e.type === "count");
  const indCount = indCountEl ? parseInt(indCountEl.tags?.total ?? "0", 10) : 0;
  const indScore = clamp255(255 - indCount * 40);

  return {
    air_quality: {
      score: aqScore,
      european_aqi: latestAqi,
      pm2_5_ug_m3: pm25,
      pm10_ug_m3: pm10,
      no2_ug_m3: no2,
      ozone_ug_m3: ozone,
      description: `Air quality is ${aqDesc}${latestAqi !== null ? ` (European AQI: ${latestAqi})` : ""}`,
      data_source:
        "Open-Meteo Air Quality API / Copernicus Atmosphere Monitoring Service (CAMS)",
    },
    noise: {
      score: noiseScore,
      road_rail_segments_within_300m: roadCount,
      description: `Noise estimate: ${roadCount} major road/rail segments within 300m`,
      note: "Estimate based on road and rail proximity — no measured noise data",
      data_source: "OpenStreetMap contributors (ODbL) via Overpass API",
    },
    industrial_hazard: {
      score: indScore,
      industrial_areas_within_2km: indCount,
      description:
        indCount === 0
          ? "No industrial land use found within 2km"
          : `${indCount} industrial area(s) within 2km`,
      data_source: "OpenStreetMap contributors (ODbL) via Overpass API",
    },
  };
}

// ── Tool: get_demographics ────────────────────────────────────────────────────

async function getDemographics({ latitude, longitude }) {
  const lat = latitude,
    lon = longitude;

  const nutsUrl = `https://gisco-services.ec.europa.eu/services/gisco/nuts/findNuts?x=${lon}&y=${lat}&year=2021`;
  let nutsCode = null;
  let nutsName = null;

  try {
    const raw = await fetchJson(nutsUrl, { headers: { Accept: "application/json" } });
    const arr = Array.isArray(raw) ? raw : Object.values(raw);
    const nuts3 = arr.find((n) => n?.NUTS_ID?.length === 5 || n?.LEVL_CODE === 3);
    if (nuts3) {
      nutsCode = nuts3.NUTS_ID;
      nutsName = nuts3.NAME_LATN ?? nuts3.NUTS_NAME ?? null;
    }
  } catch (e) {
    console.error("[quartiq] NUTS lookup error:", e.message);
  }

  if (!nutsCode) {
    return {
      nuts3_region: null,
      note: "Eurostat NUTS3 region not found — location may be outside EU/EEA coverage or at sea",
      data_source: "Eurostat GISCO",
    };
  }

  let totalPop = null;
  try {
    const popUrl = `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/demo_r_pjangrp3?geo=${nutsCode}&time=2022&sex=T&age=TOTAL&format=JSON`;
    const popRaw = await fetchJson(popUrl);
    const vals = Object.values(popRaw?.value ?? {});
    if (vals.length) totalPop = Math.round(vals[0]);
  } catch (e) {
    console.error("[quartiq] Population fetch error:", e.message);
  }

  let ageProfile = null;
  try {
    const ageUrl = `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/demo_r_pjangrp3?geo=${nutsCode}&time=2022&sex=T&age=Y_LT15,Y15-64,Y_GE65&format=JSON`;
    const ageRaw = await fetchJson(ageUrl);
    const vals = Object.values(ageRaw?.value ?? {});
    if (vals.length >= 3) {
      const [young, working, elderly] = vals;
      const total = young + working + elderly;
      if (total > 0) {
        ageProfile = {
          under_15_pct: Math.round((young / total) * 100),
          age_15_64_pct: Math.round((working / total) * 100),
          over_65_pct: Math.round((elderly / total) * 100),
        };
      }
    }
  } catch (e) {
    console.error("[quartiq] Age data fetch error:", e.message);
  }

  const ageScore = ageProfile
    ? clamp255(128 + (ageProfile.under_15_pct - ageProfile.over_65_pct) * 2)
    : 128;

  const ageDesc = ageProfile
    ? `${ageProfile.under_15_pct}% under 15, ${ageProfile.age_15_64_pct}% working-age (15–64), ${ageProfile.over_65_pct}% over 65`
    : "Age data unavailable";

  return {
    nuts3_region: { code: nutsCode, name: nutsName },
    population: totalPop !== null ? { total: totalPop, reference_year: 2022 } : null,
    age_profile: {
      score: ageScore,
      description: ageDesc,
      note: "Character scale: higher score = younger population, lower = older — neither is better",
      ...(ageProfile ?? {}),
    },
    data_source:
      "Eurostat GISCO (NUTS boundaries) + Eurostat Statistics API (demo_r_pjangrp3, 2022)",
  };
}

// ── Tool: get_risk ────────────────────────────────────────────────────────────

async function getRisk({ latitude, longitude }) {
  const lat = latitude,
    lon = longitude;

  const elevData = await fetchJson(
    `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`
  );
  const elevation = elevData.elevation?.[0] ?? null;

  const waterQ = `
[out:json][timeout:20];
(
  way["waterway"~"^(river|stream|canal)$"](around:1000,${lat},${lon});
  way["natural"~"^(water|wetland)$"](around:1000,${lat},${lon});
  relation["natural"="water"](around:1000,${lat},${lon});
);
out count;`.trim();

  const waterData = await overpassQuery(waterQ);
  const waterCountEl = (waterData.elements || []).find((e) => e.type === "count");
  const waterFeatures = waterCountEl ? parseInt(waterCountEl.tags?.total ?? "0", 10) : 0;

  let floodScore = 180;
  let floodDesc = "Flood risk assessment unavailable (elevation data missing)";

  if (elevation !== null) {
    const base =
      elevation < 2 ? 25 : elevation < 10 ? 80 : elevation < 50 ? 155 : 220;
    const waterPenalty = waterFeatures * (elevation < 10 ? 10 : 4);
    floodScore = clamp255(base - waterPenalty);
    floodDesc =
      elevation < 2
        ? `High flood risk — very low elevation (${elevation}m ASL), ${waterFeatures} water body/bodies within 1km`
        : elevation < 10
          ? `Elevated flood risk — low elevation (${elevation}m ASL), ${waterFeatures} water body/bodies within 1km`
          : elevation < 50
            ? `Moderate flood risk — elevation ${elevation}m ASL, ${waterFeatures} water body/bodies within 1km`
            : `Low flood risk — elevation ${elevation}m ASL`;
  }

  const fcastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,relativehumidity_2m&forecast_days=1&timezone=auto`;
  const fcastData = await fetchJson(fcastUrl);

  const temps = fcastData.hourly?.temperature_2m ?? [];
  const rhs = fcastData.hourly?.relativehumidity_2m ?? [];

  const T = temps[12] ?? (temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null);
  const RH = rhs[12] ?? (rhs.length ? rhs.reduce((a, b) => a + b, 0) / rhs.length : null);

  let fireScore = 200;
  let fireDesc = "Fire risk assessment unavailable (forecast data missing)";
  let angstrom = null;

  if (T !== null && RH !== null) {
    angstrom = parseFloat(((RH / 20) + ((27 - T) / 10)).toFixed(2));
    fireScore =
      angstrom < 2.0
        ? clamp255(20)
        : angstrom < 2.5
          ? clamp255(60)
          : angstrom < 3.0
            ? clamp255(128)
            : angstrom < 3.5
              ? clamp255(190)
              : clamp255(235);
    const danger =
      angstrom < 2.0
        ? "very high"
        : angstrom < 2.5
          ? "high"
          : angstrom < 3.0
            ? "moderate"
            : angstrom < 3.5
              ? "low"
              : "minimal";
    fireDesc = `${danger.charAt(0).toUpperCase() + danger.slice(1)} fire danger — Angstrom Index ${angstrom} (${T.toFixed(1)}°C, ${RH.toFixed(0)}% RH)`;
  }

  return {
    elevation_m: elevation,
    flood_safety: {
      score: floodScore,
      water_bodies_within_1km: waterFeatures,
      description: floodDesc,
      note: "Higher score = safer. Based on terrain elevation and waterway proximity.",
      data_source:
        "Open-Meteo Elevation API (NASA SRTM) + OpenStreetMap Overpass API (ODbL)",
    },
    fire_risk: {
      score: fireScore,
      angstrom_index: angstrom,
      temperature_c: T !== null ? parseFloat(T.toFixed(1)) : null,
      relative_humidity_pct: RH !== null ? parseFloat(RH.toFixed(1)) : null,
      description: fireDesc,
      note: "Higher score = safer. Angstrom Fire Index from current forecast (RH/20 + (27−T)/10).",
      data_source:
        "Open-Meteo Forecast API (ERA5 reanalysis / Copernicus CAMS)",
    },
  };
}

// ── Tool: get_schools ─────────────────────────────────────────────────────────

async function getSchools({ latitude, longitude, radius = 2000 }) {
  const lat = latitude,
    lon = longitude,
    r = radius;

  const q = `
[out:json][timeout:25];
(
  node["amenity"~"^(school|kindergarten|university|college)$"](around:${r},${lat},${lon});
  way["amenity"~"^(school|kindergarten|university|college)$"](around:${r},${lat},${lon});
  relation["amenity"~"^(school|kindergarten|university|college)$"](around:${r},${lat},${lon});
);
out center tags;`.trim();

  const data = await overpassQuery(q);
  const elements = data.elements || [];

  const schools = elements
    .map((e) => {
      const tags = e.tags || {};
      const eLat = e.lat ?? e.center?.lat ?? null;
      const eLon = e.lon ?? e.center?.lon ?? null;
      const distM =
        eLat !== null && eLon !== null ? haversineM(lat, lon, eLat, eLon) : null;
      return {
        name: tags.name ?? "Unnamed",
        type: tags.amenity,
        operator: tags.operator ?? null,
        website: tags.website ?? tags["contact:website"] ?? null,
        phone: tags["contact:phone"] ?? tags.phone ?? null,
        distance_m: distM,
        distance_km: distM !== null ? parseFloat((distM / 1000).toFixed(2)) : null,
        osm_id: e.id,
      };
    })
    .sort((a, b) => (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity));

  const counts = {
    kindergarten: schools.filter((s) => s.type === "kindergarten").length,
    school: schools.filter((s) => s.type === "school").length,
    university: schools.filter((s) => s.type === "university").length,
    college: schools.filter((s) => s.type === "college").length,
  };

  const densityRaw =
    counts.kindergarten * 20 + counts.school * 30 + counts.university * 20 + counts.college * 15;
  const densityScore = clamp255((densityRaw * 255) / 200);

  return {
    density_score: densityScore,
    description: `${schools.length} educational institutions within ${r}m: ${counts.kindergarten} kindergartens, ${counts.school} schools, ${counts.university} universities, ${counts.college} colleges`,
    counts,
    institutions: schools.slice(0, 25),
    radius_m: r,
    note: "No quality ratings — OpenStreetMap provides locations only, not academic performance data",
    data_source: "OpenStreetMap contributors (ODbL) via Overpass API",
  };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "geocode_location",
    description:
      "Geocode an address or place name to latitude/longitude coordinates using Nominatim (OpenStreetMap). Call this first before any other tool.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address or place name to geocode" },
      },
      required: ["address"],
    },
  },
  {
    name: "get_vibe",
    description:
      "Get neighbourhood vibe scores (0–255): walkability, privacy, dog-friendliness, urban-rural character, visual appeal. Based on OpenStreetMap amenity density within a configurable radius.",
    inputSchema: {
      type: "object",
      properties: {
        latitude: { type: "number", description: "Latitude from geocode_location" },
        longitude: { type: "number", description: "Longitude from geocode_location" },
        radius: {
          type: "number",
          description: "Search radius in metres (default: 800)",
          default: 800,
        },
      },
      required: ["latitude", "longitude"],
    },
  },
  {
    name: "get_environment",
    description:
      "Get environmental quality scores (0–255): air quality (Copernicus CAMS via Open-Meteo), noise level estimate (road/rail proximity), industrial hazard proximity (OpenStreetMap land use).",
    inputSchema: {
      type: "object",
      properties: {
        latitude: { type: "number", description: "Latitude" },
        longitude: { type: "number", description: "Longitude" },
      },
      required: ["latitude", "longitude"],
    },
  },
  {
    name: "get_demographics",
    description:
      "Get regional demographics from Eurostat for the NUTS3 region containing the coordinates: total population and age profile. EU/EEA coverage only.",
    inputSchema: {
      type: "object",
      properties: {
        latitude: { type: "number", description: "Latitude" },
        longitude: { type: "number", description: "Longitude" },
      },
      required: ["latitude", "longitude"],
    },
  },
  {
    name: "get_risk",
    description:
      "Get risk scores (0–255, higher = safer): flood safety based on terrain elevation (NASA SRTM) and waterway proximity, fire risk based on Angstrom Index computed from Open-Meteo forecast.",
    inputSchema: {
      type: "object",
      properties: {
        latitude: { type: "number", description: "Latitude" },
        longitude: { type: "number", description: "Longitude" },
      },
      required: ["latitude", "longitude"],
    },
  },
  {
    name: "get_schools",
    description:
      "Find nearby educational institutions (schools, kindergartens, universities, colleges) from OpenStreetMap within a given radius. Returns a density score (0–255) and a list of institutions sorted by distance.",
    inputSchema: {
      type: "object",
      properties: {
        latitude: { type: "number", description: "Latitude" },
        longitude: { type: "number", description: "Longitude" },
        radius: {
          type: "number",
          description: "Search radius in metres (default: 2000)",
          default: 2000,
        },
      },
      required: ["latitude", "longitude"],
    },
  },
];

// ── Prompt ────────────────────────────────────────────────────────────────────

const PROMPT_TEMPLATE = readFileSync(
  join(__dirname, "../prompts/neighborhood_report.md"),
  "utf8"
);

const PROMPTS = [
  {
    name: "neighborhood_report",
    description:
      "Generate a comprehensive neighbourhood intelligence report for any European address",
    arguments: [
      { name: "address", description: "Address or location to analyse", required: true },
    ],
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const server = new Server(
    { name: "quartiq", version: "1.0.0" },
    { capabilities: { tools: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result;
      switch (name) {
        case "geocode_location":
          result = await geocodeLocation(args);
          break;
        case "get_vibe":
          result = await getVibe(args);
          break;
        case "get_environment":
          result = await getEnvironment(args);
          break;
        case "get_demographics":
          result = await getDemographics(args);
          break;
        case "get_risk":
          result = await getRisk(args);
          break;
        case "get_schools":
          result = await getSchools(args);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== "neighborhood_report") throw new Error(`Unknown prompt: ${name}`);
    const text = PROMPT_TEMPLATE.replace(/\{\{\s*address\s*\}\}/g, args?.address ?? "");
    return {
      description: "Quartiq Neighbourhood Intelligence Report",
      messages: [{ role: "user", content: { type: "text", text } }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[quartiq] Ready — 6 tools, 1 prompt. No API key required.");
}

main().catch((err) => {
  console.error("[quartiq] Fatal:", err);
  process.exit(1);
});
