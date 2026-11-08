import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Public project URL and anon key. Safe to ship in the browser when row
// level security is on and table access is revoked (see supabase/migrations).
// The service-role key and database password stay on the server only.
const url = (import.meta.env.VITE_SUPABASE_URL ||
  import.meta.env.NEXT_PUBLIC_SUPABASE_URL ||
  "https://shiwnmsbxusfxygbogrb.supabase.co") as string;

const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY ||
  import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNoaXdubXNieHVzZnh5Z2JvZ3JiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNjE3NDcsImV4cCI6MjEwNzczNzc0N30.P4yao5pf7BASotUGrnm4ztd9eFPhx6fxaKZUPkRMKV8") as string;

export const hasSupabase = Boolean(url && anon);

export const supabase: SupabaseClient | null = hasSupabase
  ? createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : null;

const forceLocalAssets = (import.meta.env.VITE_LOCAL_ASSETS as string | undefined) === "1";
/** Public Storage origin for sprites/ and sounds/. Empty uses local /sprites,/sounds. */
export const assetBase =
  !forceLocalAssets && hasSupabase
    ? `${url.replace(/\/$/, "")}/storage/v1/object/public/game-assets/`
    : "";
