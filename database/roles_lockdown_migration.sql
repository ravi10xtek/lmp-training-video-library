-- ══════════════════════════════════════════════════════════
-- ROLES LOCKDOWN + VIDEO VERSIONS
--
-- Roles (unchanged in meaning, now enforced by the database, not the UI):
--   manager  = profiles.role 'admin' and not is_reviewer   (Ravi)
--   reviewer = profiles.is_reviewer                          (Joe / client)
--   writer / editor = any account assigned on scripts.writer_id / editor_id
--   staff    = everyone else ('worker'): published videos only
--
-- Fixes:
--   1. Nobody can change their own role / is_reviewer through the API, and a
--      new signup can no longer pick its role from user metadata.
--   2. Reviewers stop having blanket write access to videos, scripts,
--      script versions/feedback and project assets. Their two decisions go
--      through RPCs that check the state they act on.
--   3. The assigned editor (a plain account) can do the video job: read and
--      answer Joe's notes, upload a new version, send it to Joe.
--   4. Every upload is kept as a numbered version (video_versions), and a video
--      can only go (back) to Joe once a file for that version exists.
--   5. Writers can only change the draft and send it; they can't approve or
--      re-assign their own script.
--
-- Run once in the Supabase SQL editor, after video_team_visibility_migration.sql.
-- Safe to re-run.
-- ══════════════════════════════════════════════════════════

begin;

-- ── 0. Role helpers ─────────────────────────────────────────
create or replace function is_manager()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from profiles
                 where id = auth.uid() and role = 'admin' and coalesce(is_reviewer, false) = false);
$$;

create or replace function is_reviewer()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and is_reviewer = true);
$$;

-- Assigned to the project that owns this video slot
create or replace function is_video_assignee(p_video_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from scripts
                 where video_id = p_video_id and (writer_id = auth.uid() or editor_id = auth.uid()));
$$;

create or replace function is_video_editor(p_video_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from scripts where video_id = p_video_id and editor_id = auth.uid());
$$;

-- True only inside the RPCs below (set_config(..., true) is transaction-local
-- and PostgREST does not expose set_config, so clients cannot set it).
create or replace function in_trusted_rpc()
returns boolean language sql stable as $$
  select coalesce(current_setting('lmp.trusted_rpc', true), '') = 'on';
$$;

revoke all on function is_manager()             from public, anon;
revoke all on function is_reviewer()            from public, anon;
revoke all on function is_video_assignee(uuid)  from public, anon;
revoke all on function is_video_editor(uuid)    from public, anon;
grant execute on function is_manager()            to authenticated;
grant execute on function is_reviewer()           to authenticated;
grant execute on function is_video_assignee(uuid) to authenticated;
grant execute on function is_video_editor(uuid)   to authenticated;

-- ── 1. Profiles: role and reviewer flag are not self-service ──
create or replace function protect_profile_privileges()
returns trigger language plpgsql set search_path = public as $$
begin
  -- auth.uid() is null for the SQL editor and the service role (setup scripts)
  if auth.uid() is not null and (
       new.role is distinct from old.role
    or new.is_reviewer is distinct from old.is_reviewer
    or new.id is distinct from old.id
  ) then
    raise exception 'Your role can only be changed by an administrator' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_privileges on profiles;
create trigger profiles_protect_privileges
  before update on profiles
  for each row execute function protect_profile_privileges();

-- New accounts are always plain workers; roles are granted by an administrator.
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, role, is_reviewer)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email), 'worker', false);
  return new;
end;
$$;

-- ── 2. Video versions: every uploaded file, numbered like script versions ──
create table if not exists video_versions (
  id               uuid primary key default gen_random_uuid(),
  video_id         uuid not null references videos(id) on delete cascade,
  version          integer not null check (version >= 1),
  storage_key      text,
  video_url        text,
  file_name        text,
  size_bytes       bigint,
  duration_seconds integer,
  thumbnail_url    text,
  created_by       uuid references profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (video_id, version)
);
create index if not exists video_versions_video_idx on video_versions(video_id);

alter table video_versions enable row level security;

drop policy if exists "video_versions_read" on video_versions;
create policy "video_versions_read" on video_versions for select using (
  is_manager()
  or is_video_assignee(video_id)
  -- Joe sees a version once it has been sent to him (never the editor's
  -- in-progress upload for the next round)
  or (is_reviewer() and exists (
        select 1 from videos v where v.id = video_id
        and v.status in ('to_review', 'to_edit', 'completed', 'published')
        and version <= coalesce(v.review_round, 1)))
);
-- No insert/update/delete policies: writes go through record_video_upload().

