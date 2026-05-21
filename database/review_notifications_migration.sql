-- ══════════════════════════════════════════════════════
-- Review workflow: reviewer flag, review rounds,
-- and in-app + email notifications
--
-- SETUP: after running this migration, mark Joe's account
-- as the reviewer by running:
--   UPDATE profiles SET is_reviewer = true WHERE id = '<joe-uuid>';
-- Joe should also have role = 'admin' so he can see drafts.
-- ══════════════════════════════════════════════════════

-- Flag the designated reviewer on their profile
alter table profiles add column if not exists is_reviewer boolean default false;

-- Track review progress on each video
-- 0 = not yet reviewed, 1 = first review given, 2 = final approval given
alter table videos add column if not exists review_round   integer    default 0;
alter table videos add column if not exists reviewed_at    timestamptz;
alter table videos add column if not exists reviewed_by    uuid references profiles(id);

-- ── NOTIFICATIONS ────────────────────────────────────
create table if not exists notifications (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        references profiles(id) on delete cascade not null,
  video_id    uuid        references videos(id)   on delete cascade,
  type        text        not null check (type in ('round1_reviewed', 'round2_reviewed', 'video_ready')),
  title       text        not null,
  message     text,
  read        boolean     default false,
  created_at  timestamptz default now()
);

create index if not exists notifications_user_id_idx on notifications(user_id);
create index if not exists notifications_created_idx on notifications(created_at desc);

alter table notifications enable row level security;

-- Users see only their own notifications
create policy "notifs_own_read"
  on notifications for select
  using (auth.uid() = user_id);

-- Users can mark their own notifications as read
create policy "notifs_own_update"
  on notifications for update
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Inserts are done exclusively by the notify-review edge function
-- (service role key), so no client insert policy is needed.
