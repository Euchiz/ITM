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
import { t } from "../i18n/locale.js";

export function renderIO(host, ctx) {
  const trip = ctx.trip;
  const isOwner = ctx.role === "owner";
  const payload = tripToExportJson(trip);
  const json = JSON.stringify(payload, null, 2);

  host.appendChild(
    el("section", { class: "page-head" },
      el("h2", { text: t("io.title") }),
      el("p", { class: "muted", text: t("io.subtitleAlt") }),
    )
  );

  // ===== Export section =====
  const exportSec = el("section", { class: "card" },
    el("h3", { text: t("io.export") }),
    el("div", { class: "io-actions" },
      el("button", { class: "btn", onClick: () => copyToClipboard(json, t("io.copyJsonOk")) }, t("io.copyJson")),
      el("button", { class: "btn", onClick: () => download(filename(trip, "trip.json"), json, "application/json") }, t("io.downloadJson")),
      el("button", {
        class: "btn",
        onClick: () => copyToClipboard(aiEditPrompt(json), t("io.copyAiOk")),
      }, t("io.copyAi")),
      el("button", {
        class: "btn",
        onClick: () => download(filename(trip, "md"), tripToMarkdown(payload), "text/markdown"),
      }, t("io.downloadMd")),
    ),
    el("textarea", {
      class: "io-export-area", readonly: "readonly", rows: 16,
      onClick: (e) => e.target.select(),
    }, json),
  );
  host.appendChild(exportSec);

  // ===== Import section =====
  const importSec = el("section", { class: "card" },
    el("h3", { text: t("io.import") }),
    el("p", { class: "muted small", text: t("io.importHint") }),
  );

  const ta = el("textarea", { class: "io-import-area", rows: 8,
    placeholder: t("io.importPlaceholderAlt") });

  const previewHost = el("div", { class: "io-preview" });

  const validateBtn = el("button", { class: "btn primary",
    onClick: () => doValidate() }, t("io.validate"));

  const actions = el("div", { class: "io-actions io-import-actions", hidden: true });
  const createBtn = el("button", { class: "btn primary",
    onClick: () => doImport("create") }, t("io.createNew"));
  const replaceBtn = el("button", { class: "btn",
    onClick: () => doImport("replace") }, t("io.replace"));
  if (!isOwner) {
    replaceBtn.disabled = true;
    replaceBtn.title = t("io.replaceOnlyOwner");
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
      previewHost.appendChild(errorBlock(t("io.couldNotParse"), [parsed.error]));
      return;
    }
    const result = validate(parsed.data);
    if (!result.ok) {
      previewHost.appendChild(errorBlock(t("io.importFailedHead"), result.errors));
      return;
    }
    validatedPayload = result.data;
    previewHost.appendChild(previewBlock(validatedPayload));
    actions.hidden = false;
  }

  async function doImport(mode) {
    if (!validatedPayload) return;
    if (mode === "replace") {
      const ok = confirm(t("io.confirmReplaceWithTitle", { title: trip.title }));
      if (!ok) return;
    }
    ctx.onSaveStart?.();
    try {
      if (mode === "create") {
        const newId = await trips.createFromJson(validatedPayload);
        ctx.navigate?.({ trip: newId, page: "overview" });
      } else {
        await trips.replaceFromJson(trip.id, validatedPayload);
        await ctx.refresh();
        ctx.navigate?.({ trip: trip.id, page: "overview" });
      }
      previewHost.innerHTML = "";
      ta.value = "";
      actions.hidden = true;
    } catch (e) {
      previewHost.appendChild(errorBlock(t("io.serverRejected"), [e.message]));
    } finally {
      ctx.onSaveDone?.();
    }
  }
}

function previewBlock(p) {
  const trip = p.trip;
  const dayCount = (p.days || []).length;
  const itemCount = (p.days || []).reduce((s, d) => s + (d.items || []).length, 0);
  const todoCount = (p.days || []).reduce((s, d) => s + (d.todos || []).length, 0);
  const prepCount = (p.preparation_checklist || []).length;
  const noteCount = (p.notes || []).length;

  return el("div", { class: "io-preview-ok" },
    el("h4", { text: t("io.previewOk") }),
    el("ul", { class: "plain-list" },
      el("li", { html: `<strong>${escapeHtml(trip.title || t("io.previewUntitled"))}</strong>` }),
      trip.destination ? el("li", { text: trip.destination }) : null,
      (trip.start_date || trip.end_date)
        ? el("li", { text: fmtDateRange(trip.start_date, trip.end_date) })
        : null,
      el("li", { text: t("io.previewStats1", { days: dayCount, items: itemCount, todos: todoCount }) }),
      el("li", { text: t("io.previewStats2", { prep: prepCount, notes: noteCount }) }),
    ),
    el("p", { class: "muted small", text: t("io.previewChoose") }),
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
