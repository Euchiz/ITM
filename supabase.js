// Supabase client + auth + trips API.
// Loads the supabase-js client lazily on first use so the app boots
// even when not configured.

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
    // Expose for console diagnostics — safe because the publishable key is
    // already public on the deployed page; this only adds convenience.
    if (typeof window !== "undefined") window.__sb = client;
    return client;
  })();
  return clientReady;
}

// Public initializer; safe to call anytime, no-op when unconfigured.
export async function initSupabase() {
  return await ensureClient();
}

// =============== Auth ===============

function appUrl() {
  return window.location.origin + window.location.pathname;
}

export const auth = {
  /** Create a new account. Supabase sends a confirmation email if that's enabled. */
  async signUp(email, password) {
    const c = await ensureClient();
    if (!c) throw new Error("Supabase is not configured.");
    const { data, error } = await c.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: appUrl() },
    });
    if (error) throw error;
    // Returns whether a session was created (no email confirmation required)
    // or whether the user must confirm by email first.
    return { needsConfirmation: !data?.session, user: data?.user };
  },

  async signIn(email, password) {
    const c = await ensureClient();
    if (!c) throw new Error("Supabase is not configured.");
    const { error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },

  /** Send a password-reset email; user clicks the link, lands back here in recovery mode. */
  async sendPasswordReset(email) {
    const c = await ensureClient();
    if (!c) throw new Error("Supabase is not configured.");
    const { error } = await c.auth.resetPasswordForEmail(email, {
      redirectTo: appUrl(),
    });
    if (error) throw error;
  },

  /** Set a new password for the currently-signed-in (or recovery-session) user. */
  async updatePassword(password) {
    const c = await ensureClient();
    if (!c) throw new Error("Supabase is not configured.");
    const { error } = await c.auth.updateUser({ password });
    if (error) throw error;
  },

  /** Resend the email-confirmation link if the user lost theirs. */
  async resendConfirmation(email) {
    const c = await ensureClient();
    if (!c) throw new Error("Supabase is not configured.");
    const { error } = await c.auth.resend({
      type: "signup",
      email,
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

  /** Subscribe to auth changes. Callback receives (event, session). */
  async onChange(callback) {
    const c = await ensureClient();
    if (!c) return () => {};
    const { data } = c.auth.onAuthStateChange((event, session) => callback(event, session));
    return () => data.subscription.unsubscribe();
  },
};

// =============== Trips ===============

export const trips = {
  /** All itineraries the current user is a member of, newest first. */
  async list() {
    const c = await ensureClient();
    if (!c) throw new Error("Supabase is not configured.");
    const { data, error } = await c
      .from("itineraries")
      .select("id, title, created_by, created_at, updated_at, itinerary_members!inner(role, user_id)")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    // Flatten: pull the current user's role onto each row.
    const user = await auth.getUser();
    return (data || []).map((row) => {
      const myMembership = row.itinerary_members.find((m) => m.user_id === user?.id);
      return {
        id: row.id,
        title: row.title,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        role: myMembership?.role || "viewer",
        memberCount: row.itinerary_members.length,
      };
    });
  },

  /** Single itinerary by id. RLS enforces membership. */
  async get(id) {
    const c = await ensureClient();
    if (!c) throw new Error("Supabase is not configured.");
    const { data, error } = await c
      .from("itineraries")
      .select("id, title, markdown, created_by, created_at, updated_at")
      .eq("id", id)
      .single();
    if (error) throw error;
    // Read current user's role separately (cheap, accurate).
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

  /** Create a new itinerary via the create_itinerary RPC.
   * Direct INSERT can't be used because Supabase's WITH CHECK expressions
   * see auth.uid() as NULL on the same request — see migration
   * 20260510030000_create_itinerary_rpc.sql. The RPC is SECURITY DEFINER
   * and reads auth.uid() at function entry where it works. */
  async create({ title, markdown }) {
    const c = await ensureClient();
    if (!c) throw new Error("Supabase is not configured.");
    const { data, error } = await c.rpc("create_itinerary", {
      p_title: title || "Untitled itinerary",
      p_markdown: markdown || "",
    });
    if (error) throw error;
    return data.id;
  },

  async update(id, patch) {
    const c = await ensureClient();
    if (!c) throw new Error("Supabase is not configured.");
    const { error } = await c
      .from("itineraries")
      .update(patch)
      .eq("id", id);
    if (error) throw error;
  },

  async remove(id) {
    const c = await ensureClient();
    if (!c) throw new Error("Supabase is not configured.");
    const { error } = await c.from("itineraries").delete().eq("id", id);
    if (error) throw error;
  },
};
