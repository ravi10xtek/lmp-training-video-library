import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL             = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY          = Deno.env.get("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY         = Deno.env.get("VAPID_PRIVATE_KEY");

// Configure web-push VAPID if keys are available
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    "mailto:admin@lochmonsterplumbing.com",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

type VideoType  = "video_uploaded" | "round1_reviewed" | "round2_reviewed" | "video_ready" | "more_changes_requested";
type ScriptType = "script_sent" | "script_changes" | "script_approved";
type NotifyBody = {
  type: VideoType | ScriptType;
  // Video events
  videoId?: string;
  videoTitle?: string;
  // Script-review events
  scriptId?: string;
  scriptTitle?: string;
  versionNo?: number;
};
type Profile = { role: string; is_reviewer: boolean | null; full_name: string | null };

const SCRIPT_TYPES: ScriptType[] = ["script_sent", "script_changes", "script_approved"];

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Shared delivery: in-app rows + Web Push, with expired-endpoint cleanup ──
async function deliver(
  supabase: SupabaseClient,
  recipientIds: string[],
  n: { type: string; title: string; message: string; videoId?: string | null; scriptId?: string | null; tag: string },
) {
  await supabase.from("notifications").insert(
    recipientIds.map((id) => ({
      user_id:   id,
      video_id:  n.videoId ?? null,
      script_id: n.scriptId ?? null,
      type:      n.type,
      title:     n.title,
      message:   n.message,
    }))
  );

  if (!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) || !recipientIds.length) return;

  const { data: pushSubs } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth, user_id")
    .in("user_id", recipientIds);
  if (!pushSubs?.length) return;

  // Unread notification count per recipient → home-screen icon badge
  const unreadByUser: Record<string, number> = {};
  await Promise.all(recipientIds.map(async (uid) => {
    const { count } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", uid)
      .eq("read", false);
    unreadByUser[uid] = count || 0;
  }));

  const pushResults = await Promise.allSettled(
    pushSubs.map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({
          title:      n.title,
          body:       n.message,
          tag:        n.tag,
          url:        "/",
          badgeCount: unreadByUser[sub.user_id] ?? 1,
        })
      )
    )
  );

  // Clean up expired/invalid subscriptions (410 Gone)
  const expiredEndpoints: string[] = [];
  pushResults.forEach((result, i) => {
    if (result.status === "rejected") {
      const err = result.reason as { statusCode?: number };
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        expiredEndpoints.push(pushSubs[i].endpoint);
      } else {
        console.warn("[notify-review] push error:", result.reason);
      }
    }
  });
  if (expiredEndpoints.length) {
    await supabase.from("push_subscriptions").delete().in("endpoint", expiredEndpoints);
    console.log("[notify-review] removed", expiredEndpoints.length, "expired push subscriptions");
  }
}

