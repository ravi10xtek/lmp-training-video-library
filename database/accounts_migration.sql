-- ══════════════════════════════════════════════════════════
-- ACCOUNT TYPES — the manager creates and manages everyone's account
--
-- profiles.account_type is what the manager picks on the Team page:
--   manager  → role 'admin',  is_reviewer false   (Ravi)
--   reviewer → role 'admin',  is_reviewer true    (Joe / client reviewer)
--   team     → role 'worker'                      (writers and editors; access
--                                                  per project by assignment)
--   staff    → role 'worker'                      (client staff: published only)
-- team and staff have the same database rights; the type decides who is
-- offered as a writer/editor and how the account is labelled.
--
-- Accounts are created by the admin-users edge function (service role).
-- Run once in the Supabase SQL editor, after roles_lockdown_migration.sql.
-- Safe to re-run.
-- ══════════════════════════════════════════════════════════

begin;

alter table profiles add column if not exists account_type text;

-- Existing accounts: derive the type from what they are today
update profiles p set account_type = case
    when p.role = 'admin' and coalesce(p.is_reviewer, false) then 'reviewer'
    when p.role = 'admin' then 'manager'
    when exists (select 1 from scripts s where s.writer_id = p.id or s.editor_id = p.id) then 'team'
    else 'staff'
  end
where p.account_type is null;

alter table profiles alter column account_type set default 'staff';
alter table profiles alter column account_type set not null;
alter table profiles drop constraint if exists profiles_account_type_check;
alter table profiles add constraint profiles_account_type_check
  check (account_type in ('manager', 'reviewer', 'team', 'staff'));

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

-- A new auth user is a staff account until the manager (admin-users) says otherwise
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, role, is_reviewer, account_type)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email), 'worker', false, 'staff');
  return new;
end;
$$;

commit;

notify pgrst, 'reload schema';