-- Backfill: the file each video currently has is the version it is on.
insert into video_versions (video_id, version, storage_key, video_url, duration_seconds, created_by, created_at)
select v.id,
       case when v.status in ('empty', 'raw') then 1 else greatest(coalesce(v.review_round, 1), 1) end,
       v.storage_key, v.video_url, v.duration_seconds, v.created_by, coalesce(v.updated_at, v.created_at, now())
from videos v
where (v.storage_key is not null or v.video_url is not null)
on conflict (video_id, version) do nothing;

-- ── 3. Videos: only the manager writes rows directly ──
drop policy if exists "videos_staff_insert"   on videos;
drop policy if exists "videos_staff_update"   on videos;
drop policy if exists "videos_staff_delete"   on videos;
drop policy if exists "videos_manager_insert" on videos;
drop policy if exists "videos_manager_update" on videos;
drop policy if exists "videos_manager_delete" on videos;
create policy "videos_manager_insert" on videos for insert with check (is_manager());
create policy "videos_manager_update" on videos for update using (is_manager()) with check (is_manager());
create policy "videos_manager_delete" on videos for delete using (is_manager());

-- Status transitions, checked against who is asking and where the video is.
create or replace function set_video_status(p_video_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare
  cur   text;
  rnd   int;
  nxt   int;
  mgr   boolean := is_manager();
  rev   boolean := is_reviewer();
  edi   boolean := is_video_editor(p_video_id);
begin
  if p_status not in ('empty', 'raw', 'to_review', 'to_edit', 'completed', 'published') then
    raise exception 'Unknown status %', p_status;
  end if;

  select status, coalesce(review_round, 1) into cur, rnd
  from videos where id = p_video_id for update;
  if cur is null then raise exception 'Video not found'; end if;
  if cur = p_status then return; end if;

  -- Who may make this move
  if mgr then
    null;                                    -- manager: any move (Manage videos)
  elsif rev and not mgr then
    if not (cur = 'to_review' and p_status in ('to_edit', 'completed')) then
      raise exception 'Not authorized' using errcode = '42501';
    end if;
  elsif edi then
    if not (p_status = 'to_review' and cur in ('empty', 'raw', 'to_edit')) then
      raise exception 'Not authorized' using errcode = '42501';
    end if;
  else
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  -- Sending to Joe needs a file for the version being sent
  if p_status = 'to_review' then
    nxt := case when cur = 'to_edit' then rnd + 1
                when cur in ('empty', 'raw') then 1
                else rnd end;
    if cur in ('empty', 'raw', 'to_edit') and not exists (
      select 1 from video_versions where video_id = p_video_id and version = nxt
    ) then
      raise exception 'Upload v% before sending it to Joe', nxt using errcode = 'P0001';
    end if;
  end if;

  update videos set
    status       = p_status,
    review_round = case
      when p_status = 'to_review' and cur = 'to_edit'           then rnd + 1
      when p_status = 'to_review' and cur in ('empty', 'raw')   then 1
      else review_round
    end,
    reviewed_at  = case when p_status in ('to_edit', 'completed') then now()       else reviewed_at end,
    reviewed_by  = case when p_status in ('to_edit', 'completed') then auth.uid() else reviewed_by end
  where id = p_video_id;
end;
$$;

-- The editor (or manager) records an uploaded file as the next version.
-- Uploading again before sending replaces that pending version.
create or replace function record_video_upload(
  p_video_id      uuid,
  p_storage_key   text,
  p_video_url     text    default null,
  p_description   text    default null,
  p_thumbnail_url text    default null,
  p_duration      integer default null,
  p_file_name     text    default null,
  p_size_bytes    bigint  default null
) returns integer language plpgsql security definer set search_path = public as $$
declare
  cur text;
  rnd int;
  ver int;
  mgr boolean := is_manager();
begin
  if not (mgr or is_video_editor(p_video_id)) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select status, coalesce(review_round, 1) into cur, rnd from videos where id = p_video_id for update;
  if cur is null then raise exception 'Video not found'; end if;
  if cur not in ('empty', 'raw', 'to_edit') then
    raise exception 'This video is % — a new version can only be uploaded before it is sent to Joe or after he asks for changes', cur;
  end if;

  if not mgr then
    -- Only a key issued to this user by wasabi-upload-init; no external URLs
    if p_video_url is not null
       or p_storage_key is null
       or p_storage_key not like ('videos/' || auth.uid()::text || '/%') then
      raise exception 'Invalid upload' using errcode = '42501';
    end if;
  elsif p_storage_key is null and p_video_url is null then
    raise exception 'Upload a file or give a video URL';
  end if;

  if p_thumbnail_url is not null and p_thumbnail_url like 'data:%' then
    raise exception 'Thumbnails must be uploaded to storage';
  end if;

  ver := case when cur = 'to_edit' then rnd + 1 else 1 end;

  insert into video_versions (video_id, version, storage_key, video_url, file_name, size_bytes,
                              duration_seconds, thumbnail_url, created_by, created_at)
  values (p_video_id, ver, p_storage_key, p_video_url, p_file_name, p_size_bytes,
          p_duration, p_thumbnail_url, auth.uid(), now())
  on conflict (video_id, version) do update set
    storage_key = excluded.storage_key, video_url = excluded.video_url,
    file_name = excluded.file_name, size_bytes = excluded.size_bytes,
    duration_seconds = excluded.duration_seconds, thumbnail_url = excluded.thumbnail_url,
    created_by = excluded.created_by, created_at = excluded.created_at;

  update videos set
    storage_key      = p_storage_key,
    video_url        = p_video_url,
    video_source     = 'wasabi',
    description      = coalesce(nullif(trim(p_description), ''), description),
    thumbnail_url    = coalesce(p_thumbnail_url, thumbnail_url),
    duration_seconds = coalesce(p_duration, duration_seconds),
    status           = case when cur = 'empty' then 'raw' else cur end
  where id = p_video_id;

  return ver;
end;
$$;

revoke all on function set_video_status(uuid, text) from public, anon;
revoke all on function record_video_upload(uuid, text, text, text, text, integer, text, bigint) from public, anon;
grant execute on function set_video_status(uuid, text) to authenticated;
grant execute on function record_video_upload(uuid, text, text, text, text, integer, text, bigint) to authenticated;

-- ── 4. Video feedback: Joe, the manager and the project's team ──
drop policy if exists "video_feedback_admin_read"     on video_feedback;
drop policy if exists "video_feedback_admin_insert"   on video_feedback;
drop policy if exists "video_feedback_admin_delete"   on video_feedback;
drop policy if exists "video_feedback_team_read"      on video_feedback;
drop policy if exists "video_feedback_team_insert"    on video_feedback;
drop policy if exists "video_feedback_own_delete"     on video_feedback;
create policy "video_feedback_team_read" on video_feedback for select
  using (is_manager() or is_reviewer() or is_video_assignee(video_id));
create policy "video_feedback_team_insert" on video_feedback for insert
  with check (user_id = auth.uid() and (is_manager() or is_reviewer() or is_video_assignee(video_id)));
create policy "video_feedback_own_delete" on video_feedback for delete
  using (user_id = auth.uid() or is_manager());

-- Voice notes / images for a video live in video-feedback under <video_id>/…
drop policy if exists "video_feedback_storage_admin_delete"          on storage.objects;
drop policy if exists "video_feedback_storage_video_assignee_read"   on storage.objects;
drop policy if exists "video_feedback_storage_video_assignee_insert" on storage.objects;
drop policy if exists "video_feedback_storage_owner_delete"          on storage.objects;
create policy "video_feedback_storage_video_assignee_read" on storage.objects for select
  using (bucket_id = 'video-feedback' and name ~ '^[0-9a-f-]{36}/'
         and is_video_assignee(split_part(name, '/', 1)::uuid));
create policy "video_feedback_storage_video_assignee_insert" on storage.objects for insert
  with check (bucket_id = 'video-feedback' and name ~ '^[0-9a-f-]{36}/'
              and is_video_assignee(split_part(name, '/', 1)::uuid));
create policy "video_feedback_storage_owner_delete" on storage.objects for delete
  using (bucket_id = 'video-feedback' and (owner = auth.uid() or is_manager()));

-- ── 5. Thumbnails: files in storage, not base64 in the videos row ──
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('video-thumbnails', 'video-thumbnails', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 2097152,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "video_thumbnails_insert" on storage.objects;
drop policy if exists "video_thumbnails_update" on storage.objects;
drop policy if exists "video_thumbnails_delete" on storage.objects;
-- Path: <video_id>/<file>. Public bucket, so reads need no policy.
create policy "video_thumbnails_insert" on storage.objects for insert
  with check (bucket_id = 'video-thumbnails' and name ~ '^[0-9a-f-]{36}/'
              and (is_manager() or is_video_editor(split_part(name, '/', 1)::uuid)));
create policy "video_thumbnails_update" on storage.objects for update
  using (bucket_id = 'video-thumbnails' and (owner = auth.uid() or is_manager()));
create policy "video_thumbnails_delete" on storage.objects for delete
  using (bucket_id = 'video-thumbnails' and (owner = auth.uid() or is_manager()));

-- ── 6. Scripts: reviewer reads, decides through an RPC; writer is fenced in ──
drop policy if exists "scripts_staff_all"           on scripts;
drop policy if exists "scripts_manager_all"         on scripts;
drop policy if exists "scripts_reviewer_read"       on scripts;
create policy "scripts_manager_all"   on scripts for all using (is_manager()) with check (is_manager());
create policy "scripts_reviewer_read" on scripts for select using (is_reviewer());

drop policy if exists "script_versions_staff_all"     on script_versions;
drop policy if exists "script_versions_manager_all"   on script_versions;
drop policy if exists "script_versions_reviewer_read" on script_versions;
create policy "script_versions_manager_all"   on script_versions for all using (is_manager()) with check (is_manager());
create policy "script_versions_reviewer_read" on script_versions for select using (is_reviewer());

drop policy if exists "script_feedback_staff_all"       on script_feedback;
drop policy if exists "script_feedback_manager_all"     on script_feedback;
drop policy if exists "script_feedback_reviewer_read"   on script_feedback;
drop policy if exists "script_feedback_reviewer_insert" on script_feedback;
create policy "script_feedback_manager_all"     on script_feedback for all using (is_manager()) with check (is_manager());
create policy "script_feedback_reviewer_read"   on script_feedback for select using (is_reviewer());
create policy "script_feedback_reviewer_insert" on script_feedback for insert
  with check (user_id = auth.uid() and is_reviewer());
-- script_feedback_own_delete (user_id = auth.uid()) from scripts_assignments_migration stays.

drop policy if exists "project_assets_staff_all"     on project_assets;
drop policy if exists "project_assets_manager_all"   on project_assets;
drop policy if exists "project_assets_reviewer_read" on project_assets;
create policy "project_assets_manager_all"   on project_assets for all using (is_manager()) with check (is_manager());
create policy "project_assets_reviewer_read" on project_assets for select using (is_reviewer());

-- Writers may only edit the draft, send it, and start a revision.
create or replace function guard_script_update()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or in_trusted_rpc() or is_manager() then
    return new;
  end if;
  if new.title          is distinct from old.title
  or new.video_id       is distinct from old.video_id
  or new.category_id    is distinct from old.category_id
  or new.subcategory_id is distinct from old.subcategory_id
  or new.writer_id      is distinct from old.writer_id
  or new.editor_id      is distinct from old.editor_id
  or new.created_by     is distinct from old.created_by
  or new.approved_version_id is distinct from old.approved_version_id
  or new.approved_at    is distinct from old.approved_at
  or new.approved_by    is distinct from old.approved_by then
    raise exception 'Not allowed to change that' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if new.status = 'sent' and old.status in ('draft', 'changes') then
      if not exists (select 1 from script_versions
                     where script_id = new.id and version = new.current_version and decision = 'pending') then
        raise exception 'Send a new version first' using errcode = '42501';
      end if;
    elsif not (new.status = 'draft' and old.status = 'approved') then
      raise exception 'Not allowed to set the script to %', new.status using errcode = '42501';
    end if;
  elsif new.current_version is distinct from old.current_version then
    raise exception 'Not allowed to change the version' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists scripts_guard_update on scripts;
create trigger scripts_guard_update before update on scripts
  for each row execute function guard_script_update();

-- A writer's new version always starts undecided, as the next number.
create or replace function guard_script_version_insert()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or in_trusted_rpc() or is_manager() then
    return new;
  end if;
  new.decision   := 'pending';
  new.decided_at := null;
  new.decided_by := null;
  new.created_by := auth.uid();
  if new.version is distinct from
     (select coalesce(max(version), 0) + 1 from script_versions where script_id = new.script_id) then
    raise exception 'Version must be the next number' using errcode = '42501';
  end if;
  if exists (select 1 from scripts where id = new.script_id and status = 'sent') then
    raise exception 'The current version is still with Joe' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists script_versions_guard_insert on script_versions;
create trigger script_versions_guard_insert before insert on script_versions
  for each row execute function guard_script_version_insert();

-- Joe's decision on the version he is reviewing.
create or replace function decide_script(p_script_id uuid, p_decision text)
returns void language plpgsql security definer set search_path = public as $$
declare
  s   scripts%rowtype;
  ver script_versions%rowtype;
begin
  if not is_reviewer() then raise exception 'Not authorized' using errcode = '42501'; end if;
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

revoke all on function decide_script(uuid, text) from public, anon;
grant execute on function decide_script(uuid, text) to authenticated;

-- Paragraphs dropped since the previous version (shown to Joe as "removed")
alter table script_versions add column if not exists removed_count integer not null default 0;

commit;

notify pgrst, 'reload schema';
