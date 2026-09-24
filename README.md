# LMP Training Library

Login-based video library for Loch Monster Plumbing field technicians.
Built with plain HTML/JS + Supabase. No build step required.

---

## Run locally

The app lives in `old-html-version/`. There is no build step and no
`package.json` — `npm install` will fail and is not needed.

From the project root:

```bash
./run-training-library.sh
```

This always serves the correct app at `http://localhost:8081/`.

To use a different port:

```bash
./run-training-library.sh 8090
```

By default this runs against **production**. To work against a throwaway
Supabase project instead, see `dev/HANDOFF.md` and run `dev/setup-dev-db.ps1`:
it provisions the schema, migrations and test accounts, then writes
`old-html-version/env.local.js`, which the app loads on localhost only.
Delete that file to go back to production.

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

## Script review (confirm narration with Joe before producing video)

Sidebar → **Scripts**. A script is the start of a video's project: Ravi
creates it against a slot (category → sub-category → free slot) and assigns a
**content writer**; an **editor** is assigned later (usually after approval).
The writer drafts and sends Joe a cheap preview, Joe listens on his phone and
approves. Only then is the video produced.

```
draft → sent (with Joe) → changes requested → sent … → approved (locked)
```

Writers and editors are ordinary invited accounts (role `worker`). They see
only the scripts they're assigned to; access is granted by assignment, not
role (`database/scripts_assignments_migration.sql`). "Waiting on you" is
per role: Joe = sent, writer = draft/changes, editor = approved.

- **Preview voice** is OpenAI `gpt-4o-mini-tts` (~$0.15 for a 10-min script),
  rendered per paragraph and cached by content hash in `tts_cache` +
  the private `script-audio` bucket. A revision re-renders only the
  paragraphs whose text changed.
- **Paragraphs** are blank-line separated. A line starting with `#` is a
  section heading and is read aloud as "Section: …".
- Joe's **voice notes** are transcribed automatically (Whisper) and stored on
  `script_feedback.transcript`.
- **Play changes only** plays the changed paragraphs (with the one before each
  for context) so Joe doesn't re-listen to the whole thing.
- Approving **locks** the version; "Start a revision" makes a new draft that
  needs approval again. The approved script is tagged on the linked video slot.

Setup (once): run `database/scripts_migration.sql`, deploy `script-tts` and
`notify-review` (`supabase functions deploy <name> --use-api`). Needs the
`OPENAI_API_KEY` secret (already used by `transcribe`). Optional secrets:
`SCRIPT_TTS_VOICE` (default `ash`), `SCRIPT_TTS_MODEL`, `SCRIPT_TTS_INSTRUCTIONS`.
Changing voice/model invalidates the cache (they're part of the hash).

---

## Roles and permissions (enforced in the database)

`database/roles_lockdown_migration.sql` moves the role rules out of the UI
and into Postgres, and `database/accounts_migration.sql` adds the account
types. Run both once per project (after the other migrations), then deploy
the edge functions they pair with:

```bash
npx supabase functions deploy wasabi-upload-init wasabi-playback-url notify-review admin-users --project-ref <ref> --use-api
```

**Accounts are created by the manager** on the **Team** page (sidebar →
Admin → Team): name, email, type and a generated password to share. The
same page renames people, changes their type, sets a new password and
deactivates / reactivates sign-in. Nobody signs themselves up, so turn off
public signups in the dashboard (Authentication → Sign In / Providers →
"Allow new users to sign up"); `admin-users` still creates accounts with the
service key.

| Who | How it is recognised | Can |
|---|---|---|
| Manager (Ravi) | type `manager` (`role = 'admin'`, not `is_reviewer`) | everything, including the Team page |
| Client reviewer (Joe) | type `reviewer` (`is_reviewer`) | read projects, decide on what is sent to him (via `decide_script` / `set_video_status`), leave notes |
| Writer / editor | type `team`; per project via `scripts.writer_id` / `editor_id` | writer: edit and send the script draft. Editor: upload video versions (`record_video_upload`), send them to Joe, read and answer notes |
| Client staff | type `staff` | published videos only |

Nobody can change their own `role` / `is_reviewer`, and new signups are
always `worker`. Every uploaded video file is a row in `video_versions`; a
video can only go to Joe once the file for that version exists.

---

## YouTube cleanup SQL

After Wasabi playback is stable, run `database/youtube_cleanup.sql` to clear legacy YouTube fields.

---

## Stack

- **Frontend** — `old-html-version/` (HTML + JS, no build step, served by Vercel)
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

### 4. Add keys

The production keys live at the top of `old-html-version/app.js`:

```js
const SUPABASE_URL = window.LMP_ENV?.SUPABASE_URL || 'https://….supabase.co';
const SUPABASE_ANON_KEY = window.LMP_ENV?.SUPABASE_ANON_KEY || 'eyJ…';
```

For local work, don't edit those — put the values in
`old-html-version/env.local.js` as `window.LMP_ENV`, which is gitignored and
loaded on localhost only.

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

### 7. Deploy

The site is on **Vercel**, which serves `old-html-version/` as the web root
(see `vercel.json`). Pushing to the repo deploys the frontend.

Edge Functions are **not** deployed by a push — each one goes to each
Supabase project separately:

```bash
npx supabase functions deploy <name> --project-ref <project-ref> --use-api
```

There are no dependencies to install; Supabase loads from a CDN.

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

