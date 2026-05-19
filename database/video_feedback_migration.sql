-- ══════════════════════════════════════════════════════════
-- Video Feedback — Admins can leave voice notes per video
-- ══════════════════════════════════════════════════════════

create table if not exists video_feedback (
  id uuid primary key default uuid_generate_v4(),
  video_id uuid not null references videos(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  audio_path text not null,
  duration_seconds int,
  created_at timestamptz default now()
);

create index if not exists video_feedback_video_id_idx on video_feedback(video_id);

-- Explicit FK to profiles so PostgREST can embed the author name
alter table video_feedback
  drop constraint if exists video_feedback_user_id_profiles_fkey;
alter table video_feedback
  add constraint video_feedback_user_id_profiles_fkey
  foreign key (user_id) references profiles(id) on delete cascade;

alter table video_feedback enable row level security;

-- Admins can read all feedback
create policy "video_feedback_admin_read" on video_feedback for select
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

-- Admins can only create their own feedback rows
create policy "video_feedback_admin_insert" on video_feedback for insert
  with check (
    auth.uid() = user_id and
    exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );

-- Admins can only delete their own feedback
create policy "video_feedback_admin_delete" on video_feedback for delete
  using (
    auth.uid() = user_id and
    exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );

-- Storage bucket for audio files (admin-only)
insert into storage.buckets (id, name, public)
values ('video-feedback', 'video-feedback', false)
on conflict (id) do nothing;

create policy "video_feedback_storage_admin_read" on storage.objects for select
  using (
    bucket_id = 'video-feedback' and
    exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );

create policy "video_feedback_storage_admin_insert" on storage.objects for insert
  with check (
    bucket_id = 'video-feedback' and
    exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );

create policy "video_feedback_storage_admin_delete" on storage.objects for delete
  using (
    bucket_id = 'video-feedback' and
    exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );
