import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import {
  Deck,
  FlyToInterpolator,
  LightingEffect,
  AmbientLight,
  PointLight,
  type PickingInfo,
  type MapViewState,
} from '@deck.gl/core';
import { BASEMAP, H3TileLayer, VectorTileLayer, colorBins, colorCategories } from '@deck.gl/carto';
import {
  h3QuerySource,
  vectorTableSource,
  createViewportSpatialFilter,
  addFilter,
  removeFilter,
  getApplicableFilters,
  FilterType,
  type Filters,
  type CategoryResponse,
} from '@carto/api-client';
import * as cartoColors from 'cartocolor';
import sources from './data/sources.json';
import { loadCartoSession, scheduleSessionRefresh, HostedAppSessionError, type CartoSession } from './carto-session';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type ViewMode = 'hex' | 'stores';
type Metric = 'revenue' | 'n' | 'size_m2';
type RGB = [number, number, number];

const METRICS: Record<Metric, { title: string; legend: string; format: (v: number) => string; agg: string }> = {
  revenue: { title: 'Revenue', legend: 'Revenue per hexagon', format: (v) => fmtCompactUsd.format(v), agg: 'sum' },
  n: { title: 'Stores', legend: 'Stores per hexagon', format: (v) => fmtInt.format(Math.round(v)), agg: 'count' },
  size_m2: { title: 'Avg. size', legend: 'Average store size per hexagon', format: (v) => `${fmtInt.format(Math.round(v))} m²`, agg: 'avg' },
};

const CATEGORY_COLUMN = 'storetype';
const CATEGORY_OWNER = 'chips';
const TYPE_PALETTE = 'Bold';
// Low → high: deep purple to warm yellow reads as "heat" on Dark Matter.
const HEX_COLORS: RGB[] = ([...(cartoColors.Sunset[7] as string[])].reverse()).map(hexToRgb);
const HEX_COLORS_CSS = HEX_COLORS.map((c) => `rgb(${c.join(',')})`);

const INTRO_VIEW: MapViewState = { longitude: -96.5, latitude: 38.5, zoom: 2.4, pitch: 0, bearing: 0 };
const HOME_VIEW: MapViewState = { longitude: -96.2, latitude: 38.6, zoom: 4.15, pitch: 52, bearing: -18, minZoom: 2, maxZoom: 15.5 };
const ORBIT_DEG_PER_SEC = 1.1;
const ORBIT_RESUME_MS = 4000;
const STORES_FROM_ZOOM = 6.5;
const DEBUG = import.meta.env.DEV || new URLSearchParams(location.search).has('debug');

const lighting = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 1.35 }),
  warm: new PointLight({ color: [255, 190, 110], intensity: 1.6, position: [-118, 44, 900_000] }),
  cool: new PointLight({ color: [90, 200, 255], intensity: 1.1, position: [-72, 28, 700_000] }),
});
const hexMaterial = { ambient: 0.45, diffuse: 0.65, shininess: 48, specularColor: [255, 225, 190] as RGB };

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const loadingEl = $('loading');
const statusText = $('status-text');
const sessionEl = $('session');
const sessionLabel = $('session-label');
const sessionDot = sessionEl.querySelector<HTMLElement>('.dot')!;
const cameraBadge = $('camera-badge');
const cameraLabel = $('camera-label');
const kpiCount = $('kpi-count');
const kpiRevenue = $('kpi-revenue');
const kpiSize = $('kpi-size');
const legendTitle = $('legend-title');
const legendRes = $('legend-res');
const legendRamp = $('legend-ramp');
const legendMin = $('legend-min');
const legendMax = $('legend-max');
const chipsEl = $('chips');
const clearFilterBtn = $<HTMLButtonElement>('clear-filter');
const resInput = $<HTMLInputElement>('res');
const resOut = $<HTMLOutputElement>('res-out');
const heightInput = $<HTMLInputElement>('height');
const heightOut = $<HTMLOutputElement>('height-out');
const cinematicInput = $<HTMLInputElement>('cinematic');
const labelsInput = $<HTMLInputElement>('labels');

