-- ══════════════════════════════════════════════════════════
-- SCRIPT = PROJECT: category/sub-category/slot + assigned writer & editor
--
-- A script is created against a video slot (category → sub-category → empty
-- slot) and is the initiation of that video's project. Ravi assigns a content
-- writer up front and an editor later. Assignees are ordinary accounts (role
-- 'worker'); access is granted purely by assignment, not by role.
--
-- Run once in the Supabase SQL editor, after scripts_migration.sql.
-- ══════════════════════════════════════════════════════════

begin;

-- ── 1. Columns ──────────────────────────────────────────────
alter table scripts add column if not exists category_id    uuid references categories(id);
alter table scripts add column if not exists subcategory_id uuid references subcategories(id);
alter table scripts add column if not exists writer_id      uuid references profiles(id) on delete set null;
alter table scripts add column if not exists editor_id      uuid references profiles(id) on delete set null;

create index if not exists scripts_writer_idx on scripts(writer_id);
create index if not exists scripts_editor_idx on scripts(editor_id);
create index if not exists scripts_video_idx  on scripts(video_id);

-- ── 2. Helpers — SECURITY DEFINER so policies on child tables can look at
--       scripts without tripping scripts' own RLS ────────────
create or replace function is_script_assignee(p_script_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from scripts
    where id = p_script_id and (writer_id = auth.uid() or editor_id = auth.uid())
  );
$$;

create or replace function is_script_writer(p_script_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from scripts where id = p_script_id and writer_id = auth.uid());
$$;

revoke all on function is_script_assignee(uuid) from public, anon;
revoke all on function is_script_writer(uuid)   from public, anon;
grant execute on function is_script_assignee(uuid) to authenticated;
grant execute on function is_script_writer(uuid)   to authenticated;

-- ── 3. RLS for assignees (staff policies from scripts_migration stay) ──
drop policy if exists "scripts_assignee_read"            on scripts;
drop policy if exists "scripts_writer_update"            on scripts;
drop policy if exists "script_versions_assignee_read"    on script_versions;
drop policy if exists "script_versions_writer_insert"    on script_versions;
drop policy if exists "script_feedback_assignee_read"    on script_feedback;
drop policy if exists "script_feedback_assignee_insert"  on script_feedback;
drop policy if exists "script_feedback_own_delete"       on script_feedback;

-- Writer and editor both see the project; only the writer edits the text.
create policy "scripts_assignee_read" on scripts for select
  using (writer_id = auth.uid() or editor_id = auth.uid());
create policy "scripts_writer_update" on scripts for update
  using (writer_id = auth.uid()) with check (writer_id = auth.uid());

create policy "script_versions_assignee_read" on script_versions for select
  using (is_script_assignee(script_id));
create policy "script_versions_writer_insert" on script_versions for insert
  with check (is_script_writer(script_id));

create policy "script_feedback_assignee_read" on script_feedback for select
  using (is_script_assignee(script_id));
create policy "script_feedback_assignee_insert" on script_feedback for insert
  with check (user_id = auth.uid() and is_script_assignee(script_id));
create policy "script_feedback_own_delete" on script_feedback for delete
  using (user_id = auth.uid());

-- Assignees can see the linked video slot (title, status) even though they
-- are not staff — videos' existing per-role policies stay untouched.
drop policy if exists "videos_script_assignee_read" on videos;
create policy "videos_script_assignee_read" on videos for select
  using (exists (
    select 1 from scripts s
    where s.video_id = videos.id and (s.writer_id = auth.uid() or s.editor_id = auth.uid())
  ));

-- ── 4. Storage ──────────────────────────────────────────────
-- Preview audio: anyone assigned to at least one script may read the cache
-- (clips are content-addressed and shared across scripts anyway).
drop policy if exists "script_audio_staff_read" on storage.objects;
create policy "script_audio_staff_read" on storage.objects for select
  using (
    bucket_id = 'script-audio' and (
      exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true))
      or exists (select 1 from scripts where writer_id = auth.uid() or editor_id = auth.uid())
    )
  );

-- Script voice notes live in video-feedback under scripts/<script_id>/…
-- The existing bucket policies are admin-only; open that prefix to assignees.
drop policy if exists "video_feedback_storage_script_assignee_read"   on storage.objects;
drop policy if exists "video_feedback_storage_script_assignee_insert" on storage.objects;
drop policy if exists "video_feedback_storage_script_assignee_delete" on storage.objects;

create policy "video_feedback_storage_script_assignee_read" on storage.objects for select
  using (
    bucket_id = 'video-feedback'
    and name ~ '^scripts/[0-9a-f-]{36}/'
    and is_script_assignee(split_part(name, '/', 2)::uuid)
  );
create policy "video_feedback_storage_script_assignee_insert" on storage.objects for insert
  with check (
    bucket_id = 'video-feedback'
    and name ~ '^scripts/[0-9a-f-]{36}/'
    and is_script_assignee(split_part(name, '/', 2)::uuid)
  );
create policy "video_feedback_storage_script_assignee_delete" on storage.objects for delete
  using (
    bucket_id = 'video-feedback'
    and name ~ '^scripts/[0-9a-f-]{36}/'
    and owner = auth.uid()
  );

-- ── 5. Notifications: assignment event ──────────────────────
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in (
    'video_uploaded', 'round1_reviewed', 'round2_reviewed', 'video_ready', 'more_changes_requested',
    'script_sent', 'script_changes', 'script_approved', 'script_assigned'
  ));

commit;

notify pgrst, 'reload schema';
