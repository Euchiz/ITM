// Shared rendering helpers for page modules.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "checked" || k === "disabled" || k === "hidden") {
      if (v) node.setAttribute(k, "");
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const ch of children) {
    if (ch == null || ch === false) continue;
    if (Array.isArray(ch)) ch.forEach((c) => c != null && node.append(c));
    else if (typeof ch === "string" || typeof ch === "number") node.append(String(ch));
    else node.append(ch);
  }
  return node;
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fmtDateRange(a, b) {
  if (!a && !b) return "";
  if (a && b) return `${formatDate(a)} – ${formatDate(b)}`;
  return formatDate(a || b);
}

export function formatDate(s) {
  if (!s) return "";
  const d = new Date(s + "T00:00:00");
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatTimeRange(a, b) {
  if (!a && !b) return "";
  if (a && b) return `${formatTime(a)} – ${formatTime(b)}`;
  return formatTime(a || b);
}

export function formatTime(s) {
  if (!s) return "";
  // 'HH:MM:SS' or 'HH:MM'
  const m = String(s).match(/^(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : s;
}

/** Debounce save: returns a function you call after every keystroke; the
 *  underlying op runs once after `wait` ms of quiet. */
export function debouncedSave(fn, wait = 700) {
  let t = null;
  let pending = null;
  const run = async () => {
    const args = pending;
    pending = null;
    t = null;
    try { await fn(...args); } catch (e) { console.error(e); }
  };
  return (...args) => {
    pending = args;
    clearTimeout(t);
    t = setTimeout(run, wait);
  };
}

export function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

/** Wrap a save call so the global save indicator updates. */
export function withSaveIndicator(ctx, fn) {
  return async (...args) => {
    ctx.onSaveStart?.();
    try {
      return await fn(...args);
    } finally {
      ctx.onSaveDone?.();
    }
  };
}

export function mapsLink(url) {
  if (!url) return null;
  try { new URL(url); } catch { return null; }
  return url;
}

export function partition(arr, pred) {
  const yes = [], no = [];
  for (const x of arr) (pred(x) ? yes : no).push(x);
  return [yes, no];
}

/** Format a timestamp as a coarse "added X ago" label. Same bucket
 *  granularity as the topbar's LAST CHANGE so the UI feels consistent
 *  across surfaces. Returns null for missing/invalid input. */
export function formatRelativeTime(ts) {
  if (!ts) return null;
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  if (Number.isNaN(t)) return null;
  const delta = Math.max(0, Date.now() - t);
  const s = Math.floor(delta / 1000);
  if (s < 60)  return "just now";
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30)  return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Resolve a user_id to a display name using the trip's membersById
 *  map. Falls back to "Unknown" for missing UIDs (rows whose author
 *  has been deleted or whose member row hasn't been fetched yet). */
export function memberName(membersById, uid) {
  if (!uid) return null;
  const m = membersById && membersById[uid];
  if (!m) return null;
  return m.display_name || m.email || "Unknown";
}

/** Format integer minor-units (e.g. cents) in the given ISO currency.
 *  The minor-unit count depends on the currency — USD has 2 (cents),
 *  JPY has 0 (yen). Returns "" for null / undefined / NaN so callers
 *  can chain without a null check. The narrow-symbol style ("¥" instead
 *  of "JP¥") matches inline-cost real estate budgets on tight rows. */
export function formatMoney(cents, currency = "USD") {
  if (cents == null || Number.isNaN(Number(cents))) return "";
  const code = (currency || "USD").toUpperCase();
  const decimals = currencyMinorUnits(code);
  const major = Number(cents) / Math.pow(10, decimals);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: code, currencyDisplay: "narrowSymbol",
    }).format(major);
  } catch {
    // Unknown currency code — fall back to plain digits + the code.
    return `${major.toFixed(decimals)} ${code}`;
  }
}

/** Curated list of common currencies for the per-item override popover.
 *  Order roughly by traveler-popularity; the trip default is added
 *  separately at the top by the caller. */
export const COMMON_CURRENCIES = [
  "USD", "EUR", "JPY", "GBP", "CNY", "KRW", "AUD", "CAD",
  "HKD", "SGD", "TWD", "THB", "MXN", "BRL", "CHF",
];

/** Minor-unit count for an ISO currency. JPY/KRW use 0 decimals; USD/EUR
 *  use 2. The Intl-resolved value is the canonical answer; fall back to
 *  2 if the runtime doesn't know the code. */
export function currencyMinorUnits(code) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: (code || "USD").toUpperCase(),
    }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch { return 2; }
}

/** Parse a free-form amount the user typed (e.g. "1,500" or "15.50")
 *  into integer cents in the given currency. Returns null on empty /
 *  unparseable input — caller decides whether to clear the column or
 *  hold the previous value. */
export function parseAmountToCents(text, currency) {
  const cleaned = String(text ?? "").replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (Number.isNaN(n)) return null;
  return Math.round(n * Math.pow(10, currencyMinorUnits(currency)));
}

/** Inverse of parseAmountToCents — display-suitable text for a number
 *  input. JPY shows "1500", USD shows "15.00". Empty string for NULL. */
export function centsToAmountText(cents, currency) {
  if (cents == null) return "";
  const decimals = currencyMinorUnits(currency);
  const value = Number(cents) / Math.pow(10, decimals);
  return decimals === 0 ? String(value) : value.toFixed(decimals);
}

export function groupBy(arr, key) {
  const map = new Map();
  for (const x of arr) {
    const k = typeof key === "function" ? key(x) : x[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return map;
}
