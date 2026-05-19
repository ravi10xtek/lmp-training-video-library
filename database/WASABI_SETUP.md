# Wasabi setup for web uploads

The web app uploads in two ways:

1. **Small files** — Browser → **Supabase Storage** (`video-uploads` staging) → Edge Function **`wasabi-transfer`** → Wasabi (no browser→Wasabi for upload).
2. **Large files** (over ~45 MB) — Browser → **Wasabi** using a **presigned PUT** from Edge Function **`wasabi-upload-init`** (Wasabi bucket **CORS** must allow your site origin).

You still need Wasabi CORS for **playback** (browser GET) and for **large direct uploads**.

## File size limits

- **Supabase staging** is capped by your project **global** storage limit (often **50 MB** by default).
- **Direct Wasabi upload** (used automatically for files **> 45 MB**, or if staging rejects the file) supports up to **5 GB**.

To allow large files through staging too: **Dashboard → Project Settings → Storage → Global file size limit** → set to **5368709120** (5 GB).

## 0. Supabase staging bucket (required — run once)

In Supabase **SQL Editor**, run the full file:

- `database/storage_video_uploads.sql`

Then deploy the transfer function:

```bash
supabase functions deploy wasabi-transfer --project-ref exgmlnwkvvafmeylunjx
```

## Troubleshooting `SignatureDoesNotMatch` (Wasabi XML error)

Wasabi returns this when the **secret access key** in Supabase does not match the **access key ID** used to sign the URL.

1. In Wasabi → **Users** → open your uploader user → **Access Keys** — confirm the **Access Key ID** matches `WASABI_ACCESS_KEY_ID` in Supabase (e.g. `WDN11QSQG65YUGY1N4XX`).
2. Re-copy the **Secret Access Key** for **that same key** into Supabase → **Edge Functions** → **Secrets** → `WASABI_SECRET_ACCESS_KEY` (no leading/trailing spaces).
3. Redeploy: `supabase functions deploy wasabi-upload-init --project-ref exgmlnwkvvafmeylunjx`

If you rotated keys, the old secret will always produce `SignatureDoesNotMatch`.

## 1. Bucket CORS (required for playback)

1. Wasabi console → **Buckets** → `lochmonster-training-videos`
2. Open **CORS** (or bucket settings → CORS)
3. Paste the full JSON from `wasabi_bucket_cors.example.json`
4. Add your **production site URL** to `AllowedOrigins` when you deploy (e.g. `https://training.lochmonsterplumbing.com`)
5. Save

Without CORS, the browser upload returns **403** or fails silently.

## 2. Sub-user IAM policy (required)

1. Wasabi console → **Users** / **Access keys** → your uploader user (e.g. `lochmonster-video-uploader`)
2. Attach a policy using `wasabi_subuser_policy.example.json` (edit bucket name in ARNs if different)
3. Save

The key pair in Supabase secrets must belong to this user and include **`s3:PutObject`** on the bucket.

## 3. Supabase Edge Function secrets

Project → **Settings** → **Edge Functions** → **Secrets**:

| Secret | Example |
|--------|---------|
| `WASABI_BUCKET` | `lochmonster-training-videos` |
| `WASABI_REGION` | `us-central-1` |
| `WASABI_ACCESS_KEY_ID` | your access key |
| `WASABI_SECRET_ACCESS_KEY` | your secret key |
| `WASABI_ENDPOINT` | `https://s3.us-central-1.wasabisys.com` |

Deploy functions after changing secrets:

```bash
supabase functions deploy wasabi-upload-init --project-ref exgmlnwkvvafmeylunjx
supabase functions deploy wasabi-playback-url --project-ref exgmlnwkvvafmeylunjx
```

## 4. Database migration

Run in Supabase **SQL Editor**:

- `wasabi_migration.sql` (if not already run)

## 5. Test upload

1. Run `./run-training-library.sh`
2. Log in as **admin**
3. Add video → choose file → Save
4. If it fails, open browser **DevTools → Network**:
   - **403 on `wasabisys.com`** → fix CORS or IAM (steps 1–2)
   - **401 on `wasabi-upload-init`** → not logged in as admin, or secrets missing
