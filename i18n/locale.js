// Locale and translation runtime.
//
// One source of truth for the active UI locale, accessed by every
// formatter and every translated string. Persisted to localStorage so
// the user's choice survives reloads.
//
// Auto-detect rule (first load, no stored value): if navigator.language
// starts with "zh", pick "zh-CN"; otherwise fall back to "en".

import en from "./strings/en.js";
import zhCN from "./strings/zh-CN.js";

export const SUPPORTED = [
  { code: "en",    label: "English" },
  { code: "zh-CN", label: "中文 (简体)" },
];

const BUNDLES = { "en": en, "zh-CN": zhCN };
const FALLBACK = "en";
const STORAGE_KEY = "voyage:locale";
const EVENT = "voyage:locale-change";

let current = null;

function detectInitial() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && BUNDLES[stored]) return stored;
  } catch {}
  // Auto-detect from navigator.language. Per spec: "zh"-prefixed locales
  // -> Simplified Chinese; everything else -> English.
  try {
    const nav = (navigator.language || "").toLowerCase();
    if (nav.startsWith("zh")) return "zh-CN";
  } catch {}
  return FALLBACK;
}

/** Currently active locale code (e.g. "en", "zh-CN"). Never null. */
export function getLocale() {
  if (current == null) current = detectInitial();
  return current;
}

/** Persist an explicit user pick. Validates against SUPPORTED. Fires a
 *  `voyage:locale-change` event on window so listeners (re-render hooks,
 *  applyI18n) can react. */
export function setLocale(code) {
  if (!BUNDLES[code]) return;
  if (code === current) return;
  current = code;
  try { localStorage.setItem(STORAGE_KEY, code); } catch {}
  try { document.documentElement.lang = code; } catch {}
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { locale: code } }));
  } catch {}
}

