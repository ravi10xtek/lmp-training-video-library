-- Add phone number to profiles for SMS notifications
-- Format must be E.164 e.g. +12015551234
alter table profiles add column if not exists phone_number text;
