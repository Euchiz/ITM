// Notes page. Trip-level notes only (per-day notes live on the day card
// in the Itinerary view; that's where they belong).

import { notes } from "../supabase.js";
import { el, debouncedSave, autosize, withSaveIndicator } from "./_utils.js";

export function renderNotes(host, ctx) {
  const t = ctx.trip;
  const readOnly = ctx.role === "viewer";

  const list = (t.notes || []).slice().sort((a, b) => a.sort_order - b.sort_order);

  host.appendChild(
    el("section", { class: "page-head" },
      el("h2", { text: "Notes" }),
      el("p", { class: "muted",
        text: "Free-form notes the whole trip should know — food preferences, file/document locations, emergency contacts, budget reminders." }),
      !readOnly
        ? el("button", { class: "btn primary", onClick: () => addNote() }, "+ Add note")
        : null,
    )
  );

  if (list.length === 0) {
    host.appendChild(
      el("div", { class: "empty-state" },
        el("h3", { text: "No notes yet" }),
        el("p", { text: "Use this space for things like “Hotel confirmation is in Gmail” or “Eva's parents prefer not too spicy food.”" }),
      )
    );
    return;
  }

  list.forEach((n) => host.appendChild(noteCard(n)));

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
    );
    return wrap;
  }

  async function addNote() {
    ctx.onSaveStart?.();
    try {
      await notes.add(t.id, {
        title: "",
        body: "",
        sort_order: list.length,
      });
      await ctx.refresh();
    } catch (e) {
      alert("Could not add note: " + e.message);
    } finally {
      ctx.onSaveDone?.();
    }
  }
}
