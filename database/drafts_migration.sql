-- ══════════════════════════════════════════════════════════
-- Drafts workflow: add 'draft' and 'done' statuses
-- 'draft' = uploaded, awaiting Joe's review
-- 'done'  = re-uploaded by editor after addressing feedback
-- ══════════════════════════════════════════════════════════

alter table videos drop constraint if exists videos_status_check;
alter table videos add constraint videos_status_check
  check (status in ('empty', 'raw', 'draft', 'done', 'published'));
