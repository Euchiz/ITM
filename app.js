// Itinerary Studio — orchestrator.
//
// Three views:
//   auth     — magic-link sign-in (rendered by auth.js)
//   trips    — all-trips list (rendered by trips.js)
//   editor   — block editor + render mode (rendered here)
//
// When Supabase is not configured, we silently fall back to a single
// browser-local document so the app is still usable for trying it out.

import { parseMarkdown, serializeMarkdown, renderInline } from "./parser.js";
import {
  initSupabase, isConfigured, configSource, auth, trips,
} from "./supabase.js";
import { renderAuthView } from "./auth.js";
import { renderTripsView } from "./trips.js";

// ===== State =====

const state = {
  view: "auth",                  // "auth" | "trips" | "editor"
  user: null,                    // auth user object
  itineraryId: null,             // uuid of currently-open trip (or null in guest mode)
  role: "owner",                 // role on the current trip
  title: "",
  blocks: [],
  mode: "edit",                  // "edit" | "render"
  dirty: false,
  saving: false,
  recoveryMode: false,           // true when arrived via password-reset link
};

const LOCAL_DOC_KEY = "itinerary-studio:guest-doc";

// ===== Boot =====

window.addEventListener("DOMContentLoaded", async () => {
  bindAppHeader();
  bindEditorToolbar();
  bindSettings();

  if (!isConfigured()) {
    // Guest mode: no backend, just an editor with localStorage backup.
    restoreGuestDoc();
    setView("editor");
    return;
  }

  await initSupabase();
  await auth.onChange(handleAuthChange);

  const session = await auth.getSession();
  state.user = session?.user || null;
  routeFromSession();
});

function handleAuthChange(event, session) {
  if (event === "PASSWORD_RECOVERY") {
    // User clicked a reset link; force them to set a new password before
    // doing anything else, even though Supabase has given them a session.
    state.recoveryMode = true;
    state.user = session?.user || null;
    paintHeader();
    setView("auth");
    return;
  }

  const wasUser = state.user;
  state.user = session?.user || null;
  paintHeader();
  // Only re-route on real transitions to avoid clobbering an open editor.
  if (!!state.user !== !!wasUser) routeFromSession();
}

function routeFromSession() {
  paintHeader();
  if (state.recoveryMode) {
    setView("auth");
    return;
  }
  if (!state.user) {
    setView("auth");
    return;
  }
  const url = new URL(location.href);
  const tripId = url.searchParams.get("trip");
  if (tripId) {
    openTrip(tripId);
  } else {
    setView("trips");
  }
}

// ===== View switching =====

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  const authEl = document.getElementById("view-auth");
  const tripsEl = document.getElementById("view-trips");
  const editor = document.getElementById("view-editor");

  authEl.hidden = view !== "auth";
  tripsEl.hidden = view !== "trips";
  editor.hidden = view !== "editor";

  if (view === "auth") {
    renderAuthView(authEl, {
      initialMode: state.recoveryMode ? "reset" : "sign-in",
      onPasswordReset: () => {
        state.recoveryMode = false;
        // Strip the recovery hash from the URL so a refresh doesn't replay it.
        history.replaceState(null, "", window.location.pathname + window.location.search);
        routeFromSession();
      },
    });
  } else if (view === "trips") {
    renderTripsView(tripsEl, {
      onOpen: openTrip,
      onCreate: openTrip,
    });
  } else if (view === "editor") {
    renderEditor();
  }

  paintHeader();
}

// ===== App header =====

function bindAppHeader() {
  // Hide the ⚙ button on deployments where Supabase config comes from
  // repo Secrets — end users shouldn't see dev-time connection settings.
  // Local override still works (configSource() === "local"), and an
  // ?settings=1 escape hatch reveals it for debugging against a deployed page.
  const url = new URL(location.href);
  const escapeHatch = url.searchParams.get("settings") === "1";
  const settingsBtn = document.getElementById("settingsBtn");
  if (configSource() === "baked" && !escapeHatch) settingsBtn.hidden = true;

  document.getElementById("signOutBtn").addEventListener("click", async () => {
    try { await auth.signOut(); }
    catch (e) { toast(e.message, true); }
  });

  document.getElementById("backToTripsBtn").addEventListener("click", () => {
    if (state.dirty && state.itineraryId) {
      // Best-effort save before leaving.
      saveNow().catch(() => {});
    }
    // Strip ?trip= from URL.
    const url = new URL(location.href);
    url.searchParams.delete("trip");
    history.replaceState(null, "", url);
    setView("trips");
  });
}

