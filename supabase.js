// Optional Supabase backend. Loaded only when the user has stored config.
// We import supabase-js dynamically so the app works fully offline / unconfigured.

let client = null;
let owner = "";

const CONFIG_KEY = "itinerary-studio:cloud";

function readConfig() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}"); }
  catch {}
  // Baked-in config from GitHub Actions (repo Secrets) is used as a fallback
  // so any browser opening the deployed page is auto-connected without
  // having to paste credentials into the ⚙ dialog. localStorage still wins,
  // which lets you override the baked config for local dev or testing.
  const baked = (typeof window !== "undefined" && window.ITM_CONFIG) || {};
  return {
    url:   stored.url   || baked.url   || "",
    key:   stored.key   || baked.key   || "",
    owner: stored.owner || baked.owner || "",
    source: stored.url ? "local" : (baked.url ? "baked" : "none"),
  };
}

export function getCloud() {
  if (!client) throw new Error("Cloud is not connected. Open settings (⚙) to configure Supabase.");
  return {
    async list() {
      let q = client.from("itineraries").select("id, title, updated_at").order("updated_at", { ascending: false });
      if (owner) q = q.eq("owner", owner);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return data || [];
    },
    async load(id) {
      const { data, error } = await client.from("itineraries").select("*").eq("id", id).single();
      if (error) throw new Error(error.message);
      return data;
    },
    async save({ title, markdown }) {
      // Upsert by (owner, title): if a doc with same title exists, update it.
      const payload = { title, markdown, owner: owner || null, updated_at: new Date().toISOString() };
      let q = client.from("itineraries").select("id").eq("title", title);
      if (owner) q = q.eq("owner", owner);
      const { data: existing } = await q.maybeSingle();
      if (existing?.id) {
        const { error } = await client.from("itineraries").update(payload).eq("id", existing.id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await client.from("itineraries").insert(payload);
        if (error) throw new Error(error.message);
      }
    },
    async remove(id) {
      const { error } = await client.from("itineraries").delete().eq("id", id);
      if (error) throw new Error(error.message);
    },
  };
}

export async function initCloud(onReady) {
  const cfg = readConfig();
  client = null;
  owner = "";
  if (!cfg.url || !cfg.key) {
    onReady?.({ connected: false });
    return;
  }
  try {
    // Dynamic ESM import so we don't pay this cost when unconfigured.
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    client = createClient(cfg.url, cfg.key);
    owner = cfg.owner || "";
    const docs = await getCloud().list();
    onReady?.({ connected: true, docs, docCount: docs.length, source: cfg.source });
  } catch (e) {
    console.warn("Supabase init failed:", e);
    client = null;
    onReady?.({ connected: false, error: e.message });
  }
}
