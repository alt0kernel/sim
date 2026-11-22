# Saarathi Studio 3.0

A redesigned, map-first control room for the Saarathi indoor-shopping research simulator.

**Frontend:** React 19 + Vite + Lucide icons + custom CSS/SVG  
**Backend:** native C++17 REST simulation server (Boost.Beast, Boost.Asio, Boost.JSON)  
**Data:** 42 synthetic SKUs, 12 selectable shelf faces, six configurable store topologies

## What's new: the complete UI redesign

The previous dashboard has been replaced with a new information hierarchy, not simply recolored.

- **Graphite & cobalt visual identity.** Dark mode by default, optional light mode, saved to browser local storage. No green visual accents; cobalt and lavender indicate routes and focus, coral marks unsafe conditions.
- **Map-first overview.** Wide interactive floor plan, the right-hand mission console, compact KPI cards, more legible corridor/rack geometry, route animation, shopper position and selectable shelf faces.
- **Six navigation topologies.** Classic market, Cross-aisle, Perimeter loop, Wide-access, Compact express, Superstore.
- **Four map perspectives.** Floor plan, network, density, sensor coverage. Toggle routes, location labels, racks, dot grid, sensor coverage and obstacles; zoom in/out/reset.
- **Shelf browser.** A directory of all 12 rack faces (six aisles × left/right), with per-rack inventory, prices, remaining stock, quantity choice, shopping-list badges, and basket summary.
- **Physical collection semantics.** Browse any shelf remotely, but add-to-basket only works when the avatar has reached that aisle, is stationary, the item is in stock, and the selected accessibility profile permits it. Use **Walk to shelf** to move to the corresponding aisle.
- **Live research views.** Sensor-fusion gauge and channels, path analysis (Dijkstra/A*/BFS), proximity history, simulated camera/shelf recognition, shopping checklist and activity feed.
- **Navigation controls.** Manual/guided/automatic modes, scan, U-turn, stop, inject/remove obstacle and shortcut navigation. The assistant command field and optional browser TTS/speech recognition remain available.
- **Responsive layout.** Desktop rail and dashboard; compact navigation tabs, stacked workspace and responsive shelf product grid for smaller screens.

## Run the project

Install C++17, CMake >= 3.16, Boost >= 1.81 including Boost.JSON, Node.js >= 20.19, and npm.

On macOS:

```bash
brew install cmake boost node
```

On Ubuntu 24.04 (adjust packages for your environment):

```bash
sudo apt update
sudo apt install build-essential cmake libboost-dev libboost-json-dev nodejs npm
```

From the extracted project folder:

```bash
./start.sh
```

This builds and starts the C++ server, installs frontend packages on first launch, and starts Vite. Open **http://127.0.0.1:5173**.

Or start each process separately:

```bash
# Terminal 1: backend
cmake -S backend -B backend/build -DCMAKE_BUILD_TYPE=Release
cmake --build backend/build -j4
./backend/build/saarathi_server

# Terminal 2: frontend
cd frontend
npm install
npm run dev
```

By default the backend uses **http://127.0.0.1:8787** and Vite proxies `/api` to it. For a single production server, run `npm run build` inside `frontend/` and then start the C++ backend, which serves the frontend `dist/` directory.

## Deploy to Vercel

Import this repository into Vercel and keep the **Root Directory** at the repository root. The root `vercel.json` installs the frontend dependencies, builds the C++ engine as WebAssembly, and publishes `frontend/dist`. The build downloads Emscripten and Boost when they aren't available locally. The deployed app needs no environment variables or separate backend service. Each browser tab runs its own in-memory simulation, and refreshing starts a new session.

To deploy the current working tree from the repository root using the Vercel CLI:

```bash
npx vercel login
npx vercel deploy --prod
```

To preview the same build locally:

```bash
npm ci --prefix frontend
bash scripts/build-vercel.sh
npm --prefix frontend run preview
```

## Workspace guide

| Page | What it does |
| --- | --- |
| Overview | Simulation stats, interactive map, inline shelf browser, mission console and telemetry |
| Map explorer | Four map modes, six layouts, sensor field and routing controls |
| Shelf browser | Select left/right rack, inspect products, walk to a rack, buy list items or extras |
| Vision lab | Synthetic shelf visualizations, confidence estimates and scan results |
| Analytics | Sensor fusion, distance timeline, Dijkstra/A*/BFS comparison, cumulative metrics |
| Activity log | Timestamped simulator events and session export |

