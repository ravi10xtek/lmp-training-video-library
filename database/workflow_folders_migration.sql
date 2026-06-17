-- ══════════════════════════════════════════════════════════
-- Role-based review/edit folders + round-scoped feedback
--
-- Replaces the shared draft/done + review_round model with explicit
-- folder statuses and strict per-role read visibility:
--   to_review  → Joe's "TO REVIEW"        (reviewer only)
--   to_edit    → Ravi's "TO EDIT"          (editor only)
--   completed  → Ravi's "COMPLETED VIDEOS" (editor only)
--
-- Roles: reviewer = admin AND is_reviewer = true   (Joe)
--        editor   = admin AND is_reviewer = false  (Ravi)
--
-- Apply once in the Supabase SQL editor. Safe to re-run.
-- ══════════════════════════════════════════════════════════

-- ── 1. Status constraint ──────────────────────────────────────
alter table videos drop constraint if exists videos_status_check;
alter table videos add constraint videos_status_check
  check (status in ('empty','raw','to_review','to_edit','completed','published'));

-- ── 2. Migrate existing rows onto the new lifecycle ───────────
update videos set status = case
  when status = 'draft' and coalesce(review_round,0) >= 1 then 'to_edit'
  when status = 'draft'                                    then 'to_review'
  when status = 'done'  and coalesce(review_round,0) >= 2  then 'completed'
  when status = 'done'                                     then 'to_review'
  else status
end
where status in ('draft','done');

-- review_round is now a 1-based cycle counter
alter table videos alter column review_round set default 1;
update videos set review_round = 1 where coalesce(review_round,0) = 0;

-- ── 3. Round-scoped feedback ──────────────────────────────────
alter table video_feedback
  add column if not exists review_round integer not null default 1;

-- ── 4. RLS: strict role-scoped reads, shared admin writes ─────
-- Reads decide which folder each role sees. Writes stay admin-wide
-- (UI-gated) so a cross-folder transition can write a row the writer
-- will no longer be able to read. Client transitions use
-- .update().eq(id) without .select() (return=minimal), so no SELECT
-- on the post-update row is ever required.

drop policy if exists "videos_worker_read" on videos;
drop policy if exists "videos_admin_write"  on videos;

-- Everyone (incl. workers) reads published
create policy "videos_worker_read" on videos for select using (
  status = 'published'
);

-- Reviewer (Joe) reads only the TO REVIEW queue
create policy "videos_reviewer_read" on videos for select using (
  status = 'to_review'
  and exists (
    select 1 from profiles
    where id = auth.uid() and role = 'admin' and is_reviewer = true
  )
);

-- Editor (Ravi) reads slots + the editor-owned folders
create policy "videos_editor_read" on videos for select using (
  status in ('empty','raw','to_edit','completed')
  and exists (
    select 1 from profiles
    where id = auth.uid() and role = 'admin' and coalesce(is_reviewer, false) = false
  )
);

-- Any admin may write (insert/update/delete) — gated by the UI
create policy "videos_admin_insert" on videos for insert with check (
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);
create policy "videos_admin_update" on videos for update using (
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);
create policy "videos_admin_delete" on videos for delete using (
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);
