-- ══════════════════════════════════════════════════════════
-- LMP Training Library — Supabase Schema
-- Run this in your Supabase SQL editor
-- ══════════════════════════════════════════════════════════

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ── PROFILES ────────────────────────────────────────────────
-- Extends Supabase auth.users with role and display name
create table profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  full_name text not null,
  role text not null default 'worker' check (role in ('admin', 'worker')),
  created_at timestamptz default now()
);

-- Auto-create profile on signup
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    coalesce(new.raw_user_meta_data->>'role', 'worker')
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ── CATEGORIES ──────────────────────────────────────────────
create table categories (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  slug text not null unique,
  color text not null default '#1D9E75',
  sort_order int not null default 0,
  created_at timestamptz default now()
);

-- ── SUBCATEGORIES ────────────────────────────────────────────
create table subcategories (
  id uuid default uuid_generate_v4() primary key,
  category_id uuid references categories(id) on delete cascade,
  name text not null,
  slug text not null,
  sort_order int not null default 0,
  created_at timestamptz default now(),
  unique(category_id, slug)
);

-- ── VIDEOS ──────────────────────────────────────────────────
create table videos (
  id uuid default uuid_generate_v4() primary key,
  title text not null,
  description text,
  youtube_id text,                          -- YouTube video ID (from URL)
  category_id uuid references categories(id),
  subcategory_id uuid references subcategories(id),
  video_type text check (video_type in ('INTRO','HOW-TO','WALKTHROUGH','PROCESS','DEEP-DIVE','RAW')),
  status text not null default 'empty' check (status in ('empty','raw','published')),
  duration_seconds int,                     -- video duration for display
  thumbnail_url text,                       -- custom thumbnail or auto from YouTube
  sort_order int default 0,
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── WATCH PROGRESS ──────────────────────────────────────────
create table watch_progress (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references profiles(id) on delete cascade,
  video_id uuid references videos(id) on delete cascade,
  seconds_watched int default 0,
  completed boolean default false,
  last_watched_at timestamptz default now(),
  unique(user_id, video_id)
);

-- ── ROW LEVEL SECURITY ────────────────────────────────────────
alter table profiles enable row level security;
alter table categories enable row level security;
alter table subcategories enable row level security;
alter table videos enable row level security;
alter table watch_progress enable row level security;

-- Profiles: users can read all, edit own
create policy "profiles_read_all" on profiles for select using (true);
create policy "profiles_update_own" on profiles for update using (auth.uid() = id);

-- Categories & subcategories: everyone reads, only admin writes
create policy "categories_read_all" on categories for select using (true);
create policy "categories_admin_write" on categories for all using (
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);
create policy "subcategories_read_all" on subcategories for select using (true);
create policy "subcategories_admin_write" on subcategories for all using (
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);

-- Videos: everyone reads published, admin reads all, admin writes all
create policy "videos_worker_read" on videos for select using (
  status = 'published' or
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);
create policy "videos_admin_write" on videos for all using (
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);

-- Watch progress: users manage own records
create policy "watch_own" on watch_progress for all using (auth.uid() = user_id);

-- ── SEED DATA — CATEGORIES ───────────────────────────────────
insert into categories (name, slug, color, sort_order) values
  ('LMP Operations', 'lmp-operations', '#BA7517', 1),
  ('Properties & Contacts', 'properties-contacts', '#1D9E75', 2),
  ('Plumbing Training', 'plumbing-training', '#185FA5', 3);

-- ── SEED DATA — SUBCATEGORIES ─────────────────────────────────
-- LMP Operations
insert into subcategories (category_id, name, slug, sort_order)
select id, 'People & Roles', 'people-roles', 1 from categories where slug = 'lmp-operations';
insert into subcategories (category_id, name, slug, sort_order)
select id, 'Physical Locations', 'physical-locations', 2 from categories where slug = 'lmp-operations';
insert into subcategories (category_id, name, slug, sort_order)
select id, 'Business Processes', 'business-processes', 3 from categories where slug = 'lmp-operations';
insert into subcategories (category_id, name, slug, sort_order)
select id, 'Purchasing & Ordering', 'purchasing-ordering', 4 from categories where slug = 'lmp-operations';
insert into subcategories (category_id, name, slug, sort_order)
select id, 'Standards & Compliance', 'standards-compliance', 5 from categories where slug = 'lmp-operations';

-- Properties & Contacts
insert into subcategories (category_id, name, slug, sort_order)
select id, 'HOA Management Companies', 'hoa-management', 1 from categories where slug = 'properties-contacts';
insert into subcategories (category_id, name, slug, sort_order)
select id, 'HOA & Apartment Properties', 'hoa-properties', 2 from categories where slug = 'properties-contacts';
insert into subcategories (category_id, name, slug, sort_order)
select id, 'HOA General Training', 'hoa-general', 3 from categories where slug = 'properties-contacts';

-- Plumbing Training
insert into subcategories (category_id, name, slug, sort_order)
select id, 'Drain & Waste', 'drain-waste', 1 from categories where slug = 'plumbing-training';
insert into subcategories (category_id, name, slug, sort_order)
select id, 'Water & Fixtures', 'water-fixtures', 2 from categories where slug = 'plumbing-training';
insert into subcategories (category_id, name, slug, sort_order)
select id, 'Pipes & Materials', 'pipes-materials', 3 from categories where slug = 'plumbing-training';
insert into subcategories (category_id, name, slug, sort_order)
select id, 'Specialist Skills', 'specialist-skills', 4 from categories where slug = 'plumbing-training';

-- ── UPDATED_AT TRIGGER ────────────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger videos_updated_at before update on videos
  for each row execute procedure update_updated_at();
