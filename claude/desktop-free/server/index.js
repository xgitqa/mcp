#!/usr/bin/env node

/**
 * Neighborhood Intelligence MCP Server — Europe (100% free, no API keys)
 *
 * Data sources:
 *   • OpenStreetMap / Overpass API  — amenities, transport, schools, green space, cycling, safety
 *   • Nominatim (OSM)               — geocoding
 *   • Open-Meteo + Copernicus CAMS  — air quality (PM2.5, PM10, NO2, O3, EU AQI)
 *   • Open-Meteo Elevation (SRTM)   — elevation for flood risk assessment
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

// ─── helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Haversine distance in metres */
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

/** Closest element from elements array, enriched with `distance_m`. */
function withDistances(elements, lat, lon) {
  return elements.map((el) => {
    const elat = el.lat ?? el.center?.lat;
    const elon = el.lon ?? el.center?.lon;
    if (elat == null) return el;
    return { ...el, distance_m: Math.round(distanceM(lat, lon, elat, elon)) };
  });
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/** Overpass QL query → JSON */
async function overpass(ql) {
  return fetchJSON("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(ql)}`,
  });
}

/** Build an around-radius Overpass query for node/way/relation */
function aroundQuery(conditions, lat, lon, radius, extra = "") {
  const nwr = conditions
    .map(
      (c) =>
        `node${c}(around:${radius},${lat},${lon});\n` +
        `way${c}(around:${radius},${lat},${lon});\n`
    )
    .join("");
  return `[out:json][timeout:30];\n(\n${nwr});\nout center tags;${extra}`;
}

// EU AQI thresholds (based on EEA index)
function euAqiLabel(aqi) {
  if (aqi == null) return "Unknown";
  if (aqi <= 20) return "Good";
  if (aqi <= 40) return "Fair";
  if (aqi <= 60) return "Moderate";
  if (aqi <= 80) return "Poor";
  if (aqi <= 100) return "Very Poor";
  return "Extremely Poor";
}

// Flood risk label from elevation + proximity
function floodRiskLabel(elevation, nearestWaterM) {
  if (elevation < 2) return "Very High";
  if (elevation < 5 && nearestWaterM < 300) return "High";
  if (elevation < 10 && nearestWaterM < 500) return "Moderate";
  if (elevation < 20 && nearestWaterM < 1000) return "Low-Moderate";
  return "Low";
}

// ─── tool implementations ────────────────────────────────────────────────────

