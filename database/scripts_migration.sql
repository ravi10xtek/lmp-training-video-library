-- ══════════════════════════════════════════════════════════
-- SCRIPT REVIEW MODULE
--
-- A script is confirmed with Joe BEFORE any video is produced. Ravi writes the
-- narration text, the app renders a cheap OpenAI TTS preview (cached per
-- paragraph, so a revision only re-renders the paragraphs that changed), Joe
-- listens on his phone, leaves voice notes (auto-transcribed), and approves.
-- The approved version is pinned to the video slot for the video review flow.
--
-- Run once in the Supabase SQL editor.
-- ══════════════════════════════════════════════════════════

begin;

-- ── 1. Scripts ──────────────────────────────────────────────
create table if not exists scripts (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null,
  video_id            uuid references videos(id) on delete set null,
  -- draft    → Ravi is writing / revising (nothing with Joe)
  -- sent     → a version is with Joe, waiting for a decision
  -- changes  → Joe asked for changes on the latest version
  -- approved → latest version approved; approved_version_id is the signed-off text
  status              text not null default 'draft'
                        check (status in ('draft','sent','changes','approved')),
  draft_body          text,                       -- working text not yet sent
  current_version     int  not null default 0,    -- number of the latest sent version
  approved_version_id uuid,                       -- FK added below
  approved_at         timestamptz,
  approved_by         uuid references profiles(id),
  created_by          uuid references profiles(id),
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- ── 2. Versions — immutable snapshots, one per "Send to Joe" ─
create table if not exists script_versions (
  id            uuid primary key default gen_random_uuid(),
  script_id     uuid not null references scripts(id) on delete cascade,
  version       int  not null,
  body          text not null,
  -- [{ i, text, hash, heading, audio_path, changed }]
  -- hash    = sha256(model|voice|normalised text) → key into tts_cache
  -- changed = hash not present in the previous version (drives "play changes only")
  paragraphs    jsonb not null default '[]'::jsonb,
  changed_count int not null default 0,
  total_count   int not null default 0,
  decision      text not null default 'pending'
                  check (decision in ('pending','approved','changes')),
  decided_at    timestamptz,
  decided_by    uuid references profiles(id),
  created_by    uuid references profiles(id),
  created_at    timestamptz default now(),
  unique (script_id, version)
);

alter table scripts
  drop constraint if exists scripts_approved_version_fkey;
alter table scripts
  add constraint scripts_approved_version_fkey
  foreign key (approved_version_id) references script_versions(id) on delete set null;

create index if not exists script_versions_script_idx on script_versions(script_id, version desc);

-- ── 3. Feedback — Joe's voice notes / comments per version ───
-- Audio + images reuse the private `video-feedback` bucket under scripts/<id>/…
create table if not exists script_feedback (
  id               uuid primary key default gen_random_uuid(),
  script_id        uuid not null references scripts(id) on delete cascade,
  version_id       uuid references script_versions(id) on delete cascade,
  user_id          uuid not null references profiles(id) on delete cascade,
  body             text,
  audio_path       text,
  image_path       text,
  duration_seconds int,
  transcript       text,                          -- Whisper transcript of audio_path
  created_at       timestamptz default now(),
  constraint script_feedback_has_content
    check (body is not null or audio_path is not null or image_path is not null)
);

create index if not exists script_feedback_script_idx on script_feedback(script_id, created_at desc);

-- ── 4. TTS cache — content-addressed audio, shared across all scripts ─
create table if not exists tts_cache (
  hash       text primary key,                    -- sha256(model|voice|text)
  text       text not null,
  model      text not null,
  voice      text not null,
  chars      int  not null,
  audio_path text not null,                       -- object key in `script-audio`
  bytes      int,
  created_at timestamptz default now()
);

-- ── 5. Notifications can point at a script instead of a video ─
alter table notifications add column if not exists script_id uuid references scripts(id) on delete cascade;

alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in (
    'video_uploaded', 'round1_reviewed', 'round2_reviewed', 'video_ready', 'more_changes_requested',
    'script_sent', 'script_changes', 'script_approved'
  ));

-- ── 6. updated_at trigger (reuses the existing helper) ──────
drop trigger if exists scripts_updated_at on scripts;
create trigger scripts_updated_at
  before update on scripts
  for each row execute function update_updated_at();

-- ── 7. RLS — internal staff only (admin OR reviewer) ────────
-- Unlike videos, both people need to see every script at every stage, so
-- there is no per-folder visibility split and no SECURITY DEFINER RPC.
alter table scripts          enable row level security;
alter table script_versions  enable row level security;
alter table script_feedback  enable row level security;
alter table tts_cache        enable row level security;

drop policy if exists "scripts_staff_all"          on scripts;
drop policy if exists "script_versions_staff_all"  on script_versions;
drop policy if exists "script_feedback_staff_all"  on script_feedback;
drop policy if exists "tts_cache_staff_read"       on tts_cache;

create policy "scripts_staff_all" on scripts for all
  using  (exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true)))
  with check (exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true)));

create policy "script_versions_staff_all" on script_versions for all
  using  (exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true)))
  with check (exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true)));

create policy "script_feedback_staff_all" on script_feedback for all
  using  (exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true)))
  with check (exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true)));

-- Cache rows are written only by the script-tts edge function (service role).
create policy "tts_cache_staff_read" on tts_cache for select
  using (exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true)));

-- ── 8. Storage — private bucket for the preview audio ───────
insert into storage.buckets (id, name, public)
values ('script-audio', 'script-audio', false)
on conflict (id) do nothing;

drop policy if exists "script_audio_staff_read" on storage.objects;
create policy "script_audio_staff_read" on storage.objects for select
  using (
    bucket_id = 'script-audio' and
    exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true))
  );
-- Writes come from the edge function with the service role — no client policy.

-- ── 9. Realtime — live status/count refresh in the app ──────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'scripts'
  ) then
    alter publication supabase_realtime add table scripts;
  end if;
end $$;

commit;

notify pgrst, 'reload schema';
