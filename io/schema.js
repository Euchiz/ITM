// Trip JSON schema + validator. Pure, no I/O.
//
// validate(payload) → { ok: true, data } | { ok: false, errors: [string] }
//
// Errors are formatted human-readable (matches the example in the
// guideline doc §15) so the import preview can show them verbatim.

export const ITEM_TYPES = ["activity","food","transport","lodging","shopping","rest","note"];
export const ITEM_STATUSES = ["idea","planned","needs_booking","booked","done","cancelled"];
export const CHECKLIST_CATEGORIES = ["booking","document","packing","payment","transportation","health","other"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function isStr(v) { return typeof v === "string"; }
function isBool(v) { return typeof v === "boolean"; }
function isArr(v) { return Array.isArray(v); }
function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }

function validDate(s) {
  if (!isStr(s) || !DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime());
}

function validTime(s) {
  return isStr(s) && TIME_RE.test(s);
}

export function validate(payload) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  if (!isObj(payload)) return { ok: false, errors: ["Top-level value must be an object."] };
  if (payload.schema_version !== "trip_v1") {
    push(`schema_version must equal "trip_v1" (got ${JSON.stringify(payload.schema_version)}).`);
  }

  const trip = payload.trip;
  if (!isObj(trip)) {
    push("Missing or invalid `trip` object.");
  } else {
    if (!isStr(trip.title) || !trip.title.trim()) push("trip.title is required.");
    if (trip.start_date != null && trip.start_date !== "" && !validDate(trip.start_date)) {
      push(`trip.start_date must be YYYY-MM-DD (got ${JSON.stringify(trip.start_date)}).`);
    }
    if (trip.end_date != null && trip.end_date !== "" && !validDate(trip.end_date)) {
      push(`trip.end_date must be YYYY-MM-DD (got ${JSON.stringify(trip.end_date)}).`);
    }
    if (trip.travelers != null && !isArr(trip.travelers)) push("trip.travelers must be an array.");
  }

  const days = payload.days;
  if (days != null && !isArr(days)) {
    push("days must be an array.");
  } else if (isArr(days)) {
    days.forEach((d, di) => {
      const where = `Day ${di + 1}`;
      if (!isObj(d)) { push(`${where} must be an object.`); return; }
      if (d.date != null && d.date !== "" && !validDate(d.date)) {
        push(`${where} has invalid date: ${JSON.stringify(d.date)}. Use YYYY-MM-DD.`);
      }
      if (d.items != null && !isArr(d.items)) push(`${where}.items must be an array.`);
      if (d.todos != null && !isArr(d.todos)) push(`${where}.todos must be an array.`);

      (d.items || []).forEach((it, ii) => {
        const w = `${where} item "${it?.title || `#${ii + 1}`}"`;
        if (!isObj(it)) { push(`${w} must be an object.`); return; }
        if (it.type != null && !ITEM_TYPES.includes(it.type)) {
          push(`${w} has invalid type: ${JSON.stringify(it.type)}.\n  Allowed values: ${ITEM_TYPES.join(", ")}.`);
        }
        if (it.status != null && !ITEM_STATUSES.includes(it.status)) {
          push(`${w} has invalid status: ${JSON.stringify(it.status)}.\n  Allowed values: ${ITEM_STATUSES.join(", ")}.`);
        }
        if (it.start_time && !validTime(it.start_time)) {
          push(`${w} start_time must be HH:MM (got ${JSON.stringify(it.start_time)}).`);
        }
        if (it.end_time && !validTime(it.end_time)) {
          push(`${w} end_time must be HH:MM (got ${JSON.stringify(it.end_time)}).`);
        }
        if (it.is_fixed != null && !isBool(it.is_fixed)) push(`${w}.is_fixed must be true or false.`);
        if (it.is_highlight != null && !isBool(it.is_highlight)) push(`${w}.is_highlight must be true or false.`);
      });

      (d.todos || []).forEach((t, ti) => {
        const w = `${where} todo "${t?.text || `#${ti + 1}`}"`;
        if (!isObj(t)) { push(`${w} must be an object.`); return; }
        if (t.category != null && !CHECKLIST_CATEGORIES.includes(t.category)) {
          push(`${w} has invalid category: ${JSON.stringify(t.category)}.\n  Allowed values: ${CHECKLIST_CATEGORIES.join(", ")}.`);
        }
        if (t.is_done != null && !isBool(t.is_done)) push(`${w}.is_done must be true or false.`);
      });
    });
  }

  const prep = payload.preparation_checklist;
  if (prep != null && !isArr(prep)) {
    push("preparation_checklist must be an array.");
  } else if (isArr(prep)) {
    prep.forEach((c, ci) => {
      const w = `Preparation item "${c?.text || `#${ci + 1}`}"`;
      if (!isObj(c)) { push(`${w} must be an object.`); return; }
      if (c.category != null && !CHECKLIST_CATEGORIES.includes(c.category)) {
        push(`${w} has invalid category: ${JSON.stringify(c.category)}.\n  Allowed values: ${CHECKLIST_CATEGORIES.join(", ")}.`);
      }
      if (c.due_date != null && c.due_date !== "" && !validDate(c.due_date)) {
        push(`${w} has invalid due_date: ${JSON.stringify(c.due_date)}. Use YYYY-MM-DD.`);
      }
      if (c.is_done != null && !isBool(c.is_done)) push(`${w}.is_done must be true or false.`);
    });
  }

  const noteList = payload.notes;
  if (noteList != null && !isArr(noteList)) push("notes must be an array.");

  if (errors.length) return { ok: false, errors };
  return { ok: true, data: normalize(payload) };
}

/** Fill in safe defaults so the rest of the code can rely on shape. */
function normalize(p) {
  const trip = p.trip || {};
  return {
    schema_version: "trip_v1",
    trip: {
      title: trip.title || "Untitled trip",
      destination: trip.destination || "",
      start_date: trip.start_date || "",
      end_date: trip.end_date || "",
      summary: trip.summary || "",
      general_notes: trip.general_notes || "",
      travelers: Array.isArray(trip.travelers) ? trip.travelers.slice() : [],
    },
    days: (p.days || []).map((d) => ({
      date: d.date || "",
      title: d.title || "",
      city: d.city || "",
      notes: d.notes || "",
      items: (d.items || []).map((it) => ({
        title: it.title || "",
        type: ITEM_TYPES.includes(it.type) ? it.type : "activity",
        start_time: it.start_time || "",
        end_time: it.end_time || "",
        location_name: it.location_name || "",
        map_url: it.map_url || "",
        notes: it.notes || "",
        is_fixed: !!it.is_fixed,
        is_highlight: !!it.is_highlight,
        status: ITEM_STATUSES.includes(it.status) ? it.status : "planned",
      })),
      todos: (d.todos || []).map((t) => ({
        text: t.text || "",
        category: CHECKLIST_CATEGORIES.includes(t.category) ? t.category : "other",
        due_date: t.due_date || "",
        is_done: !!t.is_done,
        notes: t.notes || "",
      })),
    })),
    preparation_checklist: (p.preparation_checklist || []).map((c) => ({
      text: c.text || "",
      category: CHECKLIST_CATEGORIES.includes(c.category) ? c.category : "other",
      due_date: c.due_date || "",
      is_done: !!c.is_done,
      notes: c.notes || "",
    })),
    notes: (p.notes || []).map((n) => ({
      title: n.title || "",
      body: n.body || "",
    })),
  };
}