async function geocodeLocation({ query }) {
  await sleep(1100); // Nominatim usage policy: max 1 req/s
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
    query
  )}&format=json&limit=1&addressdetails=1`;
  const data = await fetchJSON(url, {
    headers: { "User-Agent": "NeighborhoodIntelligence-MCP/2.0 (open-source)" },
  });
  if (!data.length) throw new Error(`No geocoding result for: ${query}`);
  const r = data[0];
  return {
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    display_name: r.display_name,
    place_type: r.type,
    address: r.address,
    data_source: "OpenStreetMap Nominatim — © OpenStreetMap contributors",
  };
}

async function getWalkability({ lat, lon, radius_m = 800 }) {
  const categories = {
    grocery: ['["shop"~"supermarket|convenience|bakery|butcher|greengrocer|deli|farm"]'],
    food_drink: ['["amenity"~"restaurant|cafe|bar|pub|fast_food|food_court"]'],
    services: ['["amenity"~"pharmacy|bank|atm|post_office|laundry|dry_cleaning"]', '["shop"~"hairdresser|beauty|optician|hardware|electronics"]'],
    leisure: ['["leisure"~"fitness_centre|sports_centre|swimming_pool|cinema|theatre"]', '["amenity"~"cinema|theatre|arts_centre|nightclub|library"]'],
    parks: ['["leisure"~"park|garden|playground|pitch"]'],
    transport: ['["highway"="bus_stop"]', '["railway"~"station|tram_stop|halt"]', '["public_transport"="stop_position"]'],
    education: ['["amenity"~"school|kindergarten|college|university"]'],
  };

  const counts = {};
  const nearby = {};
  for (const [cat, filters] of Object.entries(categories)) {
    const ql = aroundQuery(filters, lat, lon, radius_m);
    const res = await overpass(ql);
    const els = withDistances(res.elements, lat, lon);
    counts[cat] = els.length;
    nearby[cat] = els
      .sort((a, b) => (a.distance_m ?? 9999) - (b.distance_m ?? 9999))
      .slice(0, 5)
      .map((e) => ({
        name: e.tags?.name ?? e.tags?.["name:en"] ?? "(unnamed)",
        type: e.tags?.amenity ?? e.tags?.shop ?? e.tags?.leisure ?? e.tags?.highway ?? e.tags?.railway,
        distance_m: e.distance_m,
      }));
  }

  // Walkability score 0-100 (inspired by Walk Score methodology)
  const weights = { grocery: 3, food_drink: 2.5, services: 2, leisure: 1.5, parks: 1.5, transport: 2, education: 1 };
  let raw = 0;
  for (const [cat, w] of Object.entries(weights)) {
    const c = counts[cat] ?? 0;
    raw += w * Math.min(c, 10) * 10; // cap contribution
  }
  const score = Math.min(100, Math.round(raw / 15));

  let description;
  if (score >= 90) description = "Walker's Paradise — daily errands do not require a car.";
  else if (score >= 70) description = "Very Walkable — most errands can be accomplished on foot.";
  else if (score >= 50) description = "Somewhat Walkable — some errands can be done on foot.";
  else if (score >= 25) description = "Car-Dependent — some walkable amenities exist.";
  else description = "Almost all errands require a car.";

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    score,
    score_max: 100,
    description,
    radius_m,
    total_amenities_found: total,
    category_counts: counts,
    nearest_by_category: nearby,
    data_source: "OpenStreetMap via Overpass API — © OpenStreetMap contributors (ODbL)",
  };
}

async function getAirQuality({ lat, lon }) {
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=european_aqi,pm10,pm2_5,nitrogen_dioxide,ozone,sulphur_dioxide,carbon_monoxide,dust,uv_index` +
    `&timezone=auto`;
  const data = await fetchJSON(url);
  const c = data.current ?? {};
  const aqi = c.european_aqi;
  return {
    european_aqi: aqi,
    aqi_label: euAqiLabel(aqi),
    pm2_5_μg_m3: c.pm2_5,
    pm10_μg_m3: c.pm10,
    nitrogen_dioxide_μg_m3: c.nitrogen_dioxide,
    ozone_μg_m3: c.ozone,
    sulphur_dioxide_μg_m3: c.sulphur_dioxide,
    carbon_monoxide_μg_m3: c.carbon_monoxide,
    dust_μg_m3: c.dust,
    uv_index: c.uv_index,
    measurement_time: c.time,
    description: `European AQI: ${aqi ?? "N/A"} (${euAqiLabel(aqi)}). PM2.5: ${c.pm2_5 ?? "N/A"} μg/m³ (WHO guideline: 15 μg/m³/day). PM10: ${c.pm10 ?? "N/A"} μg/m³. NO₂: ${c.nitrogen_dioxide ?? "N/A"} μg/m³. Data updated hourly.`,
    data_source:
      "Open-Meteo Air Quality API — powered by Copernicus Atmosphere Monitoring Service (CAMS) European air quality forecast",
  };
}

async function getPublicTransport({ lat, lon, radius_m = 800 }) {
  const ql = `[out:json][timeout:30];
(
  node["highway"="bus_stop"](around:${radius_m},${lat},${lon});
  node["public_transport"="stop_position"](around:${radius_m},${lat},${lon});
  node["public_transport"="platform"](around:${radius_m},${lat},${lon});
  node["railway"~"station|halt|tram_stop|subway_entrance"](around:${radius_m},${lat},${lon});
  node["amenity"="ferry_terminal"](around:${radius_m},${lat},${lon});
  way["railway"~"station|halt"](around:${radius_m},${lat},${lon});
);
out center tags;`;

  const res = await overpass(ql);
  const els = withDistances(res.elements, lat, lon).sort(
    (a, b) => (a.distance_m ?? 9999) - (b.distance_m ?? 9999)
  );

  const byType = {};
  for (const el of els) {
    const t =
      el.tags?.railway ??
      el.tags?.["public_transport"] ??
      el.tags?.highway ??
      el.tags?.amenity ??
      "stop";
    if (!byType[t]) byType[t] = [];
    byType[t].push({
      name: el.tags?.name ?? el.tags?.["name:en"] ?? "(unnamed)",
      lines: el.tags?.["route_ref"] ?? el.tags?.["ref"] ?? null,
      distance_m: el.distance_m,
    });
  }

  // Score: 0-100 based on number of stops and types
  const stationBonus = (byType.station?.length ?? 0) * 15 + (byType.halt?.length ?? 0) * 10;
  const tramBonus = (byType.tram_stop?.length ?? 0) * 10;
  const subwayBonus = (byType.subway_entrance?.length ?? 0) * 10;
  const busBonus = Math.min((byType.bus_stop?.length ?? 0) * 3, 40);
  const score = Math.min(100, stationBonus + tramBonus + subwayBonus + busBonus);

  let description;
  if (score >= 80) description = "Excellent transit — train/metro/tram served with frequent bus coverage.";
  else if (score >= 60) description = "Good transit — multiple modes available.";
  else if (score >= 40) description = "Adequate transit — bus served; limited rail.";
  else if (score >= 20) description = "Minimal transit — infrequent bus connections.";
  else description = "Very limited public transport access.";

  return {
    score,
    score_max: 100,
    description,
    radius_m,
    total_stops: els.length,
    stops_by_type: byType,
    nearest_stops: els.slice(0, 10).map((e) => ({
      name: e.tags?.name ?? "(unnamed)",
      type: e.tags?.railway ?? e.tags?.["public_transport"] ?? e.tags?.highway ?? e.tags?.amenity,
      distance_m: e.distance_m,
    })),
    data_source: "OpenStreetMap via Overpass API — © OpenStreetMap contributors (ODbL)",
  };
}

