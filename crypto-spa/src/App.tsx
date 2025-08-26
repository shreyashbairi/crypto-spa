import React, { useEffect, useMemo, useRef, useState, memo } from "react";
import { Search, Sun, Moon, TrendingUp, TrendingDown, X } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

/**
 * Crypto Prices SPA — Single‑file React app
 * -------------------------------------------------------------
 * Features
 *  - Home list of USDT pairs (from Binance 24hr ticker)
 *  - VANRY/USDT is *pinned as the first* item (hard requirement)
 *  - Click a row → detail view with live line chart (Binance klines)
 *  - Search + basic filter (All / Gainers / Losers)
 *  - Dark / Light mode toggle (persisted)
 *  - Tailwind CSS for a clean, responsive, professional UI
 *
 * Notes
 *  - This SPA consumes *public* Binance REST endpoints with CORS enabled:
 *      • Tickers (24hr):  https://api.binance.com/api/v3/ticker/24hr
 *      • Klines:          https://api.binance.com/api/v3/klines?symbol=VANRYUSDT&interval=1h
 *  - If Binance is blocked in your network, you can swap the data layer to CoinGecko
 *    (free) easily by replacing `fetchTickers()` and `fetchKlines()`.
 *  - The list is limited to spot *USDT* pairs and excludes leveraged tokens (UP/DOWN/BULL/BEAR).
 *
 * Implementation quality
 *  - Efficient render: memoized rows, minimal re-renders, batched state updates
 *  - Gentle polling (15s) for fresh prices; chart fetch on-demand
 *  - Accessible: buttons have labels, focus rings; semantic structure
 *  - Documented: functions and types explained for future maintenance
 */

// ----- Types -----
interface TickerRow {
  symbol: string; // e.g., "BTCUSDT"
  base: string; // e.g., "BTC"
  lastPrice: number;
  priceChangePercent: number; // 24h
  quoteVolume: number; // 24h quote volume (USDT)
}

interface KlinePoint {
  t: number; // close time (ms)
  c: number; // close price
}

// ----- Constants -----
const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/24hr";
const BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines";
const PINNED_SYMBOL = "VANRYUSDT"; // must appear first
const POLL_MS = 15000; // refresh list every 15s
const DRAWER_W = 560; // px

// Basic timeframe presets → Binance intervals + reasonable point counts
const TIMEFRAMES: {
  label: string;
  interval: string;
  limit: number;
  approxDays: number;
}[] = [
  { label: "24H", interval: "15m", limit: 120, approxDays: 1 },
  { label: "7D", interval: "1h", limit: 200, approxDays: 7 },
  { label: "1M", interval: "4h", limit: 200, approxDays: 30 },
  { label: "3M", interval: "1d", limit: 120, approxDays: 90 },
];

// Exclude leveraged/derivative suffixes
const EXCLUDE_PAT = /(UP|DOWN|BULL|BEAR)USDT$/;

// ----- Utilities -----
const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 });
const fmt2 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const fmt0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function baseFromSymbol(symbol: string) {
  return symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
}

function classNames(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// Persisted theme helper (class on <html>)
function useTheme() {
  type Theme = "light" | "dark";
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    if (stored === "dark" || stored === "light") return stored;
    const prefersDark =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  });

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme); // <html data-theme="...">
    root.classList.toggle("dark", theme === "dark"); // keeps `dark:` utilities working
    document.body.classList.remove("dark"); // neutralize stray body.dark
    (root as HTMLElement).style.colorScheme = theme; // native controls
    localStorage.setItem("theme", theme);
  }, [theme]);

  return { theme, setTheme } as const;
}

