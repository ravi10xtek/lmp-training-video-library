-- ══════════════════════════════════════════════════════════
-- ACCOUNT TYPES — the manager creates and manages everyone's account
--
-- profiles.account_type is what the manager picks on the Team page, and the
-- role / reviewer flag the rest of the database checks follow from it:
--
--   manager         role 'admin',  is_reviewer false  Ravi: everything
--   client          role 'admin',  is_reviewer true   Joe: reviews scripts AND videos
--   video_reviewer  role 'worker', is_reviewer true   reviews videos alongside Joe;
--                                                      never sees scripts or recordings
--   writer          role 'worker'                     writes scripts on projects
--                                                      where scripts.writer_id = them
--   editor          role 'worker'                     edits videos on projects
--                                                      where scripts.editor_id = them
--   staff           role 'worker'                     client staff: watches published
--                                                      training videos only
--
-- Writer and editor are separate accounts: a project's writer must be a writer
-- (or the manager) and its editor an editor (or the manager).
--
-- Accounts are created by the admin-users edge function (service role).
-- Run once in the Supabase SQL editor, after roles_lockdown_migration.sql.
-- Safe to re-run.
-- ══════════════════════════════════════════════════════════

begin;

alter table profiles add column if not exists account_type text;
alter table profiles drop constraint if exists profiles_account_type_check;

-- Existing accounts: derive the type from what they are today. (Also converts
-- the interim values 'reviewer' / 'team' used briefly on the dev project.)
update profiles p set account_type = case
    when p.account_type = 'reviewer' then 'client'
    when p.account_type = 'team' then
      case when exists (select 1 from scripts s where s.writer_id = p.id) then 'writer' else 'editor' end
    when p.role = 'admin' and coalesce(p.is_reviewer, false) then 'client'
    when p.role = 'admin' then 'manager'
    when coalesce(p.is_reviewer, false) then 'video_reviewer'
    when exists (select 1 from scripts s where s.writer_id = p.id) then 'writer'
    when exists (select 1 from scripts s where s.editor_id = p.id) then 'editor'
    else 'staff'
  end
where p.account_type is null or p.account_type in ('reviewer', 'team');

alter table profiles alter column account_type set default 'staff';
alter table profiles alter column account_type set not null;
alter table profiles add constraint profiles_account_type_check
  check (account_type in ('manager', 'client', 'video_reviewer', 'writer', 'editor', 'staff'));

-- Nobody changes their own role, reviewer flag or account type through the API
create or replace function protect_profile_privileges()
returns trigger language plpgsql set search_path = public as $$
begin
  -- auth.uid() is null for the SQL editor and the service role (admin-users, setup scripts)
  if auth.uid() is not null and (
       new.role is distinct from old.role
    or new.is_reviewer is distinct from old.is_reviewer
    or new.account_type is distinct from old.account_type
    or new.id is distinct from old.id
  ) then
    raise exception 'Your role can only be changed by an administrator' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- A new auth user is client staff until the manager (admin-users) says otherwise
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, role, is_reviewer, account_type)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email), 'worker', false, 'staff');
  return new;
end;
$$;

-- ── Scripts are the client's to review, not the video reviewer's ──
create or replace function is_client()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and account_type = 'client');
$$;
revoke all on function is_client() from public, anon;
grant execute on function is_client() to authenticated;

drop policy if exists "scripts_reviewer_read"             on scripts;
drop policy if exists "scripts_client_read"               on scripts;
drop policy if exists "scripts_video_reviewer_read"       on scripts;
create policy "scripts_client_read" on scripts for select using (is_client());
-- The video reviewer sees which project a video belongs to (title, category),
-- only once its script is approved — never the script text, versions or notes.
create policy "scripts_video_reviewer_read" on scripts for select
  using (is_reviewer() and status = 'approved' and video_id is not null);

drop policy if exists "script_versions_reviewer_read"     on script_versions;
drop policy if exists "script_versions_client_read"       on script_versions;
create policy "script_versions_client_read" on script_versions for select using (is_client());