function paintHeader() {
  const userBadge = document.getElementById("userBadge");
  const signOutBtn = document.getElementById("signOutBtn");
  const backBtn = document.getElementById("backToTripsBtn");

  if (state.user && state.user.email) {
    userBadge.hidden = false;
    userBadge.textContent = state.user.email;
    signOutBtn.hidden = false;
  } else {
    userBadge.hidden = true;
    signOutBtn.hidden = true;
  }

  // Back-to-trips only relevant when in editor and signed in.
  backBtn.hidden = !(state.view === "editor" && state.user);
}

// ===== Trip loading =====

async function openTrip(id) {
  try {
    const row = await trips.get(id);
    state.itineraryId = row.id;
    state.role = row.role;
    state.title = row.title || "";
    state.blocks = parseMarkdown(row.markdown || "");
    state.dirty = false;
    state.mode = "edit";

    // Reflect in URL for refresh / share-as-link.
    const url = new URL(location.href);
    url.searchParams.set("trip", id);
    history.replaceState(null, "", url);

    setView("editor");
    paintSaveStatus("clean");
  } catch (e) {
    toast("Could not open: " + e.message, true);
    setView("trips");
  }
}

// ===== Guest (no-Supabase) doc cache =====

function restoreGuestDoc() {
  try {
    const raw = localStorage.getItem(LOCAL_DOC_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    state.title = data.title || "";
    state.blocks = Array.isArray(data.blocks) ? data.blocks : [];
  } catch {}
}

function persistGuestDoc() {
  try {
    localStorage.setItem(
      LOCAL_DOC_KEY,
      JSON.stringify({ title: state.title, blocks: state.blocks })
    );
  } catch {}
}

// ===== Editor toolbar =====

function bindEditorToolbar() {
  const titleInput = document.getElementById("docTitle");
  titleInput.addEventListener("input", () => {
    state.title = titleInput.value;
    onChange();
  });

  document.querySelectorAll(".mode-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  document.getElementById("importFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    loadMarkdown(text, file.name.replace(/\.md$/i, ""));
    e.target.value = "";
  });

  document.getElementById("loadSample").addEventListener("click", async () => {
    try {
      const res = await fetch("./sample.md");
      const text = await res.text();
      loadMarkdown(text, "Eva Graduation Trip (sample)");
    } catch {
      toast("Could not load sample.md", true);
    }
  });

  document.getElementById("exportMd").addEventListener("click", () => {
    const md = currentMarkdown();
    download(safeFilename(state.title || "itinerary") + ".md", md, "text/markdown");
  });

  document.getElementById("exportHtml").addEventListener("click", async () => {
    const css = await getPrintCss();
    download(
      safeFilename(state.title || "itinerary") + ".html",
      standaloneHtmlSync(css),
      "text/html"
    );
  });

  document.getElementById("printBtn").addEventListener("click", () => {
    setMode("render");
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  });

  document.getElementById("saveBtn").addEventListener("click", () => {
    saveNow().catch((e) => toast(e.message, true));
  });
}

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  document.querySelectorAll(".mode-toggle button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  if (mode === "render") renderPreview();
}

function loadMarkdown(text, fallbackTitle = "") {
  const blocks = parseMarkdown(text);
  let title = fallbackTitle;
  let body = blocks;
  if (blocks.length && blocks[0].type === "h1") {
    title = blocks[0].text;
    body = blocks.slice(1);
  }
  state.blocks = body;
  state.title = title;
  document.getElementById("docTitle").value = state.title;
  onChange();
  renderEditor();
}

function currentMarkdown() {
  const head = state.title ? [{ type: "h1", text: state.title }] : [];
  return serializeMarkdown([...head, ...state.blocks]);
}

// ===== Save flow =====

let saveTimer = null;

function onChange() {
  state.dirty = true;
  paintSaveStatus("dirty");

  if (state.itineraryId) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow().catch((e) => toast(e.message, true)), 1500);
  } else {
    persistGuestDoc();
  }
}

async function saveNow() {
  if (!state.itineraryId) {
    persistGuestDoc();
    return;
  }
  if (state.role === "viewer") {
    toast("View-only access — changes not saved.", true);
    return;
  }
  if (state.saving) return;
  state.saving = true;
  paintSaveStatus("saving");
  try {
    await trips.update(state.itineraryId, {
      title: state.title || "Untitled itinerary",
      markdown: currentMarkdown(),
    });
    state.dirty = false;
    paintSaveStatus("clean");
  } catch (e) {
    paintSaveStatus("error");
    throw e;
  } finally {
    state.saving = false;
  }
}

