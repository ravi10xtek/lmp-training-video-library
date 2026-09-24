import { createClient } from "npm:@supabase/supabase-js@2";
import { PutObjectCommand, S3Client } from "npm:@aws-sdk/client-s3@3.614.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3.614.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function envTrim(key: string): string {
  return (Deno.env.get(key) ?? "").trim();
}

const SUPABASE_URL = envTrim("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = envTrim("SUPABASE_SERVICE_ROLE_KEY");
const WASABI_REGION = envTrim("WASABI_REGION");
const WASABI_BUCKET = envTrim("WASABI_BUCKET");
const WASABI_ACCESS_KEY_ID = envTrim("WASABI_ACCESS_KEY_ID");
const WASABI_SECRET_ACCESS_KEY = envTrim("WASABI_SECRET_ACCESS_KEY");
const WASABI_ENDPOINT = envTrim("WASABI_ENDPOINT") ||
  `https://s3.${WASABI_REGION}.wasabisys.com`;

// 5 GB max per upload (adjust if needed).
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

type UploadInitBody = {
  fileName: string;
  fileType?: string;
  fileSize?: number;
  // The video slot this upload is for. Lets the project's assigned editor
  // (a plain account) upload; admins and the reviewer may omit it.
  videoId?: string;
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// Admins (the manager; the client for his own recordings) and the editor
// assigned to the project that owns `videoId`.
async function requireUploader(authHeader: string | null, videoId?: string) {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing bearer token");
  }

  const token = authHeader.replace("Bearer ", "");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    throw new Error("Unauthorized");
  }
  const userId = userData.user.id;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, role, is_reviewer")
    .eq("id", userId)
    .single();
  if (profileError || !profile) throw new Error("Unauthorized");

  if (profile.role === "admin") return { userId };

  if (videoId) {
    const { data: script } = await supabase
      .from("scripts")
      .select("id")
      .eq("video_id", videoId)
      .eq("editor_id", userId)
      .limit(1)
      .maybeSingle();
    if (script) return { userId };
  }

  throw new Error("Only an admin or the project's editor can upload this video");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    if (
      !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !WASABI_REGION ||
      !WASABI_BUCKET || !WASABI_ACCESS_KEY_ID || !WASABI_SECRET_ACCESS_KEY
    ) {
      return jsonResponse(500, { error: "Server missing Wasabi or Supabase env configuration" });
    }

    const body = (await req.json()) as UploadInitBody;
    const { userId } = await requireUploader(req.headers.get("authorization"), body.videoId);
    const fileName = sanitizeFileName(body.fileName || "video.mp4");
    const fileSize = typeof body.fileSize === "number" ? body.fileSize : 0;

    if (fileSize > MAX_UPLOAD_BYTES) {
      return jsonResponse(400, {
        error: `File too large (max ${MAX_UPLOAD_BYTES} bytes)`,
      });
    }

    const objectKey = `videos/${userId}/${crypto.randomUUID()}-${fileName}`;
    // Must match the browser PUT Content-Type exactly.
    const contentType =
      (body.fileType && String(body.fileType).trim()) || "application/octet-stream";

    const s3 = new S3Client({
      region: WASABI_REGION,
      endpoint: WASABI_ENDPOINT,
      credentials: {
        accessKeyId: WASABI_ACCESS_KEY_ID,
        secretAccessKey: WASABI_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    });

    const command = new PutObjectCommand({
      Bucket: WASABI_BUCKET,
      Key: objectKey,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

    return jsonResponse(200, {
      uploadUrl,
      contentType,
      storageKey: objectKey,
      publicUrl: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload init failed";
    const status = message.includes("Unauthorized") || message.includes("token")
      ? 401
      : message.includes("Only an admin")
      ? 403
      : 500;
    return jsonResponse(status, { error: message });
  }
});
