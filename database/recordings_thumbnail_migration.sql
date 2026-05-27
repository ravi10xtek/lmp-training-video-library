-- Add thumbnail_data column to joe_recordings
-- Stores a small base64 JPEG data URL (≈8–15 KB) generated at capture time.
-- Used to show previews in the recordings grid without extra Wasabi signed-URL calls.

ALTER TABLE joe_recordings ADD COLUMN IF NOT EXISTS thumbnail_data text;
