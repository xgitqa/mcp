# Quartiq — European Neighbourhood Intelligence

> Free, open-data MCP server for neighbourhood analysis across Europe

Quartiq connects [Claude](https://claude.ai) to a stack of free, open data sources and delivers instant neighbourhood intelligence for any European address — no account, no API key, no subscription required.

---

## Overview

Quartiq is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that exposes six tools covering every dimension of neighbourhood due diligence: what it feels like to live somewhere, how clean the air is, how safe the area is from flooding or fire, who the neighbours are, and where the nearest schools are.

All scores are on a **0–255 scale** (higher = better, except character scales which are neutral at 128).

---

## Tools

| Tool | What it does | Data source |
|------|-------------|-------------|
| `geocode_location` | Geocode any address to lat/lon | Nominatim / OpenStreetMap |
| `get_vibe` | Walkability, privacy, dog-friendliness, urban-rural character, visual appeal | OpenStreetMap / Overpass API |
| `get_environment` | Air quality (PM2.5, PM10, NO₂, ozone, European AQI), noise estimate, industrial proximity | Open-Meteo + Copernicus CAMS; OpenStreetMap |
| `get_demographics` | NUTS3 regional population and age profile | Eurostat GISCO + Statistics API |
| `get_risk` | Flood safety (elevation + waterways) and fire risk (Angstrom Index) | Open-Meteo Elevation (NASA SRTM) + Forecast; OpenStreetMap |
| `get_schools` | Nearby schools, kindergartens, universities — count and list | OpenStreetMap / Overpass API |

---

## Data Sources

| Source | What it provides | Coverage |
|--------|-----------------|----------|
| [OpenStreetMap](https://www.openstreetmap.org) / [Overpass API](https://overpass-api.de) | Amenities, transport, land use, schools, waterways | Global |
| [Nominatim](https://nominatim.org) | Geocoding (address → lat/lon) | Global |
| [Open-Meteo](https://open-meteo.com) | Elevation (NASA SRTM), weather forecast, air quality (Copernicus CAMS) | Global / EU |
| [Eurostat GISCO](https://gisco-services.ec.europa.eu) | NUTS3 boundaries and regional statistics | EU / EEA |

All data sources are free and open. No API keys are required.

---

## Installation

**Prerequisites:** Node.js 18 or later.

```bash
git clone https://github.com/xgitqa/quartiq.git
cd quartiq
npm install
```

Test that the server starts:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node server/index.js
```

You should see a JSON response listing 6 tools.

---

## Claude Desktop Configuration

Add the following to your Claude Desktop `config.json` (no environment variables needed):

```json
{
  "mcpServers": {
    "quartiq": {
      "command": "node",
      "args": ["/absolute/path/to/quartiq/server/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/quartiq` with the directory where you cloned the repo.

---

## Usage

Once configured, ask Claude to run a neighbourhood report:

```
Use the neighborhood_report prompt for: Marienplatz 1, Munich, Germany
```

Or call tools directly in conversation:

```
Geocode "Vrijdagmarkt 22, Ghent, Belgium" then run get_vibe, get_environment, get_risk, get_schools, and get_demographics
```

### Example report prompt

The built-in `neighborhood_report` prompt walks Claude through all six steps and renders a styled HTML report with score cards, data-source citations, and an advisor's summary.

---

## License

MIT — see [LICENSE](LICENSE).

Data from OpenStreetMap is © OpenStreetMap contributors, licensed under the [Open Database Licence (ODbL)](https://opendatacommons.org/licenses/odbl/).