const fmtInt = new Intl.NumberFormat('en-US');
const fmtCompactUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const fmtUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function showStatus(html: string, isError = false) {
  loadingEl.classList.remove('hidden');
  loadingEl.classList.toggle('error', isError);
  statusText.classList.toggle('error', isError);
  statusText.innerHTML = html;
}
function hideStatus() {
  loadingEl.classList.add('hidden');
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let session: CartoSession;
const filters: Filters = {};
const state = {
  view: 'hex' as ViewMode,
  metric: 'revenue' as Metric,
  res: Number(resInput.value),
  height: Number(heightInput.value) / 100,
  cinematic: cinematicInput.checked,
  labels: labelsInput.checked,
  selectedTypes: new Set<string>(),
  viewState: { ...INTRO_VIEW } as MapViewState,
  /** Per-metric colour breaks, learnt from the tiles currently loaded. */
  breaks: {} as Partial<Record<Metric, number[]>>,
  /** Per-metric height ceiling (99.5th percentile of the tiles in view). */
  ceiling: {} as Partial<Record<Metric, number>>,
  breaksKey: '',
};
let typeDomain: string[] = [];
let typeColors: string[] = [];
let typeCounts = new Map<string, number>();
let hexSource: ReturnType<typeof h3QuerySource>;
let storesSource: ReturnType<typeof vectorTableSource>;
let deck: Deck;
let map: maplibregl.Map;

// Camera choreography
let interacting = false;
let inTransition = false;
let lastInteraction = 0;
let lastFrame = 0;
let viewportDirty = true;
let kpiAbort: AbortController | undefined;
let kpiTimer: ReturnType<typeof setTimeout> | undefined;

function cartoConfig() {
  return { apiBaseUrl: session.apiBaseUrl, accessToken: session.accessToken, connectionName: sources.connection };
}

function buildSources() {
  hexSource = h3QuerySource({
    ...cartoConfig(),
    sqlQuery: sources.h3Statement,
    aggregationExp: sources.h3AggregationExp,
    aggregationResLevel: state.res,
    filters,
  });
  storesSource = vectorTableSource({
    ...cartoConfig(),
    tableName: sources.table,
    columns: ['cartodb_id', 'storetype', 'address', 'city', 'state', 'revenue', 'size_m2'],
    filters,
  });
}

// ---------------------------------------------------------------------------
// Layers — all from @deck.gl/carto
// ---------------------------------------------------------------------------

function baseHeight() {
  // Columns shrink with the hexagons so finer resolutions do not turn into needles.
  return 130_000 * Math.pow(0.55, state.res - 4) * state.height;
}

function buildLayers() {
  const zoom = state.viewState.zoom;
  const showHex = state.view === 'hex';
  // Columns hand over to the stores between zoom 6.8 and 8.6, so a dive lands among stores, not walls.
  const hexOpacity = showHex ? Math.max(0, Math.min(1, 1 - (zoom - 6.8) / 1.8)) : 0;
  const storesVisible = state.view === 'stores' || zoom >= STORES_FROM_ZOOM;
  const breaks = state.breaks[state.metric];
  const ceiling = state.ceiling[state.metric] ?? (breaks?.at(-1) ?? 1);
  const metric = state.metric;
  const height = baseHeight();

  const fillColor = breaks
    ? colorBins({ attr: metric, domain: breaks, colors: HEX_COLORS, nullColor: [60, 60, 80] })
    : () => HEX_COLORS[2];

  const typeFill = colorCategories({ attr: CATEGORY_COLUMN, domain: typeDomain, colors: TYPE_PALETTE, othersColor: [160, 160, 170] });
  const glowFill = (f: { properties: Record<string, unknown> }): [number, number, number, number] => {
    const c = typeFill(f as never, {} as never) as unknown as number[];
    return [c[0], c[1], c[2], 55];
  };
  const pointRadius = (f: { properties: Record<string, unknown> }) => 2.2 + Math.sqrt(Number(f.properties.revenue ?? 1e6) / 2.1e6) * 5.5;

  return [
    new H3TileLayer({
      id: 'hex-columns',
      data: hexSource,
      visible: showHex && hexOpacity > 0.01 && Boolean(breaks),
      opacity: hexOpacity * 0.92,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 70],
      filled: true,
      extruded: true,
      coverage: 0.9,
      material: hexMaterial,
      getFillColor: fillColor,
      // Square-root curve against a high percentile: dense metros stand out without dwarfing everything else.
      getElevation: (f: { properties: Record<string, number> }) =>
        Math.sqrt(Math.min(Number(f.properties[metric] ?? 0), ceiling * 1.6) / ceiling) * height,
      elevationScale: 1,
      onTileLoad: onHexTileLoaded,
      onViewportLoad: onHexTilesLoaded,
      updateTriggers: { getFillColor: [metric, state.breaksKey], getElevation: [metric, state.breaksKey, height] },
      transitions: { getElevation: 500, getFillColor: 300 },
    }),
    storesVisible && new VectorTileLayer({
      id: 'stores-glow',
      data: storesSource,
      visible: storesVisible,
      pickable: false,
      pointRadiusUnits: 'pixels',
      getPointRadius: (f: { properties: Record<string, unknown> }) => pointRadius(f) * 2.6,
      getFillColor: glowFill,
      stroked: false,
      parameters: { depthCompare: 'always' },
      updateTriggers: { getFillColor: [typeDomain.join('|')] },
    }),
    storesVisible && new VectorTileLayer({
      id: 'stores',
      data: storesSource,
      visible: storesVisible,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 160],
      pointRadiusUnits: 'pixels',
      getPointRadius: pointRadius,
      getFillColor: typeFill,
      stroked: true,
      getLineColor: [7, 10, 16, 220],
      lineWidthMinPixels: 1,
      parameters: { depthCompare: 'always' },
      updateTriggers: { getFillColor: [typeDomain.join('|')] },
    }),
  ];
}

