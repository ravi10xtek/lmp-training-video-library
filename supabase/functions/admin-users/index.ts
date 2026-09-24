// admin-users — the manager creates and manages everyone's account.
//
// Actions (POST { action, ... }), manager only (profiles.role 'admin' and not
// is_reviewer):
//   list                                   → every account with email + last sign-in
//   create   { email, full_name, account_type, password }
//   update   { user_id, full_name?, account_type? }
//   password { user_id, password }         → set a new password
//   active   { user_id, active }           → deactivate / reactivate sign-in
//
// account_type → what the database checks:
//   manager  role 'admin'                    reviewer role 'admin' + is_reviewer
//   team     role 'worker' (writer/editor)   staff    role 'worker' (published only)
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type AccountType = "manager" | "reviewer" | "team" | "staff";
const ACCOUNT_TYPES: AccountType[] = ["manager", "reviewer", "team", "staff"];
const ROLE_FOR: Record<AccountType, { role: string; is_reviewer: boolean }> = {
  manager:  { role: "admin",  is_reviewer: false },
  reviewer: { role: "admin",  is_reviewer: true },
  team:     { role: "worker", is_reviewer: false },
  staff:    { role: "worker", is_reviewer: false },
};
const MIN_PASSWORD = 8;
const BANNED_FOREVER = "876000h";   // ~100 years: "deactivated"

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const cleanEmail = (v: unknown) => String(v ?? "").trim().toLowerCase();
const cleanName = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, 80);

function checkType(v: unknown): AccountType {
  if (!ACCOUNT_TYPES.includes(v as AccountType)) throw new HttpError(400, "Pick an account type");
  return v as AccountType;
}
function checkPassword(v: unknown): string {
  const p = String(v ?? "");
  if (p.length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  if (p.length > 72) throw new HttpError(400, "Password is too long");
  return p;
}

async function requireManager(supabase: SupabaseClient, authHeader: string | null) {
  if (!authHeader?.startsWith("Bearer ")) throw new HttpError(401, "Unauthorized");
  const { data, error } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  if (error || !data.user) throw new HttpError(401, "Unauthorized");
  const { data: me } = await supabase.from("profiles").select("role, is_reviewer").eq("id", data.user.id).single();
  if (!me || me.role !== "admin" || me.is_reviewer) throw new HttpError(403, "Only the manager can manage accounts");
  return data.user.id;
}

async function setProfile(supabase: SupabaseClient, userId: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from("profiles").update(patch).eq("id", userId);
  if (error) throw new HttpError(500, "Could not save the profile: " + error.message);
}

async function listAccounts(supabase: SupabaseClient) {
  const users: { id: string; email?: string; last_sign_in_at?: string | null; banned_until?: string | null; created_at?: string }[] = [];
  for (let page = 1; page < 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new HttpError(500, error.message);
    users.push(...data.users);
    if (data.users.length < 200) break;
  }
  const { data: profiles, error } = await supabase
    .from("profiles").select("id, full_name, role, is_reviewer, account_type, created_at");
  if (error) throw new HttpError(500, error.message);
  const byId = new Map(users.map((u) => [u.id, u]));
  const now = Date.now();
  return (profiles || []).map((p) => {
    const u = byId.get(p.id);
    return {
      id: p.id,
      full_name: p.full_name,
      email: u?.email ?? null,
      account_type: p.account_type,
      last_sign_in_at: u?.last_sign_in_at ?? null,
      active: !(u?.banned_until && new Date(u.banned_until).getTime() > now),
      created_at: p.created_at,
    };
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const callerId = await requireManager(supabase, req.headers.get("authorization"));
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "list") {
      return json(200, { accounts: await listAccounts(supabase) });
    }

    if (action === "create") {
      const email = cleanEmail(body.email);
      const full_name = cleanName(body.full_name);
      const type = checkType(body.account_type);
      const password = checkPassword(body.password);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email address");
      if (!full_name) throw new HttpError(400, "Enter the person's name");

      const { data, error } = await supabase.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name },
      });
      if (error || !data.user) {
        const msg = error?.message || "Could not create the account";
        throw new HttpError(/already|registered|exists/i.test(msg) ? 409 : 400,
          /already|registered|exists/i.test(msg) ? "An account with this email already exists" : msg);
      }
      // The signup trigger made a staff profile; give it the chosen type
      await setProfile(supabase, data.user.id, { full_name, account_type: type, ...ROLE_FOR[type] });
      return json(200, { id: data.user.id });
    }

    const userId = String(body.user_id || "");
    if (!/^[0-9a-f-]{36}$/.test(userId)) throw new HttpError(400, "user_id is required");

    if (action === "update") {
      const patch: Record<string, unknown> = {};
      if (body.full_name !== undefined) {
        const n = cleanName(body.full_name);
        if (!n) throw new HttpError(400, "Enter the person's name");
        patch.full_name = n;
      }
      if (body.account_type !== undefined) {
        const type = checkType(body.account_type);
        if (userId === callerId && type !== "manager") throw new HttpError(400, "You can't change your own account type");
        Object.assign(patch, { account_type: type, ...ROLE_FOR[type] });
      }
      if (!Object.keys(patch).length) throw new HttpError(400, "Nothing to change");
      await setProfile(supabase, userId, patch);
      return json(200, { ok: true });
    }

    if (action === "password") {
      const password = checkPassword(body.password);
      const { error } = await supabase.auth.admin.updateUserById(userId, { password });
      if (error) throw new HttpError(400, error.message);
      return json(200, { ok: true });
    }

    if (action === "active") {
      if (userId === callerId) throw new HttpError(400, "You can't deactivate your own account");
      const active = body.active === true;
      const { error } = await supabase.auth.admin.updateUserById(userId, { ban_duration: active ? "none" : BANNED_FOREVER });
      if (error) throw new HttpError(400, error.message);
      return json(200, { ok: true });
    }

    throw new HttpError(400, "Unknown action");
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.error("[admin-users]", err);
    return json(500, { error: err instanceof Error ? err.message : "Internal error" });
  }
});
