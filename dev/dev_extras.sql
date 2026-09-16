-- Dev-only: steps the migrations leave as manual dashboard instructions.
-- joe-recordings bucket + policies (from comments in joe_recordings_migration.sql).

insert into storage.buckets (id, name, public) values ('joe-recordings', 'joe-recordings', false)
on conflict (id) do nothing;

drop policy if exists "admin_reviewer_upload" on storage.objects;
create policy "admin_reviewer_upload" on storage.objects
  for insert with check (
    bucket_id = 'joe-recordings' and
    auth.uid()::text = (storage.foldername(name))[1] and
    exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true))
  );

drop policy if exists "admin_reviewer_read_storage" on storage.objects;
create policy "admin_reviewer_read_storage" on storage.objects
  for select using (
    bucket_id = 'joe-recordings' and
    exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true))
  );

drop policy if exists "delete_own_storage" on storage.objects;
create policy "delete_own_storage" on storage.objects
  for delete using (
    bucket_id = 'joe-recordings' and
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- Signup trigger runs under supabase_auth_admin, whose search_path lacks
-- public, so unqualified "profiles" fails ("Database error creating new user").
alter function public.handle_new_user() set search_path = public;

notify pgrst, 'reload schema';