function refreshLayers() {
  deck.setProps({ layers: buildLayers() });
}

/** Values seen in loaded H3 tiles, keyed by tile id, so breaks can be learnt without waiting for every tile. */
const tileValues = new Map<string, Record<Metric, number[]>>();
let breaksTimer: ReturnType<typeof setTimeout> | undefined;

function onHexTileLoaded(tile: { id?: string; index?: unknown; content?: unknown }) {
  const id = String(tile.id ?? JSON.stringify(tile.index));
  const values: Record<Metric, number[]> = { revenue: [], n: [], size_m2: [] };
  const raw = tile.content;
  const cells: { properties?: Record<string, number> }[] = Array.isArray(raw) ? (raw as { properties?: Record<string, number> }[]) : [];
  for (const c of cells) {
    const p = c.properties ?? {};
    for (const m of Object.keys(values) as Metric[]) if (Number.isFinite(p[m])) values[m].push(Number(p[m]));
  }
  tileValues.set(id, values);
  if (tileValues.size > 400) tileValues.delete(tileValues.keys().next().value!);
  if (breaksTimer) clearTimeout(breaksTimer);
  breaksTimer = setTimeout(() => learnBreaks([...tileValues.values()]), 250);
}

/** Learn colour breaks and the height ceiling from every H3 tile seen so far. */
function learnBreaks(pools: Record<Metric, number[]>[]) {
  const values: Record<Metric, number[]> = { revenue: [], n: [], size_m2: [] };
  for (const pool of pools) for (const m of Object.keys(values) as Metric[]) values[m].push(...pool[m]);
  if (DEBUG) console.info('[hex] learnBreaks from', pools.length, 'tiles,', values.revenue.length, 'cells');
  if (values.revenue.length < 8) return;
  const next: Partial<Record<Metric, number[]>> = {};
  const ceilings: Partial<Record<Metric, number>> = {};
  for (const m of Object.keys(values) as Metric[]) {
    const sorted = [...values[m]].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.02)] ?? 0;
    const hi = Math.max(sorted[Math.floor(sorted.length * 0.995)] ?? 1, lo + 1e-9);
    ceilings[m] = hi;
    const n = HEX_COLORS.length;
    next[m] = Array.from({ length: n - 1 }, (_, i) => lo + (hi - lo) * Math.pow((i + 1) / n, 2));
  }
  const key = JSON.stringify(next[state.metric]!.map((v) => Math.round(v)));
  if (key === state.breaksKey) return;
  state.breaks = next;
  state.ceiling = ceilings;
  state.breaksKey = key;
  renderLegend();
  refreshLayers();
}

