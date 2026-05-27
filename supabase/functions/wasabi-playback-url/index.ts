import { createClient } from "npm:@supabase/supabase-js@2";
import { GetObjectCommand, S3Client } from "npm:@aws-sdk/client-s3@3.614.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3.614.0";

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

type PlaybackBody = {
  storageKey?: string;
  videoId?: string;
  download?: boolean; // if true, presign with Content-Disposition: attachment
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function requireUser(authHeader: string | null) {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing bearer token");
  }

  const token = authHeader.replace("Bearer ", "");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Error("Unauthorized");
  return { supabase, userId: data.user.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    const { supabase, userId } = await requireUser(req.headers.get("authorization"));
    const body = (await req.json()) as PlaybackBody;
    let storageKey = body.storageKey || null;

    if (!storageKey && body.videoId) {
      const { data: video, error } = await supabase
        .from("videos")
        .select("id, status, storage_key, video_source")
        .eq("id", body.videoId)
        .single();

      if (error || !video) {
        return jsonResponse(404, { error: "Video not found" });
      }
      if (video.video_source !== "wasabi") {
        return jsonResponse(400, { error: "Video is not Wasabi-backed" });
      }
      if (video.status !== "published") {
        // Allow admins to preview unpublished records.
        const { data: profile } = await supabase
          .from("profiles")
          .select("role, is_reviewer")
          .eq("id", userId)
          .single();
        if (profile?.role !== "admin" && !profile?.is_reviewer) {
          return jsonResponse(403, { error: "Not allowed to view unpublished video" });
        }
      }
      storageKey = video.storage_key;
    }

    if (!storageKey) {
      return jsonResponse(400, { error: "storageKey or videoId is required" });
    }

    const s3 = new S3Client({
      region: WASABI_REGION,
      endpoint: WASABI_ENDPOINT,
      credentials: {
        accessKeyId: WASABI_ACCESS_KEY_ID,
        secretAccessKey: WASABI_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    });

    const filename = storageKey.split("/").pop() || "download";
    const command = new GetObjectCommand({
      Bucket: WASABI_BUCKET,
      Key: storageKey,
      ...(body.download
        ? { ResponseContentDisposition: `attachment; filename="${filename}"` }
        : {}),
    });

    const playbackUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
    return jsonResponse(200, { playbackUrl });
  } catch (error) {
    return jsonResponse(401, {
      error: error instanceof Error ? error.message : "Could not create playback URL",
    });
  }
});