async function getSchoolsNearby({ lat, lon, radius_m = 2000 }) {
  const ql = `[out:json][timeout:30];
(
  node["amenity"~"school|kindergarten|college|university|music_school|language_school"](around:${radius_m},${lat},${lon});
  way["amenity"~"school|kindergarten|college|university"](around:${radius_m},${lat},${lon});
  relation["amenity"~"school|kindergarten|college|university"](around:${radius_m},${lat},${lon});
);
out center tags;`;

  const res = await overpass(ql);
  const schools = withDistances(res.elements, lat, lon)
    .sort((a, b) => (a.distance_m ?? 9999) - (b.distance_m ?? 9999))
    .map((e) => ({
      name: e.tags?.name ?? e.tags?.["name:en"] ?? "(unnamed)",
      type: e.tags?.amenity,
      isced_level: e.tags?.["isced:level"] ?? null,
      operator: e.tags?.operator ?? null,
      website: e.tags?.website ?? null,
      distance_m: e.distance_m,
    }));

  const byType = {};
  for (const s of schools) {
    if (!byType[s.type]) byType[s.type] = 0;
    byType[s.type]++;
  }

  return {
    total_schools: schools.length,
    schools_by_type: byType,
    schools,
    note: "OpenStreetMap does not include official government school performance ratings. For official ratings check national education authority websites (e.g., Ofsted in UK, AVIS in France, Schulqualität in Germany).",
    data_source: "OpenStreetMap via Overpass API — © OpenStreetMap contributors (ODbL)",
  };
}

async function getGreenSpaces({ lat, lon, radius_m = 1000 }) {
  const ql = `[out:json][timeout:30];
(
  way["leisure"~"park|garden|nature_reserve|playground|pitch|recreation_ground|dog_park"](around:${radius_m},${lat},${lon});
  node["leisure"~"park|garden|playground"](around:${radius_m},${lat},${lon});
  way["landuse"~"forest|grass|meadow|recreation_ground|allotments"](around:${radius_m},${lat},${lon});
  way["natural"~"wood|scrub|grassland|heath|beach"](around:${radius_m},${lat},${lon});
);
out center tags;`;

  const res = await overpass(ql);
  const spaces = withDistances(res.elements, lat, lon)
    .sort((a, b) => (a.distance_m ?? 9999) - (b.distance_m ?? 9999))
    .map((e) => ({
      name: e.tags?.name ?? e.tags?.["name:en"] ?? "(unnamed)",
      type: e.tags?.leisure ?? e.tags?.landuse ?? e.tags?.natural,
      access: e.tags?.access ?? "public",
      distance_m: e.distance_m,
    }));

  const score = Math.min(100, spaces.length * 8);
  let description;
  if (score >= 80) description = "Excellent green access — abundant parks and nature nearby.";
  else if (score >= 50) description = "Good green access — several parks and green areas within reach.";
  else if (score >= 25) description = "Some green space nearby.";
  else description = "Limited green space in the immediate area.";

  return {
    score,
    score_max: 100,
    description,
    radius_m,
    total_green_spaces: spaces.length,
    green_spaces: spaces.slice(0, 15),
    data_source: "OpenStreetMap via Overpass API — © OpenStreetMap contributors (ODbL)",
  };
}