function paintSaveStatus(kind) {
  const el = document.getElementById("saveStatus");
  if (!el) return;
  el.dataset.kind = kind;
  el.textContent =
    kind === "saving" ? "Saving…" :
    kind === "dirty"  ? "Unsaved changes" :
    kind === "error"  ? "Save failed" :
                        "Saved";
  // Hide entirely in guest mode (no itinerary to save against).
  el.hidden = !state.itineraryId;
}

// Save before leaving / closing.
window.addEventListener("beforeunload", (e) => {
  if (state.dirty && state.itineraryId) {
    saveNow().catch(() => {});
    e.preventDefault();
    e.returnValue = "";
  }
});

// ===== Editor rendering =====

const editorEl = () => document.getElementById("editor");

function renderEditor() {
  const titleInput = document.getElementById("docTitle");
  titleInput.value = state.title || "";
  titleInput.disabled = state.role === "viewer";

  const root = editorEl();
  root.innerHTML = "";

  if (state.blocks.length === 0) {
    root.appendChild(emptyState());
    return;
  }

  state.blocks.forEach((block, idx) => {
    root.appendChild(addBetween(idx));
    root.appendChild(blockEl(block, idx));
  });
  root.appendChild(addBetween(state.blocks.length));
}

function emptyState() {
  const el = document.createElement("div");
  el.className = "empty-state";
  el.innerHTML = `
    <h2>Start your itinerary</h2>
    <p>Import a markdown file, load the sample, or build from scratch.</p>
    <div class="actions">
      <button class="btn primary" id="es-sample">Load sample</button>
      <button class="btn" id="es-blank">Start blank</button>
    </div>
  `;
  el.querySelector("#es-sample").addEventListener("click", () =>
    document.getElementById("loadSample").click()
  );
  el.querySelector("#es-blank").addEventListener("click", () => {
    state.title = state.title || "Untitled itinerary";
    state.blocks = [{ type: "paragraph", text: "Start typing — or use the + buttons to add tables and headings." }];
    document.getElementById("docTitle").value = state.title;
    onChange();
    renderEditor();
  });
  return el;
}

function addBetween(idx) {
  const el = document.createElement("div");
  el.className = "add-between";
  el.innerHTML = `<button title="Insert block here">+ heading · paragraph · table</button>`;
  if (state.role === "viewer") {
    el.style.display = "none";
    return el;
  }
  el.querySelector("button").addEventListener("click", (e) => {
    e.stopPropagation();
    showInsertMenu(el, idx);
  });
  return el;
}

function showInsertMenu(anchor, idx) {
  const menu = document.createElement("div");
  menu.style.cssText = `
    position:absolute; z-index:50; background:#fff; border:1px solid var(--border);
    border-radius:8px; box-shadow:var(--shadow); padding:6px; display:flex; gap:4px;
  `;
  const opts = [
    ["H2", () => insertBlock(idx, { type: "h2", text: "New section" })],
    ["H3", () => insertBlock(idx, { type: "h3", text: "New subsection" })],
    ["¶", () => insertBlock(idx, { type: "paragraph", text: "" })],
    ["⊞ Table", () => insertBlock(idx, { type: "table", headers: ["Column A", "Column B"], rows: [["", ""], ["", ""]] })],
    ["“ Quote", () => insertBlock(idx, { type: "blockquote", text: "" })],
  ];
  for (const [label, fn] of opts) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "btn ghost";
    b.style.padding = "4px 10px";
    b.addEventListener("click", () => { fn(); menu.remove(); });
    menu.appendChild(b);
  }
  const rect = anchor.getBoundingClientRect();
  menu.style.left = window.scrollX + rect.left + rect.width / 2 - 140 + "px";
  menu.style.top = window.scrollY + rect.bottom + 4 + "px";
  document.body.appendChild(menu);
  const close = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("mousedown", close);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

function insertBlock(idx, block) {
  state.blocks.splice(idx, 0, block);
  onChange();
  renderEditor();
}
function deleteBlock(idx) {
  state.blocks.splice(idx, 1);
  onChange();
  renderEditor();
}
function moveBlock(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= state.blocks.length) return;
  const [b] = state.blocks.splice(idx, 1);
  state.blocks.splice(j, 0, b);
  onChange();
  renderEditor();
}