The **Configure** button opens store layout, shopping scenario, accessibility profile, lighting, simulation speed, and dynamic-obstacle settings.

### Keyboard shortcuts

`↑ ↓ ← →` steer · `1–9` choose a route option · `Space` walk/pause · `S` scan · `U` U-turn · `O` add/remove obstacle · `R` reset session

### Shelf purchasing

1. Choose a rack in the Overview shelf browser, open the dedicated **Shelf browser** tab, or click an individual **L/R rack** directly on the map.
2. Inspect the rack's actual assigned products. Shopping-list membership and extra items are distinguished visually.
3. Click **Walk to shelf** if you are at another aisle.
4. Once the avatar arrives and is standing still, adjust quantity if desired and click **Add**.
5. Inventory, basket contents and totals are refreshed by the C++ API. Buying a shopping-list goal manually also marks it completed.

### Request an extra product

Type **I want instant coffee** in the Saarathi assistant at the top of the workspace, or select the microphone and say it. The simulator highlights the shortest open route from your current position to the correct aisle and rack. Use **Walk next corridor**, **Start walking**, or the manual direction controls to move when ready. If a name matches several variants, ask again using one of the suggested product names.

At the rack, choose **Add to basket** to collect the extra and return to your pending shopping list. **Resume shopping list** skips the optional stop. The Everyday Essentials list is the default, and the same workflow uses whichever list is active in Configure.

### Find and collect a shopping-list item

Use **Show shortest route** in the mission card, select a route icon next to a pending item, or name the item in the assistant. Follow the highlighted path with the manual walking controls. At the aisle, select **Scan**. A successful scan opens an **Item found** prompt. Choose **Add to basket** to collect it and advance the list, or **Not now** to leave it pending.

## C++ API

- `GET /api/health`: health check
- `GET /api/state`: full simulation snapshot, catalogue/rack data and live metrics
- `POST /api/action`: actions `{ "action": "select_shelf", "value": "Aisle_2_R" }` or `{ "action": "buy", "value": { "sku_id": "...", "quantity": 1 } }`
- `POST /api/action` with `{ "action": "request_product", "value": "instant coffee" }` previews the shortest path to a product. The snapshot reports extra stops in `product_detour`. Use `route_to_goal` to preview the current list item or `resume_list` to leave an extra stop.
- A successful manual `scan` exposes `scan_purchase`. Use `confirm_scan` or `dismiss_scan` with the scanned SKU to respond to the prompt.
- `GET /api/export`: downloadable JSON snapshot and session event log

See `backend/server.cpp` for the full action set. The interface uses regular state polling and fetch-based actions.

## Test the backend

```bash
cmake -S backend -B backend/build -DCMAKE_BUILD_TYPE=Release
cmake --build backend/build -j4
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

The integration tests cover all six maps, route planners and settings, steering, autopilot checkout, inventory and rack visits, and extra-product detours from an aisle or mid-corridor. They also verify obstacle rerouting, list preservation, and product request errors.

## Research accuracy and limitations

This application is a **C++ scenario simulator**, not a bit-for-bit translation of the original research modules. It preserves a reference copy of the supplied Python file in `legacy/voice_sim_original.py`. The catalogue, shelf placement, synthetic sensor noise, computer-vision boxes and confidence scores are demonstration data. They are **not** empirical model predictions, real camera imagery, or outputs from the original PyTorch CAQE, XXAI, DPO or GoG pipeline. The backend's 2.1 engine protocol is intentionally preserved; **Studio 3.0 refers to the redesigned frontend**.

### Build verification in the creation environment

- C++ backend: compiled successfully.
- Backend integration suite: all seven tests passed.
- React JSX: parsed and transpiled successfully with TypeScript syntax tooling.
- CSS: parsed successfully with no errors.
- Layout: visually reviewed at desktop and mobile widths using a static browser-rendered representation of the React markup and live API sample data. Preview screenshots are design references, not a substitute for a full React/Vite test.
- **Not verified here:** a real Vite production build or full React browser integration, because the container cannot resolve `registry.npmjs.org` to install npm dependencies. Run `npm install && npm run build` in your network-enabled environment.

## Project structure

```text
saarathi_studio_aurora/
├── backend/
│   ├── CMakeLists.txt
│   └── server.cpp
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   └── src/
│       ├── main.jsx           # React 3.0 redesign
│       └── studio.css         # dark/light token system, responsive layouts, SVG map
├── data/catalogue.json
├── tests/test_api.py
├── legacy/voice_sim_original.py
├── previews/
└── start.sh
```
