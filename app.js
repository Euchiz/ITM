import { parseMarkdown, serializeMarkdown, renderInline } from "./parser.js";
import { initCloud, getCloud } from "./supabase.js";

// ===== State =====

const state = {
  title: "",
  blocks: [],
  mode: "edit",
};

const LS_KEY = "itinerary-studio:doc";

// ===== Boot =====

window.addEventListener("DOMContentLoaded", async () => {
  bindToolbar();
  bindSettings();
  await initCloud(onCloudReady);
  restore();
  renderEditor();
});

// ===== Persistence (browser-local autosave) =====

function persist() {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ title: state.title, blocks: state.blocks })
    );
  } catch {}
}

function restore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      // Show empty state on first run.
      state.blocks = [];
      state.title = "";
      return;
    }
    const data = JSON.parse(raw);
    state.title = data.title || "";
    state.blocks = Array.isArray(data.blocks) ? data.blocks : [];
  } catch {
    state.blocks = [];
  }
  document.getElementById("docTitle").value = state.title;
}

// ===== Toolbar =====

function bindToolbar() {
  const titleInput = document.getElementById("docTitle");
  titleInput.addEventListener("input", () => {
    state.title = titleInput.value;
    persist();
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
    // Wait one frame so layout settles before invoking print.
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
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
  state.blocks = blocks;
  // If first block is an H1, lift it as the title.
  if (blocks.length && blocks[0].type === "h1") {
    state.title = blocks[0].text;
    state.blocks = blocks.slice(1);
  } else {
    state.title = fallbackTitle;
  }
  document.getElementById("docTitle").value = state.title;
  persist();
  renderEditor();
}

function currentMarkdown() {
  const head = state.title ? [{ type: "h1", text: state.title }] : [];
  return serializeMarkdown([...head, ...state.blocks]);
}

// ===== Editor rendering =====

const editorEl = () => document.getElementById("editor");

function renderEditor() {
  const root = editorEl();
  root.innerHTML = "";

  if (state.blocks.length === 0) {
    root.appendChild(emptyState());
    return;
  }

  // Insert add-between slots before each block, plus one at the end.
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
    state.blocks = [
      { type: "paragraph", text: "Start typing — or use the + buttons to add tables and headings." },
    ];
    document.getElementById("docTitle").value = state.title;
    persist();
    renderEditor();
  });
  return el;
}

function addBetween(idx) {
  const el = document.createElement("div");
  el.className = "add-between";
  el.innerHTML = `<button title="Insert block here">+ heading · paragraph · table</button>`;
  el.querySelector("button").addEventListener("click", (e) => {
    e.stopPropagation();
    showInsertMenu(el, idx);
  });
  return el;
}

function showInsertMenu(anchor, idx) {
  // Simple sequential menu: pick a type via prompt-less buttons.
  const menu = document.createElement("div");
  menu.style.cssText = `
    position:absolute; z-index:50; background:#fff; border:1px solid var(--border);
    border-radius:8px; box-shadow:var(--shadow); padding:6px; display:flex; gap:4px;
  `;
  const opts = [
    ["H2", () => insertBlock(idx, { type: "h2", text: "New section" })],
    ["H3", () => insertBlock(idx, { type: "h3", text: "New subsection" })],
    ["¶", () => insertBlock(idx, { type: "paragraph", text: "" })],
    ["⊞ Table", () =>
      insertBlock(idx, {
        type: "table",
        headers: ["Column A", "Column B"],
        rows: [["", ""], ["", ""]],
      })],
    ["“ Quote", () => insertBlock(idx, { type: "blockquote", text: "" })],
  ];
  for (const [label, fn] of opts) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "btn ghost";
    b.style.padding = "4px 10px";
    b.addEventListener("click", () => {
      fn();
      menu.remove();
    });
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
  persist();
  renderEditor();
}

function deleteBlock(idx) {
  state.blocks.splice(idx, 1);
  persist();
  renderEditor();
}

function moveBlock(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= state.blocks.length) return;
  const [b] = state.blocks.splice(idx, 1);
  state.blocks.splice(j, 0, b);
  persist();
  renderEditor();
}