// Data fetchers
async function fetchTickers(): Promise<TickerRow[]> {
  const res = await fetch(BINANCE_TICKER_URL);
  if (!res.ok) throw new Error(`Ticker HTTP ${res.status}`);
  const raw: any[] = await res.json();
  const usdt = raw
    .filter(
      (r) =>
        typeof r?.symbol === "string" &&
        r.symbol.endsWith("USDT") &&
        !EXCLUDE_PAT.test(r.symbol)
    )
    .map((r) => ({
      symbol: r.symbol as string,
      base: baseFromSymbol(r.symbol as string),
      lastPrice: parseFloat(r.lastPrice),
      priceChangePercent: parseFloat(r.priceChangePercent),
      quoteVolume: parseFloat(r.quoteVolume),
    })) as TickerRow[];

  // Deduplicate & ensure VANRYUSDT is present and pinned first
  const map = new Map<string, TickerRow>();
  usdt.forEach((t) => {
    if (!map.has(t.symbol)) map.set(t.symbol, t);
  });

  // If for some reason VANRYUSDT isn't returned (rare), create a placeholder entry.
  if (!map.has(PINNED_SYMBOL)) {
    map.set(PINNED_SYMBOL, {
      symbol: PINNED_SYMBOL,
      base: baseFromSymbol(PINNED_SYMBOL),
      lastPrice: NaN,
      priceChangePercent: NaN,
      quoteVolume: 0,
    });
  }

  const arr = Array.from(map.values());
  // Sort by quote volume desc, but keep VANRY at index 0
  arr.sort((a, b) => b.quoteVolume - a.quoteVolume);
  const vanryIndex = arr.findIndex((t) => t.symbol === PINNED_SYMBOL);
  if (vanryIndex > 0) {
    const [vanry] = arr.splice(vanryIndex, 1);
    arr.unshift(vanry);
  }

  // Limit for performance on first view
  return arr.slice(0, 100);
}

