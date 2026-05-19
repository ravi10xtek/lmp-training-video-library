-- YouTube cleanup script
-- Run after verifying Wasabi rollout is stable.

-- 1) Convert legacy source marker to wasabi for rows
-- that already have Wasabi keys/URLs.
update videos
set video_source = 'wasabi'
where (video_source is null or video_source = 'youtube')
  and (storage_key is not null or video_url is not null);

-- 2) Disable publishing for orphaned YouTube-only rows so workers do not see broken cards.
update videos
set status = 'empty',
    youtube_id = null
where (video_source = 'youtube' or video_source is null)
  and storage_key is null
  and video_url is null;

-- 3) Final normalization: force all rows to Wasabi source and clear youtube_id.
update videos
set video_source = 'wasabi',
    youtube_id = null
where video_source <> 'wasabi' or video_source is null or youtube_id is not null;
