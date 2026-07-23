interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Government Auctions MCP — physical-asset auctions (surplus, seized, forfeited,
 * tax-deed) that agencies sell to the public. Queries the Pipeworx-hosted
 * auction_lots table (ingested daily by workers/auction-scraper) via PostgREST.
 *
 * Coverage: GovDeals + AllSurplus (state/local surplus — vehicles, equipment,
 * real estate) and IRS seized/forfeited property. Distinct from the gsa-auctions
 * pack (live GSA federal-surplus API); this pack is the multi-source, DB-backed
 * store whose differentiator is SOLD-PRICE HISTORY (auctions_sold_comps) — we
 * never delete closed lots, so hammer prices accumulate.
 *
 * The pack is stateless (gateway handles auth/rate-limit) and never throws for
 * expected empty results — it shapes LLM-friendly objects and returns { error }.
 */


const ASSET_TYPES = ['vehicle', 'equipment', 'realestate', 'electronics', 'other'] as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'auctions_search',
    description:
      'Search live US government auction lots for physical assets sold to the public — surplus vehicles, heavy equipment, real estate, electronics — from state/local governments (GovDeals, AllSurplus) and IRS seized/forfeited property. Filter by free-text keyword (matched on the item title, e.g. "truck", "excavator", "pickup"), 2-letter state, asset_type (vehicle|equipment|realestate|electronics|other), max_price (current bid ceiling), and closing_within_hours. Returns each lot with source, title, location, current bid, close time, and a link. For historical sold prices use auctions_sold_comps instead.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Free-text matched (case-insensitive) against the lot title, e.g. "truck", "forklift", "generator".' },
        state: { type: 'string', description: '2-letter state code of the item location, e.g. "TX", "CA".' },
        asset_type: { type: 'string', description: `One of: ${ASSET_TYPES.join(' | ')}.` },
        source: { type: 'string', description: 'Restrict to one source: govdeals | allsurplus | irs.' },
        max_price: { type: ['number', 'string'], description: 'Only lots whose current bid is at or below this.' },
        closing_within_hours: { type: ['number', 'string'], description: 'Only lots closing within this many hours from now.' },
        limit: { type: ['number', 'string'], description: 'Max lots (1-100, default 25).' },
      },
      required: [],
    },
  },
  {
    name: 'auctions_closing_soon',
    description:
      'Live government auction lots ordered by soonest close time — the "what can I still bid on before it ends" view across all sources (GovDeals, AllSurplus, IRS). Optionally filter by state, asset_type, or keyword. Returns lots with time remaining, current bid, location, and link.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: '2-letter state code.' },
        asset_type: { type: 'string', description: `One of: ${ASSET_TYPES.join(' | ')}.` },
        keyword: { type: 'string', description: 'Free-text title match.' },
        limit: { type: ['number', 'string'], description: 'Max lots (1-100, default 25).' },
      },
      required: [],
    },
  },
  {
    name: 'auction_lot_details',
    description:
      'Full details for a single government auction lot, looked up by its source + source_lot_id (as returned by auctions_search) or by its listing URL. Returns title, description, category, location, bid, close time, seller agency, and link.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Lot source: govdeals | allsurplus | irs.' },
        source_lot_id: { type: 'string', description: 'The lot id within that source.' },
        url: { type: 'string', description: 'Alternatively, the full listing URL.' },
      },
      required: [],
    },
  },
  {
    name: 'auctions_sold_comps',
    description:
      'Historical SOLD prices for government auction items — the final hammer price of closed lots, which no upstream site keeps but Pipeworx retains. Use to answer "what do seized pickup trucks actually sell for" or to comp an asset. Filter by keyword (title match), asset_type, and/or state. Returns count, min/median/max/average final price, and recent examples. Only includes lots that have closed with a recorded final price.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Free-text title match, e.g. "f-150", "excavator", "trailer".' },
        asset_type: { type: 'string', description: `One of: ${ASSET_TYPES.join(' | ')}.` },
        state: { type: 'string', description: '2-letter state code.' },
        limit: { type: ['number', 'string'], description: 'Max example lots to return (1-50, default 10).' },
      },
      required: [],
    },
  },
  {
    name: 'auctions_coverage',
    description:
      'What government-auction data Pipeworx currently holds: per-source active lot counts and data freshness (when each source was last refreshed). Use to gauge coverage and how current the data is before relying on it.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

interface SupabaseConfig {
  url: string;
  key: string;
}

async function pg<T>(cfg: SupabaseConfig, table: string, query: string): Promise<T> {
  const res = await fetch(`${cfg.url}/rest/v1/${table}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${table}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// Exact row count for a filter, via PostgREST's Content-Range header. Used
// instead of a count() aggregate (aggregate functions are disabled on the
// project). Requests a single row with Prefer: count=exact and parses the
// "0-0/1234" range tail.
async function pgCount(cfg: SupabaseConfig, table: string, query: string): Promise<number> {
  const res = await fetch(`${cfg.url}/rest/v1/${table}?${query}&limit=1`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Prefer: 'count=exact' },
  });
  if (!res.ok) return 0;
  const range = res.headers.get('content-range') ?? '';
  const total = range.split('/')[1];
  const n = Number(total);
  return Number.isFinite(n) ? n : 0;
}

// The sources this pack ingests. Kept explicit (aggregate/distinct is disabled)
// and matched to the auction-scraper adapters.
const KNOWN_SOURCES = ['govdeals', 'allsurplus', 'irs'] as const;

interface LotRow {
  source: string;
  source_lot_id: string;
  title: string;
  description: string | null;
  category: string | null;
  asset_type: string | null;
  location_city: string | null;
  location_state: string | null;
  location_zip: string | null;
  currency: string;
  current_bid: number | null;
  bid_count: number | null;
  final_price: number | null;
  starts_at: string | null;
  closes_at: string | null;
  status: string;
  seller_agency: string | null;
  url: string | null;
}

const LOT_SELECT =
  'select=source,source_lot_id,title,category,asset_type,location_city,location_state,location_zip,currency,current_bid,bid_count,closes_at,status,seller_agency,url';

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
}

function shapeLot(r: LotRow) {
  return {
    source: r.source,
    source_lot_id: r.source_lot_id,
    title: r.title,
    category: r.category,
    asset_type: r.asset_type,
    location: [r.location_city, r.location_state].filter(Boolean).join(', ') || null,
    state: r.location_state,
    current_bid: r.current_bid,
    currency: r.currency,
    bid_count: r.bid_count,
    closes_at: r.closes_at,
    seller: r.seller_agency,
    url: r.url,
  };
}

// Shared filter builder for the active-lot list tools.
function activeLotFilters(args: Record<string, unknown>): string[] {
  const parts = ['status=eq.active'];
  // Accept the common param aliases agents reach for (query/q/search/keywords)
  // — previously anything but `keyword` was silently ignored, returning the
  // whole unfiltered pool as if it had matched.
  parts.push(...titleKeywordParts(args));
  const state = String(args.state ?? args.location_state ?? '').trim();
  if (state) parts.push(`location_state=eq.${encodeURIComponent(state.toUpperCase())}`);
  const assetType = normalizeAssetType(String(args.asset_type ?? args.category ?? args.type ?? '').trim());
  if (assetType) parts.push(`asset_type=eq.${encodeURIComponent(assetType)}`);
  const source = String(args.source ?? '').trim().toLowerCase();
  if (source) parts.push(`source=eq.${encodeURIComponent(source)}`);
  return parts;
}

// Keyword → PostgREST title filters, shared by all keyword tools. Accepts the
// param aliases agents use (query/q/search/keywords), and tokenizes multi-word
// keywords into AND-ed substring matches so word order/adjacency don't matter.
function titleKeywordParts(args: Record<string, unknown>): string[] {
  const keyword = String(args.keyword ?? args.query ?? args.q ?? args.search ?? args.keywords ?? '').trim();
  if (!keyword) return [];
  return keyword
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 6)
    .map((tok) => `title=ilike.*${encodeURIComponent(tok)}*`);
}

// Map plural/synonym asset categories agents pass to the enum values.
function normalizeAssetType(raw: string): string {
  if (!raw) return '';
  const t = raw.toLowerCase();
  const map: Record<string, string> = {
    vehicles: 'vehicle', car: 'vehicle', cars: 'vehicle', truck: 'vehicle', trucks: 'vehicle', auto: 'vehicle',
    equipment: 'equipment', machinery: 'equipment', heavy: 'equipment',
    realestate: 'realestate', 'real estate': 'realestate', property: 'realestate', land: 'realestate',
    electronics: 'electronics', electronic: 'electronics', computers: 'electronics',
  };
  if ((ASSET_TYPES as readonly string[]).includes(t)) return t;
  return map[t] ?? '';
}

async function search(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const parts = activeLotFilters(args);
  if (args.max_price !== undefined && String(args.max_price).trim() !== '') {
    parts.push(`current_bid=lte.${Number(args.max_price)}`);
  }
  if (args.closing_within_hours !== undefined && String(args.closing_within_hours).trim() !== '') {
    const cutoff = new Date(Date.now() + Number(args.closing_within_hours) * 3600_000).toISOString();
    parts.push(`closes_at=lte.${cutoff}`);
    parts.push('closes_at=gte.' + new Date().toISOString());
  }
  const limit = clampInt(args.limit, 1, 100, 25);
  parts.push(LOT_SELECT, 'order=closes_at.asc.nullslast', `limit=${limit}`);
  const rows = await pg<LotRow[]>(cfg, 'auction_lots', parts.join('&'));
  return { count: rows.length, lots: rows.map(shapeLot) };
}

async function closingSoon(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const parts = activeLotFilters(args);
  parts.push('closes_at=gte.' + new Date().toISOString());
  const limit = clampInt(args.limit, 1, 100, 25);
  parts.push(LOT_SELECT, 'order=closes_at.asc.nullslast', `limit=${limit}`);
  const rows = await pg<LotRow[]>(cfg, 'auction_lots', parts.join('&'));
  const now = Date.now();
  return {
    count: rows.length,
    lots: rows.map((r) => ({
      ...shapeLot(r),
      hours_remaining: r.closes_at ? Math.round(((new Date(r.closes_at).getTime() - now) / 3600_000) * 10) / 10 : null,
    })),
  };
}

async function lotDetails(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const parts: string[] = ['limit=1', 'select=*'];
  const url = String(args.url ?? '').trim();
  const source = String(args.source ?? '').trim();
  const id = String(args.source_lot_id ?? '').trim();
  if (url) {
    parts.push(`url=eq.${encodeURIComponent(url)}`);
  } else if (source && id) {
    parts.push(`source=eq.${encodeURIComponent(source)}`, `source_lot_id=eq.${encodeURIComponent(id)}`);
  } else {
    return { error: 'missing_args', message: 'Provide either url, or both source and source_lot_id.' };
  }
  const rows = await pg<LotRow[]>(cfg, 'auction_lots', parts.join('&'));
  if (rows.length === 0) return { error: 'not_found', message: 'No matching lot.' };
  const r = rows[0];
  return {
    ...shapeLot(r),
    description: r.description,
    zip: r.location_zip,
    status: r.status,
    final_price: r.final_price,
  };
}

async function soldComps(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const parts = ['status=eq.closed', 'final_price=not.is.null'];
  const keyword = String(args.keyword ?? args.query ?? args.q ?? args.search ?? args.keywords ?? '').trim();
  parts.push(...titleKeywordParts(args));
  const assetType = normalizeAssetType(String(args.asset_type ?? args.category ?? args.type ?? '').trim());
  if (assetType) parts.push(`asset_type=eq.${encodeURIComponent(assetType)}`);
  const state = String(args.state ?? args.location_state ?? '').trim();
  if (state) parts.push(`location_state=eq.${encodeURIComponent(state.toUpperCase())}`);

  // Pull final prices for stats (cap to keep it bounded) + a few recent examples.
  const statRows = await pg<Array<{ final_price: number }>>(
    cfg,
    'auction_lots',
    [...parts, 'select=final_price', 'order=closes_at.desc', 'limit=1000'].join('&'),
  );
  if (statRows.length === 0) {
    return {
      error: 'no_comps',
      message: `No closed lots with a recorded sold price match${keyword ? ` "${keyword}"` : ''} yet. Sold-price history accumulates as active lots close.`,
    };
  }
  const prices = statRows.map((r) => Number(r.final_price)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const avg = Math.round(prices.reduce((s, n) => s + n, 0) / prices.length);
  const exLimit = clampInt(args.limit, 1, 50, 10);
  const examples = await pg<LotRow[]>(
    cfg,
    'auction_lots',
    [...parts, 'select=title,location_state,final_price,closes_at,url', 'order=closes_at.desc', `limit=${exLimit}`].join('&'),
  );
  return {
    matched_lots: prices.length,
    final_price: { min: prices[0], median, average: avg, max: prices[prices.length - 1], currency: 'USD' },
    recent_examples: examples.map((r) => ({
      title: r.title,
      state: r.location_state,
      sold_for: r.final_price,
      closed_at: r.closes_at,
      url: r.url,
    })),
  };
}

async function coverage(cfg: SupabaseConfig) {
  const sources = await pg<Array<{ source: string; last_success_at: string | null }>>(
    cfg,
    'auction_sources',
    'select=source,last_success_at',
  );
  const freshness = new Map(sources.map((s) => [s.source, s.last_success_at]));
  const perSource = await Promise.all(
    KNOWN_SOURCES.map(async (source) => ({
      source,
      active_lots: await pgCount(cfg, 'auction_lots', `status=eq.active&source=eq.${source}`),
      last_refreshed_at: freshness.get(source) ?? null,
    })),
  );
  const soldComps = await pgCount(cfg, 'auction_lots', 'status=eq.closed&final_price=not.is.null');
  return {
    total_active_lots: perSource.reduce((s, c) => s + c.active_lots, 0),
    sold_comps_retained: soldComps,
    sources: perSource,
    note: 'Data is refreshed daily. Sold-price comps (auctions_sold_comps) retain closed lots indefinitely.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const supabaseUrl = (args._supabaseUrl as string | undefined)?.trim();
  const supabaseKey = (args._supabaseKey as string | undefined)?.trim();
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('gov-auctions pack requires platform Supabase credentials (operator-configured).');
  }
  const cfg: SupabaseConfig = { url: supabaseUrl, key: supabaseKey };

  switch (name) {
    case 'auctions_search':
      return search(cfg, args);
    case 'auctions_closing_soon':
      return closingSoon(cfg, args);
    case 'auction_lot_details':
      return lotDetails(cfg, args);
    case 'auctions_sold_comps':
      return soldComps(cfg, args);
    case 'auctions_coverage':
      return coverage(cfg);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