drop policy if exists "script_feedback_reviewer_read"     on script_feedback;
drop policy if exists "script_feedback_reviewer_insert"   on script_feedback;
drop policy if exists "script_feedback_client_read"       on script_feedback;
drop policy if exists "script_feedback_client_insert"     on script_feedback;
create policy "script_feedback_client_read" on script_feedback for select using (is_client());
create policy "script_feedback_client_insert" on script_feedback for insert
  with check (user_id = auth.uid() and is_client());

drop policy if exists "project_assets_reviewer_read"      on project_assets;
drop policy if exists "project_assets_client_read"        on project_assets;
create policy "project_assets_client_read" on project_assets for select using (is_client());

-- Only the client decides on scripts
create or replace function decide_script(p_script_id uuid, p_decision text)
returns void language plpgsql security definer set search_path = public as $$
declare
  s   scripts%rowtype;
  ver script_versions%rowtype;
begin
  if not is_client() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_decision not in ('approved', 'changes') then raise exception 'Unknown decision %', p_decision; end if;

  select * into s from scripts where id = p_script_id for update;
  if s.id is null then raise exception 'Script not found'; end if;
  if s.status <> 'sent' then raise exception 'This script is not waiting for your review'; end if;

  select * into ver from script_versions where script_id = p_script_id order by version desc limit 1;
  if ver.id is null then raise exception 'Nothing to decide on'; end if;

  perform set_config('lmp.trusted_rpc', 'on', true);
  update script_versions set decision = p_decision, decided_at = now(), decided_by = auth.uid()
  where id = ver.id;
  if p_decision = 'approved' then
    update scripts set status = 'approved', approved_version_id = ver.id,
                       approved_at = now(), approved_by = auth.uid()
    where id = p_script_id;
  else
    update scripts set status = 'changes' where id = p_script_id;
  end if;
  perform set_config('lmp.trusted_rpc', '', true);
end;
$$;

-- ── The video reviewer posts voice notes / images on videos (Joe does as admin) ──
drop policy if exists "video_feedback_storage_reviewer_read"   on storage.objects;
drop policy if exists "video_feedback_storage_reviewer_insert" on storage.objects;
create policy "video_feedback_storage_reviewer_read" on storage.objects for select
  using (bucket_id = 'video-feedback' and name ~ '^[0-9a-f-]{36}/' and is_reviewer());
create policy "video_feedback_storage_reviewer_insert" on storage.objects for insert
  with check (bucket_id = 'video-feedback' and name ~ '^[0-9a-f-]{36}/' and is_reviewer());

-- ── Joe's recordings are the client's and the manager's (admins), not the video reviewer's ──
drop policy if exists "admin_reviewer_read_recordings"   on joe_recordings;
drop policy if exists "admin_reviewer_insert_recordings" on joe_recordings;
drop policy if exists "admin_reviewer_delete_recordings" on joe_recordings;
create policy "admin_reviewer_read_recordings" on joe_recordings for select
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "admin_reviewer_insert_recordings" on joe_recordings for insert
  with check (created_by = auth.uid() and exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "admin_reviewer_delete_recordings" on joe_recordings for delete
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

drop policy if exists "admin_reviewer_upload"       on storage.objects;
drop policy if exists "admin_reviewer_read_storage" on storage.objects;
create policy "admin_reviewer_upload" on storage.objects for insert
  with check (bucket_id = 'joe-recordings' and auth.uid()::text = (storage.foldername(name))[1]
              and exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "admin_reviewer_read_storage" on storage.objects for select
  using (bucket_id = 'joe-recordings'
         and exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

-- ── A project's writer is a writer, its editor an editor (or the manager) ──
create or replace function check_script_assignees()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.writer_id is not null and (tg_op = 'INSERT' or new.writer_id is distinct from old.writer_id)
     and not exists (select 1 from profiles where id = new.writer_id and account_type in ('writer', 'manager')) then
    raise exception 'The writer must be a writer account' using errcode = '23514';
  end if;
  if new.editor_id is not null and (tg_op = 'INSERT' or new.editor_id is distinct from old.editor_id)
     and not exists (select 1 from profiles where id = new.editor_id and account_type in ('editor', 'manager')) then
    raise exception 'The editor must be an editor account' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists scripts_check_assignees on scripts;
create trigger scripts_check_assignees before insert or update of writer_id, editor_id on scripts
  for each row execute function check_script_assignees();

commit;

notify pgrst, 'reload schema';