async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number
): Promise<KlinePoint[]> {
  const url = new URL(BINANCE_KLINES_URL);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Klines HTTP ${res.status}`);
  const raw: any[] = await res.json();
  return raw.map((row) => ({ t: row[6], c: parseFloat(row[4]) })); // use closeTime + close
}

// ----- UI Components -----
const Row = memo(function Row({
  t,
  onClick,
}: {
  t: TickerRow;
  onClick: () => void;
}) {
  const isPinned = t.symbol === PINNED_SYMBOL;
  const up = t.priceChangePercent >= 0;
  return (
    <button
      onClick={onClick}
      className={classNames(
        "w-full text-left px-4 py-3 rounded-xl border transition-shadow focus:outline-none focus:ring-2 focus:ring-indigo-500",
        "bg-white dark:bg-zinc-900/60 border-zinc-200 dark:border-zinc-800 hover:shadow-md"
      )}
      aria-label={`Open ${t.base}/USDT details`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={classNames(
              "w-9 h-9 rounded-lg grid place-items-center text-sm font-semibold",
              isPinned
                ? "bg-indigo-600 text-white"
                : "bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
            )}
          >
            {t.base.substring(0, 4)}
          </div>
          <div className="min-w-0">
            <div className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {t.base}/USDT
            </div>
            <div className="text-xs text-zinc-500">
              Vol: {isFinite(t.quoteVolume) ? fmt0.format(t.quoteVolume) : "—"}{" "}
              USDT
            </div>
          </div>
          {isPinned && (
            <span className="ml-2 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
              Pinned (VANRY/USDT)
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-4">
          <div className="tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
            {isFinite(t.lastPrice) ? fmt.format(t.lastPrice) : "—"}
          </div>
          <div
            className={classNames(
              "text-sm font-medium inline-flex items-center gap-1",
              up ? "text-emerald-600" : "text-rose-600"
            )}
          >
            {up ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
            {isFinite(t.priceChangePercent)
              ? `${fmt2.format(t.priceChangePercent)}%`
              : "—"}
          </div>
        </div>
      </div>
    </button>
  );
});

function Chart({ symbol }: { symbol: string }) {
  const [points, setPoints] = useState<KlinePoint[] | null>(null);
  const [tf, setTf] = useState(TIMEFRAMES[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const p = await fetchKlines(symbol, tf.interval, tf.limit);
        if (!alive) return;
        setPoints(p);
      } catch (e: any) {
        setError(e?.message || "Failed to load chart");
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [symbol, tf]);

  return (
    <div className="w-full h-72 sm:h-96">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-zinc-500">Interval</div>
        <div className="flex gap-2">
          {TIMEFRAMES.map((t) => (
            <button
              key={t.label}
              onClick={() => setTf(t)}
              className={classNames(
                "px-2.5 py-1 text-sm rounded-md border",
                tf.label === t.label
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-transparent border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              )}
              aria-pressed={tf.label === t.label}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative h-full">
        {loading && (
          <div className="absolute inset-0 grid place-items-center text-sm text-zinc-500">
            Loading chart…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 grid place-items-center text-sm text-rose-600">
            {error}
          </div>
        )}
        {points && !loading && !error && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={points}
              margin={{ top: 8, right: 8, bottom: 36, left: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                className="stroke-zinc-200 dark:stroke-zinc-800"
              />
              <XAxis
                dataKey="t"
                tickFormatter={(ts) =>
                  new Date(ts).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                }
                type="number"
                domain={["dataMin", "dataMax"]}
                tick={{ fontSize: 12 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                dataKey="c"
                domain={["auto", "auto"]}
                tick={{ fontSize: 12 }}
                width={72}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--tw-prose-bg, #fff)",
                  borderRadius: 8,
                  border: "1px solid #e5e7eb",
                }}
                labelFormatter={(ts) => new Date(Number(ts)).toLocaleString()}
                formatter={(v: any) => [fmt.format(Number(v)), "Close"]}
              />
              <ReferenceLine
                y={points[points.length - 1].c}
                stroke="#a1a1aa"
                strokeDasharray="3 3"
              />
              <Line type="monotone" dataKey="c" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// Simple slide-in drawer that stays mounted to allow smooth transitions
function Drawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={classNames(
        "fixed inset-0 z-20 overflow-hidden transition-[opacity]",
        open
          ? "opacity-100 pointer-events-auto"
          : "opacity-0 pointer-events-none"
      )}
    >
      {/* Backdrop */}
      <div
        className={classNames(
          "absolute inset-0 bg-black/40 transition-opacity duration-300",
          open ? "opacity-100" : "opacity-0"
        )}
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel */}
      <div
        className={classNames(
          "absolute right-0 top-0 h-full w-full sm:w-[560px] bg-white dark:bg-zinc-900 shadow-xl border-l border-zinc-200 dark:border-zinc-800 p-4 sm:p-6 overflow-y-auto",
          "transform transition-transform duration-300 will-change-transform",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const { theme, setTheme } = useTheme();
  const [tickers, setTickers] = useState<TickerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "gainers" | "losers">("all");
  const [selected, setSelected] = useState<TickerRow | null>(null);

  // Fetch & poll
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const data = await fetchTickers();
        if (!alive) return;
        setTickers(data);
        setError(null);
      } catch (e: any) {
        setError(e?.message || "Failed to load tickers");
      }
    }
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const filtered = useMemo(() => {
    if (!tickers) return [] as TickerRow[];
    const q = search.trim().toLowerCase();
    let list = tickers;
    if (q)
      list = list.filter(
        (t) =>
          t.symbol.toLowerCase().includes(q) || t.base.toLowerCase().includes(q)
      );
    if (filter === "gainers")
      list = list.filter(
        (t) => isFinite(t.priceChangePercent) && t.priceChangePercent >= 0
      );
    if (filter === "losers")
      list = list.filter(
        (t) => isFinite(t.priceChangePercent) && t.priceChangePercent < 0
      );

    const idx = list.findIndex((t) => t.symbol === PINNED_SYMBOL);
    if (idx > 0) {
      const [vanry] = list.splice(idx, 1);
      list = [vanry, ...list];
    }
    return list;
  }, [tickers, search, filter]);

  const reserveRightPadding = selected ? `lg:pr-[${DRAWER_W + 20}px]` : ""; // +20 for gutter

  return (
    // <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
    <div className="min-h-screen overflow-x-hidden bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      {/* Header */}
      <header className="sticky top-0 z-10 backdrop-blur supports-[backdrop-filter]:bg-white/70 dark:supports-[backdrop-filter]:bg-zinc-900/60 bg-white/90 dark:bg-zinc-900/80 border-b border-zinc-200 dark:border-zinc-800">
        <div
          className={classNames(
            "mx-auto w-full px-4 sm:px-6 py-3 flex items-center gap-3 transition-[padding] duration-300"
          )}
        >
          <div className="font-semibold tracking-tight text-lg sm:text-xl">
            Crypto Prices — USDT Pairs
          </div>
          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
            VANRY/USDT pinned
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              aria-label="Toggle dark mode"
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              <span className="text-sm hidden sm:inline">
                {theme === "dark" ? "Light" : "Dark"} mode
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* Controls */}
      <section
        className={classNames(
          "mx-auto w-full px-4 sm:px-6 mt-4 transition-[padding] duration-300"
        )}
      >
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 h-5 w-5 text-zinc-400" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSelected(null);
              }}
              placeholder="Search symbol (e.g., VANRY, BTC)…"
              className="w-full pl-10 pr-4 py-2 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="flex gap-2">
            {(
              [
                { key: "all", label: "All" },
                { key: "gainers", label: "Gainers" },
                { key: "losers", label: "Losers" },
              ] as const
            ).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => {
                  setFilter(key);
                  setSelected(null);
                }}
                className={classNames(
                  "px-3 py-2 rounded-xl border",
                  filter === key
                    ? "bg-indigo-600 text-white border-indigo-600"
                    : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                )}
                aria-pressed={filter === key}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* List */}
      <main
        className={classNames(
          "mx-auto w-full px-4 sm:px-6 mt-4 pb-24 transition-[padding] duration-300"
        )}
      >
        {error && (
          <div className="mb-4 p-3 rounded-lg border border-rose-300 bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:border-rose-900">
            Failed to load prices: {error}
          </div>
        )}
        {!tickers && !error && (
          <div className="text-sm text-zinc-500">Loading prices…</div>
        )}
        {tickers && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((t) => (
              <Row key={t.symbol} t={t} onClick={() => setSelected(t)} />
            ))}
          </div>
        )}
      </main>

      {/* Detail Drawer (kept mounted for smooth enter/exit) */}
      <Drawer open={!!selected} onClose={() => setSelected(null)}>
        {selected && (
          <>
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg sm:text-xl font-semibold">
                  {selected.base}/USDT
                </div>
                <div className="mt-1 flex items-center gap-3">
                  <div className="text-2xl font-bold tabular-nums">
                    {isFinite(selected.lastPrice)
                      ? fmt.format(selected.lastPrice)
                      : "—"}
                  </div>
                  <div
                    className={classNames(
                      "px-2 py-0.5 rounded-md text-sm font-medium",
                      selected.priceChangePercent >= 0
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                        : "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
                    )}
                  >
                    {isFinite(selected.priceChangePercent)
                      ? `${fmt2.format(selected.priceChangePercent)}% 24h`
                      : "—"}
                  </div>
                </div>
                <div className="text-xs text-zinc-500 mt-1">
                  Symbol: {selected.symbol} · 24h Quote Vol:{" "}
                  {fmt0.format(selected.quoteVolume)} USDT
                </div>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="p-2 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                aria-label="Close details"
              >
                <X />
              </button>
            </div>

            <div className="mt-6">
              <Chart symbol={selected.symbol} />
            </div>

            <div className="mt-3 pt-1 text-xs sm:text-sm text-zinc-500">
              Data source: Binance public API (spot). Times in your local
              timezone.
            </div>
          </>
        )}
      </Drawer>

      {/* Footer */}
      <footer className="border-t border-zinc-200 dark:border-zinc-800 py-6">
        <div className="mx-auto w-full px-4 sm:px-6 text-xs text-zinc-500 flex flex-wrap items-center gap-2">
          <span>Built with React + Tailwind + Recharts.</span>
          <span>Updates every {Math.round(POLL_MS / 1000)}s.</span>
          <span>VANRY/USDT is always shown first as requested.</span>
        </div>
      </footer>
    </div>
  );
}