/** Kept as a second trigger: when every selected tile is in, learn from all of them at once. */
function onHexTilesLoaded(tiles: { content?: unknown }[]) {
  const values: Record<Metric, number[]> = { revenue: [], n: [], size_m2: [] };
  for (const t of tiles) {
    const raw = (t as { content?: unknown; data?: unknown }).content ?? (t as { data?: unknown }).data;
    const cells: { properties?: Record<string, number> }[] = Array.isArray(raw)
      ? (raw as { properties?: Record<string, number> }[])
      : Array.isArray((raw as { cells?: unknown })?.cells)
        ? ((raw as { cells: { properties?: Record<string, number> }[] }).cells)
        : [];
    for (const c of cells) {
      const p = c.properties ?? {};
      for (const m of Object.keys(values) as Metric[]) if (Number.isFinite(p[m])) values[m].push(Number(p[m]));
    }
  }
  if (DEBUG) console.info('[hex] onViewportLoad tiles', tiles.length, 'cells', values.revenue.length);
  learnBreaks([values]);
}

// ---------------------------------------------------------------------------
// Camera: controlled view state, MapLibre follows, slow orbit while idle
// ---------------------------------------------------------------------------

function applyViewState(vs: MapViewState) {
  state.viewState = vs;
  deck.setProps({ viewState: vs, layers: buildLayers() });
  map.jumpTo({ center: [vs.longitude, vs.latitude], zoom: vs.zoom, pitch: vs.pitch ?? 0, bearing: vs.bearing ?? 0 });
  viewportDirty = true;
}

function flyTo(target: Partial<MapViewState>, duration = 2200) {
  applyViewState({
    ...state.viewState,
    ...target,
    transitionDuration: duration,
    transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }),
  } as MapViewState);
}

function cameraLoop(now: number) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000 || 0);
  lastFrame = now;
  const idle = !interacting && !inTransition && now - lastInteraction > ORBIT_RESUME_MS;
  const orbiting = state.cinematic && idle;
  cameraBadge.classList.toggle('paused', !orbiting);
  cameraLabel.textContent = state.cinematic ? (orbiting ? 'Camera orbiting' : 'Camera paused') : 'Camera manual';
  if (orbiting) {
    const vs = state.viewState;
    applyViewState({ ...vs, bearing: ((vs.bearing ?? 0) + ORBIT_DEG_PER_SEC * dt + 360) % 360, transitionDuration: 0 } as MapViewState);
  }
  requestAnimationFrame(cameraLoop);
}

// ---------------------------------------------------------------------------
// Widgets: figures for the view (server-side, table source) — throttled while the camera moves
// ---------------------------------------------------------------------------

async function refreshKpis() {
  viewportDirty = false;
  kpiAbort?.abort();
  kpiAbort = new AbortController();
  const signal = kpiAbort.signal;
  const viewport = deck.getViewports()[0];
  if (!viewport) return;
  const spatialFilter = createViewportSpatialFilter(viewport.getBounds() as [number, number, number, number]);
  if (!spatialFilter) return;
  for (const el of [kpiCount, kpiRevenue, kpiSize]) el.classList.add('loading');
  try {
    const { widgetSource } = await storesSource;
    const [count, revenue, size] = await Promise.all([
      widgetSource.getFormula({ column: 'cartodb_id', operation: 'count', spatialFilter, signal }),
      widgetSource.getFormula({ column: 'revenue', operation: 'sum', spatialFilter, signal }),
      widgetSource.getFormula({ column: 'size_m2', operation: 'avg', spatialFilter, signal }),
    ]);
    if (signal.aborted) return;
    kpiCount.textContent = fmtInt.format(count.value ?? 0);
    kpiRevenue.textContent = fmtCompactUsd.format(revenue.value ?? 0);
    kpiSize.textContent = size.value ? `${fmtInt.format(Math.round(size.value))} m²` : '–';
  } catch (err) {
    if ((err as Error).name !== 'AbortError') console.error('[widgets]', err);
  } finally {
    if (!signal.aborted) for (const el of [kpiCount, kpiRevenue, kpiSize]) el.classList.remove('loading');
  }
}

