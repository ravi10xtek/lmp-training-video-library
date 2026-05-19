import { createClient } from "npm:@supabase/supabase-js@2";
import { PutObjectCommand, S3Client } from "npm:@aws-sdk/client-s3@3.614.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WASABI_REGION = Deno.env.get("WASABI_REGION")!;
const WASABI_BUCKET = Deno.env.get("WASABI_BUCKET")!;
const WASABI_ACCESS_KEY_ID = Deno.env.get("WASABI_ACCESS_KEY_ID")!;
const WASABI_SECRET_ACCESS_KEY = Deno.env.get("WASABI_SECRET_ACCESS_KEY")!;
const WASABI_ENDPOINT = Deno.env.get("WASABI_ENDPOINT") || `https://s3.${WASABI_REGION}.wasabisys.com`;

const STAGING_BUCKET = "video-uploads";

type TransferBody = {
  storagePath?: string;
  contentType?: string;
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function requireAdmin(authHeader: string | null) {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing bearer token");
  }

  const token = authHeader.replace("Bearer ", "");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    throw new Error("Unauthorized");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, role")
    .eq("id", userData.user.id)
    .single();

  if (profileError || !profile || profile.role !== "admin") {
    throw new Error("Admin access required");
  }

  return { supabase, userId: userData.user.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    const { supabase, userId } = await requireAdmin(req.headers.get("authorization"));
    const body = (await req.json()) as TransferBody;
    const storagePath = body.storagePath?.trim();

    if (!storagePath) {
      return jsonResponse(400, { error: "storagePath is required" });
    }

    if (!storagePath.startsWith(`${userId}/`)) {
      return jsonResponse(403, { error: "Invalid storage path" });
    }

    const { data: blob, error: downloadError } = await supabase.storage
      .from(STAGING_BUCKET)
      .download(storagePath);

    if (downloadError || !blob) {
      return jsonResponse(404, {
        error: downloadError?.message || "Staging file not found",
      });
    }

    const fileName = storagePath.split("/").pop() || "video.mp4";
    const objectKey = `videos/${userId}/${crypto.randomUUID()}-${fileName}`;
    const contentType = (body.contentType && body.contentType.trim()) ||
      blob.type ||
      "application/octet-stream";

    const s3 = new S3Client({
      region: WASABI_REGION,
      endpoint: WASABI_ENDPOINT,
      credentials: {
        accessKeyId: WASABI_ACCESS_KEY_ID,
        secretAccessKey: WASABI_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    });

    const bytes = new Uint8Array(await blob.arrayBuffer());

    await s3.send(
      new PutObjectCommand({
        Bucket: WASABI_BUCKET,
        Key: objectKey,
        Body: bytes,
        ContentType: contentType,
      }),
    );

    await supabase.storage.from(STAGING_BUCKET).remove([storagePath]);

    return jsonResponse(200, {
      storageKey: objectKey,
      publicUrl: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transfer failed";
    const status = message.includes("Admin") || message.includes("Unauthorized") || message.includes("token")
      ? 401
      : 500;
    return jsonResponse(status, { error: message });
  }
});
