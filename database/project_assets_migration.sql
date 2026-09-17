-- ══════════════════════════════════════════════════════════════
-- PROJECT ASSETS — everything that belongs to a video project
-- (finalized audio, original audio, transcript, other files)
-- shown in the project modal beside the slot's video.
--
-- Files live in the private `project-assets` bucket under
--   <script_id>/<kind>/<timestamp>-<file name>
-- A transcript may be plain text (body) instead of a file.
-- ══════════════════════════════════════════════════════════════
begin;

create table if not exists project_assets (
  id           uuid primary key default gen_random_uuid(),
  script_id    uuid not null references scripts(id) on delete cascade,
  kind         text not null check (kind in ('final_audio','original_audio','transcript','other')),
  storage_path text,                       -- object key in `project-assets` (null for text transcripts)
  file_name    text,
  mime_type    text,
  size_bytes   bigint,
  body         text,                       -- transcript text (Whisper output or pasted)
  created_by   uuid references profiles(id) on delete set null,
  created_at   timestamptz default now(),
  check (storage_path is not null or body is not null)
);

create index if not exists project_assets_script_idx on project_assets(script_id, kind, created_at desc);

alter table project_assets enable row level security;

drop policy if exists "project_assets_staff_all"        on project_assets;
drop policy if exists "project_assets_assignee_read"    on project_assets;
drop policy if exists "project_assets_assignee_insert"  on project_assets;
drop policy if exists "project_assets_own_delete"       on project_assets;

-- Admins and the reviewer see and manage everything
create policy "project_assets_staff_all" on project_assets for all
  using (exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true)))
  with check (exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true)));

-- Writer / editor of the project may read and add, and remove what they added
create policy "project_assets_assignee_read" on project_assets for select
  using (is_script_assignee(script_id));
create policy "project_assets_assignee_insert" on project_assets for insert
  with check (created_by = auth.uid() and is_script_assignee(script_id));
create policy "project_assets_own_delete" on project_assets for delete
  using (created_by = auth.uid());

-- ── Storage bucket ───────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('project-assets', 'project-assets', false, 2147483648)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

drop policy if exists "project_assets_storage_staff_read"      on storage.objects;
drop policy if exists "project_assets_storage_staff_insert"    on storage.objects;
drop policy if exists "project_assets_storage_staff_delete"    on storage.objects;
drop policy if exists "project_assets_storage_assignee_read"   on storage.objects;
drop policy if exists "project_assets_storage_assignee_insert" on storage.objects;
drop policy if exists "project_assets_storage_own_delete"      on storage.objects;

create policy "project_assets_storage_staff_read" on storage.objects for select
  using (bucket_id = 'project-assets'
    and exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true)));
create policy "project_assets_storage_staff_insert" on storage.objects for insert
  with check (bucket_id = 'project-assets'
    and exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true)));
create policy "project_assets_storage_staff_delete" on storage.objects for delete
  using (bucket_id = 'project-assets'
    and exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or is_reviewer = true)));

create policy "project_assets_storage_assignee_read" on storage.objects for select
  using (bucket_id = 'project-assets'
    and name ~ '^[0-9a-f-]{36}/'
    and is_script_assignee(split_part(name, '/', 1)::uuid));
create policy "project_assets_storage_assignee_insert" on storage.objects for insert
  with check (bucket_id = 'project-assets'
    and name ~ '^[0-9a-f-]{36}/'
    and is_script_assignee(split_part(name, '/', 1)::uuid));
create policy "project_assets_storage_own_delete" on storage.objects for delete
  using (bucket_id = 'project-assets' and owner = auth.uid());

commit;
notify pgrst, 'reload schema';
