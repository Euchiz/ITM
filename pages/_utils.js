// Shared rendering helpers for page modules.

import {
  formatDate as _formatDate,
  formatMonthDay as _formatMonthDay,
  formatTime as _formatTime,
  formatRelativeTime as _formatRelativeTime,
  formatMoney as _formatMoney,
  currencyMinorUnits as _currencyMinorUnits,
  formatWeekday as _formatWeekday,
} from "../i18n/locale.js";

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

export const formatDate = _formatDate;
export const formatMonthDay = _formatMonthDay;
export const formatWeekday = _formatWeekday;

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

export const formatTime = _formatTime;

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

/** Format a timestamp as a coarse "added X ago" label. Locale-aware via
 *  Intl.RelativeTimeFormat. Returns null for missing/invalid input. */
export const formatRelativeTime = _formatRelativeTime;

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
 *  Locale-aware. Returns "" for null/undefined/NaN. */
export const formatMoney = _formatMoney;

/** Curated list of common currencies for the per-item override popover.
 *  Order roughly by traveler-popularity; the trip default is added
 *  separately at the top by the caller. */
export const COMMON_CURRENCIES = [
  "USD", "EUR", "JPY", "GBP", "CNY", "KRW", "AUD", "CAD",
  "HKD", "SGD", "TWD", "THB", "MXN", "BRL", "CHF",
];

/** Minor-unit count for an ISO currency. JPY/KRW use 0 decimals; USD/EUR
 *  use 2. Falls back to 2 if the runtime doesn't know the code. */
export const currencyMinorUnits = _currencyMinorUnits;

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
