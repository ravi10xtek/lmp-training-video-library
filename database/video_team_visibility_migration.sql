-- ══════════════════════════════════════════════════════════
-- Team keeps seeing a video while it is with Joe
--
-- Uploads now stay 'raw' until someone clicks Submit for Review, and the
-- editor/admin read policy also covers 'to_review' so the video doesn't vanish
-- from the team's Video tab once it has been sent. Joe (reviewer) still only
-- sees the TO REVIEW queue. Safe to re-run.
-- ══════════════════════════════════════════════════════════
begin;

drop policy if exists "videos_editor_read" on videos;
create policy "videos_editor_read" on videos for select using (
  status in ('empty','raw','to_review','to_edit','completed')
  and exists (
    select 1 from profiles
    where id = auth.uid() and role = 'admin' and coalesce(is_reviewer, false) = false
  )
);

commit;

-- Joe sees the slot linked to each project (title, status) so his project page
-- doesn't read "No slot". The app keeps the video itself hidden from him until
-- it has been submitted for review.
drop policy if exists "videos_reviewer_project_read" on videos;
create policy "videos_reviewer_project_read" on videos for select using (
  exists (select 1 from scripts s where s.video_id = videos.id)
  and exists (select 1 from profiles where id = auth.uid() and is_reviewer = true)
);