function blockEl(block, idx) {
  const wrap = document.createElement("div");
  wrap.className = "block " + block.type;

  if (state.role !== "viewer") {
    const controls = document.createElement("div");
    controls.className = "block-controls";
    controls.innerHTML = `
      <button title="Move up" data-act="up">↑</button>
      <button title="Move down" data-act="down">↓</button>
      <button title="Delete" data-act="del" class="del">✕</button>
    `;
    controls.querySelector('[data-act="up"]').addEventListener("click", () => moveBlock(idx, -1));
    controls.querySelector('[data-act="down"]').addEventListener("click", () => moveBlock(idx, +1));
    controls.querySelector('[data-act="del"]').addEventListener("click", () => deleteBlock(idx));
    wrap.appendChild(controls);
  }

  const tag = document.createElement("span");
  tag.className = "block-type-tag";
  tag.textContent = block.type;
  wrap.appendChild(tag);

  if (block.type === "table") {
    wrap.appendChild(tableEditor(block));
  } else {
    const ta = document.createElement("textarea");
    ta.className = "block-edit-input";
    ta.value = block.text || "";
    ta.rows = 1;
    ta.spellcheck = false;
    ta.disabled = state.role === "viewer";
    autosize(ta);
    ta.addEventListener("input", () => {
      block.text = ta.value;
      autosize(ta);
      onChange();
    });
    if (block.type === "h1" || block.type === "h2" || block.type === "h3") {
      ta.placeholder = block.type.toUpperCase() + " heading";
    } else if (block.type === "blockquote") {
      ta.placeholder = "Note / callout";
    } else {
      ta.placeholder = "Write a paragraph…";
    }
    wrap.appendChild(ta);
  }
  return wrap;
}

function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

// ===== Editable tables =====

function tableEditor(block) {
  const wrap = document.createElement("div");
  wrap.className = "editor-table-wrap";

  const table = document.createElement("table");
  table.className = "editor-table";
  const thead = document.createElement("thead");
  thead.appendChild(headerRow(block));
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  block.rows.forEach((_, ri) => tbody.appendChild(bodyRow(block, ri)));
  table.appendChild(tbody);
  wrap.appendChild(table);

  if (state.role === "viewer") return wrap;

  const toolbar = document.createElement("div");
  toolbar.className = "table-toolbar";
  toolbar.innerHTML = `
    <button data-act="add-row">+ row</button>
    <button data-act="add-col">+ column</button>
    <button data-act="del-row">– row</button>
    <button data-act="del-col">– column</button>
  `;
  toolbar.querySelector('[data-act="add-row"]').addEventListener("click", () => {
    block.rows.push(block.headers.map(() => ""));
    onChange();
    refreshTable(wrap, block);
  });
  toolbar.querySelector('[data-act="add-col"]').addEventListener("click", () => {
    block.headers.push("New column");
    block.rows.forEach((r) => r.push(""));
    onChange();
    refreshTable(wrap, block);
  });
  toolbar.querySelector('[data-act="del-row"]').addEventListener("click", () => {
    if (block.rows.length > 0) block.rows.pop();
    onChange();
    refreshTable(wrap, block);
  });
  toolbar.querySelector('[data-act="del-col"]').addEventListener("click", () => {
    if (block.headers.length > 1) {
      block.headers.pop();
      block.rows.forEach((r) => r.pop());
      onChange();
      refreshTable(wrap, block);
    }
  });
  wrap.appendChild(toolbar);
  return wrap;
}

function refreshTable(wrap, block) {
  const old = wrap.querySelector("table");
  const fresh = document.createElement("table");
  fresh.className = "editor-table";
  const thead = document.createElement("thead");
  thead.appendChild(headerRow(block));
  fresh.appendChild(thead);
  const tbody = document.createElement("tbody");
  block.rows.forEach((_, ri) => tbody.appendChild(bodyRow(block, ri)));
  fresh.appendChild(tbody);
  old.replaceWith(fresh);
}

function headerRow(block) {
  const tr = document.createElement("tr");
  block.headers.forEach((h, ci) => {
    const th = document.createElement("th");
    th.appendChild(makeCellEditor(h, (v) => { block.headers[ci] = v; onChange(); }));
    tr.appendChild(th);
  });
  return tr;
}

function bodyRow(block, ri) {
  const tr = document.createElement("tr");
  block.rows[ri].forEach((cell, ci) => {
    const td = document.createElement("td");
    td.appendChild(makeCellEditor(cell, (v) => { block.rows[ri][ci] = v; onChange(); }));
    tr.appendChild(td);
  });
  return tr;
}

