import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Public project URL and anon key. Safe to ship in the browser when row
// level security is on and table access is revoked (see supabase/migrations).
// The service-role key and database password stay on the server only.
// Configure via env; no hardcoded project fallback (a stale host breaks assets/auth).
const url = (import.meta.env.VITE_SUPABASE_URL ||
  import.meta.env.NEXT_PUBLIC_SUPABASE_URL ||
  "") as string;

const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY ||
  import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "") as string;

export const hasSupabase = Boolean(url && anon);

export const supabase: SupabaseClient | null = hasSupabase
  ? createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : null;

const forceLocalAssets = (import.meta.env.VITE_LOCAL_ASSETS as string | undefined) === "1";
const forceRemoteAssets = (import.meta.env.VITE_REMOTE_ASSETS as string | undefined) === "1";
/** Public Storage origin for sprites/ and sounds/. Defaults to local bundled assets. */
export const assetBase =
  forceRemoteAssets && hasSupabase && !forceLocalAssets
    ? `${url.replace(/\/$/, "")}/storage/v1/object/public/game-assets/`
    : "";