function startKpiTicker() {
  const tick = () => {
    if (viewportDirty && !inTransition) void refreshKpis();
    kpiTimer = setTimeout(tick, 2500);
  };
  tick();
}

// ---------------------------------------------------------------------------
// Legend, chips, controls
// ---------------------------------------------------------------------------

function renderLegend() {
  const m = METRICS[state.metric];
  legendTitle.textContent = m.legend;
  legendRes.textContent = `H3 resolution ${state.res}`;
  legendRamp.style.background = `linear-gradient(90deg, ${HEX_COLORS_CSS.join(', ')})`;
  const b = state.breaks[state.metric];
  legendMin.textContent = b ? `≤ ${m.format(b[0])}` : 'low';
  legendMax.textContent = b ? `≥ ${m.format(b.at(-1)!)}` : 'high';
}

function renderChips() {
  const hasSel = state.selectedTypes.size > 0;
  chipsEl.innerHTML = typeDomain
    .map((name, i) => {
      const on = state.selectedTypes.has(name);
      const cls = ['chip', on ? 'on' : '', hasSel && !on ? 'dim' : ''].filter(Boolean).join(' ');
      return `<button class="${cls}" data-type="${escapeHtml(name)}" aria-pressed="${on}" style="color:${typeColors[i]}">
        <span class="sw" style="background:${typeColors[i]}"></span>${escapeHtml(name)}
        <span class="n">${fmtInt.format(typeCounts.get(name) ?? 0)}</span></button>`;
    })
    .join('');
  clearFilterBtn.hidden = !hasSel;
}

function applyTypeFilter() {
  if (state.selectedTypes.size) {
    addFilter(filters, { column: CATEGORY_COLUMN, type: FilterType.IN, values: [...state.selectedTypes], owner: CATEGORY_OWNER });
  } else {
    removeFilter(filters, { column: CATEGORY_COLUMN, owner: CATEGORY_OWNER });
  }
  state.breaksKey = '';
  tileValues.clear();
  buildSources();
  refreshLayers();
  renderChips();
  viewportDirty = true;
  void refreshKpis();
}

chipsEl.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-type]');
  if (!btn) return;
  const t = btn.dataset.type!;
  if (state.selectedTypes.has(t)) state.selectedTypes.delete(t);
  else state.selectedTypes.add(t);
  applyTypeFilter();
});
clearFilterBtn.addEventListener('click', () => {
  state.selectedTypes.clear();
  applyTypeFilter();
});

function setSegment(segId: string, attr: string, value: string) {
  for (const b of $(segId).querySelectorAll<HTMLButtonElement>('button')) {
    const on = b.dataset[attr] === value;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
}
function setView(view: ViewMode) {
  state.view = view;
  setSegment('view-seg', 'view', view);
  refreshLayers();
}
function setMetric(metric: Metric) {
  state.metric = metric;
  setSegment('metric-seg', 'metric', metric);
  state.breaksKey = JSON.stringify(state.breaks[metric]?.map((v) => Math.round(v)) ?? []);
  renderLegend();
  refreshLayers();
}

$('view-seg').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-view]');
  if (b) setView(b.dataset.view as ViewMode);
});
$('metric-seg').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-metric]');
  if (b) setMetric(b.dataset.metric as Metric);
});
resInput.addEventListener('input', () => {
  state.res = Number(resInput.value);
  resOut.textContent = `resolution ${state.res}`;
  state.breaks = {};
  state.ceiling = {};
  state.breaksKey = '';
  tileValues.clear();
  buildSources();
  renderLegend();
  refreshLayers();
});
heightInput.addEventListener('input', () => {
  state.height = Number(heightInput.value) / 100;
  heightOut.textContent = `${state.height.toFixed(1)}×`;
  refreshLayers();
});
cinematicInput.addEventListener('change', () => {
  state.cinematic = cinematicInput.checked;
  lastInteraction = 0;
});
labelsInput.addEventListener('change', () => {
  state.labels = labelsInput.checked;
  map.setStyle(state.labels ? BASEMAP.DARK_MATTER : BASEMAP.DARK_MATTER_NOLABELS);
});
$('reset').addEventListener('click', () => flyTo(HOME_VIEW, 2400));