/** Subscribe to locale changes. Returns an unsubscribe function. */
export function onLocaleChange(cb) {
  const handler = (e) => cb(e.detail?.locale || getLocale());
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

// ===== String lookup =====

function lookupRaw(key) {
  const loc = getLocale();
  const fromLoc = BUNDLES[loc]?.[key];
  if (fromLoc != null) return fromLoc;
  if (loc !== FALLBACK) {
    const fromFb = BUNDLES[FALLBACK]?.[key];
    if (fromFb != null) return fromFb;
  }
  return undefined;
}

function interpolate(s, vars) {
  if (!vars || typeof s !== "string") return s;
  return s.replace(/\{(\w+)\}/g, (m, name) => {
    return Object.prototype.hasOwnProperty.call(vars, name)
      ? String(vars[name])
      : m;
  });
}

/** Translate a key. Falls back to en, then to the key itself so a typo
 *  produces a visible breadcrumb instead of an empty string. Optional
 *  vars object supplies {placeholder} substitutions. */
export function t(key, vars) {
  const raw = lookupRaw(key);
  if (raw == null) return key;
  if (typeof raw === "string") return interpolate(raw, vars);
  // Plural form object — caller probably forgot to use plural(). Pick
  // "other" as the most useful default.
  if (raw && typeof raw === "object" && "other" in raw) {
    return interpolate(raw.other, vars);
  }
  return key;
}

/** Pick the plural form for n and interpolate {n} (plus any extra
 *  vars). Bundles store plural forms as { one, other, zero?, few?, ... }
 *  keyed by Intl.PluralRules categories. */
export function plural(key, n, vars) {
  const raw = lookupRaw(key);
  if (raw == null) return key;
  let forms;
  if (typeof raw === "string") forms = { other: raw };
  else if (raw && typeof raw === "object") forms = raw;
  else return key;
  let cat;
  try { cat = new Intl.PluralRules(getLocale()).select(n); }
  catch { cat = n === 1 ? "one" : "other"; }
  const form = forms[cat] || forms.other || forms.one || "";
  return interpolate(form, { n, ...vars });
}

// ===== Locale-aware formatters =====
//
// Every formatter reads getLocale() at call time, so a setLocale() +
// re-render is all that's needed to flip the UI.

/** ISO yyyy-mm-dd → localized short date. Returns input unchanged for
 *  unparseable values. */
export function formatDate(s, opts) {
  if (!s) return "";
  const d = new Date(s + "T00:00:00");
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString(getLocale(),
    opts || { month: "short", day: "numeric", year: "numeric" });
}

/** Date range "Mar 5 – Mar 12, 2026". */
export function formatDateRange(a, b) {
  if (!a && !b) return "";
  if (a && b) return `${formatDate(a)} – ${formatDate(b)}`;
  return formatDate(a || b);
}

/** A Date instance → localized weekday in the requested style ("short" /
 *  "long" / "narrow"). For "short" returns it upper-cased to match the
 *  day-strip's visual style. */
export function formatWeekday(date, style = "short") {
  try {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return "";
    const s = new Intl.DateTimeFormat(getLocale(), { weekday: style }).format(d);
    return style === "short" ? s.toUpperCase() : s;
  } catch { return ""; }
}

/** "Mar 5" — short month + day for compact contexts. */
export function formatMonthDay(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
}

/** "Friday, March 5, 2026" — long form used by the print view. */
export function formatLongDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(getLocale(), {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

/** Slice "HH:MM:SS" / "HH:MM" down to "HH:MM". The 12h vs 24h split is
 *  locale-driven elsewhere; here we just strip seconds. */
export function formatTime(s) {
  if (!s) return "";
  const m = String(s).match(/^(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : s;
}

/** Format a timestamp as a coarse "added X ago" label via
 *  Intl.RelativeTimeFormat. Returns null for missing/invalid input so
 *  callers can chain without a null check. */
export function formatRelativeTime(ts) {
  if (!ts) return null;
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  if (Number.isNaN(t)) return null;
  const delta = Math.max(0, Date.now() - t);
  const s = Math.floor(delta / 1000);
  if (s < 60) return tJustNow();
  let rtf;
  try { rtf = new Intl.RelativeTimeFormat(getLocale(), { style: "short", numeric: "always" }); }
  catch { return `${Math.floor(s / 60)}m ago`; }
  const m = Math.floor(s / 60);
  if (m < 60)  return rtf.format(-m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24)  return rtf.format(-h, "hour");
  const d = Math.floor(h / 24);
  if (d < 30)  return rtf.format(-d, "day");
  const mo = Math.floor(d / 30);
  if (mo < 12) return rtf.format(-mo, "month");
  return rtf.format(-Math.floor(mo / 12), "year");
}

function tJustNow() {
  // Used by formatRelativeTime and the topbar's "LAST CHANGE" indicator
  // alike. Routed through t() so each locale supplies its own phrasing.
  return t("topbar.justNow");
}

/** Format integer minor-units (cents) in the given ISO currency code.
 *  The minor-unit count is currency-driven (JPY=0, USD=2). Returns "" for
 *  null/NaN so callers can chain without null checks. */
export function formatMoney(cents, currency = "USD") {
  if (cents == null || Number.isNaN(Number(cents))) return "";
  const code = (currency || "USD").toUpperCase();
  const decimals = currencyMinorUnits(code);
  const major = Number(cents) / Math.pow(10, decimals);
  try {
    return new Intl.NumberFormat(getLocale(), {
      style: "currency", currency: code, currencyDisplay: "narrowSymbol",
    }).format(major);
  } catch {
    return `${major.toFixed(decimals)} ${code}`;
  }
}

/** Minor-unit count for an ISO currency. Locale doesn't affect this but
 *  we route it through Intl.NumberFormat for consistency. */
export function currencyMinorUnits(code) {
  try {
    return new Intl.NumberFormat(getLocale(), {
      style: "currency", currency: (code || "USD").toUpperCase(),
    }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch { return 2; }
}

// ===== DOM application =====
//
// Sweeps an element (or document) for [data-i18n*] attributes and sets
// the corresponding property. Idempotent — running it again on locale
// change just re-translates the same nodes.

export function applyI18n(root) {
  const host = root || document;
  host.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  host.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder));
  });
  host.querySelectorAll("[data-i18n-title]").forEach((node) => {
    node.setAttribute("title", t(node.dataset.i18nTitle));
  });
  host.querySelectorAll("[data-i18n-aria-label]").forEach((node) => {
    node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
  });
}

// Seed <html lang> from the resolved locale as early as possible so
// screen readers and the browser's spellchecker pick up the right one.
try { document.documentElement.lang = getLocale(); } catch {}
