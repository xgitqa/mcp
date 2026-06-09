#!/usr/bin/env node

/**
 * Neighborhood Intelligence MCP Server — Europe v3 (100% free, no API keys)
 *
 * Data sources:
 *   OpenStreetMap / Overpass API    amenities, transport, schools, vibe, environment
 *   Nominatim (OSM)                 geocoding + reverse geocoding
 *   Eurostat GISCO API              NUTS3 region lookup (free, no key)
 *   Eurostat Statistics API         regional demographics (free, no key)
 *   Open-Meteo + Copernicus CAMS    air quality — PM2.5, PM10, NO2, O3, EU AQI
 *   Open-Meteo Forecast             temperature, humidity, wind for fire risk
 *   Open-Meteo Elevation (SRTM)     elevation for flood risk assessment
 *
 * All scores 0–255 with semantic description fields.
 */

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

const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function withDistances(elements, lat, lon) {
  return elements.map((el) => {
    const elat = el.lat ?? el.center?.lat;
    const elon = el.lon ?? el.center?.lon;
    if (elat == null) return el;
    return { ...el, distance_m: Math.round(distanceM(lat, lon, elat, elon)) };
  });
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

async function overpass(ql) {
  return fetchJSON("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(ql)}`,
  });
}

// Count elements matching a filter around a point; uses a single Overpass call
async function countAround(filter, lat, lon, radius) {
  const ql = `[out:json][timeout:20];(node${filter}(around:${radius},${lat},${lon});way${filter}(around:${radius},${lat},${lon}););out count;`;
  try {
    const r = await overpass(ql);
    return r.elements?.[0]?.tags?.total ?? 0;
  } catch {
    return 0;
  }
}

// Fetch multiple counts in parallel with a shared Overpass query (cheaper)
async function countMultiple(filters, lat, lon, radius) {
  const parts = filters
    .map(([key, f]) => `node${f}(around:${radius},${lat},${lon});\nway${f}(around:${radius},${lat},${lon});`)
    .join("\n");
  const ql = `[out:json][timeout:30];\n(\n${parts}\n);\nout center tags;`;
  try {
    const r = await overpass(ql);
    const els = withDistances(r.elements ?? [], lat, lon);
    const result = {};
    for (const [key, f] of filters) result[key] = 0;
    for (const el of els) {
      for (const [key, f] of filters) {
        // tag matching heuristic — just count all if single-filter pass
      }
    }
    return { elements: els, total: els.length };
  } catch {
    return { elements: [], total: 0 };
  }
}

// Score label for quality scales (higher = better)
function qualityLabel(score) {
  if (score >= 215) return "Excellent";
  if (score >= 170) return "Very Good";
  if (score >= 130) return "Good";
  if (score >= 90)  return "Fair";
  if (score >= 50)  return "Below Average";
  return "Poor";
}

// Score label for risk scales (255 = safest)
function riskSafetyLabel(score) {
  if (score >= 215) return "Minimal Risk";
  if (score >= 170) return "Low Risk";
  if (score >= 130) return "Low-Moderate Risk";
  if (score >= 90)  return "Moderate Risk";
  if (score >= 50)  return "High Risk";
  return "Very High Risk";
}

function urbanRuralLabel(score) {
  if (score <= 40)  return "Dense Urban Core";
  if (score <= 80)  return "Urban";
  if (score <= 130) return "Urban-Suburban";
  if (score <= 180) return "Suburban";
  if (score <= 220) return "Semi-Rural";
  return "Rural";
}

