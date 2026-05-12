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

export function groupBy(arr, key) {
  const map = new Map();
  for (const x of arr) {
    const k = typeof key === "function" ? key(x) : x[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return map;
}
