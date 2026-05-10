// Import / Export page.
//
// Export side: copy JSON, download .trip.json, copy AI prompt + JSON,
//              download Markdown with embedded JSON block.
// Import side: paste box → parse → validate → preview → "Create new"
//              or "Replace current".

import { trips } from "../supabase.js";
import { tripToExportJson, aiEditPrompt, tripToMarkdown } from "../io/export.js";
import { parseImportText } from "../io/parser.js";
import { validate } from "../io/schema.js";
import { el, escapeHtml, fmtDateRange } from "./_utils.js";

export function renderIO(host, ctx) {
  const t = ctx.trip;
  const isOwner = ctx.role === "owner";
  const payload = tripToExportJson(t);
  const json = JSON.stringify(payload, null, 2);

  host.appendChild(
    el("section", { class: "page-head" },
      el("h2", { text: "Import / Export" }),
      el("p", { class: "muted",
        text: "Export your trip as JSON to share or feed into an AI assistant. Edit the JSON elsewhere, then paste it back to import." }),
    )
  );

  // ===== Export section =====
  const exportSec = el("section", { class: "card" },
    el("h3", { text: "Export" }),
    el("div", { class: "io-actions" },
      el("button", { class: "btn", onClick: () => copyToClipboard(json, "JSON copied") }, "Copy JSON"),
      el("button", { class: "btn", onClick: () => download(filename(t, "trip.json"), json, "application/json") }, "Download .trip.json"),
      el("button", {
        class: "btn",
        onClick: () => copyToClipboard(aiEditPrompt(json), "AI editing prompt copied"),
      }, "Copy AI prompt + JSON"),
      el("button", {
        class: "btn",
        onClick: () => download(filename(t, "md"), tripToMarkdown(payload), "text/markdown"),
      }, "Download Markdown"),
    ),
    el("textarea", {
      class: "io-export-area", readonly: "readonly", rows: 16,
      onClick: (e) => e.target.select(),
    }, json),
  );
  host.appendChild(exportSec);

  // ===== Import section =====
  const importSec = el("section", { class: "card" },
    el("h3", { text: "Import" }),
    el("p", { class: "muted small",
      text: "Paste a trip JSON object, a Markdown export with an embedded ```trip-json``` block, or any text containing one." }),
  );

  const ta = el("textarea", { class: "io-import-area", rows: 8,
    placeholder: "Paste trip JSON or Markdown here…" });

  const previewHost = el("div", { class: "io-preview" });

  const validateBtn = el("button", { class: "btn primary",
    onClick: () => doValidate() }, "Validate");

  const actions = el("div", { class: "io-actions io-import-actions", hidden: true });
  const createBtn = el("button", { class: "btn primary",
    onClick: () => doImport("create") }, "Create as new trip");
  const replaceBtn = el("button", { class: "btn",
    onClick: () => doImport("replace") }, "Replace current trip");
  if (!isOwner) {
    replaceBtn.disabled = true;
    replaceBtn.title = "Only the trip owner can replace it";
  }
  actions.append(createBtn, replaceBtn);

  importSec.append(ta, validateBtn, previewHost, actions);
  host.appendChild(importSec);

  let validatedPayload = null;

  function doValidate() {
    validatedPayload = null;
    actions.hidden = true;
    previewHost.innerHTML = "";

    const parsed = parseImportText(ta.value);
    if (!parsed.ok) {
      previewHost.appendChild(errorBlock("Could not parse", [parsed.error]));
      return;
    }
    const result = validate(parsed.data);
    if (!result.ok) {
      previewHost.appendChild(errorBlock("Import failed", result.errors));
      return;
    }
    validatedPayload = result.data;
    previewHost.appendChild(previewBlock(validatedPayload));
    actions.hidden = false;
  }

  async function doImport(mode) {
    if (!validatedPayload) return;
    const tripData = validatedPayload.trip;
    if (mode === "replace") {
      const ok = confirm(
        `Replace "${t.title}" with imported data? This deletes the current days, items, checklist, and notes.`
      );
      if (!ok) return;
    }
    ctx.onSaveStart?.();
    try {
      if (mode === "create") {
        const newId = await trips.createFromJson(validatedPayload);
        ctx.navigate?.({ trip: newId, page: "overview" });
      } else {
        await trips.replaceFromJson(t.id, validatedPayload);
        await ctx.refresh();
        ctx.navigate?.({ trip: t.id, page: "overview" });
      }
      previewHost.innerHTML = "";
      ta.value = "";
      actions.hidden = true;
    } catch (e) {
      previewHost.appendChild(errorBlock("Server rejected the import", [e.message]));
    } finally {
      ctx.onSaveDone?.();
    }
  }
}

function previewBlock(p) {
  const t = p.trip;
  const dayCount = (p.days || []).length;
  const itemCount = (p.days || []).reduce((s, d) => s + (d.items || []).length, 0);
  const todoCount = (p.days || []).reduce((s, d) => s + (d.todos || []).length, 0);
  const prepCount = (p.preparation_checklist || []).length;
  const noteCount = (p.notes || []).length;

  return el("div", { class: "io-preview-ok" },
    el("h4", { text: "Looks good — preview" }),
    el("ul", { class: "plain-list" },
      el("li", { html: `<strong>${escapeHtml(t.title || "Untitled")}</strong>` }),
      t.destination ? el("li", { text: t.destination }) : null,
      (t.start_date || t.end_date)
        ? el("li", { text: fmtDateRange(t.start_date, t.end_date) })
        : null,
      el("li", { text: `${dayCount} days · ${itemCount} items · ${todoCount} daily todos` }),
      el("li", { text: `${prepCount} preparation checklist items · ${noteCount} notes` }),
    ),
    el("p", { class: "muted small", text: "Choose how to import:" }),
  );
}

function errorBlock(heading, errors) {
  return el("div", { class: "io-preview-error" },
    el("h4", { text: heading }),
    el("ul", { class: "plain-list error-list" },
      ...errors.map((e) => el("li", { text: "- " + e }))
    ),
  );
}

function filename(trip, ext) {
  const base = (trip.title || "trip").trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "_");
  return `${base || "trip"}.${ext}`;
}

function download(name, content, mime) {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyToClipboard(text, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
    flashToast(successMsg);
  } catch {
    // Fallback: use a temporary textarea
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    flashToast(successMsg);
  }
}

function flashToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("error");
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 2200);
}
