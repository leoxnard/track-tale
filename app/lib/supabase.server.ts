import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.server";

let client: SupabaseClient | undefined;

export function supabase(): SupabaseClient {
  client ??= createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: { persistSession: false },
  });
  return client;
}