async function getFloodRisk({ lat, lon }) {
  // 1. Get elevation at location
  const elevUrl = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`;
  const elevData = await fetchJSON(elevUrl);
  const elevation = elevData.elevation?.[0] ?? null;

  // 2. Find nearby water features (rivers, streams, coastline, lakes)
  const waterQl = `[out:json][timeout:20];
(
  way["waterway"~"river|stream|canal|drain"](around:2000,${lat},${lon});
  way["natural"~"coastline|water"](around:2000,${lat},${lon});
  relation["natural"="water"](around:2000,${lat},${lon});
  way["landuse"="reservoir"](around:2000,${lat},${lon});
);
out center tags;`;
  const waterRes = await overpass(waterQl);
  const waterFeatures = withDistances(waterRes.elements, lat, lon).sort(
    (a, b) => (a.distance_m ?? 9999) - (b.distance_m ?? 9999)
  );
  const nearestWaterM =
    waterFeatures.length > 0 ? (waterFeatures[0].distance_m ?? 9999) : 9999;
  const nearestWaterName = waterFeatures[0]?.tags?.name ?? waterFeatures[0]?.tags?.waterway ?? "water body";

  const riskLabel = floodRiskLabel(elevation ?? 999, nearestWaterM);
  const isCoastal = waterFeatures.some((e) => e.tags?.natural === "coastline");

  let advice;
  if (riskLabel === "Very High")
    advice = "Location is at very low elevation — likely in a floodplain or tidal zone. Flood insurance highly recommended. Check local flood maps before purchase.";
  else if (riskLabel === "High")
    advice = "Low elevation combined with nearby water body. Flood risk is material — review local flood zone maps and factor in insurance costs.";
  else if (riskLabel === "Moderate")
    advice = "Moderate flood risk due to proximity to water or low elevation. Check municipal flood maps for this specific parcel.";
  else if (riskLabel === "Low-Moderate")
    advice = "Generally safe but not completely immune — review local drainage infrastructure, especially for extreme weather events.";
  else
    advice = "Low flood risk based on elevation and distance from water bodies.";

  return {
    risk_level: riskLabel,
    elevation_m: elevation,
    nearest_water_feature_m: nearestWaterM === 9999 ? null : nearestWaterM,
    nearest_water_name: nearestWaterM === 9999 ? null : nearestWaterName,
    is_coastal: isCoastal,
    water_features_within_2km: waterFeatures.slice(0, 8).map((e) => ({
      name: e.tags?.name ?? "(unnamed)",
      type: e.tags?.waterway ?? e.tags?.natural ?? e.tags?.landuse,
      distance_m: e.distance_m,
    })),
    description: `Elevation: ${elevation ?? "unknown"} m above sea level. Nearest water feature: ${nearestWaterM === 9999 ? "none within 2km" : `${nearestWaterM}m (${nearestWaterName})`}. Risk level: ${riskLabel}.`,
    advice,
    note: "This assessment uses SRTM elevation data and OSM water features as proxies. For legally binding flood zone classification, consult national/municipal flood maps (e.g., EU Floods Directive Flood Hazard Maps).",
    data_source:
      "Open-Meteo Elevation API (NASA SRTM) + OpenStreetMap waterways via Overpass API",
  };
}

async function getNeighborhoodCharacter({ lat, lon, radius_m = 1000 }) {
  // Affluence and lifestyle proxy indicators
  const categories = {
    fine_dining: ['["amenity"~"restaurant"]["cuisine"!~"fast_food|kebab"]'],
    cafes_independent: ['["amenity"="cafe"]'],
    luxury_retail: ['["shop"~"jewellery|watches|art|antique|gallery|designer|fashion|boutique"]'],
    cultural: ['["amenity"~"theatre|cinema|museum|arts_centre|opera|gallery"]', '["tourism"~"museum|gallery|artwork"]'],
    sports_wellness: ['["leisure"~"fitness_centre|yoga|spa|sauna"]', '["amenity"~"spa|sauna"]'],
    nightlife: ['["amenity"~"bar|pub|nightclub|cocktail_bar"]'],
    supermarkets: ['["shop"~"supermarket|organic|deli|health_food"]'],
    hotels: ['["tourism"~"hotel|boutique_hotel|apartment"]'],
    coworking: ['["amenity"~"coworking_space"]', '["office"="coworking"]'],
    religious: ['["amenity"~"place_of_worship"]'],
    atm_banks: ['["amenity"~"bank|atm"]'],
  };

  const counts = {};
  for (const [cat, filters] of Object.entries(categories)) {
    const ql = aroundQuery(filters, lat, lon, radius_m);
    const res = await overpass(ql);
    counts[cat] = res.elements.length;
  }

  // Affluence score proxy (0-100)
  const affluenceScore = Math.min(
    100,
    Math.round(
      (counts.fine_dining * 4 +
        counts.luxury_retail * 6 +
        counts.cultural * 5 +
        counts.sports_wellness * 4 +
        counts.cafes_independent * 2 +
        counts.hotels * 3) /
        2
    )
  );

  // Vibrancy score
  const vibrancyScore = Math.min(
    100,
    Math.round(
      (counts.cafes_independent * 3 +
        counts.nightlife * 2 +
        counts.cultural * 4 +
        counts.fine_dining * 2 +
        counts.coworking * 3) /
        1.5
    )
  );

  let characterLabel;
  if (affluenceScore >= 70) characterLabel = "Affluent / Upmarket";
  else if (affluenceScore >= 45) characterLabel = "Middle-class / Mixed";
  else if (vibrancyScore >= 60) characterLabel = "Vibrant / Bohemian";
  else characterLabel = "Residential / Neighbourhood-oriented";

  return {
    affluence_score: affluenceScore,
    vibrancy_score: vibrancyScore,
    character_label: characterLabel,
    radius_m,
    indicators: counts,
    description: `Character: ${characterLabel}. Affluence proxy score: ${affluenceScore}/100. Vibrancy score: ${vibrancyScore}/100 based on ${radius_m}m radius amenity distribution.`,
    methodology_note:
      "Affluence and character scores are proxies derived from OSM amenity density (restaurants, luxury retail, cultural venues, wellness). Not a socioeconomic survey — use as one of many indicators.",
    data_source: "OpenStreetMap via Overpass API — © OpenStreetMap contributors (ODbL)",
  };
}

async function getCyclingInfrastructure({ lat, lon, radius_m = 1500 }) {
  const ql = `[out:json][timeout:30];
(
  way["highway"="cycleway"](around:${radius_m},${lat},${lon});
  way["bicycle"~"designated|yes"]["highway"](around:${radius_m},${lat},${lon});
  way["cycleway"~"lane|track|shared_lane"](around:${radius_m},${lat},${lon});
  node["amenity"="bicycle_parking"](around:${radius_m},${lat},${lon});
  node["amenity"="bicycle_rental"](around:${radius_m},${lat},${lon});
  node["amenity"="bicycle_repair_station"](around:${radius_m},${lat},${lon});
  node["shop"="bicycle"](around:${radius_m},${lat},${lon});
);
out center tags;`;

  const res = await overpass(ql);
  const byType = {};
  for (const el of res.elements) {
    const t =
      el.tags?.amenity === "bicycle_parking"
        ? "parking"
        : el.tags?.amenity === "bicycle_rental"
        ? "rental_station"
        : el.tags?.amenity === "bicycle_repair_station"
        ? "repair_station"
        : el.tags?.shop === "bicycle"
        ? "bike_shop"
        : el.tags?.highway === "cycleway"
        ? "dedicated_cycleway"
        : el.tags?.cycleway
        ? `cycleway_${el.tags.cycleway}`
        : "bike_infrastructure";
    if (!byType[t]) byType[t] = 0;
    byType[t]++;
  }

  const infraCount =
    (byType.dedicated_cycleway ?? 0) +
    (byType.cycleway_lane ?? 0) +
    (byType.cycleway_track ?? 0) +
    (byType.cycleway_shared_lane ?? 0);
  const score = Math.min(100, infraCount * 5 + (byType.parking ?? 0) * 2 + (byType.rental_station ?? 0) * 5);

  let description;
  if (score >= 80) description = "Excellent cycling infrastructure — dedicated lanes and bike-friendly roads throughout.";
  else if (score >= 50) description = "Good cycling infrastructure — mix of dedicated lanes and marked routes.";
  else if (score >= 25) description = "Some cycling infrastructure present.";
  else description = "Limited dedicated cycling infrastructure.";

  return {
    score,
    score_max: 100,
    description,
    radius_m,
    infrastructure_by_type: byType,
    total_features: res.elements.length,
    data_source: "OpenStreetMap via Overpass API — © OpenStreetMap contributors (ODbL)",
  };
}

async function getSafetyIndicators({ lat, lon, radius_m = 2000 }) {
  const ql = `[out:json][timeout:30];
(
  node["amenity"="police"](around:${radius_m},${lat},${lon});
  node["amenity"="fire_station"](around:${radius_m},${lat},${lon});
  node["amenity"="hospital"](around:${radius_m},${lat},${lon});
  node["amenity"="ambulance_station"](around:${radius_m},${lat},${lon});
  node["man_made"="surveillance"](around:${radius_m},${lat},${lon});
  way["man_made"="surveillance"](around:${radius_m},${lat},${lon});
  node["amenity"~"police|fire_station|hospital"](around:${radius_m},${lat},${lon});
  way["amenity"~"police|fire_station|hospital"](around:${radius_m},${lat},${lon});
);
out center tags;`;

  const res = await overpass(ql);
  const features = withDistances(res.elements, lat, lon);

  const byType = {
    police: features.filter((e) => e.tags?.amenity === "police"),
    fire_station: features.filter((e) => e.tags?.amenity === "fire_station"),
    hospital: features.filter((e) => e.tags?.amenity === "hospital"),
    ambulance: features.filter((e) => e.tags?.amenity === "ambulance_station"),
    cctv: features.filter((e) => e.tags?.man_made === "surveillance"),
  };

  const nearestPolice = byType.police.sort((a, b) => a.distance_m - b.distance_m)[0];
  const nearestHospital = byType.hospital.sort((a, b) => a.distance_m - b.distance_m)[0];

  const policeScore = nearestPolice
    ? Math.max(0, 100 - Math.round((nearestPolice.distance_m / radius_m) * 60))
    : 10;

  return {
    nearest_police_station: nearestPolice
      ? { name: nearestPolice.tags?.name ?? "Police station", distance_m: nearestPolice.distance_m }
      : null,
    nearest_hospital: nearestHospital
      ? { name: nearestHospital.tags?.name ?? "Hospital", distance_m: nearestHospital.distance_m }
      : null,
    counts: {
      police_stations: byType.police.length,
      fire_stations: byType.fire_station.length,
      hospitals: byType.hospital.length,
      ambulance_stations: byType.ambulance.length,
      surveillance_cameras: byType.cctv.length,
    },
    emergency_services_score: policeScore,
    description: `${byType.police.length} police station(s), ${byType.fire_station.length} fire station(s), ${byType.hospital.length} hospital(s) within ${radius_m}m. ${nearestPolice ? `Nearest police: ${nearestPolice.distance_m}m.` : ""} ${nearestHospital ? `Nearest hospital: ${nearestHospital.distance_m}m.` : ""}`,
    note: "Safety infrastructure presence is an indicator but does not represent actual crime statistics. For crime data, check local police open data portals (e.g., data.police.uk for England/Wales).",
    data_source: "OpenStreetMap via Overpass API — © OpenStreetMap contributors (ODbL)",
  };
}

async function getHealthcareAccess({ lat, lon, radius_m = 2000 }) {
  const ql = `[out:json][timeout:30];
(
  node["amenity"~"hospital|clinic|doctors|dentist|pharmacy|optometrist|veterinary"](around:${radius_m},${lat},${lon});
  way["amenity"~"hospital|clinic"](around:${radius_m},${lat},${lon});
);
out center tags;`;

  const res = await overpass(ql);
  const facilities = withDistances(res.elements, lat, lon)
    .sort((a, b) => (a.distance_m ?? 9999) - (b.distance_m ?? 9999))
    .map((e) => ({
      name: e.tags?.name ?? "(unnamed)",
      type: e.tags?.amenity,
      speciality: e.tags?.["healthcare:speciality"] ?? null,
      wheelchair: e.tags?.wheelchair ?? null,
      distance_m: e.distance_m,
    }));

  const byType = {};
  for (const f of facilities) {
    if (!byType[f.type]) byType[f.type] = 0;
    byType[f.type]++;
  }

  const score = Math.min(
    100,
    (byType.pharmacy ?? 0) * 10 +
      (byType.doctors ?? 0) * 10 +
      (byType.hospital ?? 0) * 20 +
      (byType.clinic ?? 0) * 10 +
      (byType.dentist ?? 0) * 5
  );

  return {
    score,
    score_max: 100,
    total_facilities: facilities.length,
    by_type: byType,
    nearest_facilities: facilities.slice(0, 12),
    description: `${facilities.length} healthcare facilities within ${radius_m}m. ${byType.hospital ? `Hospitals: ${byType.hospital}.` : ""} ${byType.pharmacy ? `Pharmacies: ${byType.pharmacy}.` : ""} ${byType.doctors ? `GP practices: ${byType.doctors}.` : ""}`,
    data_source: "OpenStreetMap via Overpass API — © OpenStreetMap contributors (ODbL)",
  };
}

async function getNoiseSources({ lat, lon, radius_m = 1000 }) {
  const ql = `[out:json][timeout:30];
(
  way["highway"~"motorway|trunk|primary|secondary"](around:${radius_m},${lat},${lon});
  way["railway"~"rail|subway|tram"](around:${radius_m},${lat},${lon});
  node["aeroway"~"aerodrome|helipad"](around:${radius_m},${lat},${lon});
  way["aeroway"~"runway|taxiway"](around:${radius_m},${lat},${lon});
  way["landuse"~"industrial|commercial|retail"](around:${radius_m},${lat},${lon});
  node["amenity"~"nightclub|bar|live_music_venue"](around:${radius_m},${lat},${lon});
  node["industrial"](around:${radius_m},${lat},${lon});
);
out center tags;`;

  const res = await overpass(ql);
  const features = withDistances(res.elements, lat, lon);

  const noiseFactors = {
    motorway: features.filter((e) => e.tags?.highway === "motorway"),
    trunk_road: features.filter((e) => e.tags?.highway === "trunk"),
    primary_road: features.filter((e) => e.tags?.highway === "primary"),
    secondary_road: features.filter((e) => e.tags?.highway === "secondary"),
    railway: features.filter((e) => e.tags?.railway === "rail"),
    tram: features.filter((e) => e.tags?.railway === "tram"),
    airport: features.filter((e) => e.tags?.aeroway),
    industrial: features.filter((e) => e.tags?.landuse === "industrial"),
    nightlife: features.filter((e) => e.tags?.amenity === "nightclub" || e.tags?.amenity === "bar"),
  };

  // Noise risk score (higher = more noise)
  const noiseScore = Math.min(
    100,
    (noiseFactors.motorway.length > 0 ? 40 : 0) +
      (noiseFactors.trunk_road.length > 0 ? 25 : 0) +
      (noiseFactors.primary_road.length > 0 ? 15 : 0) +
      (noiseFactors.railway.length > 0 ? 20 : 0) +
      (noiseFactors.airport.length > 0 ? 30 : 0) +
      (noiseFactors.industrial.length > 0 ? 15 : 0) +
      (noiseFactors.nightlife.length * 3)
  );

  let noiseLabel;
  if (noiseScore >= 70) noiseLabel = "High noise risk";
  else if (noiseScore >= 40) noiseLabel = "Moderate noise risk";
  else if (noiseScore >= 20) noiseLabel = "Some noise sources present";
  else noiseLabel = "Low noise risk";

  const sources = [];
  if (noiseFactors.motorway.length) sources.push(`motorway/highway (${noiseFactors.motorway.length} within ${radius_m}m)`);
  if (noiseFactors.railway.length) sources.push(`railway lines (${noiseFactors.railway.length})`);
  if (noiseFactors.airport.length) sources.push("airport/airfield");
  if (noiseFactors.industrial.length) sources.push(`industrial zones (${noiseFactors.industrial.length})`);
  if (noiseFactors.nightlife.length) sources.push(`nightlife venues (${noiseFactors.nightlife.length})`);
  if (noiseFactors.tram.length) sources.push(`tram lines (${noiseFactors.tram.length})`);

  return {
    noise_risk_score: noiseScore,
    noise_label: noiseLabel,
    description: `${noiseLabel}. ${sources.length ? `Noise sources: ${sources.join("; ")}.` : "No major noise sources identified in OSM data."}`,
    noise_factors: Object.fromEntries(
      Object.entries(noiseFactors).map(([k, v]) => [k, v.length])
    ),
    note: "Noise assessment is based on proximity to known noise sources in OSM. For certified noise maps see the EU Environmental Noise Directive maps at noise.eionet.europa.eu.",
    data_source: "OpenStreetMap via Overpass API — © OpenStreetMap contributors (ODbL)",
  };
}

// ─── prompt ──────────────────────────────────────────────────────────────────

const PROMPT_TEMPLATE = readFileSync(
  join(__dirname, "../prompts/neighborhood_report.md"),
  "utf8"
);

const PROMPTS = [
  {
    name: "neighborhood_report_europe",
    description:
      "Generate a comprehensive Neighborhood Intelligence report for any European location using free open data.",
    arguments: [
      {
        name: "address",
        description: "Address or location to analyse (anywhere in Europe)",
        required: true,
      },
    ],
  },
];

// ─── tool registry ────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "geocode_location",
    description:
      "Geocode an address or place name to coordinates. Works anywhere in Europe. Data source: OpenStreetMap Nominatim.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Address or location to geocode (e.g. '10 Rue de Rivoli, Paris')",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_walkability",
    description:
      "Score walkability (0-100) by counting daily-life amenities within a radius. Data source: OpenStreetMap.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Latitude" },
        lon: { type: "number", description: "Longitude" },
        radius_m: {
          type: "number",
          description: "Search radius in metres (default 800)",
          default: 800,
        },
      },
      required: ["lat", "lon"],
    },
  },
  {
    name: "get_air_quality",
    description:
      "Current air quality: European AQI, PM2.5, PM10, NO₂, O₃. Data source: Open-Meteo / Copernicus CAMS.",
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
    name: "get_public_transport",
    description:
      "Find nearby public transport stops and score transit access (0-100). Data source: OpenStreetMap.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
        radius_m: {
          type: "number",
          description: "Search radius in metres (default 800)",
          default: 800,
        },
      },
      required: ["lat", "lon"],
    },
  },
  {
    name: "get_schools_nearby",
    description:
      "List schools (kindergarten, primary, secondary, university) near a location. Data source: OpenStreetMap.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
        radius_m: {
          type: "number",
          description: "Search radius in metres (default 2000)",
          default: 2000,
        },
      },
      required: ["lat", "lon"],
    },
  },
  {
    name: "get_green_spaces",
    description:
      "Find parks, forests, playgrounds, and nature areas. Returns score 0-100. Data source: OpenStreetMap.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
        radius_m: {
          type: "number",
          description: "Search radius in metres (default 1000)",
          default: 1000,
        },
      },
      required: ["lat", "lon"],
    },
  },
  {
    name: "get_flood_risk",
    description:
      "Assess flood risk from terrain elevation (NASA SRTM) and proximity to waterways. Data sources: Open-Meteo Elevation + OpenStreetMap.",
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
    name: "get_neighborhood_character",
    description:
      "Assess neighborhood character: affluence score, vibrancy score, lifestyle profile from amenity distribution. Data source: OpenStreetMap.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
        radius_m: {
          type: "number",
          description: "Search radius in metres (default 1000)",
          default: 1000,
        },
      },
      required: ["lat", "lon"],
    },
  },
  {
    name: "get_cycling_infrastructure",
    description:
      "Score cycling friendliness (0-100): dedicated lanes, cycle tracks, bike parking and rentals. Data source: OpenStreetMap.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
        radius_m: {
          type: "number",
          description: "Search radius in metres (default 1500)",
          default: 1500,
        },
      },
      required: ["lat", "lon"],
    },
  },
  {
    name: "get_safety_indicators",
    description:
      "Emergency services proximity: police stations, fire stations, hospitals, CCTV. Data source: OpenStreetMap.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
        radius_m: {
          type: "number",
          description: "Search radius in metres (default 2000)",
          default: 2000,
        },
      },
      required: ["lat", "lon"],
    },
  },
  {
    name: "get_healthcare_access",
    description:
      "Find hospitals, clinics, pharmacies, GPs and dentists near a location. Data source: OpenStreetMap.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
        radius_m: {
          type: "number",
          description: "Search radius in metres (default 2000)",
          default: 2000,
        },
      },
      required: ["lat", "lon"],
    },
  },
  {
    name: "get_noise_sources",
    description:
      "Identify noise sources: motorways, railways, airports, industrial zones, nightlife. Returns noise risk score 0-100. Data source: OpenStreetMap.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
        radius_m: {
          type: "number",
          description: "Search radius in metres (default 1000)",
          default: 1000,
        },
      },
      required: ["lat", "lon"],
    },
  },
];

const TOOL_FNS = {
  geocode_location: geocodeLocation,
  get_walkability: getWalkability,
  get_air_quality: getAirQuality,
  get_public_transport: getPublicTransport,
  get_schools_nearby: getSchoolsNearby,
  get_green_spaces: getGreenSpaces,
  get_flood_risk: getFloodRisk,
  get_neighborhood_character: getNeighborhoodCharacter,
  get_cycling_infrastructure: getCyclingInfrastructure,
  get_safety_indicators: getSafetyIndicators,
  get_healthcare_access: getHealthcareAccess,
  get_noise_sources: getNoiseSources,
};

// ─── MCP server ──────────────────────────────────────────────────────────────

async function main() {
  const server = new Server(
    { name: "neighborhood-intelligence-europe", version: "2.0.0" },
    { capabilities: { tools: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const fn = TOOL_FNS[name];
    if (!fn) throw new Error(`Unknown tool: ${name}`);
    try {
      const result = await fn(args ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS,
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== "neighborhood_report_europe")
      throw new Error(`Unknown prompt: ${name}`);
    const address = args?.address ?? "the specified location";
    const text = PROMPT_TEMPLATE.replace(/\{\{\s*address\s*\}\}/g, address);
    return {
      messages: [{ role: "user", content: { type: "text", text } }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[neighborhood-intel] Server ready — ${TOOLS.length} tools, ${PROMPTS.length} prompts (all free, no API key required)`
  );
}

main().catch((err) => {
  console.error("[neighborhood-intel] Fatal:", err);
  process.exit(1);
});
