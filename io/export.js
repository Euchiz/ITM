// Build the canonical export JSON from a loaded trip object.
//
// Input:  the shape returned by trips.getFull(id) — itinerary row with
//         nested days[].items[], top-level checklist_items[], notes[].
// Output: { schema_version: "trip_v1", trip, days, preparation_checklist, notes }

export function tripToExportJson(t) {
  const checklists = t.checklist_items || [];
  const prep = checklists.filter((c) => !c.day_id);
  const todosByDay = new Map();
  for (const c of checklists) {
    if (!c.day_id) continue;
    if (!todosByDay.has(c.day_id)) todosByDay.set(c.day_id, []);
    todosByDay.get(c.day_id).push(c);
  }

  const sortedDays = (t.days || []).slice().sort((a, b) => a.sort_order - b.sort_order);

  return {
    schema_version: "trip_v1",
    trip: {
      title: t.title || "",
      destination: t.destination || "",
      start_date: t.start_date || "",
      end_date: t.end_date || "",
      summary: t.summary || "",
      travelers: Array.isArray(t.travelers) ? t.travelers : [],
      general_notes: t.general_notes || "",
    },
    days: sortedDays.map((d) => ({
      date: d.date || "",
      title: d.title || "",
      city: d.city || "",
      notes: d.notes || "",
      items: (d.items || [])
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((it) => ({
          title: it.title || "",
          type: it.type,
          start_time: it.start_time || "",
          end_time: it.end_time || "",
          location_name: it.location_name || "",
          map_url: it.map_url || "",
          notes: it.notes || "",
          is_fixed: !!it.is_fixed,
          is_highlight: !!it.is_highlight,
          start_next_day: !!it.start_next_day,
          status: it.status,
        })),
      todos: (todosByDay.get(d.id) || [])
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((c) => ({
          text: c.text || "",
          category: c.category,
          due_date: c.due_date || "",
          is_done: !!c.is_done,
          notes: c.notes || "",
        })),
    })),
    preparation_checklist: prep
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => ({
        text: c.text || "",
        category: c.category,
        due_date: c.due_date || "",
        is_done: !!c.is_done,
        notes: c.notes || "",
      })),
    notes: (t.notes || [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((n) => ({
        title: n.title || "",
        body: n.body || "",
      })),
  };
}

/** AI-editing prompt template from guideline §13. */
export function aiEditPrompt(tripJsonString) {
  return `You are helping me edit a travel itinerary.

Please modify the trip JSON below while preserving the schema exactly.

Rules:
- Keep schema_version as "trip_v1".
- Use dates in YYYY-MM-DD format.
- Use times in HH:MM 24-hour format.
- Only use these item types: activity, food, transport, lodging, shopping, rest, note.
- Only use these item statuses: idea, planned, needs_booking, booked, done, cancelled.
- Only use these checklist categories: booking, document, packing, payment, transportation, health, other.
- Keep checklist items as text-based reminders only.
- Do not add file uploads.
- Represent file/document needs as text notes.
- Do not add comments outside the JSON.
- Return only valid JSON.

Object shapes (use these exact field names — strings unless noted; "" or [] when unknown):

  trip:
    title, destination, start_date, end_date, summary, general_notes
    travelers              array of strings

  days[]:
    date, title, city, notes
    items                  array of item objects (see below)
    todos                  array of day-todo objects (see below)

  days[].items[]:
    title, type, start_time, end_time, location_name, map_url, notes, status
    is_fixed               boolean (locked-in schedule, not movable)
    is_highlight           boolean (must-do / favourite of the trip)

  days[].todos[]:
    text, category, due_date, notes
    is_done                boolean

  preparation_checklist[]:
    text, category, due_date, notes
    is_done                boolean

  notes[]:
    title, body

Task:
[Write your request here]

Trip JSON:
${tripJsonString}
`;
}

/** Markdown-with-embedded-trip-json export (guideline §12). */
export function tripToMarkdown(payload) {
  const t = payload.trip;
  const dates = (t.start_date || t.end_date)
    ? `${t.start_date || "?"} to ${t.end_date || "?"}`
    : "";
  const travelers = (t.travelers && t.travelers.length) ? t.travelers.join(", ") : "";
  const lines = [];
  lines.push(`# ${t.title || "Untitled trip"}`);
  lines.push("");
  lines.push("This file is readable by humans and external AI.");
  lines.push("");
  lines.push("You can edit the JSON block below and import it back into the trip app.");
  lines.push("");
  lines.push("## Trip Summary");
  lines.push("");
  if (t.destination) lines.push(`Destination: ${t.destination}  `);
  if (dates) lines.push(`Dates: ${dates}  `);
  if (travelers) lines.push(`Travelers: ${travelers}`);
  lines.push("");
  if (t.summary) {
    lines.push("## Summary");
    lines.push("");
    lines.push(t.summary);
    lines.push("");
  }
  if (t.general_notes) {
    lines.push("## Human Notes");
    lines.push("");
    lines.push(t.general_notes);
    lines.push("");
  }
  lines.push("```trip-json");
  lines.push(JSON.stringify(payload, null, 2));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}