window.addEventListener('keydown', (ev) => {
  if ((ev.target as HTMLElement).tagName === 'INPUT') return;
  if (ev.code === 'Space') {
    ev.preventDefault();
    cinematicInput.checked = !cinematicInput.checked;
    cinematicInput.dispatchEvent(new Event('change'));
  } else if (ev.key === 'r' || ev.key === 'R') flyTo(HOME_VIEW, 2400);
  else if (ev.key === '1') setView('hex');
  else if (ev.key === '2') setView('stores');
});

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function getTooltip({ object, layer }: PickingInfo) {
  if (!object) return null;
  const style = {
    background: 'rgba(9,13,21,0.9)', color: '#e9edf4', padding: '10px 12px', borderRadius: '10px',
    border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 12px 30px rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)',
  };
  const p = (object as { properties?: Record<string, unknown> }).properties ?? {};
  if (layer?.id?.startsWith('hex-columns')) {
    const n = Number(p.n ?? 0);
    return {
      html: `<div class="tip-title">${fmtInt.format(n)} store${n === 1 ? '' : 's'} in this hexagon</div>
        <div class="tip-row">Revenue <b>${fmtCompactUsd.format(Number(p.revenue ?? 0))}</b> · Avg. size <b>${fmtInt.format(Math.round(Number(p.size_m2 ?? 0)))} m²</b></div>
        <div class="tip-row">Click to dive in</div>`,
      style,
    };
  }
  const type = String(p.storetype ?? 'Store');
  const color = typeColors[typeDomain.indexOf(type)] ?? '#aaa';
  return {
    html: `<div class="tip-title"><span class="tip-sw" style="background:${color}"></span>${escapeHtml(type)}</div>
      <div class="tip-row">${escapeHtml(String(p.address ?? ''))}</div>
      <div class="tip-row">${escapeHtml(String(p.city ?? ''))}, ${escapeHtml(String(p.state ?? ''))}</div>
      <div class="tip-row">Revenue <b>${fmtUsd.format(Number(p.revenue ?? 0))}</b> · Size <b>${fmtInt.format(Number(p.size_m2 ?? 0))} m²</b></div>`,
    style,
  };
}

// ---------------------------------------------------------------------------
// Click a column → dive in
// ---------------------------------------------------------------------------