function blockEl(block, idx) {
  const wrap = document.createElement("div");
  wrap.className = "block " + block.type;

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
    autosize(ta);
    ta.addEventListener("input", () => {
      block.text = ta.value;
      autosize(ta);
      persist();
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

// ===== Table editor =====

function tableEditor(block) {
  const wrap = document.createElement("div");
  wrap.className = "editor-table-wrap";

  const table = document.createElement("table");
  table.className = "editor-table";

  const thead = document.createElement("thead");
  thead.appendChild(headerRow(block));
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  block.rows.forEach((row, ri) => tbody.appendChild(bodyRow(block, ri)));
  table.appendChild(tbody);

  wrap.appendChild(table);

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
    persist();
    refreshTable(wrap, block);
  });
  toolbar.querySelector('[data-act="add-col"]').addEventListener("click", () => {
    block.headers.push("New column");
    block.rows.forEach((r) => r.push(""));
    persist();
    refreshTable(wrap, block);
  });
  toolbar.querySelector('[data-act="del-row"]').addEventListener("click", () => {
    if (block.rows.length > 0) block.rows.pop();
    persist();
    refreshTable(wrap, block);
  });
  toolbar.querySelector('[data-act="del-col"]').addEventListener("click", () => {
    if (block.headers.length > 1) {
      block.headers.pop();
      block.rows.forEach((r) => r.pop());
      persist();
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
    th.appendChild(makeCellEditor(h, (v) => { block.headers[ci] = v; persist(); }));
    tr.appendChild(th);
  });
  return tr;
}

function bodyRow(block, ri) {
  const tr = document.createElement("tr");
  block.rows[ri].forEach((cell, ci) => {
    const td = document.createElement("td");
    td.appendChild(makeCellEditor(cell, (v) => { block.rows[ri][ci] = v; persist(); }));
    tr.appendChild(td);
  });
  return tr;
}

function makeCellEditor(initial, onChange) {
  const ta = document.createElement("textarea");
  ta.className = "cell-edit";
  ta.value = initial || "";
  ta.rows = 1;
  ta.spellcheck = false;
  autosize(ta);
  ta.addEventListener("input", () => {
    autosize(ta);
    onChange(ta.value);
  });
  // Resize when first inserted into the DOM.
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

  // Cover: H1 + first run of paragraph blocks.
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

  for (const b of blocks) {
    out.push(renderBlock(b));
  }
  return out.join("\n");
}

function renderBlock(b) {
  switch (b.type) {
    case "h1": return `<h1>${escapeHtml(b.text)}</h1>`;
    case "h2": return `<h2>${escapeHtml(b.text)}</h2>`;
    case "h3": return `<h3>${escapeHtml(b.text)}</h3>`;
    case "paragraph": return `<p>${renderInline(b.text)}</p>`;
    case "blockquote":
      // Lines starting with "!" become "warn" callouts.
      const warn = /^\s*!/.test(b.text);
      const text = warn ? b.text.replace(/^\s*!\s*/, "") : b.text;
      return `<blockquote${warn ? ' class="warn"' : ""}>${renderInline(text)}</blockquote>`;
    case "table": return renderTable(b);
    default: return "";
  }
}

function renderTable(t) {
  const cls = tableClass(t);
  const head = `<tr>${t.headers.map((h) => `<th>${renderInline(h)}</th>`).join("")}</tr>`;
  const body = t.rows
    .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table${cls ? ` class="${cls}"` : ""}><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// Heuristic styling for known itinerary table shapes.
function tableClass(t) {
  const w = t.headers.length;
  const cls = ["compact"];
  // Bilingual: 2 columns whose headers contain "中文" or "English"
  if (w === 2) {
    const joined = t.headers.join(" ").toLowerCase();
    if (/中文|chinese|english/.test(joined)) cls.push("bilingual");
  }
  // Dated 3-col: first header looks like "Date" / "日期" / "Night"
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

async function loadCss(href) {
  try {
    const r = await fetch(href);
    return await r.text();
  } catch {
    return "";
  }
}

async function readPrintCss() {
  // Inline the print stylesheet so the exported HTML is fully self-contained.
  return await loadCss("./print.css");
}

let cachedPrintCss = null;
async function getPrintCss() {
  if (cachedPrintCss == null) cachedPrintCss = await readPrintCss();
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

// ===== Download helper =====

function download(name, content, mime) {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(s) {
  return String(s).trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "_") || "itinerary";
}

// ===== Toast =====

let toastTimer = null;
export function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

// ===== Settings dialog (Supabase config) =====

function bindSettings() {
  const dlg = document.getElementById("settingsDialog");
  const url = document.getElementById("sbUrl");
  const key = document.getElementById("sbKey");
  const owner = document.getElementById("sbOwner");

  document.getElementById("settingsBtn").addEventListener("click", () => {
    const cfg = readCloudConfig();
    url.value = cfg.url || "";
    key.value = cfg.key || "";
    owner.value = cfg.owner || "";
    dlg.showModal();
  });

  dlg.addEventListener("close", async () => {
    const action = dlg.returnValue;
    if (action === "connect") {
      writeCloudConfig({ url: url.value.trim(), key: key.value.trim(), owner: owner.value.trim() });
      await initCloud(onCloudReady);
    } else if (action === "disconnect") {
      writeCloudConfig({ url: "", key: "", owner: "" });
      await initCloud(onCloudReady);
    }
  });
}

function readCloudConfig() {
  try { return JSON.parse(localStorage.getItem("itinerary-studio:cloud") || "{}"); }
  catch { return {}; }
}
function writeCloudConfig(cfg) {
  localStorage.setItem("itinerary-studio:cloud", JSON.stringify(cfg));
}

async function onCloudReady(status) {
  const bar = document.getElementById("cloudBar");
  const statusEl = document.getElementById("cloudStatus");
  if (!status.connected) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  statusEl.textContent = `Connected · ${status.docCount} docs`;
  statusEl.classList.add("connected");

  const list = document.getElementById("cloudDocList");
  list.innerHTML = `<option value="">— pick a saved doc —</option>` +
    status.docs.map((d) =>
      `<option value="${d.id}">${escapeHtml(d.title || "(untitled)")}</option>`
    ).join("");

  document.getElementById("cloudLoad").onclick = async () => {
    const id = list.value;
    if (!id) return toast("Pick a document to load.");
    try {
      const doc = await getCloud().load(id);
      loadMarkdown(doc.markdown, doc.title);
      toast(`Loaded "${doc.title}".`);
    } catch (e) { toast(e.message, true); }
  };
  document.getElementById("cloudSave").onclick = async () => {
    if (!state.title) return toast("Set a title first.", true);
    try {
      await getCloud().save({ title: state.title, markdown: currentMarkdown() });
      toast(`Saved "${state.title}".`);
      await initCloud(onCloudReady); // refresh dropdown
    } catch (e) { toast(e.message, true); }
  };
  document.getElementById("cloudDelete").onclick = async () => {
    const id = list.value;
    if (!id) return toast("Pick a document first.");
    if (!confirm("Delete this saved itinerary from Supabase?")) return;
    try {
      await getCloud().remove(id);
      toast("Deleted.");
      await initCloud(onCloudReady);
    } catch (e) { toast(e.message, true); }
  };
}
