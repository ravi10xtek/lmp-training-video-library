import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL             = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TWILIO_ACCOUNT_SID       = Deno.env.get("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN        = Deno.env.get("TWILIO_AUTH_TOKEN");
const TWILIO_FROM_NUMBER       = Deno.env.get("TWILIO_FROM_NUMBER");

type NotifyBody = {
  type: "round1_reviewed" | "round2_reviewed" | "video_ready" | "more_changes_requested";
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
    let recipientsQuery = supabase.from("profiles").select("id, phone_number");
    if (type === "video_ready") {
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
      type === "round1_reviewed"        ? `${callerName} reviewed: ${videoTitle}` :
      type === "round2_reviewed"        ? `${callerName} approved: ${videoTitle} — ready to publish` :
      type === "more_changes_requested" ? `${callerName} requested more changes: ${videoTitle}` :
                                          `Video ready for review: ${videoTitle}`;
    const notifMessage =
      type === "round1_reviewed"
        ? `${callerName} has reviewed "${videoTitle}" and left audio feedback. Please revise and mark as Done.`
        : type === "round2_reviewed"
        ? `${callerName} has given final approval for "${videoTitle}". You can now publish it.`
        : type === "more_changes_requested"
        ? `${callerName} reviewed "${videoTitle}" and needs more changes. Please revise and mark as Done again.`
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

    // Send SMS via Twilio — skipped gracefully if secrets not configured
    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER) {
      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
      const credentials = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
      const smsBody = `LMP Training Library: ${notifTitle}`;

      await Promise.allSettled(
        recipients
          .filter((r) => r.phone_number)
          .map((r) =>
            fetch(twilioUrl, {
              method: "POST",
              headers: {
                "Authorization": `Basic ${credentials}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                From: TWILIO_FROM_NUMBER,
                To:   r.phone_number!,
                Body: smsBody,
              }).toString(),
            })
          )
      );
    }

    return json(200, { ok: true });
  } catch (err) {
    console.error("[notify-review]", err);
    return json(500, { error: err instanceof Error ? err.message : "Internal error" });
  }
});