function makeCellEditor(initial, onChangeCb) {
  const ta = document.createElement("textarea");
  ta.className = "cell-edit";
  ta.value = initial || "";
  ta.rows = 1;
  ta.spellcheck = false;
  ta.disabled = state.role === "viewer";
  autosize(ta);
  ta.addEventListener("input", () => {
    autosize(ta);
    onChangeCb(ta.value);
  });
  setTimeout(() => autosize(ta), 0);
  return ta;
}

// ===== Render mode =====

function renderPreview() {
  const root = document.getElementById("render");
  root.innerHTML = renderHtmlBody(state.title, state.blocks);
}

function renderHtmlBody(title, blocks) {
  const out = [];
  if (title) {
    const coverParts = [`<h1>${escapeHtml(title)}</h1>`];
    let i = 0;
    while (i < blocks.length && blocks[i].type === "paragraph") {
      const cls = i === 0 ? ' class="first-after"' : "";
      coverParts.push(`<p${cls}>${renderInline(blocks[i].text)}</p>`);
      i++;
    }
    out.push(`<section class="cover">${coverParts.join("")}</section>`);
    blocks = blocks.slice(i);
  }
  for (const b of blocks) out.push(renderBlock(b));
  return out.join("\n");
}

function renderBlock(b) {
  switch (b.type) {
    case "h1": return `<h1>${escapeHtml(b.text)}</h1>`;
    case "h2": return `<h2>${escapeHtml(b.text)}</h2>`;
    case "h3": return `<h3>${escapeHtml(b.text)}</h3>`;
    case "paragraph": return `<p>${renderInline(b.text)}</p>`;
    case "blockquote": {
      const warn = /^\s*!/.test(b.text);
      const text = warn ? b.text.replace(/^\s*!\s*/, "") : b.text;
      return `<blockquote${warn ? ' class="warn"' : ""}>${renderInline(text)}</blockquote>`;
    }
    case "table": return renderTable(b);
    default: return "";
  }
}

function renderTable(t) {
  const cls = tableClass(t);
  const head = `<tr>${t.headers.map((h) => `<th>${renderInline(h)}</th>`).join("")}</tr>`;
  const body = t.rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("");
  return `<table${cls ? ` class="${cls}"` : ""}><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function tableClass(t) {
  const w = t.headers.length;
  const cls = ["compact"];
  if (w === 2) {
    const joined = t.headers.join(" ").toLowerCase();
    if (/中文|chinese|english/.test(joined)) cls.push("bilingual");
  }
  if (w === 3) {
    const h0 = t.headers[0].toLowerCase();
    if (/date|日期|day|night|时间/.test(h0)) cls.push("dated");
  }
  return cls.join(" ");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ===== Standalone HTML export =====

let cachedPrintCss = null;
async function getPrintCss() {
  if (cachedPrintCss == null) {
    try { cachedPrintCss = await (await fetch("./print.css")).text(); }
    catch { cachedPrintCss = ""; }
  }
  return cachedPrintCss;
}

function standaloneHtmlSync(css) {
  const body = renderHtmlBody(state.title, state.blocks);
  const title = state.title || "Itinerary";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { margin: 0; background: #e9edf3; }
.printable { max-width: 8.5in; margin: 24px auto; padding: 0.6in 0.55in; background:#fff; box-shadow: 0 6px 28px rgba(20,30,50,0.12); }
@media print { body { background:#fff; } .printable { max-width:none; margin:0; padding:0; box-shadow:none; } }
${css}
</style>
</head>
<body>
<article class="printable">
${body}
</article>
</body>
</html>
`;
}

// ===== Download / toast =====

function download(name, content, mime) {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(s) {
  return String(s).trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "_") || "itinerary";
}

let toastTimer = null;
export function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ===== Settings dialog (Supabase config) =====

function bindSettings() {
  const dlg = document.getElementById("settingsDialog");
  const url = document.getElementById("sbUrl");
  const key = document.getElementById("sbKey");

  document.getElementById("settingsBtn").addEventListener("click", () => {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem("itinerary-studio:cloud") || "{}"); } catch {}
    url.value = stored.url || "";
    key.value = stored.key || "";
    document.getElementById("sbConfigSource").textContent =
      "Currently using config from: " + configSource();
    dlg.showModal();
  });

  dlg.addEventListener("close", async () => {
    const action = dlg.returnValue;
    if (action === "connect") {
      localStorage.setItem("itinerary-studio:cloud", JSON.stringify({
        url: url.value.trim(), key: key.value.trim(),
      }));
      location.reload();
    } else if (action === "disconnect") {
      localStorage.removeItem("itinerary-studio:cloud");
      location.reload();
    }
  });
}
