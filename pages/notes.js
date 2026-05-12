// Notes page. Trip-level notes only (per-day notes live on the day card
// in the Itinerary view; that's where they belong).
//
// "+ Add note" creates an in-memory draft that is only written to the
// database the first time the user types non-empty content. This keeps
// blank notes from accumulating when the button is clicked exploratively
// (issue #2).

import { notes } from "../supabase.js";
import {
  el, debouncedSave, autosize, withSaveIndicator,
  formatRelativeTime, memberName,
} from "./_utils.js";

export function renderNotes(host, ctx) {
  const t = ctx.trip;
  const readOnly = ctx.role === "viewer";

  const list = (t.notes || []).slice().sort((a, b) => a.sort_order - b.sort_order);

  const cardsHost = el("div", { class: "notes-list" });

  host.appendChild(
    el("section", { class: "page-head" },
      el("h2", { text: "Notes" }),
      el("p", { class: "muted",
        text: "Free-form notes the whole trip should know — food preferences, document locations, emergency contacts." }),
      !readOnly
        ? el("button", { class: "btn primary", onClick: () => addDraftNote() }, "+ Add note")
        : null,
    )
  );
  host.appendChild(cardsHost);

  if (list.length === 0) {
    cardsHost.appendChild(emptyHint());
  } else {
    list.forEach((n) => cardsHost.appendChild(noteCard(n)));
  }

  function emptyHint() {
    return el("div", { class: "empty-state notes-empty" },
      el("h3", { text: "No notes yet" }),
      el("p", { text: readOnly ? "Nothing here." : "Click + Add note to start." }),
    );
  }

  function clearEmptyHint() {
    cardsHost.querySelector(".notes-empty")?.remove();
  }

  /** Render an existing, persisted note (with a row id). */
  function noteCard(n) {
    const save = debouncedSave(withSaveIndicator(ctx, async (patch) => {
      await notes.update(n.id, patch);
      Object.assign(n, patch);
    }), 700);

    const wrap = el("section", { class: "card note-card" });

    const titleInput = el("input", {
      type: "text", value: n.title || "", placeholder: "Note title",
      class: "note-title-input", disabled: readOnly,
    });
    titleInput.addEventListener("input", () => save({ title: titleInput.value }));

    const bodyTa = el("textarea", {
      class: "block-edit-input note-body",
      placeholder: "Write the note…",
      disabled: readOnly, rows: 3,
    });
    bodyTa.value = n.body || "";
    setTimeout(() => autosize(bodyTa), 0);
    bodyTa.addEventListener("input", () => { autosize(bodyTa); save({ body: bodyTa.value }); });

    // Attribution footer — rendered only when we can resolve the
    // creator's display name from the trip roster. Mirrors the
    // pattern used in the itinerary editor.
    const author = memberName(ctx.membersById, n.created_by);
    const when   = formatRelativeTime(n.created_at);
    const attribution = author
      ? el("p", { class: "note-attribution muted small",
          text: when ? `Added by ${author} · ${when}` : `Added by ${author}` })
      : null;

    wrap.append(
      el("header", { class: "note-header" },
        titleInput,
        !readOnly
          ? el("button", {
              class: "icon-btn danger",
              title: "Delete note",
              onClick: async () => {
                if (!confirm("Delete this note?")) return;
                ctx.onSaveStart?.();
                try {
                  await notes.remove(n.id);
                  await ctx.refresh();
                } catch (e) {
                  alert("Delete failed: " + e.message);
                } finally {
                  ctx.onSaveDone?.();
                }
              },
            }, "✕")
          : null,
      ),
      bodyTa,
      attribution,
    );
    return wrap;
  }

  /**
   * Render a draft note that is not yet in the database. The first
   * non-empty input promotes it into a real note via notes.add(); after
   * that, behaviour matches a normal noteCard. Discarding the draft
   * just removes it from the DOM — nothing was persisted.
   */
  function addDraftNote() {
    if (cardsHost.querySelector(".note-card.draft")) {
      // Reuse the existing empty draft instead of stacking more.
      cardsHost.querySelector(".note-card.draft input")?.focus();
      return;
    }
    clearEmptyHint();

    const wrap = el("section", { class: "card note-card draft" });
    let row = null; // becomes set once promoted

    const titleInput = el("input", {
      type: "text", value: "", placeholder: "Note title",
      class: "note-title-input",
    });
    const bodyTa = el("textarea", {
      class: "block-edit-input note-body",
      placeholder: "Write the note…",
      rows: 3,
    });
    setTimeout(() => autosize(bodyTa), 0);

    let pendingPromotion = false;

    async function promoteIfNeeded() {
      if (row || pendingPromotion) return;
      const title = titleInput.value;
      const body = bodyTa.value;
      if (!title.trim() && !body.trim()) return;
      pendingPromotion = true;
      ctx.onSaveStart?.();
      try {
        row = await notes.add(t.id, {
          title, body,
          sort_order: (t.notes?.length || 0),
        });
        // Mirror the new row into the in-memory trip so subsequent
        // refreshes reconcile cleanly.
        (t.notes ||= []).push(row);
        wrap.classList.remove("draft");
      } catch (e) {
        alert("Could not save note: " + e.message);
        wrap.remove();
        if ((t.notes?.length || 0) === 0) cardsHost.appendChild(emptyHint());
      } finally {
        pendingPromotion = false;
        ctx.onSaveDone?.();
      }
    }

    const saveExisting = (patch) => {
      ctx.onSaveStart?.();
      notes.update(row.id, patch)
        .then(() => Object.assign(row, patch))
        .catch((e) => alert("Save failed: " + e.message))
        .finally(() => ctx.onSaveDone?.());
    };
    const debouncedExisting = debounce(saveExisting, 700);

    titleInput.addEventListener("input", async () => {
      await promoteIfNeeded();
      if (row) debouncedExisting({ title: titleInput.value });
    });
    bodyTa.addEventListener("input", async () => {
      autosize(bodyTa);
      await promoteIfNeeded();
      if (row) debouncedExisting({ body: bodyTa.value });
    });

    const discardBtn = el("button", {
      class: "icon-btn danger",
      title: "Delete note",
      onClick: async () => {
        if (row) {
          if (!confirm("Delete this note?")) return;
          ctx.onSaveStart?.();
          try {
            await notes.remove(row.id);
            await ctx.refresh();
          } catch (e) {
            alert("Delete failed: " + e.message);
          } finally {
            ctx.onSaveDone?.();
          }
        } else {
          // Draft only — discard locally.
          wrap.remove();
          if ((t.notes?.length || 0) === 0) cardsHost.appendChild(emptyHint());
        }
      },
    }, "✕");

    wrap.append(
      el("header", { class: "note-header" }, titleInput, discardBtn),
      bodyTa,
    );
    cardsHost.appendChild(wrap);
    titleInput.focus();
  }
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
