-- Add 'more_changes_requested' notification type
-- Allows the reviewer to send more changes back to editors
-- instead of giving final approval.
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('round1_reviewed', 'round2_reviewed', 'video_ready', 'more_changes_requested'));