// ── Script-review events ─────────────────────────────────────
// script_sent     → Ravi sent a version   → notify reviewers (Joe)
// script_changes  → Joe wants changes     → notify other admins (Ravi)
// script_approved → Joe approved          → notify other admins (Ravi)
async function notifyScript(supabase: SupabaseClient, callerId: string, caller: Profile, body: NotifyBody) {
  const { type, scriptId, scriptTitle, versionNo } = body;
  const v = versionNo ? `v${versionNo}` : "the latest version";
  const callerName = caller.full_name || (type === "script_sent" ? "Ravi" : "Joe");

  let recipientsQuery = supabase.from("profiles").select("id");
  recipientsQuery = type === "script_sent"
    ? recipientsQuery.eq("is_reviewer", true)
    : recipientsQuery.eq("role", "admin").neq("id", callerId);
  const { data: recipients } = await recipientsQuery;
  if (!recipients?.length) return json(200, { ok: true, skipped: "no recipients" });

  const title =
    type === "script_sent"     ? `Script ready to review: ${scriptTitle}` :
    type === "script_changes"  ? `${callerName} wants changes: ${scriptTitle}` :
                                 `${callerName} approved the script: ${scriptTitle}`;
  const message =
    type === "script_sent"
      ? `${callerName} sent ${v} of "${scriptTitle}". Tap to listen and approve or request changes.`
      : type === "script_changes"
      ? `${callerName} listened to ${v} of "${scriptTitle}" and left feedback. Revise and send again.`
      : `${v} of "${scriptTitle}" is approved and locked — ready to record the final narration.`;

  await deliver(supabase, recipients.map((r) => r.id), {
    type: type!, title, message, scriptId, tag: `lmp-${type}-${scriptId}`,
  });
  return json(200, { ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return json(401, { error: "Unauthorized" });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Verify caller is authenticated
  const { data: { user: caller }, error: authErr } =
    await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  if (authErr || !caller) return json(401, { error: "Unauthorized" });

  const { data: callerProfile } = await supabase
    .from("profiles")
    .select("role, is_reviewer, full_name")
    .eq("id", caller.id)
    .single();

  if (!callerProfile) return json(403, { error: "Profile not found" });
  if (callerProfile.role !== "admin" && !callerProfile.is_reviewer) {
    return json(403, { error: "Not authorized" });
  }

  try {
    const body = (await req.json()) as NotifyBody;
    const { type } = body;

    if (SCRIPT_TYPES.includes(type as ScriptType)) {
      if (!body.scriptId || !body.scriptTitle) {
        return json(400, { error: "scriptId and scriptTitle are required" });
      }
      return await notifyScript(supabase, caller.id, callerProfile as Profile, body);
    }

    const videoId = body.videoId, videoTitle = body.videoTitle;
    if (!type || !videoId || !videoTitle) {
      return json(400, { error: "type, videoId, and videoTitle are required" });
    }

    // ── Update video status FIRST (must happen regardless of recipients) ──
    if (type === "round1_reviewed" || type === "round2_reviewed") {
      const { error: vidErr } = await supabase.from("videos").update({
        review_round: type === "round2_reviewed" ? 2 : 1,
        reviewed_at:  new Date().toISOString(),
        reviewed_by:  caller.id,
      }).eq("id", videoId);
      if (vidErr) console.error("[notify-review] video update error:", vidErr);
    } else if (type === "more_changes_requested") {
      // Reset back to draft so the editor can revise again
      const { error: vidErr } = await supabase.from("videos").update({
        status:       "draft",
        review_round: 1,
      }).eq("id", videoId);
      if (vidErr) console.error("[notify-review] video status reset error:", vidErr);
    }

    // ── Find recipients for notifications ──
    let recipientsQuery = supabase.from("profiles").select("id");
    if (type === "video_uploaded" || type === "video_ready") {
      // Notify reviewers (Joe) when a new draft is uploaded or when Ravi marks done
      recipientsQuery = recipientsQuery.eq("is_reviewer", true);
    } else {
      // round1_reviewed, round2_reviewed, more_changes_requested all notify other admins
      recipientsQuery = recipientsQuery.eq("role", "admin").neq("id", caller.id);
    }
    const { data: recipients } = await recipientsQuery;
    if (!recipients?.length) return json(200, { ok: true, skipped: "no recipients" });

    // Build notification copy
    const callerName = callerProfile.full_name || "Reviewer";
    const notifTitle =
      type === "video_uploaded"         ? `New video uploaded: ${videoTitle}` :
      type === "round1_reviewed"        ? `${callerName} reviewed: ${videoTitle}` :
      type === "round2_reviewed"        ? `${callerName} approved: ${videoTitle} — ready to publish` :
      type === "more_changes_requested" ? `${callerName} requested more changes: ${videoTitle}` :
                                          `Video ready for review: ${videoTitle}`;
    const notifMessage =
      type === "video_uploaded"
        ? `${callerName} uploaded a new video "${videoTitle}" — it's in drafts waiting for production.`
        : type === "round1_reviewed"
        ? `${callerName} has reviewed "${videoTitle}" and left audio feedback. Please revise and mark as Done.`
        : type === "round2_reviewed"
        ? `${callerName} has given final approval for "${videoTitle}". You can now publish it.`
        : type === "more_changes_requested"
        ? `${callerName} reviewed "${videoTitle}" and needs more changes. Please revise and mark as Done again.`
        : `"${videoTitle}" has been revised and is ready for your final review.`;

    await deliver(supabase, recipients.map((r) => r.id), {
      type, title: notifTitle, message: notifMessage, videoId, tag: `lmp-${type}-${videoId}`,
    });

    return json(200, { ok: true });
  } catch (err) {
    console.error("[notify-review]", err);
    return json(500, { error: err instanceof Error ? err.message : "Internal error" });
  }
});
