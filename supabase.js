// Supabase client + auth + trip data API.
//
// `trips` exposes the trip-shaped CRUD used by the dashboard and the
// trip view. Children (days, items, checklists, notes) get their own
// small modules so each page only imports what it touches.

let client = null;
let clientReady = null; // Promise that resolves to the client (or null)

const CONFIG_KEY = "itinerary-studio:cloud";

function readConfig() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}"); }
  catch {}
  const baked = (typeof window !== "undefined" && window.ITM_CONFIG) || {};
  return {
    url: stored.url || baked.url || "",
    key: stored.key || baked.key || "",
    source: stored.url ? "local" : (baked.url ? "baked" : "none"),
  };
}

export function isConfigured() {
  const c = readConfig();
  return !!(c.url && c.key);
}

export function configSource() {
  return readConfig().source;
}

async function ensureClient() {
  if (client) return client;
  if (clientReady) return clientReady;
  const cfg = readConfig();
  if (!cfg.url || !cfg.key) return null;

  clientReady = (async () => {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    client = createClient(cfg.url, cfg.key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    if (typeof window !== "undefined") window.__sb = client;
    return client;
  })();
  return clientReady;
}

export async function initSupabase() {
  return await ensureClient();
}

async function sb() {
  const c = await ensureClient();
  if (!c) throw new Error("Supabase is not configured.");
  return c;
}

// =============== Auth ===============

function appUrl() {
  return window.location.origin + window.location.pathname;
}

export const auth = {
  async signUp(email, password) {
    const c = await sb();
    const { data, error } = await c.auth.signUp({
      email, password,
      options: { emailRedirectTo: appUrl() },
    });
    if (error) throw error;
    return { needsConfirmation: !data?.session, user: data?.user };
  },

  async signIn(email, password) {
    const c = await sb();
    const { error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },

  async sendPasswordReset(email) {
    const c = await sb();
    const { error } = await c.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
    if (error) throw error;
  },

  async updatePassword(password) {
    const c = await sb();
    const { error } = await c.auth.updateUser({ password });
    if (error) throw error;
  },

  async resendConfirmation(email) {
    const c = await sb();
    const { error } = await c.auth.resend({
      type: "signup", email,
      options: { emailRedirectTo: appUrl() },
    });
    if (error) throw error;
  },

  async signOut() {
    const c = await ensureClient();
    if (!c) return;
    await c.auth.signOut();
  },

  async getSession() {
    const c = await ensureClient();
    if (!c) return null;
    const { data } = await c.auth.getSession();
    return data?.session || null;
  },

  async getUser() {
    const session = await this.getSession();
    return session?.user || null;
  },

  async onChange(callback) {
    const c = await ensureClient();
    if (!c) return () => {};
    const { data } = c.auth.onAuthStateChange((event, session) => callback(event, session));
    return () => data.subscription.unsubscribe();
  },
};

// =============== Trips ===============

export const trips = {
  /** Dashboard list. Returns lightweight rows with role + prep progress. */
  async list() {
    const c = await sb();
    const { data, error } = await c
      .from("itineraries")
      .select(`
        id, title, destination, start_date, end_date, summary,
        created_by, created_at, updated_at,
        itinerary_members!inner(role, user_id),
        checklist_items(id, is_done, day_id)
      `)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    const user = await auth.getUser();
    return (data || []).map((row) => {
      const myMembership = row.itinerary_members.find((m) => m.user_id === user?.id);
      const prep = (row.checklist_items || []).filter((c) => c.day_id == null);
      return {
        id: row.id,
        title: row.title,
        destination: row.destination || "",
        start_date: row.start_date,
        end_date: row.end_date,
        summary: row.summary || "",
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        role: myMembership?.role || "viewer",
        memberCount: row.itinerary_members.length,
        prepDone: prep.filter((c) => c.is_done).length,
        prepTotal: prep.length,
      };
    });
  },

  /** Full trip object: trip + nested days+items + checklists + notes. */
  async getFull(id) {
    const c = await sb();
    const { data, error } = await c
      .from("itineraries")
      .select(`
        id, title, destination, start_date, end_date, summary,
        general_notes, travelers, created_by, created_at, updated_at,
        days:days(id, date, title, city, notes, sort_order,
          items:itinerary_items(id, title, type, start_time, end_time,
            location_name, map_url, notes, is_fixed, is_highlight, status, sort_order)
        ),
        checklist_items(id, day_id, text, category, due_date, is_done, notes, sort_order),
        notes(id, day_id, title, body, sort_order)
      `)
      .eq("id", id)
      .single();
    if (error) throw error;

    // Sort everything client-side; PostgREST embedded ordering needs
    // foreign-table options that vary by version.
    (data.days || []).sort((a, b) => a.sort_order - b.sort_order);
    for (const d of data.days || []) {
      (d.items || []).sort((a, b) => a.sort_order - b.sort_order);
    }
    (data.checklist_items || []).sort((a, b) => a.sort_order - b.sort_order);
    (data.notes || []).sort((a, b) => a.sort_order - b.sort_order);

    const user = await auth.getUser();
    let role = "viewer";
    if (user) {
      const { data: m } = await c
        .from("itinerary_members")
        .select("role")
        .eq("itinerary_id", id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (m?.role) role = m.role;
    }
    return { ...data, role };
  },

  async createEmpty(title = "Untitled trip") {
    const c = await sb();
    const { data, error } = await c.rpc("create_trip", { p_title: title });
    if (error) throw error;
    return data; // uuid
  },

  async createFromJson(payload) {
    const c = await sb();
    const { data, error } = await c.rpc("create_trip_full", { p_payload: payload });
    if (error) throw error;
    return data;
  },

  async replaceFromJson(id, payload) {
    const c = await sb();
    const { data, error } = await c.rpc("replace_trip_full", { p_id: id, p_payload: payload });
    if (error) throw error;
    return data;
  },

  async updateMeta(id, patch) {
    const c = await sb();
    const { error } = await c.from("itineraries").update(patch).eq("id", id);
    if (error) throw error;
  },

  async remove(id) {
    const c = await sb();
    const { error } = await c.from("itineraries").delete().eq("id", id);
    if (error) throw error;
  },
};

// =============== Days ===============

export const days = {
  async add(trip_id, patch = {}) {
    const c = await sb();
    const { data, error } = await c
      .from("days")
      .insert([{ trip_id, ...patch }])
      .select()
      .single();
    if (error) throw error;
    return data;
  },
  async update(id, patch) {
    const c = await sb();
    const { error } = await c.from("days").update(patch).eq("id", id);
    if (error) throw error;
  },
  async remove(id) {
    const c = await sb();
    const { error } = await c.from("days").delete().eq("id", id);
    if (error) throw error;
  },
  async reorder(ids) {
    const c = await sb();
    // Update sort_order one row at a time. Bulk upsert would also work
    // but needs a pkey-only payload; this is simpler and trips are tiny.
    for (let i = 0; i < ids.length; i++) {
      const { error } = await c.from("days").update({ sort_order: i }).eq("id", ids[i]);
      if (error) throw error;
    }
  },
};

// =============== Itinerary items ===============

export const items = {
  async add(trip_id, day_id, patch = {}) {
    const c = await sb();
    const { data, error } = await c
      .from("itinerary_items")
      .insert([{ trip_id, day_id, ...patch }])
      .select()
      .single();
    if (error) throw error;
    return data;
  },
  async update(id, patch) {
    const c = await sb();
    const { error } = await c.from("itinerary_items").update(patch).eq("id", id);
    if (error) throw error;
  },
  async remove(id) {
    const c = await sb();
    const { error } = await c.from("itinerary_items").delete().eq("id", id);
    if (error) throw error;
  },
  async reorder(ids) {
    const c = await sb();
    for (let i = 0; i < ids.length; i++) {
      const { error } = await c.from("itinerary_items").update({ sort_order: i }).eq("id", ids[i]);
      if (error) throw error;
    }
  },
};

// =============== Checklist items (prep + daily todos) ===============

export const checklist = {
  async add(trip_id, patch = {}) {
    const c = await sb();
    const { data, error } = await c
      .from("checklist_items")
      .insert([{ trip_id, ...patch }])
      .select()
      .single();
    if (error) throw error;
    return data;
  },
  async update(id, patch) {
    const c = await sb();
    const { error } = await c.from("checklist_items").update(patch).eq("id", id);
    if (error) throw error;
  },
  async remove(id) {
    const c = await sb();
    const { error } = await c.from("checklist_items").delete().eq("id", id);
    if (error) throw error;
  },
};

// =============== Notes ===============

export const notes = {
  async add(trip_id, patch = {}) {
    const c = await sb();
    const { data, error } = await c
      .from("notes")
      .insert([{ trip_id, ...patch }])
      .select()
      .single();
    if (error) throw error;
    return data;
  },
  async update(id, patch) {
    const c = await sb();
    const { error } = await c.from("notes").update(patch).eq("id", id);
    if (error) throw error;
  },
  async remove(id) {
    const c = await sb();
    const { error } = await c.from("notes").delete().eq("id", id);
    if (error) throw error;
  },
};
