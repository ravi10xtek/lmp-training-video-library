-- ══════════════════════════════════════════════════════════
-- Upgrade video_feedback → rich comments
-- A comment may now contain any combination of: text, audio, image.
-- ══════════════════════════════════════════════════════════

-- Audio is no longer required (text-only or image-only comments allowed)
alter table video_feedback alter column audio_path drop not null;

-- New optional content columns
alter table video_feedback add column if not exists body       text;
alter table video_feedback add column if not exists image_path text;

-- A comment must carry at least one kind of content
alter table video_feedback drop constraint if exists video_feedback_has_content;
alter table video_feedback add constraint video_feedback_has_content
  check (body is not null or audio_path is not null or image_path is not null);

-- Images live in the same private bucket as audio; existing storage
-- policies (admin read/insert/delete on bucket 'video-feedback') already cover them.

notify pgrst, 'reload schema';
