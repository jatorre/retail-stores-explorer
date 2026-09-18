import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import { Deck, type PickingInfo } from '@deck.gl/core';
import { BASEMAP, VectorTileLayer, colorCategories } from '@deck.gl/carto';
import {
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
import {
  loadCartoSession,
  scheduleSessionRefresh,
  HostedAppSessionError,
  type CartoSession,
} from './carto-session';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONNECTION_NAME = 'carto_dw';
const TABLE_NAME = 'carto-demo-data.demo_tables.retail_stores';
const CATEGORY_COLUMN = 'storetype';
const CATEGORY_OWNER = 'storetype-widget';
const PALETTE = 'Bold';

// Continental US — the demo data spans Hawaii → Maine.
const INITIAL_VIEW_STATE = { longitude: -96.5, latitude: 38.5, zoom: 3.7, pitch: 0, bearing: 0 };

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const statusText = $('status-text');
const sessionEl = $('session');
const sessionLabel = $('session-label');
const kpiCount = $('kpi-count');
const kpiRevenue = $('kpi-revenue');
const kpiSize = $('kpi-size');
const categoriesEl = $<HTMLUListElement>('categories');
const clearFilterBtn = $<HTMLButtonElement>('clear-filter');
const panel = $('panel');
const panelToggle = $<HTMLButtonElement>('panel-toggle');

panelToggle.addEventListener('click', () => {
  const collapsed = panel.classList.toggle('collapsed');
  panelToggle.setAttribute('aria-expanded', String(!collapsed));
});

const fmtInt = new Intl.NumberFormat('en-US');
const fmtCompactUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const fmtUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function showStatus(message: string, isError = false) {
  statusEl.hidden = false;
  statusEl.classList.toggle('error', isError);
  statusText.innerHTML = message;
}
function hideStatus() {
  statusEl.hidden = true;
}

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let session: CartoSession;
const filters: Filters = {};
let categoryDomain: string[] = [];
let categoryColors: string[] = [];
let selectedCategories = new Set<string>();
let dataSource: ReturnType<typeof vectorTableSource>;
let deck: Deck;
let map: maplibregl.Map;
let widgetAbort: AbortController | undefined;

function cartoConfig() {
  return {
    apiBaseUrl: session.apiBaseUrl,
    accessToken: session.accessToken,
    connectionName: CONNECTION_NAME,
  };
}

function buildSource() {
  dataSource = vectorTableSource({
    ...cartoConfig(),
    tableName: TABLE_NAME,
    columns: ['cartodb_id', 'storetype', 'address', 'city', 'state', 'revenue', 'size_m2'],
    filters,
  });
  return dataSource;
}

function buildLayers() {
  return [
    new VectorTileLayer({
      id: 'retail-stores',
      data: dataSource,
      pickable: true,
      autoHighlight: true,
      highlightColor: [3, 111, 226, 200],
      pointRadiusUnits: 'pixels',
      getPointRadius: 3.5,
      pointRadiusMinPixels: 2,
      getFillColor: colorCategories({
        attr: CATEGORY_COLUMN,
        domain: categoryDomain,
        colors: PALETTE,
        othersColor: [180, 180, 180],
      }),
      getLineColor: [255, 255, 255, 190],
      lineWidthMinPixels: 0.8,
      stroked: true,
      updateTriggers: { getFillColor: [categoryDomain.join('|')] },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Widgets (read from the same source + filters as the map)
// ---------------------------------------------------------------------------

function currentSpatialFilter() {
  const viewport = deck.getViewports()[0];
  return viewport ? createViewportSpatialFilter(viewport.getBounds() as [number, number, number, number]) : undefined;
}

async function refreshWidgets() {
  widgetAbort?.abort();
  widgetAbort = new AbortController();
  const signal = widgetAbort.signal;
  const spatialFilter = currentSpatialFilter();
  if (!spatialFilter) return;

  for (const el of [kpiCount, kpiRevenue, kpiSize]) el.classList.add('loading');

  try {
    const { widgetSource } = await dataSource;
    const categoryFilters = getApplicableFilters(CATEGORY_OWNER, filters);

    const [count, revenue, size, categories] = await Promise.all([
      widgetSource.getFormula({ column: 'cartodb_id', operation: 'count', spatialFilter, signal }),
      widgetSource.getFormula({ column: 'revenue', operation: 'sum', spatialFilter, signal }),
      widgetSource.getFormula({ column: 'size_m2', operation: 'avg', spatialFilter, signal }),
      widgetSource.getCategories({
        column: CATEGORY_COLUMN,
        operation: 'count',
        spatialFilter,
        filters: categoryFilters,
        signal,
      }),
    ]);
    if (signal.aborted) return;

    kpiCount.textContent = fmtInt.format(count.value ?? 0);
    kpiRevenue.textContent = fmtCompactUsd.format(revenue.value ?? 0);
    kpiSize.textContent = size.value ? `${fmtInt.format(Math.round(size.value))} m²` : '–';
    renderCategories(categories);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    console.error('[widgets]', err);
  } finally {
    if (!signal.aborted) for (const el of [kpiCount, kpiRevenue, kpiSize]) el.classList.remove('loading');
  }
}

const refreshWidgetsDebounced = debounce(refreshWidgets, 300);

function renderCategories(rows: CategoryResponse) {
  const byName = new Map(rows.filter((r) => r.name != null).map((r) => [String(r.name), r.value]));
  const max = Math.max(1, ...rows.map((r) => r.value));
  const hasSelection = selectedCategories.size > 0;

  categoriesEl.innerHTML = categoryDomain
    .map((name, i) => {
      const value = byName.get(name) ?? 0;
      const selected = selectedCategories.has(name);
      const cls = ['category', selected ? 'selected' : '', hasSelection && !selected ? 'dimmed' : '']
        .filter(Boolean)
        .join(' ');
      const width = ((value / max) * 100).toFixed(1);
      return `
        <li>
          <button class="${cls}" data-category="${escapeHtml(name)}" aria-pressed="${selected}">
            <span class="category-swatch" style="background:${categoryColors[i]}"></span>
            <span class="category-name">${escapeHtml(name)}</span>
            <span class="category-count">${fmtInt.format(value)}</span>
            <span class="category-bar"><span style="width:${width}%;background:${categoryColors[i]}"></span></span>
          </button>
        </li>`;
    })
    .join('');

  clearFilterBtn.hidden = !hasSelection;
}

categoriesEl.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-category]');
  if (!btn) return;
  toggleCategory(btn.dataset.category!);
});
clearFilterBtn.addEventListener('click', () => {
  selectedCategories = new Set();
  applyFilters();
});

function toggleCategory(name: string) {
  const next = new Set(selectedCategories);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  selectedCategories = next;
  applyFilters();
}

function applyFilters() {
  if (selectedCategories.size) {
    addFilter(filters, {
      column: CATEGORY_COLUMN,
      type: FilterType.IN,
      values: [...selectedCategories],
      owner: CATEGORY_OWNER,
    });
  } else {
    removeFilter(filters, { column: CATEGORY_COLUMN, owner: CATEGORY_OWNER });
  }
  buildSource();
  deck.setProps({ layers: buildLayers() });
  void refreshWidgets();
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function getTooltip({ object }: PickingInfo) {
  if (!object) return null;
  const p = (object as { properties: Record<string, unknown> }).properties;
  return {
    html: `
      <div class="tip-title">${escapeHtml(String(p.storetype ?? 'Store'))}</div>
      <div class="tip-row">${escapeHtml(String(p.address ?? ''))}</div>
      <div class="tip-row">${escapeHtml(String(p.city ?? ''))}, ${escapeHtml(String(p.state ?? ''))}</div>
      <div class="tip-row">Revenue <b>${fmtUsd.format(Number(p.revenue ?? 0))}</b> · Size <b>${fmtInt.format(Number(p.size_m2 ?? 0))} m²</b></div>`,
    style: {
      background: '#fff',
      color: '#2C3032',
      padding: '8px 10px',
      borderRadius: '6px',
      boxShadow: '0 4px 12px rgba(44,48,50,0.16)',
      border: '1px solid #E1E3E4',
    },
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  // 1. Session — per-viewer token served by CARTO Hosted Apps (or the dev plugin).
  try {
    session = await loadCartoSession();
  } catch (err) {
    const status = err instanceof HostedAppSessionError ? err.status : undefined;
    sessionEl.classList.add('error');
    sessionLabel.textContent = 'Not signed in';
    const hint =
      status === 401 || status === 403 || status === 404
        ? 'This app must be opened from CARTO Workspace, where your organization login provides the session.'
        : (err as Error).message;
    showStatus(`<strong>Could not start a CARTO session.</strong><br>${escapeHtml(hint)}`, true);
    return;
  }
  sessionEl.classList.add('ok');
  const isPublic = !session.user;
  sessionLabel.textContent = session.user?.email
    ? `${session.user.email}${session.devProfile ? ' (dev)' : ''}`
    : 'Public access · scoped token';
  const tag = document.querySelector<HTMLElement>('.brand-tag');
  if (tag) tag.textContent = isPublic ? 'Public' : 'Hosted App';

  scheduleSessionRefresh(session, (next) => {
    session = next;
    buildSource();
    deck.setProps({ layers: buildLayers() });
  });

  // 2. Category domain (global, unfiltered) — shared by the layer colors and the widget.
  showStatus('Loading store types…');
  buildSource();
  const { widgetSource } = await dataSource;
  const cats = await widgetSource.getCategories({ column: CATEGORY_COLUMN, operation: 'count' });
  categoryDomain = cats
    .filter((c) => c.name != null)
    .sort((a, b) => b.value - a.value)
    .map((c) => String(c.name));
  const stops = Math.min(Math.max(categoryDomain.length, 2), 11);
  categoryColors = (cartoColors[PALETTE][stops] as string[]).slice(0, categoryDomain.length);

  // 3. Basemap + deck.gl. deck owns interaction; MapLibre follows.
  map = new maplibregl.Map({
    container: 'map',
    style: BASEMAP.POSITRON,
    interactive: false,
    center: [INITIAL_VIEW_STATE.longitude, INITIAL_VIEW_STATE.latitude],
    zoom: INITIAL_VIEW_STATE.zoom,
    attributionControl: { compact: true },
  });

  deck = new Deck({
    canvas: 'deck-canvas',
    initialViewState: INITIAL_VIEW_STATE,
    controller: true,
    layers: buildLayers(),
    getTooltip,
    onViewStateChange: ({ viewState }) => {
      const { longitude, latitude, zoom, pitch, bearing } = viewState as typeof INITIAL_VIEW_STATE;
      map.jumpTo({ center: [longitude, latitude], zoom, pitch, bearing });
      refreshWidgetsDebounced();
    },
    onLoad: () => {
      hideStatus();
      void refreshWidgets();
    },
  });
}

main().catch((err) => {
  console.error(err);
  showStatus(`<strong>Something went wrong.</strong><br>${escapeHtml((err as Error).message)}`, true);
});
