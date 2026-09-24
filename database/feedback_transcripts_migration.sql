-- ══════════════════════════════════════════════════════════
-- Transcripts on video feedback, like script feedback already has.
-- Every voice note is transcribed when it is saved (transcribe edge function,
-- feedbackId mode) and the first line is shown on the note — Joe starts each
-- recording with the section number it is about.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ══════════════════════════════════════════════════════════
alter table video_feedback add column if not exists transcript text;
notify pgrst, 'reload schema';
