-- Deliver new notifications to the bell in real time.
-- The client subscribes to INSERTs on `notifications`, but the table was never
-- added to the realtime publication, so new rows only showed up after a reload.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table notifications;
  end if;
end $$;
