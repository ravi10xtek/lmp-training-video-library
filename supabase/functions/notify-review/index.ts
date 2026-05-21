import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL             = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY            = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL                = Deno.env.get("NOTIFY_FROM_EMAIL") ||
  "Training Library <no-reply@lochmonsterplumbing.com>";

type NotifyBody = {
  type: "round1_reviewed" | "round2_reviewed" | "video_ready";
  videoId: string;
  videoTitle: string;
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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
    const { type, videoId, videoTitle } = (await req.json()) as NotifyBody;
    if (!type || !videoId || !videoTitle) {
      return json(400, { error: "type, videoId, and videoTitle are required" });
    }

    // Find recipients
    let recipientsQuery = supabase.from("profiles").select("id");
    if (type === "video_ready") {
      // Notify the reviewer(s)
      recipientsQuery = recipientsQuery.eq("is_reviewer", true);
    } else {
      // Notify all admins except the person who clicked Reviewed
      recipientsQuery = recipientsQuery.eq("role", "admin").neq("id", caller.id);
    }
    const { data: recipients } = await recipientsQuery;
    if (!recipients?.length) return json(200, { ok: true, skipped: "no recipients" });

    // Build notification copy
    const callerName = callerProfile.full_name || "Reviewer";
    const notifTitle =
      type === "round1_reviewed" ? `${callerName} reviewed: ${videoTitle}` :
      type === "round2_reviewed" ? `${callerName} approved: ${videoTitle} — ready to publish` :
                                   `Video ready for review: ${videoTitle}`;
    const notifMessage =
      type === "round1_reviewed"
        ? `${callerName} has reviewed "${videoTitle}" and left audio feedback. Please revise and mark as Done.`
        : type === "round2_reviewed"
        ? `${callerName} has given final approval for "${videoTitle}". You can now publish it.`
        : `"${videoTitle}" has been revised and is ready for your final review.`;

    // Insert in-app notifications
    await supabase.from("notifications").insert(
      recipients.map((r) => ({
        user_id:  r.id,
        video_id: videoId,
        type,
        title:    notifTitle,
        message:  notifMessage,
      }))
    );

    // Update review round on the video (reviewer actions only)
    if (type === "round1_reviewed" || type === "round2_reviewed") {
      await supabase.from("videos").update({
        review_round: type === "round2_reviewed" ? 2 : 1,
        reviewed_at:  new Date().toISOString(),
        reviewed_by:  caller.id,
      }).eq("id", videoId);
    }

    // Send emails via Resend — skipped gracefully if key not configured
    if (RESEND_API_KEY) {
      await Promise.allSettled(
        recipients.map(async (r) => {
          const { data: { user } } = await supabase.auth.admin.getUserById(r.id);
          if (!user?.email) return;
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: FROM_EMAIL,
              to:   user.email,
              subject: notifTitle,
              text: notifMessage + "\n\nLog in to the Training Library to view this video.",
            }),
          });
        })
      );
    }

    return json(200, { ok: true });
  } catch (err) {
    console.error("[notify-review]", err);
    return json(500, { error: err instanceof Error ? err.message : "Internal error" });
  }
});
