export let supa = null;
export let USE_SUPABASE = false;

export function initSupabase(url, key) {
  USE_SUPABASE = !!(url && key && window.supabase);
  if (USE_SUPABASE) supa = window.supabase.createClient(url, key);
  return USE_SUPABASE;
}
