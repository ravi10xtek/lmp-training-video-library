# LMP Training Library

Login-based video library for Loch Monster Plumbing field technicians.
Built with plain HTML/JS + Supabase. No build step required.

---

## Run locally (correct app)

The production app lives in `old-html-version` (not the Vite starter in `frontend`).

From the project root:

```bash
./run-training-library.sh
```

This always serves the correct app at `http://localhost:8081/`.

To use a different port:

```bash
./run-training-library.sh 8090
```

---

## Wasabi video uploads (admin)

Videos are stored in **Wasabi** (private bucket). Admins upload files in the web app; playback uses signed URLs.

**Setup checklist:** see `database/WASABI_SETUP.md`

1. Run `database/wasabi_migration.sql` in Supabase SQL editor (once).
2. Run `database/storage_video_uploads.sql` (staging bucket for uploads).
3. Configure **Wasabi bucket CORS** and **IAM policy** (templates in `database/`).
4. Set Edge Function secrets and deploy:
   - `wasabi-transfer` — copies staged file to Wasabi (upload path)
   - `wasabi-playback-url` — signed GET for playback

Required secrets: `WASABI_REGION`, `WASABI_BUCKET`, `WASABI_ACCESS_KEY_ID`, `WASABI_SECRET_ACCESS_KEY`, optional `WASABI_ENDPOINT`.

---

## YouTube cleanup SQL

After Wasabi playback is stable, run `database/youtube_cleanup.sql` to clear legacy YouTube fields.

---

## Stack

- **Frontend** — `old-html-version/` (HTML + JS, no build step)
- **Database** — Supabase (Postgres + Auth + RLS)
- **Video hosting** — Wasabi (S3-compatible private bucket)

---

## Setup — Step by step

### 1. Create a Supabase project

Go to supabase.com → New project → name it "lmp-training"

### 2. Run the schema

In your Supabase dashboard → SQL Editor → paste the entire contents of
`supabase_schema.sql` and click Run.

This creates:
- `profiles` table (extends auth users with name + role)
- `categories` table (pre-seeded with 3 categories)
- `subcategories` table (pre-seeded with all sub-categories)
- `videos` table (your video slots)
- `watch_progress` table (tracks who watched what)
- Row Level Security policies (workers see published only, admins see all)

### 3. Get your Supabase keys

Supabase dashboard → Settings → API

Copy:
- Project URL  → looks like https://abcdefgh.supabase.co
- anon/public key → long string starting with eyJ...

### 4. Add keys to index.html

Open `index.html` and find these two lines near the top of the `<script>`:

```js
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

Replace with your actual values.

### 5. Create your first admin user

In Supabase dashboard → Authentication → Users → Invite user

Enter Joe's email. After he sets a password, go to the SQL editor and run:

```sql
update profiles set role = 'admin' where id = (
  select id from auth.users where email = 'joe@lochmonsterplumbing.com'
);
```

Do the same for any other admins. All other users default to 'worker' role.

### 6. Create worker accounts

Authentication → Users → Invite user for each team member.
They receive an email to set their password. No further setup needed —
they automatically get the 'worker' role.

### 7. Host the file

Drop `index.html` on any static host:

- **Netlify** — drag and drop the file at app.netlify.com/drop
- **Vercel** — `npx vercel` in this folder
- **GitHub Pages** — push to a repo, enable Pages
- **Cloudflare Pages** — connect repo or drag and drop

The file has no dependencies to install — it loads Supabase from CDN.

---

## Adding videos

Log in as admin → click "Add video slot"

Fill in:
- **Title** — use the naming convention from the guidelines doc
- **Category** — LMP Operations / Properties & Contacts / Plumbing Training
- **Sub-category** — matches the document structure
- **Video type** — INTRO / HOW-TO / WALKTHROUGH / PROCESS / DEEP-DIVE / RAW
- **Status** — Empty slot / Raw (has recording) / Published
- **Upload video file** — MP4/WebM/MOV; file is sent to Wasabi via presigned POST
- **Duration** — in seconds (180 = 3 min, 600 = 10 min)

If upload returns **403**, complete Wasabi CORS + IAM setup in `database/WASABI_SETUP.md`.

---

## Bulk importing the 152 video slots

To pre-populate all slots from the content categorisation document,
run this type of SQL in the Supabase SQL editor:

```sql
-- Example: insert an empty slot
insert into videos (title, category_id, subcategory_id, video_type, status, sort_order)
values (
  'Joe L — master plumber, VP & DBA overview',
  (select id from categories where slug = 'lmp-operations'),
  (select id from subcategories where slug = 'people-roles'),
  'INTRO',
  'empty',
  1
);
```

Or ask for a bulk insert script — all 152 slots can be inserted in one SQL block.

---

## Features

**Worker view**
- Browse videos by category using the sidebar
- Search across all video titles, descriptions, categories
- Click any published video to play (Wasabi signed URL)
- Empty slots show as locked cards (great for the "empty slots" motivation)

**Admin view** (same as worker, plus)
- Stats bar showing published / raw / empty counts
- Add new video slots
- Edit any existing slot (upload/replace video, change status, update details)
- Edit buttons visible on every card

---

