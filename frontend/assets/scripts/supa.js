// frontend/assets/scripts/supa.js
// No-op shim (we no longer use Supabase). Safe to keep while phasing out imports.

export let supa = null;
export let USE_SUPABASE = false;

/**
 * Kept for backward compatibility. Always returns false.
 * You can delete this file once no modules import it.
 */
export function initSupabase(/* url, key */) {
  if (typeof window !== "undefined") {
    console.info("[supa.js] Supabase is disabled in this build.");
  }
  supa = null;
  USE_SUPABASE = false;
  return false;
}
