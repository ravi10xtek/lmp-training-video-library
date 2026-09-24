import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
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
  versionId?: string; // a specific uploaded version (video_versions.id)
  download?: boolean; // if true, presign with Content-Disposition: attachment
};

type Video = { id: string; status: string; storage_key: string | null; video_url: string | null; review_round: number | null };
type Viewer = { userId: string; isAdmin: boolean; isManager: boolean; isReviewer: boolean };

class Forbidden extends Error {}

// Who may watch which file:
//   published                      → everyone signed in
//   manager                        → everything
//   the project's writer / editor  → their project's video, every version
//   reviewer (Joe)                 → what has been sent to him, never the
//                                    editor's upload that hasn't been sent yet
async function canWatch(supabase: SupabaseClient, viewer: Viewer, video: Video, version: number | null) {
  if (video.status === "published" && version === null) return true;
  if (viewer.isManager) return true;
  const { data: assigned } = await supabase
    .from("scripts").select("id").eq("video_id", video.id)
    .or(`writer_id.eq.${viewer.userId},editor_id.eq.${viewer.userId}`)
    .limit(1).maybeSingle();
  if (assigned) return true;
  if (viewer.isReviewer) {
    const round = video.review_round || 1;
    if (version !== null) {
      return ["to_review", "to_edit", "completed", "published"].includes(video.status) && version <= round;
    }
    return ["to_review", "completed", "published"].includes(video.status);
  }
  return false;
}

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

    const { data: profile } = await supabase
      .from("profiles").select("role, is_reviewer").eq("id", userId).single();
    const viewer: Viewer = {
      userId,
      isAdmin:    profile?.role === "admin",
      isReviewer: !!profile?.is_reviewer,
      isManager:  profile?.role === "admin" && !profile?.is_reviewer,
    };

    const VIDEO_COLS = "id, status, storage_key, video_url, review_round";
    let storageKey: string | null = null;

    if (body.versionId) {
      const { data: ver } = await supabase
        .from("video_versions").select("video_id, version, storage_key, video_url")
        .eq("id", body.versionId).maybeSingle();
      if (!ver) return jsonResponse(404, { error: "Version not found" });
      const { data: video } = await supabase.from("videos").select(VIDEO_COLS).eq("id", ver.video_id).single();
      if (!video || !(await canWatch(supabase, viewer, video as Video, ver.version))) throw new Forbidden();
      if (!ver.storage_key && ver.video_url) return jsonResponse(200, { playbackUrl: ver.video_url });
      storageKey = ver.storage_key;
    } else if (body.videoId) {
      const { data: video } = await supabase.from("videos").select(VIDEO_COLS).eq("id", body.videoId).maybeSingle();
      if (!video) return jsonResponse(404, { error: "Video not found" });
      if (!(await canWatch(supabase, viewer, video as Video, null))) throw new Forbidden();
      if (!video.storage_key && video.video_url) return jsonResponse(200, { playbackUrl: video.video_url });
      storageKey = video.storage_key;
    } else if (body.storageKey) {
      // A bare key is only signed if it belongs to something this user may see:
      // one of Joe's recordings (admins: the client and the manager) or a video / video version.
      const key = body.storageKey;
      const { data: rec } = await supabase
        .from("joe_recordings").select("id").eq("storage_key", key).limit(1).maybeSingle();
      let allowed = !!rec && viewer.isAdmin;
      if (!allowed) {
        const { data: ver } = await supabase
          .from("video_versions").select("video_id, version").eq("storage_key", key).limit(1).maybeSingle();
        const vid = ver?.video_id ?? (await supabase
          .from("videos").select("id").eq("storage_key", key).limit(1).maybeSingle()).data?.id;
        if (vid) {
          const { data: video } = await supabase.from("videos").select(VIDEO_COLS).eq("id", vid).single();
          const isCurrent = video?.storage_key === key;
          allowed = !!video && await canWatch(supabase, viewer, video as Video, isCurrent ? null : (ver?.version ?? null));
        }
      }
      if (!allowed) throw new Forbidden();
      storageKey = key;
    }

    if (!storageKey) {
      return jsonResponse(400, { error: "storageKey, videoId or versionId is required" });
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
    if (error instanceof Forbidden) return jsonResponse(403, { error: "Not allowed to view this video" });
    return jsonResponse(401, {
      error: error instanceof Error ? error.message : "Could not create playback URL",
    });
  }
});
