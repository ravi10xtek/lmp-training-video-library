-- Joe's Recordings table
-- Stores audio, video, and photo captures made by Joe (or admins)
-- Files live in the 'joe-recordings' Supabase Storage bucket.

CREATE TABLE IF NOT EXISTS joe_recordings (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type         TEXT        NOT NULL CHECK (type IN ('audio', 'video', 'photo')),
  storage_key  TEXT        NOT NULL,
  title        TEXT,
  duration_sec INTEGER,                -- null for photos
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE joe_recordings ENABLE ROW LEVEL SECURITY;

-- Admins and reviewers can view all recordings
CREATE POLICY "admin_reviewer_read_recordings" ON joe_recordings
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND (role = 'admin' OR is_reviewer = TRUE)
    )
  );

-- Admins and reviewers can insert their own
CREATE POLICY "admin_reviewer_insert_recordings" ON joe_recordings
  FOR INSERT WITH CHECK (
    auth.uid() = created_by AND
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND (role = 'admin' OR is_reviewer = TRUE)
    )
  );

-- Users can delete their own recordings
CREATE POLICY "delete_own_recordings" ON joe_recordings
  FOR DELETE USING (auth.uid() = created_by);

-- ────────────────────────────────────────────────────────────────
-- After running this migration also do the following in Supabase:
--
-- 1. Create Storage bucket:
--    Dashboard → Storage → New bucket
--    Name: joe-recordings
--    Public: OFF (private, signed URLs for playback)
--
-- 2. Storage RLS policies for the bucket (run in SQL editor):
--    INSERT INTO storage.buckets (id, name, public) VALUES ('joe-recordings', 'joe-recordings', false)
--    ON CONFLICT (id) DO NOTHING;
--
--    CREATE POLICY "admin_reviewer_upload" ON storage.objects
--      FOR INSERT WITH CHECK (
--        bucket_id = 'joe-recordings' AND
--        auth.uid()::text = (storage.foldername(name))[1] AND
--        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND (role = 'admin' OR is_reviewer = TRUE))
--      );
--
--    CREATE POLICY "admin_reviewer_read_storage" ON storage.objects
--      FOR SELECT USING (
--        bucket_id = 'joe-recordings' AND
--        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND (role = 'admin' OR is_reviewer = TRUE))
--      );
--
--    CREATE POLICY "delete_own_storage" ON storage.objects
--      FOR DELETE USING (
--        bucket_id = 'joe-recordings' AND
--        auth.uid()::text = (storage.foldername(name))[1]
--      );
-- ────────────────────────────────────────────────────────────────
