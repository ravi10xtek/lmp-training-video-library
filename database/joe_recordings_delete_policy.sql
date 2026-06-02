-- ══════════════════════════════════════════════════════════
-- Allow admins & reviewers to delete ANY recording
-- (previously only the original creator could delete, so an admin
--  could not remove a recording Joe made — the delete silently
--  affected 0 rows.)
-- ══════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "delete_own_recordings" ON joe_recordings;

CREATE POLICY "admin_reviewer_delete_recordings" ON joe_recordings
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND (role = 'admin' OR is_reviewer = TRUE)
    )
  );

NOTIFY pgrst, 'reload schema';
