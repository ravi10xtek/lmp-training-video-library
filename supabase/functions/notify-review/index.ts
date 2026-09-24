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
type ScriptType = "script_sent" | "script_changes" | "script_approved" | "script_assigned";
type NotifyBody = {
  type: VideoType | ScriptType;
  // Video events
  videoId?: string;
  videoTitle?: string;
  // Script-review events
  scriptId?: string;
  scriptTitle?: string;
  versionNo?: number;
  // script_assigned
  assigneeId?: string;
  assigneeRole?: "writer" | "editor";
};
type Profile = { role: string; is_reviewer: boolean | null; full_name: string | null };

const SCRIPT_TYPES: ScriptType[] = ["script_sent", "script_changes", "script_approved", "script_assigned"];
const VIDEO_TYPES: VideoType[] = ["video_uploaded", "round1_reviewed", "round2_reviewed", "video_ready", "more_changes_requested"];

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
// script_sent     → writer sent a version → reviewers (Joe)
// script_changes  → Joe wants changes     → admins + assigned writer
// script_approved → Joe approved          → admins + writer + assigned editor
// script_assigned → Ravi assigned someone → that person
async function notifyScript(supabase: SupabaseClient, callerId: string, caller: Profile, body: NotifyBody) {
  const { type, scriptId, versionNo, assigneeId, assigneeRole } = body;
  const v = versionNo ? `v${versionNo}` : "the latest version";
  const callerName = caller.full_name || (type === "script_sent" ? "The writer" : "Joe");

  // Never trust the client for text that lands in someone else's inbox
  const { data: script } = await supabase
    .from("scripts").select("title, writer_id, editor_id").eq("id", scriptId!).single();
  if (!script) return json(404, { error: "Script not found" });
  const scriptTitle = script.title;
  if (type === "script_assigned" && assigneeId !== script.writer_id && assigneeId !== script.editor_id) {
    return json(400, { error: "That person is not assigned to this script" });
  }

  const ids = new Set<string>();
  if (type === "script_assigned") {
    if (assigneeId) ids.add(assigneeId);
  } else if (type === "script_sent") {
    // Scripts are reviewed by the client only, not the video reviewer
    const { data } = await supabase.from("profiles").select("id").eq("account_type", "client");
    (data || []).forEach((r) => ids.add(r.id));
  } else {
    (await managerIds(supabase)).forEach((id) => ids.add(id));
    if (script.writer_id) ids.add(script.writer_id);
    if (type === "script_approved" && script.editor_id) ids.add(script.editor_id);
  }
  ids.delete(callerId);
  const recipientIds = [...ids];
  if (!recipientIds.length) return json(200, { ok: true, skipped: "no recipients" });

  const roleLabel = assigneeRole === "editor" ? "editor" : "content writer";
  const title =
    type === "script_sent"     ? `Script ready to review: ${scriptTitle}` :
    type === "script_changes"  ? `${callerName} wants changes: ${scriptTitle}` :
    type === "script_approved" ? `${callerName} approved the script: ${scriptTitle}` :
                                 `You're the ${roleLabel} on: ${scriptTitle}`;
  const message =
    type === "script_sent"
      ? `${callerName} sent ${v} of "${scriptTitle}". Tap to listen and approve or request changes.`
      : type === "script_changes"
      ? `${callerName} listened to ${v} of "${scriptTitle}" and left feedback. Revise and send again.`
      : type === "script_approved"
      ? `${v} of "${scriptTitle}" is approved and locked — ready to record the final narration and produce the video.`
      : assigneeRole === "editor"
      ? `${callerName} assigned you to edit the video for "${scriptTitle}". You'll be notified when the script is approved.`
      : `${callerName} assigned you to write "${scriptTitle}". Open Scripts to start the draft.`;

  await deliver(supabase, recipientIds, {
    type: type!, title, message, scriptId, tag: `lmp-${type}-${scriptId}${assigneeId ? "-" + assigneeId : ""}`,
  });
  return json(200, { ok: true });
}

// The manager(s): admins who are not the client reviewer
async function managerIds(supabase: SupabaseClient): Promise<string[]> {
  const { data } = await supabase.from("profiles").select("id, is_reviewer").eq("role", "admin");
  return (data || []).filter((r) => !r.is_reviewer).map((r) => r.id);
}

