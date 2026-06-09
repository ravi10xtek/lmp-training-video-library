import { createClient } from "npm:@supabase/supabase-js@2";
import { GetObjectCommand, S3Client } from "npm:@aws-sdk/client-s3@3.614.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY           = Deno.env.get("OPENAI_API_KEY");
const WASABI_REGION            = Deno.env.get("WASABI_REGION");
const WASABI_BUCKET            = Deno.env.get("WASABI_BUCKET");
const WASABI_ACCESS_KEY_ID     = Deno.env.get("WASABI_ACCESS_KEY_ID");
const WASABI_SECRET_ACCESS_KEY = Deno.env.get("WASABI_SECRET_ACCESS_KEY");
const WASABI_ENDPOINT          = Deno.env.get("WASABI_ENDPOINT") ||
  `https://s3.${WASABI_REGION}.wasabisys.com`;
const FEEDBACK_BUCKET = "video-feedback";

// OpenAI hard limit for the transcription endpoint
const MAX_BYTES = 25 * 1024 * 1024;

type Body = { storageKey?: string; audioPath?: string };

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function mimeFor(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".mp4"))  return "video/mp4";
  if (n.endsWith(".webm")) return "audio/webm";
  if (n.endsWith(".ogg") || n.endsWith(".oga")) return "audio/ogg";
  if (n.endsWith(".m4a"))  return "audio/m4a";
  if (n.endsWith(".mp3"))  return "audio/mpeg";
  if (n.endsWith(".wav"))  return "audio/wav";
  return "application/octet-stream";
}

async function requireAdmin(authHeader: string | null) {
  if (!authHeader?.startsWith("Bearer ")) throw new Error("Unauthorized");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  if (error || !user) throw new Error("Unauthorized");
  const { data: profile } = await supabase
    .from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") throw new Error("Admin access required");
  return supabase;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  if (!OPENAI_API_KEY) {
    return json(500, { error: "OPENAI_API_KEY is not configured on the server." });
  }

  let supabase;
  try {
    supabase = await requireAdmin(req.headers.get("authorization"));
  } catch (e) {
    return json(401, { error: e instanceof Error ? e.message : "Unauthorized" });
  }

  try {
    const { storageKey, audioPath } = (await req.json()) as Body;
    if (!storageKey && !audioPath) {
      return json(400, { error: "storageKey or audioPath is required" });
    }

    let bytes: Uint8Array;
    let filename: string;

    if (audioPath) {
      // Feedback voice note — lives in private Supabase Storage
      const { data, error } = await supabase.storage.from(FEEDBACK_BUCKET).download(audioPath);
      if (error || !data) return json(404, { error: "Audio not found" });
      bytes = new Uint8Array(await data.arrayBuffer());
      filename = audioPath.split("/").pop() || "audio.webm";
    } else {
      // Video — lives on Wasabi
      if (!WASABI_REGION || !WASABI_BUCKET || !WASABI_ACCESS_KEY_ID || !WASABI_SECRET_ACCESS_KEY) {
        return json(500, { error: "Wasabi is not configured on the server." });
      }
      const s3 = new S3Client({
        region: WASABI_REGION,
        endpoint: WASABI_ENDPOINT,
        credentials: { accessKeyId: WASABI_ACCESS_KEY_ID, secretAccessKey: WASABI_SECRET_ACCESS_KEY },
        forcePathStyle: true,
      });
      const obj = await s3.send(new GetObjectCommand({ Bucket: WASABI_BUCKET, Key: storageKey! }));
      if ((obj.ContentLength ?? 0) > MAX_BYTES) {
        return json(413, {
          error: `This video is ${Math.round((obj.ContentLength ?? 0) / 1048576)}MB — over OpenAI's 25MB transcription limit. (Shorter clips work; longer ones need an audio-extraction step.)`,
        });
      }
      // @ts-ignore SDK stream helper
      bytes = await obj.Body.transformToByteArray();
      filename = storageKey!.split("/").pop() || "video.mp4";
    }

    if (bytes.byteLength > MAX_BYTES) {
      return json(413, { error: "File is over OpenAI's 25MB transcription limit." });
    }

    // Send to OpenAI Whisper
    const form = new FormData();
    form.append("file", new File([bytes], filename, { type: mimeFor(filename) }));
    form.append("model", "whisper-1");
    form.append("response_format", "text");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error("[transcribe] OpenAI error:", r.status, detail);
      return json(502, { error: `Transcription failed (${r.status}). ${detail.slice(0, 200)}` });
    }

    const text = (await r.text()).trim();
    return json(200, { text });
  } catch (err) {
    console.error("[transcribe]", err);
    return json(500, { error: err instanceof Error ? err.message : "Transcription failed" });
  }
});
