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
-- Apply once in the Supabase SQL editor. Idempotent / safe to re-run.
-- ══════════════════════════════════════════════════════════

begin;

-- ── 1. Drop the old constraint so statuses can be re-mapped freely ──
-- (Must happen BEFORE the data migration — adding the new constraint
--  while draft/done rows still exist would violate it.)
alter table videos drop constraint if exists videos_status_check;

-- ── 2. Migrate existing rows onto the new lifecycle ───────────
update videos set status = case
  when status = 'draft' and coalesce(review_round,0) >= 1 then 'to_edit'
  when status = 'draft'                                    then 'to_review'
  when status = 'done'  and coalesce(review_round,0) >= 2  then 'completed'
  when status = 'done'                                     then 'to_review'
  else status
end
where status in ('draft','done');

-- Coerce any other legacy/unknown status so the new constraint will hold:
-- content-bearing → to_review, otherwise → empty
update videos set status = case
  when storage_key is not null or video_url is not null then 'to_review'
  else 'empty'
end
where status not in ('empty','raw','to_review','to_edit','completed','published');

-- review_round is now a 1-based cycle counter
update videos set review_round = 1 where coalesce(review_round,0) = 0;
alter table videos alter column review_round set default 1;

-- ── 3. Add the new constraint (every row already conforms) ────
alter table videos add constraint videos_status_check
  check (status in ('empty','raw','to_review','to_edit','completed','published'));

-- ── 4. Round-scoped feedback ──────────────────────────────────
alter table video_feedback
  add column if not exists review_round integer not null default 1;

-- ── 5. RLS: strict role-scoped reads, shared admin writes ─────
-- Reads decide which folder each role sees. Writes stay admin-wide
-- (UI-gated) so a cross-folder transition can write a row the writer
-- will no longer be able to read. Client transitions use
-- .update().eq(id) without .select() (return=minimal), so no SELECT
-- on the post-update row is ever required.

drop policy if exists "videos_worker_read"   on videos;
drop policy if exists "videos_admin_write"   on videos;
drop policy if exists "videos_reviewer_read" on videos;
drop policy if exists "videos_editor_read"   on videos;
drop policy if exists "videos_admin_insert"  on videos;
drop policy if exists "videos_admin_update"  on videos;
drop policy if exists "videos_admin_delete"  on videos;
drop policy if exists "videos_staff_insert"  on videos;
drop policy if exists "videos_staff_update"  on videos;
drop policy if exists "videos_staff_delete"  on videos;

-- Everyone (incl. workers) reads published
create policy "videos_worker_read" on videos for select using (
  status = 'published'
);

-- Reviewer (Joe) reads only the TO REVIEW queue. Keyed on is_reviewer so it
-- works regardless of the reviewer's exact `role` value.
create policy "videos_reviewer_read" on videos for select using (
  status = 'to_review'
  and exists (
    select 1 from profiles where id = auth.uid() and is_reviewer = true
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

-- Writes: any internal staff (admin OR reviewer) — gated by the UI. Explicit
-- WITH CHECK so cross-folder transitions (e.g. to_review → to_edit) are allowed.
create policy "videos_staff_insert" on videos for insert
  with check (exists (
    select 1 from profiles where id = auth.uid()
    and (role = 'admin' or is_reviewer = true)
  ));
create policy "videos_staff_update" on videos for update
  using (exists (
    select 1 from profiles where id = auth.uid()
    and (role = 'admin' or is_reviewer = true)
  ))
  with check (exists (
    select 1 from profiles where id = auth.uid()
    and (role = 'admin' or is_reviewer = true)
  ));
create policy "videos_staff_delete" on videos for delete
  using (exists (
    select 1 from profiles where id = auth.uid()
    and (role = 'admin' or is_reviewer = true)
  ));

commit;

-- ══════════════════════════════════════════════════════════
-- 6. Status transitions via SECURITY DEFINER function
--
-- Strict per-role SELECT means a transition (e.g. to_review → to_edit) moves
-- the row out of the actor's own read scope, which makes a plain client UPDATE
-- fail RLS ("new row violates row-level security policy"). This function runs
-- with elevated rights (bypassing the read re-check) but verifies the caller
-- is staff and applies the review_round logic server-side.
-- ══════════════════════════════════════════════════════════
create or replace function set_video_status(p_video_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cur text;
  rnd int;
begin
  if not exists (
    select 1 from profiles
    where id = auth.uid() and (role = 'admin' or is_reviewer = true)
  ) then
    raise exception 'Not authorized';
  end if;

  select status, coalesce(review_round, 1) into cur, rnd
  from videos where id = p_video_id;
  if cur is null then
    raise exception 'Video not found';
  end if;

  update videos set
    status = p_status,
    review_round = case
      when p_status = 'to_review' and cur = 'to_edit'        then rnd + 1
      when p_status = 'to_review' and cur in ('empty','raw') then 1
      else review_round
    end,
    reviewed_at = case when p_status in ('to_edit','completed') then now() else reviewed_at end,
    reviewed_by = case when p_status in ('to_edit','completed') then auth.uid() else reviewed_by end
  where id = p_video_id;
end;
$$;

revoke all on function set_video_status(uuid, text) from public, anon;
grant execute on function set_video_status(uuid, text) to authenticated;