// Assigned writers/editors are plain accounts (role 'worker'); they may fire
// script events for their own script.
async function isScriptAssignee(supabase: SupabaseClient, userId: string, scriptId: string) {
  const { data } = await supabase.from("scripts").select("writer_id, editor_id").eq("id", scriptId).single();
  return !!data && (data.writer_id === userId || data.editor_id === userId);
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
  const isStaff = callerProfile.role === "admin" || !!callerProfile.is_reviewer;

  try {
    const body = (await req.json()) as NotifyBody;
    const { type } = body;

    if (SCRIPT_TYPES.includes(type as ScriptType)) {
      if (!body.scriptId) {
        return json(400, { error: "scriptId is required" });
      }
      // A writer may only announce a version they sent; decisions and
      // assignments come from staff.
      if (!isStaff && (type !== "script_sent" || !(await isScriptAssignee(supabase, caller.id, body.scriptId)))) {
        return json(403, { error: "Not authorized" });
      }
      return await notifyScript(supabase, caller.id, callerProfile as Profile, body);
    }

    const videoId = body.videoId;
    if (!VIDEO_TYPES.includes(type as VideoType) || !videoId) {
      return json(400, { error: "A known type and videoId are required" });
    }

    const { data: video } = await supabase.from("videos").select("title").eq("id", videoId).single();
    if (!video) return json(404, { error: "Video not found" });
    const videoTitle = video.title;

    // The project's editor (and writer) may announce their own video
    const { data: project } = await supabase
      .from("scripts").select("writer_id, editor_id").eq("video_id", videoId).limit(1).maybeSingle();
    const isAssignee = !!project && (project.writer_id === caller.id || project.editor_id === caller.id);
    // The editor can only say "sent to Joe"; the decisions are Joe's.
    if (!isStaff && !(isAssignee && type === "video_ready")) return json(403, { error: "Not authorized" });

    // ── Recipients ──
    // Sent to Joe → the reviewers. Joe's decision → the manager(s) + the editor.
    const ids = new Set<string>();
    if (type === "video_uploaded" || type === "video_ready") {
      const { data } = await supabase.from("profiles").select("id").eq("is_reviewer", true);
      (data || []).forEach((r) => ids.add(r.id));
    } else {
      (await managerIds(supabase)).forEach((id) => ids.add(id));
      if (project?.editor_id) ids.add(project.editor_id);
    }
    ids.delete(caller.id);
    const recipients = [...ids].map((id) => ({ id }));
    if (!recipients.length) return json(200, { ok: true, skipped: "no recipients" });

    // Build notification copy
    const callerName = callerProfile.full_name || "Reviewer";
    const notifTitle =
      type === "video_uploaded"         ? `New video uploaded: ${videoTitle}` :
      type === "round1_reviewed"        ? `${callerName} reviewed: ${videoTitle}` :
      type === "round2_reviewed"        ? `${callerName} approved: ${videoTitle} — ready to publish` :
      type === "more_changes_requested" ? `${callerName} wants changes: ${videoTitle}` :
                                          `Video ready for review: ${videoTitle}`;
    const notifMessage =
      type === "video_uploaded"
        ? `${callerName} uploaded a new video "${videoTitle}" — it's in drafts waiting for production.`
        : type === "round1_reviewed"
        ? `${callerName} has reviewed "${videoTitle}" and left audio feedback. Please revise and mark as Done.`
        : type === "round2_reviewed"
        ? `${callerName} has given final approval for "${videoTitle}". You can now publish it.`
        : type === "more_changes_requested"
        ? `${callerName} reviewed "${videoTitle}" and left notes. Make the changes, upload the new version and send it back.`
        : `A new version of "${videoTitle}" is ready for your review.`;

    await deliver(supabase, recipients.map((r) => r.id), {
      type, title: notifTitle, message: notifMessage, videoId, tag: `lmp-${type}-${videoId}`,
    });

    return json(200, { ok: true });
  } catch (err) {
    console.error("[notify-review]", err);
    return json(500, { error: err instanceof Error ? err.message : "Internal error" });
  }
});
