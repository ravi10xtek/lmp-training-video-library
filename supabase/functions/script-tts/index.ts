// script-tts — cheap preview narration for script review.
//
// Splits a script into paragraphs, hashes each one, and renders ONLY the
// paragraphs whose hash is not already in `tts_cache`. Audio lands in the
// private `script-audio` bucket. A revision that changes three paragraphs
// therefore costs three short OpenAI calls, not a full re-render.
//
// Renders at most MAX_RENDER_PER_CALL paragraphs per request so a long
// first-time script can't hit the edge-function wall clock — the client
// keeps calling until `pending` is 0.
//
// Body:    { text: string, scriptId?: string, maxRender?: number }
// Returns: { paragraphs: [{ i, text, hash, heading, audio_path|null }],
//            pending, rendered, cached, charsRendered, model, voice }
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY            = Deno.env.get("OPENAI_API_KEY");
// Overridable without a redeploy. Changing either invalidates the cache
// (they're part of the hash), which is the correct behaviour.
const TTS_MODEL = Deno.env.get("SCRIPT_TTS_MODEL") || "gpt-4o-mini-tts";
const TTS_VOICE = Deno.env.get("SCRIPT_TTS_VOICE") || "ash";
const TTS_INSTRUCTIONS = Deno.env.get("SCRIPT_TTS_INSTRUCTIONS") ||
  "Calm, clear, unhurried training narration for plumbing technicians. Neutral American accent. Read exactly what is written.";

const AUDIO_BUCKET = "script-audio";
const MAX_RENDER_PER_CALL = 6;
const CONCURRENCY = 3;
// OpenAI's input cap is 4096 chars; leave headroom.
const MAX_PARAGRAPH_CHARS = 3800;

type Paragraph = { i: number; text: string; hash: string; heading: boolean; audio_path: string | null };

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Admins may render anything; an assigned content writer may render for the
// script they are assigned to (scriptId in the body).
async function requireRenderer(authHeader: string | null, scriptId?: string) {
  if (!authHeader?.startsWith("Bearer ")) throw new Error("Unauthorized");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  if (error || !user) throw new Error("Unauthorized");
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role === "admin") return supabase;
  if (scriptId) {
    const { data: s } = await supabase.from("scripts").select("writer_id").eq("id", scriptId).single();
    if (s?.writer_id === user.id) return supabase;
  }
  throw new Error("Only an admin or the assigned writer can render this script");
}

// ── Paragraph splitting ───────────────────────────────────────
// Blank-line separated. A line starting with '#' is a section heading: it is
// spoken ("Section: …") so Joe can orient himself by ear, and flagged so the
// UI can style it. Whitespace differences never change the hash.
function splitParagraphs(raw: string): { text: string; heading: boolean }[] {
  return raw
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^#{1,6}\s*(.+)$/s);
      if (m) return { text: m[1].replace(/\s+/g, " ").trim(), heading: true };
      return { text: p.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim(), heading: false };
    });
}

function spokenText(p: { text: string; heading: boolean }) {
  return p.heading ? `Section: ${p.text}.` : p.text;
}

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function renderOne(text: string): Promise<Uint8Array> {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
      instructions: TTS_INSTRUCTIONS,
      response_format: "mp3",
    }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`OpenAI TTS ${r.status}: ${detail.slice(0, 200)}`);
  }
  return new Uint8Array(await r.arrayBuffer());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!OPENAI_API_KEY) return json(500, { error: "OPENAI_API_KEY is not configured on the server." });

  let body: { text?: string; maxRender?: number; scriptId?: string };
  try {
    body = await req.json();
  } catch (_) {
    return json(400, { error: "Invalid JSON body" });
  }

  let supabase;
  try {
    supabase = await requireRenderer(req.headers.get("authorization"), body.scriptId);
  } catch (e) {
    return json(401, { error: e instanceof Error ? e.message : "Unauthorized" });
  }

  try {
    const { text, maxRender } = body;
    if (!text || !text.trim()) return json(400, { error: "text is required" });

    const parts = splitParagraphs(text);
    if (!parts.length) return json(400, { error: "Script has no paragraphs" });

    const tooLong = parts.findIndex((p) => spokenText(p).length > MAX_PARAGRAPH_CHARS);
    if (tooLong !== -1) {
      return json(400, {
        error: `Paragraph ${tooLong + 1} is ${spokenText(parts[tooLong]).length} characters — split it with a blank line (max ${MAX_PARAGRAPH_CHARS}).`,
      });
    }

    // Hash = model|voice|spoken text, so a voice change is a full re-render.
    const paragraphs: Paragraph[] = await Promise.all(parts.map(async (p, i) => ({
      i,
      text: p.text,
      heading: p.heading,
      hash: await sha256(`${TTS_MODEL}|${TTS_VOICE}|${spokenText(p)}`),
      audio_path: null,
    })));

    // ── Cache lookup ──
    const hashes = [...new Set(paragraphs.map((p) => p.hash))];
    const { data: cached, error: cacheErr } = await supabase
      .from("tts_cache").select("hash, audio_path").in("hash", hashes);
    if (cacheErr) throw cacheErr;
    const byHash = new Map((cached || []).map((c) => [c.hash, c.audio_path as string]));

    // ── Render the missing ones (bounded per call) ──
    const limit = Math.max(1, Math.min(maxRender ?? MAX_RENDER_PER_CALL, 12));
    const missing: Paragraph[] = [];
    const seen = new Set<string>();
    for (const p of paragraphs) {
      if (byHash.has(p.hash) || seen.has(p.hash)) continue;
      seen.add(p.hash);
      missing.push(p);
    }
    const batch = missing.slice(0, limit);

    let charsRendered = 0;
    let rendered = 0;
    let firstErr: Error | null = null;

    const work = async (p: Paragraph) => {
      const spoken = spokenText(p);
      try {
        const bytes = await renderOne(spoken);
        const audio_path = `tts/${p.hash}.mp3`;
        const { error: upErr } = await supabase.storage
          .from(AUDIO_BUCKET)
          .upload(audio_path, bytes, { contentType: "audio/mpeg", upsert: true });
        if (upErr) throw upErr;
        const { error: insErr } = await supabase.from("tts_cache").upsert({
          hash: p.hash, text: spoken, model: TTS_MODEL, voice: TTS_VOICE,
          chars: spoken.length, audio_path, bytes: bytes.byteLength,
        }, { onConflict: "hash" });
        if (insErr) throw insErr;
        byHash.set(p.hash, audio_path);
        charsRendered += spoken.length;
        rendered += 1;
      } catch (e) {
        console.error("[script-tts] paragraph", p.i, e);
        if (!firstErr) firstErr = e instanceof Error ? e : new Error(String(e));
      }
    };

    // Small worker pool — keeps wall clock down without hammering the API.
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
      while (cursor < batch.length) {
        const p = batch[cursor++];
        await work(p);
      }
    }));

    if (firstErr && rendered === 0) throw firstErr;

    for (const p of paragraphs) p.audio_path = byHash.get(p.hash) ?? null;
    const pending = paragraphs.filter((p) => !p.audio_path).length;

    return json(200, {
      paragraphs,
      pending,
      rendered,
      cached: hashes.length - missing.length,
      charsRendered,
      model: TTS_MODEL,
      voice: TTS_VOICE,
      ...(firstErr ? { warning: (firstErr as Error).message } : {}),
    });
  } catch (err) {
    console.error("[script-tts]", err);
    return json(500, { error: err instanceof Error ? err.message : "TTS failed" });
  }
});
