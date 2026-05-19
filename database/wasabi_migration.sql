-- Wasabi migration for videos table
-- Run this in Supabase SQL editor after the base schema.

alter table videos
  add column if not exists video_source text not null default 'youtube'
    check (video_source in ('youtube', 'wasabi')),
  add column if not exists video_url text,
  add column if not exists storage_key text;

create index if not exists videos_video_source_idx on videos(video_source);
create index if not exists videos_storage_key_idx on videos(storage_key);