function scoreObj(score, description) {
  return { score, score_max: 255, description };
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA FETCHERS
// ═══════════════════════════════════════════════════════════════════════════

async function nominatimGeocode(query) {
  await sleep(1100); // Nominatim usage policy: 1 req/s
  return fetchJSON(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`,
    { headers: { "User-Agent": "NeighborhoodIntelligence-MCP/3.0 (open-source)" } }
  );
}

async function nominatimReverse(lat, lon) {
  await sleep(1100);
  return fetchJSON(
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&zoom=10`,
    { headers: { "User-Agent": "NeighborhoodIntelligence-MCP/3.0 (open-source)" } }
  );
}

async function getNutsCode(lat, lon) {
  // GISCO uses GeoJSON [lon, lat] order
  const geom = encodeURIComponent(JSON.stringify({ type: "Point", coordinates: [lon, lat] }));
  try {
    const r = await fetchJSON(
      `https://gisco-services.ec.europa.eu/api/?operation=CONTAINS&f=json&sr=4326&geometry=${geom}&layer=nutsrg&scale=03M&year=2021`
    );
    // Find NUTS3 (5-char code), fall back to NUTS2 (4-char), then NUTS1
    const features = r.features ?? r.results ?? [];
    const nuts3 = features.find((f) => (f.properties?.NUTS_ID ?? f.attributes?.NUTS_ID ?? "").length === 5);
    const nuts2 = features.find((f) => (f.properties?.NUTS_ID ?? f.attributes?.NUTS_ID ?? "").length === 4);
    const best = nuts3 ?? nuts2 ?? features[0];
    if (!best) return null;
    const code = best.properties?.NUTS_ID ?? best.attributes?.NUTS_ID ?? null;
    const name = best.properties?.NUTS_NAME ?? best.attributes?.NUTS_NAME ?? null;
    return { code, name, level: code?.length === 5 ? 3 : code?.length === 4 ? 2 : 1 };
  } catch {
    return null;
  }
}

async function getEurostatData(nutsCode) {
  if (!nutsCode) return null;
  // Population by age group at NUTS3 level
  const url =
    `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/demo_r_pjangrp3` +
    `?format=JSON&geo=${nutsCode}&sex=T&lang=en`;
  try {
    const r = await fetchJSON(url);
    const dims = r.dimension;
    const vals = r.value;
    if (!dims || !vals) return null;

    // Extract age dimension values
    const ageIndex = dims.age?.category?.index ?? {};
    const geoIndex = dims.geo?.category?.index ?? {};
    const geoPos = geoIndex[nutsCode] ?? 0;
    const nAge = Object.keys(ageIndex).length;

    const agePop = {};
    for (const [age, agePos] of Object.entries(ageIndex)) {
      const key = String(geoPos * nAge + agePos);
      agePop[age] = vals[key] ?? 0;
    }

    // Group into young / middle / old
    const young = (agePop["Y_LT5"] ?? 0) + (agePop["Y5-9"] ?? 0) + (agePop["Y10-14"] ?? 0) +
                  (agePop["Y15-19"] ?? 0) + (agePop["Y20-24"] ?? 0) + (agePop["Y25-29"] ?? 0);
    const middle = (agePop["Y30-34"] ?? 0) + (agePop["Y35-39"] ?? 0) + (agePop["Y40-44"] ?? 0) +
                   (agePop["Y45-49"] ?? 0) + (agePop["Y50-54"] ?? 0) + (agePop["Y55-59"] ?? 0);
    const old = (agePop["Y60-64"] ?? 0) + (agePop["Y65-69"] ?? 0) + (agePop["Y70-74"] ?? 0) +
                (agePop["Y75-79"] ?? 0) + (agePop["Y80-84"] ?? 0) + (agePop["Y_GE85"] ?? 0);
    const total = young + middle + old;

    if (total === 0) return null;

    return {
      young_pct: Math.round((young / total) * 100),
      middle_pct: Math.round((middle / total) * 100),
      old_pct: Math.round((old / total) * 100),
      total_population: total,
      nuts_code: nutsCode,
    };
  } catch {
    return null;
  }
}

async function getElevation(lat, lon) {
  try {
    const r = await fetchJSON(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
    return r.elevation?.[0] ?? null;
  } catch {
    return null;
  }
}

async function getAirQualityData(lat, lon) {
  try {
    return fetchJSON(
      `https://air-quality-api.open-meteo.com/v1/air-quality` +
      `?latitude=${lat}&longitude=${lon}` +
      `&current=european_aqi,pm10,pm2_5,nitrogen_dioxide,ozone,sulphur_dioxide,carbon_monoxide` +
      `&timezone=auto`
    );
  } catch {
    return null;
  }
}

async function getWeatherData(lat, lon) {
  try {
    return fetchJSON(
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation` +
      `&daily=precipitation_sum&past_days=14&forecast_days=1&timezone=auto`
    );
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════

// ─── geocode_location ────────────────────────────────────────────────────────

async function geocodeLocation({ query }) {
  const data = await nominatimGeocode(query);
  if (!data?.length) throw new Error(`No geocoding result for: ${query}`);
  const r = data[0];
  const lat = parseFloat(r.lat);
  const lon = parseFloat(r.lon);

  // Enrich with elevation and NUTS region in parallel
  const [elevation, nuts] = await Promise.all([
    getElevation(lat, lon),
    getNutsCode(lat, lon),
  ]);

  return {
    lat,
    lon,
    display_name: r.display_name,
    place_type: r.type,
    address: r.address,
    elevation_m: elevation,
    nuts_region: nuts,
    data_source: "OpenStreetMap Nominatim — © OpenStreetMap contributors; Eurostat GISCO for NUTS region",
  };
}

// ─── get_vibe ─────────────────────────────────────────────────────────────────

async function getVibe({ lat, lon }) {
  // Run all OSM queries in parallel — one big batch query is faster than many small ones
  const radius800 = 800;
  const radius300 = 300;
  const radius1200 = 1200;

  // One composite Overpass query to get all relevant features
  const ql = `[out:json][timeout:45];
(
  node["amenity"~"restaurant|cafe|bar|pub|fast_food|food_court|nightclub|theatre|cinema|arts_centre"](around:${radius800},${lat},${lon});
  node["shop"](around:${radius800},${lat},${lon});
  node["amenity"~"pharmacy|bank|atm|post_office|supermarket"](around:${radius800},${lat},${lon});
  way["shop"](around:${radius800},${lat},${lon});
  node["leisure"~"park|garden|playground|dog_park|fitness_centre|sports_centre"](around:${radius1200},${lat},${lon});
  way["leisure"~"park|garden|nature_reserve|pitch|track"](around:${radius1200},${lat},${lon});
  way["landuse"~"forest|wood|grass|meadow|recreation_ground"](around:${radius1200},${lat},${lon});
  node["natural"~"wood|tree_row|scrub"](around:${radius1200},${lat},${lon});
  way["natural"~"wood|scrub|heath"](around:${radius1200},${lat},${lon});
  node["amenity"~"veterinary"](around:${radius1200},${lat},${lon});
  node["shop"~"pet"](around:${radius1200},${lat},${lon});
  way["highway"~"footway|path|track"](around:${radius1200},${lat},${lon});
  node["tourism"~"museum|gallery|artwork|attraction|viewpoint"](around:${radius800},${lat},${lon});
  node["historic"](around:${radius800},${lat},${lon});
  way["historic"](around:${radius800},${lat},${lon});
  node["waterway"~"river|stream|canal"](around:${radius800},${lat},${lon});
  way["waterway"~"river|stream|canal"](around:${radius800},${lat},${lon});
  way["natural"~"coastline|beach|water"](around:${radius800},${lat},${lon});
  node["landuse"~"industrial|commercial"](around:${radius800},${lat},${lon});
  way["landuse"~"industrial|commercial"](around:${radius800},${lat},${lon});
  node["building"](around:${radius300},${lat},${lon});
  way["building"](around:${radius300},${lat},${lon});
  way["highway"~"motorway|trunk|primary|secondary"](around:${radius800},${lat},${lon});
  way["highway"~"sidewalk|footway"](around:${radius800},${lat},${lon});
  node["crossing"](around:${radius800},${lat},${lon});
);
out center tags;`;

  const res = await overpass(ql);
  const els = withDistances(res.elements ?? [], lat, lon);

  // Classify elements
  const social = els.filter((e) =>
    /restaurant|cafe|bar|pub|nightclub|theatre|cinema|arts_centre|food_court/.test(e.tags?.amenity ?? "")
  );
  const shops = els.filter((e) => e.tags?.shop);
  const services = els.filter((e) =>
    /pharmacy|bank|atm|post_office|supermarket/.test(e.tags?.amenity ?? "")
  );
  const parks = els.filter((e) =>
    /park|garden|nature_reserve|pitch|track/.test(e.tags?.leisure ?? "") ||
    /forest|wood|grass|meadow|recreation_ground/.test(e.tags?.landuse ?? "") ||
    /wood|scrub|heath/.test(e.tags?.natural ?? "")
  );
  const dogParks = els.filter((e) => e.tags?.leisure === "dog_park");
  const vets = els.filter((e) => e.tags?.amenity === "veterinary" || e.tags?.shop === "pet");
  const trails = els.filter((e) => /footway|path|track/.test(e.tags?.highway ?? ""));
  const cultural = els.filter((e) =>
    /museum|gallery|artwork|attraction|viewpoint/.test(e.tags?.tourism ?? "") ||
    e.tags?.historic
  );
  const water = els.filter((e) =>
    /river|stream|canal/.test(e.tags?.waterway ?? "") ||
    /coastline|beach|water/.test(e.tags?.natural ?? "")
  );
  const industrial = els.filter((e) =>
    /industrial/.test(e.tags?.landuse ?? "")
  );
  const buildings = els.filter((e) => e.tags?.building);
  const majorRoads = els.filter((e) =>
    /motorway|trunk|primary|secondary/.test(e.tags?.highway ?? "")
  );
  const sidewalks = els.filter((e) =>
    /sidewalk|footway/.test(e.tags?.highway ?? "")
  );
  const crossings = els.filter((e) => e.tags?.crossing);

  // ── WALKABILITY (0-255) ──────────────────────────────────────────────────
  // Distance-weighted amenity score
  const maxDist = 800;
  let walkRaw = 0;
  const walkWeights = { social: 2.5, shops: 2, services: 3, parks: 1, sidewalks: 1, crossings: 0.5 };
  for (const el of social)   walkRaw += walkWeights.social   * Math.max(0, 1 - (el.distance_m ?? maxDist) / maxDist);
  for (const el of shops)    walkRaw += walkWeights.shops    * Math.max(0, 1 - (el.distance_m ?? maxDist) / maxDist);
  for (const el of services) walkRaw += walkWeights.services * Math.max(0, 1 - (el.distance_m ?? maxDist) / maxDist);
  for (const el of parks)    walkRaw += walkWeights.parks    * Math.max(0, 1 - (el.distance_m ?? maxDist) / maxDist);
  walkRaw += Math.min(sidewalks.length * 2, 40);
  walkRaw += Math.min(crossings.length * 3, 30);
  const walkScore = clamp255(walkRaw * 1.8);
  const walkLabel =
    walkScore >= 215 ? "Walker's Paradise — daily errands require no car." :
    walkScore >= 170 ? "Very Walkable — most errands can be done on foot." :
    walkScore >= 130 ? "Walkable — most daily needs within walking distance." :
    walkScore >= 90  ? "Somewhat Walkable — some errands can be done on foot." :
    walkScore >= 50  ? "Car-Dependent — some walkable amenities exist." :
                       "Almost all errands require a car.";

  // ── PRIVACY (0-255) ──────────────────────────────────────────────────────
  // High score = secluded; penalise density, reward green & distance from roads
  let privRaw = 128;
  const bCount = buildings.length;
  if (bCount > 80) privRaw -= 90;
  else if (bCount > 50) privRaw -= 65;
  else if (bCount > 25) privRaw -= 40;
  else if (bCount > 10) privRaw -= 20;
  // Tree/park cover rewards privacy
  const greenCount = parks.length;
  privRaw += Math.min(greenCount * 4, 60);
  // Major roads near centre reduce privacy
  if (majorRoads.some((r) => (r.distance_m ?? 9999) < 100)) privRaw -= 40;
  else if (majorRoads.some((r) => (r.distance_m ?? 9999) < 300)) privRaw -= 20;
  const privScore = clamp255(privRaw);
  const privLabel =
    privScore >= 200 ? "Very Private — secluded, low visibility from street." :
    privScore >= 155 ? "Fairly Private — lower density with good green buffer." :
    privScore >= 110 ? "Moderate Privacy — typical residential setting." :
    privScore >= 65  ? "Low Privacy — dense urban, high street visibility." :
                       "Very Low Privacy — extremely dense, minimal seclusion.";

  // ── VISUAL APPEAL (0-255) ────────────────────────────────────────────────
  // Proxy: historic buildings, water, green, cultural venues, penalise industrial
  let vaRaw = 110;
  vaRaw += Math.min(cultural.length * 12, 60);
  vaRaw += Math.min(water.length * 18, 50);
  vaRaw += Math.min(greenCount * 5, 40);
  vaRaw -= Math.min(industrial.length * 18, 70);
  vaRaw -= majorRoads.some((r) => (r.distance_m ?? 9999) < 100) ? 20 : 0;
  const vaScore = clamp255(vaRaw);
  const vaLabel =
    vaScore >= 200 ? "Visually Stunning — rich architectural, historic, or natural character." :
    vaScore >= 160 ? "Attractive — pleasant streetscape with notable features." :
    vaScore >= 120 ? "Pleasant — standard residential character with some appeal." :
    vaScore >= 80  ? "Functional — utilitarian; limited aesthetic distinction." :
                     "Low Visual Appeal — industrial or severely degraded streetscape.";

  // ── DOG FRIENDLINESS (0-255) ─────────────────────────────────────────────
  let dogRaw = 0;
  dogRaw += dogParks.length * 60;
  dogRaw += Math.min(parks.filter((e) => e.tags?.leisure === "park").length * 12, 80);
  dogRaw += Math.min(trails.length * 2, 40);
  dogRaw += vets.length * 20;
  const dogScore = clamp255(dogRaw);
  const dogLabel =
    dogScore >= 200 ? "Dog Paradise — dedicated off-leash parks, trails, pet services abundant." :
    dogScore >= 150 ? "Very Dog-Friendly — parks, trails, and pet services nearby." :
    dogScore >= 100 ? "Dog-Friendly — parks and walking routes available." :
    dogScore >= 50  ? "Somewhat Dog-Friendly — limited parks; mainly street walks." :
                      "Not Very Dog-Friendly — few parks or green spaces.";

  // ── URBAN-RURAL (0-255, character scale) ────────────────────────────────
  let urRaw = 128;
  if (bCount > 80) urRaw -= 90;
  else if (bCount > 50) urRaw -= 60;
  else if (bCount > 25) urRaw -= 35;
  else if (bCount > 10) urRaw -= 15;
  if (majorRoads.some((r) => /motorway|trunk/.test(r.tags?.highway ?? ""))) urRaw -= 30;
  if (social.length > 30) urRaw -= 20;
  if (greenCount > 10) urRaw += 50;
  else if (greenCount > 4) urRaw += 25;
  const urScore = clamp255(urRaw);
  const urLabel = urbanRuralLabel(urScore);

  // ── LIVELINESS (0-255) ──────────────────────────────────────────────────
  // Density of social destinations
  const liveRaw = social.length * 5 + Math.min(shops.length, 30) * 1.5 + cultural.length * 8;
  const liveScore = clamp255(liveRaw);
  const liveLabel =
    liveScore >= 200 ? "Highly Vibrant — dense social scene, abundant destinations." :
    liveScore >= 150 ? "Lively — active neighbourhood with good dining and culture." :
    liveScore >= 100 ? "Moderately Lively — reasonable selection of social venues." :
    liveScore >= 55  ? "Quiet Neighbourhood — limited social destinations." :
                       "Very Quiet — minimal social activity nearby.";

  return {
    walkability:   { ...scoreObj(walkScore, walkLabel),    nearby_amenities: social.length + shops.length + services.length },
    privacy:       { ...scoreObj(privScore, privLabel),    building_count_300m: bCount },
    visual_appeal: { ...scoreObj(vaScore, vaLabel),        cultural_features: cultural.length, water_features: water.length },
    dog_friendliness: { ...scoreObj(dogScore, dogLabel),   dog_parks: dogParks.length, parks: parks.length, vets_pet_shops: vets.length },
    urban_rural:   { ...scoreObj(urScore, urLabel),        note: "Character scale — 0=dense urban, 255=rural. Neither extreme is inherently better." },
    liveliness:    { ...scoreObj(liveScore, liveLabel),    social_venues: social.length, cultural_venues: cultural.length },
    data_source: "OpenStreetMap via Overpass API — © OpenStreetMap contributors (ODbL)",
  };
}

// ─── get_environment ──────────────────────────────────────────────────────────

async function getEnvironment({ lat, lon }) {
  // Run OSM noise/industrial query and air quality in parallel
  const noiseQl = `[out:json][timeout:30];
(
  way["highway"~"motorway|trunk|primary|secondary"](around:1000,${lat},${lon});
  way["railway"~"rail|subway|tram"](around:800,${lat},${lon});
  node["aeroway"~"aerodrome|helipad"](around:5000,${lat},${lon});
  way["aeroway"~"runway|taxiway"](around:5000,${lat},${lon});
  node["amenity"~"nightclub"](around:500,${lat},${lon});
  node["landuse"~"industrial"](around:1500,${lat},${lon});
  way["landuse"~"industrial"](around:1500,${lat},${lon});
  node["man_made"~"wastewater_plant|power_station|works|chimney"](around:2000,${lat},${lon});
  way["man_made"~"wastewater_plant|power_station|works"](around:2000,${lat},${lon});
  node["industrial"](around:1500,${lat},${lon});
  way["landuse"~"landfill|quarry|brownfield"](around:2000,${lat},${lon});
);
out center tags;`;

  const [noiseRes, aqData] = await Promise.all([
    overpass(noiseQl).catch(() => ({ elements: [] })),
    getAirQualityData(lat, lon),
  ]);

  const els = withDistances(noiseRes.elements ?? [], lat, lon);

  // Classify
  const motorways = els.filter((e) => e.tags?.highway === "motorway");
  const trunks    = els.filter((e) => e.tags?.highway === "trunk");
  const primaries = els.filter((e) => e.tags?.highway === "primary");
  const secondaries = els.filter((e) => e.tags?.highway === "secondary");
  const railways  = els.filter((e) => e.tags?.railway === "rail");
  const trams     = els.filter((e) => e.tags?.railway === "tram" || e.tags?.railway === "subway");
  const airports  = els.filter((e) => e.tags?.aeroway);
  const nightlife = els.filter((e) => e.tags?.amenity === "nightclub");
  const industrial = els.filter((e) =>
    e.tags?.landuse === "industrial" ||
    e.tags?.industrial ||
    e.tags?.man_made === "works" || e.tags?.man_made === "wastewater_plant" || e.tags?.man_made === "power_station"
  );
  const hazardous = els.filter((e) =>
    /landfill|quarry|brownfield/.test(e.tags?.landuse ?? "") ||
    e.tags?.man_made === "chimney"
  );

  // ── NOISE (0-255, higher = quieter) ─────────────────────────────────────
  let noisePenalty = 0;
  const closestMotorway = Math.min(...motorways.map((e) => e.distance_m ?? 9999), 9999);
  const closestTrunk    = Math.min(...trunks.map((e) => e.distance_m ?? 9999), 9999);
  const closestPrimary  = Math.min(...primaries.map((e) => e.distance_m ?? 9999), 9999);
  const closestRailway  = Math.min(...railways.map((e) => e.distance_m ?? 9999), 9999);
  const closestAirport  = Math.min(...airports.map((e) => e.distance_m ?? 9999), 9999);
  const closestTram     = Math.min(...trams.map((e) => e.distance_m ?? 9999), 9999);

  if (closestMotorway < 500)  noisePenalty += 100 * (1 - closestMotorway / 500);
  if (closestTrunk < 500)     noisePenalty += 70  * (1 - closestTrunk / 500);
  if (closestPrimary < 500)   noisePenalty += 45  * (1 - closestPrimary / 500);
  if (closestRailway < 500)   noisePenalty += 80  * (1 - closestRailway / 500);
  if (closestAirport < 5000)  noisePenalty += 60  * (1 - closestAirport / 5000);
  if (closestTram < 300)      noisePenalty += 30  * (1 - closestTram / 300);
  noisePenalty += Math.min(nightlife.length * 12, 40);
  if (secondaries.some((e) => (e.distance_m ?? 9999) < 200)) noisePenalty += 15;

  const noiseScore = clamp255(255 - noisePenalty * 2.2);
  const noiseLabel =
    noiseScore >= 215 ? "Very Quiet — minimal traffic or rail noise detected." :
    noiseScore >= 170 ? "Fairly Quiet — some ambient road/tram noise; not intrusive." :
    noiseScore >= 130 ? "Moderate Noise — road or rail noise present and noticeable." :
    noiseScore >= 90  ? "Noisy — significant road, rail, or industrial noise." :
    noiseScore >= 50  ? "Very Noisy — multiple major noise sources within close proximity." :
                        "Extremely Noisy — motorway, heavy rail, or airport directly adjacent.";

  const noiseSources = [];
  if (motorways.length) noiseSources.push(`motorway (${Math.round(closestMotorway)}m)`);
  if (trunks.length)    noiseSources.push(`trunk road (${Math.round(closestTrunk)}m)`);
  if (primaries.length) noiseSources.push(`primary road (${Math.round(closestPrimary)}m)`);
  if (railways.length)  noiseSources.push(`railway (${Math.round(closestRailway)}m)`);
  if (trams.length)     noiseSources.push(`tram/metro (${Math.round(closestTram)}m)`);
  if (airports.length)  noiseSources.push(`airport (${Math.round(closestAirport)}m)`);
  if (nightlife.length) noiseSources.push(`${nightlife.length} nightclub(s)`);

  // ── AIR QUALITY (0-255, higher = better) ────────────────────────────────
  const c = aqData?.current ?? {};
  const aqi = c.european_aqi ?? null;
  let aqScore;
  if (aqi == null) {
    aqScore = 128; // unknown
  } else if (aqi <= 20)  aqScore = clamp255(230 + (20 - aqi) * 1.25);
  else if (aqi <= 40)    aqScore = clamp255(170 + (40 - aqi) * 3);
  else if (aqi <= 60)    aqScore = clamp255(110 + (60 - aqi) * 3);
  else if (aqi <= 80)    aqScore = clamp255(55  + (80 - aqi) * 2.75);
  else if (aqi <= 100)   aqScore = clamp255(15  + (100 - aqi) * 2);
  else                   aqScore = clamp255(Math.max(0, 15 - (aqi - 100) * 0.5));

  const aqLabel =
    aqScore >= 215 ? "Excellent — air quality well within all guidelines." :
    aqScore >= 170 ? "Good — air quality meets EU standards; minor pollutants." :
    aqScore >= 130 ? "Fair — acceptable most of the year; occasional moderate pollution." :
    aqScore >= 90  ? "Poor — exceeds WHO guidelines; sensitive groups affected." :
    aqScore >= 50  ? "Very Poor — regular exceedances; health impact likely." :
                     "Hazardous — severe persistent pollution; major health risk.";

  // ── INDUSTRIAL PROXIMITY (0-255, higher = farther from hazards) ─────────
  let indPenalty = 0;
  if (industrial.some((e) => (e.distance_m ?? 9999) < 300)) indPenalty += 120;
  else if (industrial.some((e) => (e.distance_m ?? 9999) < 700)) indPenalty += 80;
  else if (industrial.some((e) => (e.distance_m ?? 9999) < 1500)) indPenalty += 40;
  if (hazardous.some((e) => (e.distance_m ?? 9999) < 500)) indPenalty += 80;
  else if (hazardous.some((e) => (e.distance_m ?? 9999) < 1500)) indPenalty += 40;
  const indScore = clamp255(255 - indPenalty);
  const indLabel =
    indScore >= 215 ? "No industrial or hazardous sites in the immediate area." :
    indScore >= 170 ? "Minor industrial presence within 1.5 km; low impact expected." :
    indScore >= 110 ? "Some industrial activity within 700 m; check specific uses." :
    indScore >= 60  ? "Industrial or waste facilities within 500 m; notable concern." :
                      "Industrial site directly adjacent; significant environmental concern.";

  const closestInd = industrial.sort((a, b) => a.distance_m - b.distance_m)[0];

  return {
    noise: {
      ...scoreObj(noiseScore, noiseLabel),
      sources_identified: noiseSources.length ? noiseSources : ["None identified in OSM data"],
      data_note: "Based on proximity to mapped noise sources. For certified EU noise maps see noise.eionet.europa.eu.",
    },
    air_quality: {
      ...scoreObj(aqScore, aqLabel),
      european_aqi: aqi,
      pm2_5_μg_m3: c.pm2_5 ?? null,
      pm10_μg_m3:  c.pm10 ?? null,
      no2_μg_m3:   c.nitrogen_dioxide ?? null,
      o3_μg_m3:    c.ozone ?? null,
      measurement_time: c.time ?? null,
    },
    industrial_proximity: {
      ...scoreObj(indScore, indLabel),
      industrial_sites_within_2km: industrial.length,
      hazardous_sites_within_2km:  hazardous.length,
      nearest_industrial: closestInd
        ? { name: closestInd.tags?.name ?? "(unnamed)", distance_m: closestInd.distance_m }
        : null,
    },
    data_source: "OpenStreetMap via Overpass API; Open-Meteo / Copernicus CAMS (air quality) — © OpenStreetMap contributors (ODbL)",
  };
}

// ─── get_demographics ─────────────────────────────────────────────────────────

async function getDemographics({ lat, lon }) {
  // NUTS lookup → Eurostat
  const nuts = await getNutsCode(lat, lon);
  const eurostat = nuts ? await getEurostatData(nuts.code) : null;

  // OSM-based economic vitality proxy (run in parallel with Eurostat)
  const econQl = `[out:json][timeout:25];
(
  node["office"](around:1000,${lat},${lon});
  way["office"](around:1000,${lat},${lon});
  node["amenity"~"bank|coworking_space"](around:1000,${lat},${lon});
  node["shop"~"electronics|car|furniture|clothes|jewellery"](around:1000,${lat},${lon});
  node["tourism"~"hotel"](around:1000,${lat},${lon});
  node["amenity"~"restaurant"](around:800,${lat},${lon});
  node["leisure"~"fitness_centre|spa"](around:1000,${lat},${lon});
);
out count;`;

  const econRes = await overpass(econQl).catch(() => ({ elements: [{ tags: { total: 0 } }] }));
  const econCount = econRes.elements?.[0]?.tags?.total ?? 0;

  // Population density proxy from building count
  const bdgQl = `[out:json][timeout:20];(way["building"](around:500,${lat},${lon}););out count;`;
  const bdgRes = await overpass(bdgQl).catch(() => ({ elements: [{ tags: { total: 0 } }] }));
  const buildingCount = bdgRes.elements?.[0]?.tags?.total ?? 0;

  // ── AGE PROFILE (0-255, character scale: 0=young, 255=old) ──────────────
  let ageScore, ageLabel, ageData;
  if (eurostat) {
    // Weighted age profile score
    ageScore = clamp255(
      ((eurostat.middle_pct * 0.5 + eurostat.old_pct * 1.5) / 150) * 255
    );
    ageData = {
      young_under30_pct:  eurostat.young_pct,
      middle_30_59_pct:   eurostat.middle_pct,
      older_60plus_pct:   eurostat.old_pct,
      total_nuts3_population: eurostat.total_population,
      nuts3_region: nuts.code,
      nuts3_name: nuts.name,
    };
  } else {
    ageScore = 128;
    ageData = { note: "Eurostat data unavailable for this location; score is neutral estimate." };
  }
  ageLabel =
    ageScore <= 50  ? "Very Young Area — predominantly under-30 population (student/young professional area)." :
    ageScore <= 100 ? "Young-Skewing — more young adults and families than average." :
    ageScore <= 155 ? "Mixed Age Profile — balanced distribution across all age groups." :
    ageScore <= 200 ? "Mature-Skewing — higher share of middle-aged and older residents." :
                      "Senior-Skewing — predominantly older population; likely retirement area.";

  // ── ECONOMIC VITALITY (0-255, proxy) ───────────────────────────────────
  // Higher = more economic activity / commercial density
  const econScore = clamp255(econCount * 8);
  const econLabel =
    econScore >= 200 ? "High Economic Activity — dense commercial, office, and service sector." :
    econScore >= 150 ? "Active Economy — good mix of businesses and services." :
    econScore >= 100 ? "Moderate Commercial Activity — typical mixed residential/commercial." :
    econScore >= 50  ? "Limited Commercial Activity — mostly residential with local services." :
                       "Very Low Commercial Activity — almost entirely residential.";

  // ── POPULATION DENSITY (0-255, character scale) ──────────────────────────
  let densScore;
  if (buildingCount > 200) densScore = 250;
  else if (buildingCount > 100) densScore = 200;
  else if (buildingCount > 50) densScore = 160;
  else if (buildingCount > 25) densScore = 120;
  else if (buildingCount > 10) densScore = 80;
  else densScore = 40;
  const densLabel =
    densScore >= 220 ? "Very High Density — dense urban, high-rise, or tightly packed housing." :
    densScore >= 170 ? "High Density — urban blocks, apartment buildings." :
    densScore >= 130 ? "Moderate Density — typical mixed urban-residential." :
    densScore >= 90  ? "Low-Moderate Density — suburban residential." :
    densScore >= 50  ? "Low Density — detached housing, large lots." :
                       "Very Low Density — sparse rural or semi-rural.";

  return {
    age_profile: {
      ...scoreObj(ageScore, ageLabel),
      ...ageData,
      note: "Character scale — neither young nor old is inherently better. Reflects NUTS3 regional average, not street-level precision.",
    },
    economic_vitality: {
      ...scoreObj(econScore, econLabel),
      commercial_features_1km: econCount,
      note: "Proxy from OSM commercial/office amenity density. Not an official economic index.",
    },
    population_density: {
      ...scoreObj(densScore, densLabel),
      buildings_within_500m: buildingCount,
      note: "Character scale — density preference is subjective. Based on mapped building count.",
    },
    data_source: "Eurostat Statistics API (demo_r_pjangrp3) for age profile; OpenStreetMap Overpass API for economic and density proxies; Eurostat GISCO for NUTS region lookup.",
  };
}

// ─── get_risk ─────────────────────────────────────────────────────────────────

async function getRisk({ lat, lon }) {
  // Run elevation, waterway OSM, and weather in parallel
  const waterQl = `[out:json][timeout:25];
(
  way["waterway"~"river|stream|canal|drain"](around:2500,${lat},${lon});
  way["natural"~"coastline|water"](around:2500,${lat},${lon});
  relation["natural"="water"](around:2500,${lat},${lon});
  way["landuse"="reservoir"](around:2500,${lat},${lon});
);
out center tags;`;

  const [elevation, waterRes, weather] = await Promise.all([
    getElevation(lat, lon),
    overpass(waterQl).catch(() => ({ elements: [] })),
    getWeatherData(lat, lon),
  ]);

  const waterEls = withDistances(waterRes.elements ?? [], lat, lon).sort(
    (a, b) => (a.distance_m ?? 9999) - (b.distance_m ?? 9999)
  );
  const nearestWaterM = waterEls[0]?.distance_m ?? 9999;
  const isCoastal = waterEls.some((e) => e.tags?.natural === "coastline");

  // ── FLOOD RISK (0-255, higher = safer) ──────────────────────────────────
  let floodBase = 255;
  const elev = elevation ?? 50; // assume moderate elevation if unknown
  if (elev < 0)  floodBase -= 200;
  else if (elev < 2)  floodBase -= 150;
  else if (elev < 5)  floodBase -= 100;
  else if (elev < 10) floodBase -= 60;
  else if (elev < 20) floodBase -= 30;
  else if (elev < 40) floodBase -= 10;

  if (nearestWaterM < 100)  floodBase -= 80;
  else if (nearestWaterM < 300)  floodBase -= 55;
  else if (nearestWaterM < 600)  floodBase -= 35;
  else if (nearestWaterM < 1200) floodBase -= 18;
  else if (nearestWaterM < 2500) floodBase -= 8;

  if (isCoastal) floodBase -= 30;

  const floodScore = clamp255(floodBase);
  const floodLabel = riskSafetyLabel(floodScore);
  const floodDesc =
    `${floodLabel}. Elevation: ${elevation != null ? `${elevation} m` : "unknown"}. ` +
    `Nearest water feature: ${nearestWaterM === 9999 ? "none within 2.5 km" : `${nearestWaterM} m (${waterEls[0]?.tags?.name ?? waterEls[0]?.tags?.waterway ?? "water body"})`}. ` +
    (isCoastal ? "Coastal location — factor in storm surge and sea-level rise. " : "") +
    (floodScore < 130
      ? "Flood insurance and verification of official flood zone maps strongly recommended."
      : floodScore < 170
      ? "Verify municipal flood maps for this parcel before purchase."
      : "Low flood exposure; standard due diligence sufficient.");

  // ── FIRE RISK (0-255, higher = safer) ───────────────────────────────────
  // Angstrom Index: I = (H/20) + ((27-T)/10)
  // < 2.0 = extreme; 2.0-2.5 = high; 2.5-3.0 = moderate; >= 3.0 = low
  const cw = weather?.current ?? {};
  const temp = cw.temperature_2m ?? 15;
  const humid = cw.relative_humidity_2m ?? 70;
  const wind = cw.wind_speed_10m ?? 10;

  // 14-day precipitation sum
  const dailyPrecip = weather?.daily?.precipitation_sum ?? [];
  const recentPrecip14d = dailyPrecip.reduce((s, v) => s + (v ?? 0), 0);

  const angstrom = (humid / 20) + ((27 - temp) / 10);
  let firePenalty = 0;
  if (angstrom < 2.0) firePenalty += 160;
  else if (angstrom < 2.5) firePenalty += 110;
  else if (angstrom < 3.0) firePenalty += 65;
  else if (angstrom < 4.0) firePenalty += 25;

  // Drought modifier (little rain recently)
  if (recentPrecip14d < 5) firePenalty += 40;
  else if (recentPrecip14d < 15) firePenalty += 20;

  // Wind amplifier
  if (wind > 40) firePenalty += 30;
  else if (wind > 25) firePenalty += 15;

  // Vegetation check (forest/scrub nearby increases fuel load)
  const vegQl = `[out:json][timeout:15];(way["landuse"~"forest"](around:500,${lat},${lon});way["natural"~"wood|scrub|heath"](around:500,${lat},${lon}););out count;`;
  const vegRes = await overpass(vegQl).catch(() => ({ elements: [{ tags: { total: 0 } }] }));
  const vegCount = vegRes.elements?.[0]?.tags?.total ?? 0;
  if (vegCount > 5) firePenalty += 25;
  else if (vegCount > 0) firePenalty += 10;

  const fireScore = clamp255(255 - firePenalty);
  const fireLabel = riskSafetyLabel(fireScore);
  const fireDesc =
    `${fireLabel}. Angstrom Fire Index: ${angstrom.toFixed(1)} ` +
    `(temp ${temp}°C, humidity ${humid}%, wind ${wind} km/h). ` +
    `Precipitation last 14 days: ${recentPrecip14d.toFixed(0)} mm. ` +
    `Vegetation within 500 m: ${vegCount > 0 ? `${vegCount} forested/scrub areas (fuel load present)` : "none mapped"}. ` +
    (fireScore < 90
      ? "Current conditions indicate elevated fire danger — relevant for wooded or peri-urban areas."
      : "Fire risk is currently low based on prevailing weather conditions.");

  return {
    flood_risk: {
      ...scoreObj(floodScore, floodDesc),
      elevation_m: elevation,
      nearest_water_m: nearestWaterM === 9999 ? null : nearestWaterM,
      nearest_water_name: waterEls[0]?.tags?.name ?? waterEls[0]?.tags?.waterway ?? null,
      is_coastal: isCoastal,
      water_bodies_within_2_5km: waterEls.slice(0, 6).map((e) => ({
        name: e.tags?.name ?? "(unnamed)",
        type: e.tags?.waterway ?? e.tags?.natural ?? e.tags?.landuse,
        distance_m: e.distance_m,
      })),
      note: "Based on NASA SRTM elevation and OSM waterways. Consult national/municipal flood hazard maps (EU Floods Directive) for legally binding zone classification.",
    },
    fire_risk: {
      ...scoreObj(fireScore, fireDesc),
      angstrom_index: parseFloat(angstrom.toFixed(2)),
      temperature_c: temp,
      relative_humidity_pct: humid,
      wind_speed_kmh: wind,
      precipitation_14d_mm: parseFloat(recentPrecip14d.toFixed(1)),
      vegetation_areas_500m: vegCount,
      note: "Angstrom Fire Weather Index from real-time Open-Meteo data. Assesses current atmospheric fire danger, not long-term structural fire risk. Relevant for peri-urban and forested areas.",
    },
    data_source: "Open-Meteo Elevation API (NASA SRTM); Open-Meteo Forecast API; OpenStreetMap via Overpass API",
  };
}

// ─── get_schools ──────────────────────────────────────────────────────────────

async function getSchools({ lat, lon, radius_m = 2500 }) {
  const ql = `[out:json][timeout:30];
(
  node["amenity"~"school|kindergarten|college|university|music_school|language_school"](around:${radius_m},${lat},${lon});
  way["amenity"~"school|kindergarten|college|university"](around:${radius_m},${lat},${lon});
  relation["amenity"~"school|kindergarten|college|university"](around:${radius_m},${lat},${lon});
);
out center tags;`;

  const res = await overpass(ql);
  const schools = withDistances(res.elements ?? [], lat, lon)
    .sort((a, b) => (a.distance_m ?? 9999) - (b.distance_m ?? 9999))
    .map((e) => ({
      name: e.tags?.name ?? e.tags?.["name:en"] ?? "(unnamed)",
      type: e.tags?.amenity,
      isced_level: e.tags?.["isced:level"] ?? null,
      operator_type: e.tags?.["operator:type"] ?? (e.tags?.operator ? "listed" : null),
      operator: e.tags?.operator ?? null,
      website: e.tags?.website ?? null,
      email: e.tags?.email ?? null,
      phone: e.tags?.phone ?? null,
      min_age: e.tags?.min_age ?? null,
      max_age: e.tags?.max_age ?? null,
      capacity: e.tags?.capacity ?? null,
      distance_m: e.distance_m,
    }));

  const byType = {};
  for (const s of schools) {
    byType[s.type] = (byType[s.type] ?? 0) + 1;
  }

  // Reverse geocode to get administrative district info for the "district" concept
  const adminQl = `[out:json][timeout:20];
(
  relation["boundary"="administrative"]["admin_level"~"8|9|10"](around:100,${lat},${lon});
);
out tags;`;
  const adminRes = await overpass(adminQl).catch(() => ({ elements: [] }));
  const adminArea = adminRes.elements?.[0];

  return {
    total_schools: schools.length,
    schools_by_type: byType,
    schools,
    district: adminArea
      ? {
          name: adminArea.tags?.name ?? adminArea.tags?.["name:en"] ?? "Unknown district",
          admin_level: adminArea.tags?.admin_level,
          population: adminArea.tags?.population ?? null,
          website: adminArea.tags?.website ?? null,
          note: "Administrative boundary from OSM. For official school catchment boundaries contact local education authority.",
        }
      : null,
    ratings_note:
      "OpenStreetMap does not carry official government school performance ratings. " +
      "For official ratings consult national education authority websites: " +
      "UK → Ofsted (reports.ofsted.gov.uk); France → AVIS (education.gouv.fr); " +
      "Germany → KMK state portals; Netherlands → Inspectie (onderwijsinspectie.nl); " +
      "Spain → Consejería de Educación; Bulgaria → МОН (mon.bg / schoolmetrics.bg).",
    data_source: "OpenStreetMap via Overpass API — © OpenStreetMap contributors (ODbL)",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT
// ═══════════════════════════════════════════════════════════════════════════

const PROMPT_TEMPLATE = readFileSync(
  join(__dirname, "../prompts/neighborhood_report.md"),
  "utf8"
);

const PROMPTS = [
  {
    name: "neighborhood_report_europe",
    description:
      "Generate a comprehensive Neighborhood Intelligence report for any European location using free open data. Covers vibe, environment, demographics, risk, schools, and more.",
    arguments: [
      {
        name: "address",
        description: "Address or location to analyse (anywhere in Europe)",
        required: true,
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// TOOL REGISTRY
// ═══════════════════════════════════════════════════════════════════════════

const TOOLS = [
  {
    name: "geocode_location",
    description:
      "Convert a free-text address or place name to coordinates (lat/lon), elevation, and NUTS3 region. " +
      "Built for single-shot agentic use — run this first, then pass the coordinates to all other tools. " +
      "Data source: OpenStreetMap Nominatim + Eurostat GISCO.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Address or place name — works anywhere in Europe.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_vibe",
    description:
      "Neighbourhood feel across six dimensions, all scored 0–255 with descriptions: " +
      "Walkability (sidewalks, intersection density, amenity proximity), " +
      "Privacy (seclusion, density, tree cover, visibility), " +
      "Visual Appeal (architecture, landscaping, streetscape), " +
      "Dog Friendliness (parks, trails, off-leash areas, vets), " +
      "Urban-Rural (dense urban core ↔ open countryside — character scale), " +
      "Liveliness (social destinations density, from quiet enclave to urban hotspot). " +
      "Data source: OpenStreetMap.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Latitude from geocode_location" },
        lon: { type: "number", description: "Longitude from geocode_location" },
      },
      required: ["lat", "lon"],
    },
  },
  {
    name: "get_environment",
    description:
      "Physical environment across three dimensions, all scored 0–255: " +
      "Noise (road, rail, aviation sources — higher = quieter), " +
      "Air Quality (EU AQI, PM2.5, PM10, NO₂, O₃ via Copernicus CAMS — higher = cleaner), " +
      "Industrial Proximity (EPA-equivalent: industrial zones, waste, power plants — higher = farther from hazards). " +
      "Data sources: OpenStreetMap + Open-Meteo/Copernicus CAMS.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
      },
      required: ["lat", "lon"],
    },
  },
  {
    name: "get_demographics",
    description:
      "Population-level indicators for the NUTS3 region containing the address: " +
      "Age Profile (0=very young, 255=very old — character scale, from Eurostat census data), " +
      "Economic Vitality (0–255, commercial/office density proxy), " +
      "Population Density (0=sparse, 255=very dense — character scale). " +
      "Data sources: Eurostat Statistics API (demo_r_pjangrp3) + OpenStreetMap.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
      },
      required: ["lat", "lon"],
    },
  },
  {
    name: "get_risk",
    description:
      "Natural hazard exposure across two dimensions, both scored 0–255 where higher = safer: " +
      "Flood Risk (elevation from NASA SRTM + waterway proximity — coastal to minimal risk), " +
      "Fire Risk (real-time Angstrom Fire Weather Index from temperature, humidity, wind + vegetation fuel load). " +
      "Data sources: Open-Meteo Elevation (SRTM) + Open-Meteo Forecast + OpenStreetMap.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
      },
      required: ["lat", "lon"],
    },
  },
  {
    name: "get_schools",
    description:
      "Find K-12 schools, kindergartens, and universities near a location. " +
      "Returns school list with type, operator, distance, contact details, and administrative district. " +
      "Note: OSM does not carry official government performance ratings — pointers to national rating authorities provided. " +
      "Data source: OpenStreetMap.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
        radius_m: {
          type: "number",
          description: "Search radius in metres (default 2500)",
          default: 2500,
        },
      },
      required: ["lat", "lon"],
    },
  },
];

const TOOL_FNS = {
  geocode_location: geocodeLocation,
  get_vibe:         getVibe,
  get_environment:  getEnvironment,
  get_demographics: getDemographics,
  get_risk:         getRisk,
  get_schools:      getSchools,
};

// ═══════════════════════════════════════════════════════════════════════════
// MCP SERVER
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const server = new Server(
    { name: "neighborhood-intelligence-europe", version: "3.0.0" },
    { capabilities: { tools: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const fn = TOOL_FNS[name];
    if (!fn) throw new Error(`Unknown tool: ${name}`);
    try {
      const result = await fn(args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== "neighborhood_report_europe") throw new Error(`Unknown prompt: ${name}`);
    const address = args?.address ?? "the specified location";
    const text = PROMPT_TEMPLATE.replace(/\{\{\s*address\s*\}\}/g, address);
    return { messages: [{ role: "user", content: { type: "text", text } }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[neighborhood-intel] v3 ready — ${TOOLS.length} tools (0–255 scores), ${PROMPTS.length} prompts · all free, no API key`
  );
}

main().catch((err) => {
  console.error("[neighborhood-intel] Fatal:", err);
  process.exit(1);
});