function diveAt(x: number, y: number) {
  const info = deck.pickObject({ x, y, radius: 4 });
  if (DEBUG) console.info('[click]', Boolean(info?.picked), info?.layer?.id, info?.sourceLayer?.id, info?.coordinate);
  if (!info?.picked) return;
  const onHex = [info.layer?.id, info.sourceLayer?.id].some((id) => id?.startsWith('hex-columns'));
  if (!onHex) return;
  const target = info.coordinate ?? (deck.getViewports()[0]?.unproject([x, y]) as number[] | undefined);
  if (!target) return;
  lastInteraction = performance.now() + 6000;
  flyTo({ longitude: target[0], latitude: target[1], zoom: Math.max(state.viewState.zoom + 2.8, 8.4), pitch: 55 }, 1800);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  // 1. Session: per-viewer token inside CARTO, scoped public token outside, CLI token in dev.
  try {
    session = await loadCartoSession();
  } catch (err) {
    const status = err instanceof HostedAppSessionError ? err.status : undefined;
    sessionDot.classList.add('error');
    sessionLabel.textContent = 'Not signed in';
    const hint = status === 401 || status === 403 || status === 404
      ? 'This app must be opened from CARTO Workspace, where your organization login provides the session.'
      : (err as Error).message;
    showStatus(`<strong>Could not start a CARTO session.</strong><br>${escapeHtml(hint)}`, true);
    return;
  }
  const isPublic = !session.user;
  sessionDot.classList.add('ok');
  sessionLabel.textContent = session.user?.email ? `${session.user.email}${session.devProfile ? ' (dev)' : ''}` : 'Public access · scoped token';
  document.querySelector('.eyebrow')!.textContent = `CARTO · ${isPublic ? 'Public build' : 'Hosted App'} · United States`;
  scheduleSessionRefresh(session, (next) => {
    session = next;
    buildSources();
    refreshLayers();
  });

  // 2. Store types (server-side categories) drive chip colours and the point palette.
  showStatus('Loading 11,966 stores…');
  buildSources();
  const { widgetSource } = await storesSource;
  const cats: CategoryResponse = await widgetSource.getCategories({ column: CATEGORY_COLUMN, operation: 'count' });
  const sorted = cats.filter((c) => c.name != null).sort((a, b) => b.value - a.value);
  typeDomain = sorted.map((c) => String(c.name));
  typeCounts = new Map(sorted.map((c) => [String(c.name), c.value]));
  const stops = Math.min(Math.max(typeDomain.length, 2), 11);
  typeColors = (cartoColors[TYPE_PALETTE][stops] as string[]).slice(0, typeDomain.length);
  renderChips();
  renderLegend();
  resOut.textContent = `resolution ${state.res}`;
  heightOut.textContent = `${state.height.toFixed(1)}×`;

  // 3. Basemap + deck.gl. deck owns the camera, MapLibre follows.
  map = new maplibregl.Map({
    container: 'map',
    style: state.labels ? BASEMAP.DARK_MATTER : BASEMAP.DARK_MATTER_NOLABELS,
    interactive: false,
    center: [INTRO_VIEW.longitude, INTRO_VIEW.latitude],
    zoom: INTRO_VIEW.zoom,
    maxPitch: 60,
    attributionControl: { compact: true },
  });

  const canvas = document.getElementById('deck-canvas') as HTMLCanvasElement;
  let downAt: [number, number] | null = null;
  canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  canvas.addEventListener('click', (e) => {
    const moved = downAt ? Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) : 0;
    downAt = null;
    if (moved > 6) return; // a drag, not a click
    const rect = canvas.getBoundingClientRect();
    diveAt(e.clientX - rect.left, e.clientY - rect.top);
  });

  deck = new Deck({
    canvas: 'deck-canvas',
    viewState: state.viewState,
    controller: { inertia: 250, touchRotate: true },
    effects: [lighting],
    layers: buildLayers(),
    getTooltip,
    onViewStateChange: ({ viewState, interactionState }) => {
      const vs = viewState as MapViewState;
      inTransition = Boolean(interactionState?.inTransition);
      applyViewState(vs);
    },
    onInteractionStateChange: (s) => {
      const active = Boolean(s.isDragging || s.isPanning || s.isZooming || s.isRotating);
      if (active) interacting = true;
      else if (interacting) {
        interacting = false;
        lastInteraction = performance.now();
      }
      inTransition = Boolean(s.inTransition);
    },
    onLoad: () => {
      hideStatus();
      // Cinematic entrance, then let the orbit take over.
      lastInteraction = performance.now() + 2500;
      setTimeout(() => flyTo(HOME_VIEW, 3600), 250);
      lastFrame = performance.now();
      requestAnimationFrame(cameraLoop);
      startKpiTicker();
    },
  });
}

main().catch((err) => {
  console.error(err);
  showStatus(`<strong>Something went wrong.</strong><br>${escapeHtml((err as Error).message)}`, true);
});

// Keep the module's timers reachable for HMR teardown in dev.
if (import.meta.hot) import.meta.hot.dispose(() => { if (kpiTimer) clearTimeout(kpiTimer); });
