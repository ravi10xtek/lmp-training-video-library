-- Let users dismiss (delete) their own notifications from the bell panel.
drop policy if exists "notifs_own_delete" on notifications;
create policy "notifs_own_delete"
  on notifications for delete
  using (auth.uid() = user_id);
