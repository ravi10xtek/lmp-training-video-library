-- Fix notifications type CHECK constraint to include all notification types
-- The original constraint was missing 'video_uploaded' and 'more_changes_requested'

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('video_uploaded', 'round1_reviewed', 'round2_reviewed', 'video_ready', 'more_changes_requested'));
