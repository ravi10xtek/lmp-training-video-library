-- Staging bucket: browser uploads here (Supabase CORS), then Edge Function copies to Wasabi.
-- Run once in Supabase SQL Editor.
--
-- Also raise the PROJECT global limit (default is often 50MB):
-- Supabase Dashboard → Project Settings → Storage → Global file size limit → 5 GB (5368709120)

insert into storage.buckets (id, name, public, file_size_limit)
values (
  'video-uploads',
  'video-uploads',
  false,
  5368709120
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit;

-- Admins may upload only under their own user id prefix: {user_id}/...
create policy "video_uploads_admin_insert"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'video-uploads'
  and split_part(name, '/', 1) = auth.uid()::text
  and exists (
    select 1 from public.profiles
    where profiles.id = auth.uid() and profiles.role = 'admin'
  )
);

create policy "video_uploads_admin_select"
on storage.objects for select
to authenticated
using (
  bucket_id = 'video-uploads'
  and split_part(name, '/', 1) = auth.uid()::text
  and exists (
    select 1 from public.profiles
    where profiles.id = auth.uid() and profiles.role = 'admin'
  )
);

create policy "video_uploads_admin_delete"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'video-uploads'
  and split_part(name, '/', 1) = auth.uid()::text
  and exists (
    select 1 from public.profiles
    where profiles.id = auth.uid() and profiles.role = 'admin'
  )
);
