// ══════════════════════════════════════════════════════
// CONFIGURATION — Replace with your Supabase details
// ══════════════════════════════════════════════════════
const SUPABASE_URL = 'https://tdxwsgfjkpurtjmgwabr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkeHdzZ2Zqa3B1cnRqbWd3YWJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNjE3NzAsImV4cCI6MjA5NDczNzc3MH0.9t1S-8kw6LCp7WDDTvs7Um0REVCvIoQt-d8xoF9ITbA';

// ══════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// ── Session freshness ─────────────────────────────────────────────
// PWAs get backgrounded for long stretches; the access token can expire
// before the next call, producing 401s from edge functions. Refresh the
// token proactively (and retry once on an auth failure).
const _rawInvoke = sb.functions.invoke.bind(sb.functions);

function _isAuthError(err) {
  const msg = (err?.message || '').toLowerCase();
  const status = err?.context?.status || err?.status;
  return status === 401 || msg.includes('unauthorized') || msg.includes('jwt') || msg.includes('token');
}

async function ensureFreshSession() {
  try {
    const { data } = await sb.auth.getSession();
    const s = data?.session;
    if (!s) return;
    const expMs = (s.expires_at || 0) * 1000;
    // Refresh if already expired or expiring within 2 minutes
    if (expMs && expMs - Date.now() < 120000) await sb.auth.refreshSession();
  } catch (_) { /* a stale call below will trigger the retry path */ }
}

// Drop-in replacement for sb.functions.invoke that keeps the token fresh
async function invokeEdge(name, options) {
  await ensureFreshSession();
  let res = await _rawInvoke(name, options);
  if (res.error && _isAuthError(res.error)) {
    try { await sb.auth.refreshSession(); } catch (_) {}
    res = await _rawInvoke(name, options);
  }
  return res;
}

// Refresh the session the moment the app/PWA returns to the foreground
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ensureFreshSession();
  });
}

let currentUser = null;
let currentProfile = null;
let allVideos = [];
let allCategories = [];
let allSubcats = [];
let currentFilter = 'all';
let currentSubcatFilter = 'all';
let currentStatus = null;
let currentSearch = '';
let editingVideoId = null;
let pendingWasabiFile = null;
let pendingThumbnail = null;
let currentVideoId = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingStream = null;
let recordingStartTime = 0;
let recordingTimerInterval = null;
// Comment composer attachments (staged before Send)
let composerAudioBlob = null;
let composerAudioDuration = 0;
let composerImageFile = null;
let allNotifications = [];
let notifPanelOpen = false;
let notifSubscription = null;
const NOTIFY_FUNCTION = 'notify-review';
const FEEDBACK_BUCKET = 'video-feedback';
const MAX_RECORDING_MS = 3 * 60 * 1000;

const WASABI_UPLOAD_INIT_FUNCTION = 'wasabi-upload-init';
const WASABI_TRANSFER_FUNCTION = 'wasabi-transfer';
const WASABI_PLAYBACK_FUNCTION = 'wasabi-playback-url';
const TRANSCRIBE_FUNCTION = 'transcribe';
const VIDEO_STAGING_BUCKET = 'video-uploads';
/** Supabase global storage limit is often 50MB — use direct Wasabi above this. */
const STAGING_MAX_BYTES = 45 * 1024 * 1024;

// Web Push VAPID public key
const VAPID_PUBLIC_KEY = 'BF5qtmbogW7IDuuY6TtBNg5wD1Xf_ZhLQfCb-vlbDGgH4rOPMLxPJG05Hn35FOdGwk_pSwAlGPrUsPNm5jBC9VE';

// ══════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════
async function handleLogin() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');

  btn.disabled = true;
  btn.textContent = 'Signing in…';
  err.style.display = 'none';

  const { data, error } = await sb.auth.signInWithPassword({ email, password });

  if (error) {
    err.textContent = error.message;
    err.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Sign in';
    return;
  }

  await initApp(data.user);
}

async function handleLogout() {
  if (notifSubscription) { sb.removeChannel(notifSubscription); notifSubscription = null; }
  allNotifications = [];
  await sb.auth.signOut();
  currentUser = null;
  currentProfile = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-page').style.display = 'flex';
}

// ══════════════════════════════════════════════════════
// INIT APP
// ══════════════════════════════════════════════════════
async function initApp(user) {
  currentUser = user;

  // Get profile
  const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).single();
  currentProfile = profile;

  // Show app
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  // Set user UI
  const initials = (profile?.full_name || user.email).split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('user-name').textContent = profile?.full_name || user.email;

  const badge = document.getElementById('user-badge');
  if (profile?.role === 'admin') {
    badge.textContent = 'Admin';
    badge.classList.add('admin');
    document.getElementById('sidebar-admin').classList.remove('hidden');
  }
  if (profile?.is_reviewer) {
    badge.textContent = profile?.role === 'admin' ? 'Admin · Reviewer' : 'Reviewer';
    badge.classList.add('admin');
    document.getElementById('sidebar-admin').classList.remove('hidden');
  }
  if (profile?.role === 'admin' || profile?.is_reviewer) {
    document.getElementById('notif-wrap').classList.remove('hidden');
    document.getElementById('capture-topbar-btn').classList.remove('hidden');
  }

  // Load data
  await Promise.all([loadCategories(), loadVideos()]);
  await Promise.all([loadNotifications(), loadRecordingsCount()]);
  subscribeToNotifications();
}

// ══════════════════════════════════════════════════════
// DATA LOADING
// ══════════════════════════════════════════════════════
async function loadCategories() {
  const { data: cats } = await sb.from('categories').select('*').order('sort_order');
  const { data: subs } = await sb.from('subcategories').select('*').order('sort_order');
  allCategories = cats || [];
  allSubcats = subs || [];

  // Populate admin category select
  const catSel = document.getElementById('v-category');
  catSel.innerHTML = '<option value="">Select category…</option>';
  allCategories.forEach(c => {
    catSel.innerHTML += `<option value="${c.id}">${c.name}</option>`;
  });
}

async function loadSubcats(catId) {
  const sel = document.getElementById('v-subcat');
  sel.innerHTML = '<option value="">Select sub-category…</option>';
  allSubcats.filter(s => s.category_id === catId).forEach(s => {
    sel.innerHTML += `<option value="${s.id}">${s.name}</option>`;
  });
}

async function loadVideos() {
  const isAdmin = currentProfile?.role === 'admin';
  let query = sb.from('videos').select(`
    *,
    categories(name, slug, color),
    subcategories(name, slug)
  `).order('sort_order').order('title');

  const { data, error } = await query;
  allVideos = data || [];

  // Update counts
  updateCounts();
  renderVideos();
}

function updateCounts() {
  const isAdmin = currentProfile?.role === 'admin';
  const visibleVideos = allVideos.filter(v => v.status !== 'draft' && v.status !== 'done' && (isAdmin || v.status === 'published'));
  const total = visibleVideos.length;
  const ops  = visibleVideos.filter(v => v.categories?.slug === 'lmp-operations').length;
  const prop = visibleVideos.filter(v => v.categories?.slug === 'properties-contacts').length;
  const plmb = visibleVideos.filter(v => v.categories?.slug === 'plumbing-training').length;
  const drafts = allVideos.filter(v => v.status === 'draft' || v.status === 'done').length;
  document.getElementById('count-all').textContent = total;
  document.getElementById('count-ops').textContent = ops;
  document.getElementById('count-prop').textContent = prop;
  document.getElementById('count-plmb').textContent = plmb;
  const draftEl = document.getElementById('count-drafts');
  if (draftEl) draftEl.textContent = drafts;
}

// ══════════════════════════════════════════════════════
// FILTERING & RENDERING
// ══════════════════════════════════════════════════════
function filterCategory(slug, el) {
  currentFilter = slug;
  
  // Auto-select first subcategory if not 'all'
  if (slug !== 'all') {
    const category = allCategories.find(c => c.slug === slug);
    if (category) {
      const subcats = allSubcats.filter(s => s.category_id === category.id);
      if (subcats.length > 0) {
        currentSubcatFilter = subcats[0].slug;
      } else {
        currentSubcatFilter = 'all';
      }
    }
  } else {
    currentSubcatFilter = 'all';
  }
  
  currentStatus = null;
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
  renderVideos();
}

function filterSubcat(slug) {
  currentSubcatFilter = slug;
  renderVideos();
}

function filterStatus(status, el) {
  currentStatus = status;
  currentFilter = 'all';
  currentSubcatFilter = 'all';
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
  renderVideos();
}

function filterDrafts(el) {
  currentStatus = 'drafts';
  currentFilter = 'all';
  currentSubcatFilter = 'all';
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
  renderVideos();
}

function handleSearch(val) {
  currentSearch = val.toLowerCase();
  renderVideos();
}

function getFilteredVideos() {
  const isAdmin = currentProfile?.role === 'admin';
  return allVideos.filter(v => {
    if (!isAdmin && v.status !== 'published') return false;
    const isDraftVideo = v.status === 'draft' || v.status === 'done';
    if (currentStatus === 'drafts') {
      if (!isAdmin || !isDraftVideo) return false;
    } else {
      if (isDraftVideo) return false;
      if (currentStatus && v.status !== currentStatus) return false;
    }
    if (currentFilter !== 'all' && v.categories?.slug !== currentFilter) return false;
    if (currentSubcatFilter !== 'all' && v.subcategories?.slug !== currentSubcatFilter) return false;
    if (currentSearch) {
      const q = currentSearch;
      if (!v.title?.toLowerCase().includes(q) &&
          !v.description?.toLowerCase().includes(q) &&
          !v.categories?.name?.toLowerCase().includes(q) &&
          !v.subcategories?.name?.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function renderVideos() {
  const videos = getFilteredVideos();
  const isAdmin = currentProfile?.role === 'admin';
  const main = document.getElementById('main-content');

  // Stats
  const published = allVideos.filter(v => v.status === 'published').length;
  const empty = allVideos.filter(v => v.status === 'empty').length;

  let html = '';

  // Admin stats bar
  if (isAdmin) {
    html += `<div class="stats-bar">
      <div class="stat-card"><div class="stat-val teal">${published}</div><div class="stat-lbl">Published</div></div>
      <div class="stat-card"><div class="stat-val" style="color:var(--muted)">${empty}</div><div class="stat-lbl">Empty slots</div></div>
      <div class="stat-card"><div class="stat-val blue">${allVideos.length}</div><div class="stat-lbl">Total slots</div></div>
    </div>`;
  }

  // Page header
  const catLabel = currentFilter === 'all' ? 'All Videos' :
    allCategories.find(c => c.slug === currentFilter)?.name || 'Videos';
  html += `<div class="page-header">
    <div class="page-title">${catLabel}</div>
    <div class="page-sub">${videos.length} video${videos.length !== 1 ? 's' : ''}${currentSearch ? ` matching "${currentSearch}"` : ''}</div>
  </div>`;

  // Render Subcategory Tabs
  if (currentFilter !== 'all' && !currentSearch) {
    const category = allCategories.find(c => c.slug === currentFilter);
    if (category) {
      const subcats = allSubcats.filter(s => s.category_id === category.id);
      if (subcats.length > 0) {
        html += `<div class="filter-tabs">`;
        subcats.forEach(s => {
          html += `<button class="filter-tab ${currentSubcatFilter === s.slug ? 'active' : ''}" onclick="filterSubcat('${s.slug}')">${s.name}</button>`;
        });
        html += `</div>`;
      }
    }
  }

  // Admin add button
  if (isAdmin) {
    html += `<div style="margin-bottom:20px">
      <button class="btn btn-primary btn-sm" style="width:auto" onclick="openAddVideo()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add video slot
      </button>
    </div>`;
  }

  if (videos.length === 0) {
    html += `<div class="empty-state">
      <h3>No videos found</h3>
      <p>${currentSearch ? 'Try a different search term' : 'No videos in this category yet'}</p>
    </div>`;
  } else {
    html += `<div class="video-grid">`;
    videos.forEach(v => { html += renderVideoCard(v, isAdmin); });
    html += `</div>`;
  }

  main.innerHTML = html;
}

function renderVideoCard(v, isAdmin) {
  const typeClass = v.video_type ? `type-${v.video_type.toLowerCase()}` : 'status-empty';
  const STATUS_META = {
    published: { color: 'var(--teal)', label: 'Published' },
    draft:     { color: '#f5a524',     label: 'Draft' },
    done:      { color: '#3b82f6',     label: 'Done' },
    raw:       { color: 'var(--muted)', label: 'Raw' },
    empty:     { color: 'var(--muted)', label: 'Empty slot' },
  };
  const statusMeta = STATUS_META[v.status] || STATUS_META.empty;
  const statusColor = statusMeta.color;
  const statusLabel = statusMeta.label;

  const hasPlayableVideo = Boolean(v.video_url || v.storage_key);

  const thumb = v.thumbnail_url
    ? `<img src="${v.thumbnail_url}" alt="" class="card-thumb-img" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block">`
    : `<div class="card-thumb-empty">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <span>${hasPlayableVideo ? 'Video ready' : 'No video yet'}</span>
      </div>`;

  const duration = v.duration_seconds ? formatDuration(v.duration_seconds) : '';

  const playableStatus = v.status === 'published' || v.status === 'draft' || v.status === 'done';
  const clickAction = playableStatus && hasPlayableVideo
    ? `onclick="openVideo('${v.id}')"`
    : isAdmin ? `onclick="openEditVideo('${v.id}')"` : '';

  return `<div class="video-card ${v.status !== 'published' ? 'empty' : ''}" ${clickAction}>
    <div class="card-thumb">
      ${thumb}
      ${playableStatus && hasPlayableVideo ? `
        <div class="play-overlay">
          <div class="play-btn-circle">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
        </div>` : ''}
    </div>
    <div class="card-body">
      <div class="card-tags">
        ${v.video_type ? `<span class="card-tag ${typeClass}">${v.video_type}</span>` : ''}
        ${v.status !== 'published' ? `<span class="card-tag status-${v.status}">${statusLabel}</span>` : ''}
      </div>
      <div class="card-title">${v.title}</div>
      <div class="card-sub">${v.subcategories?.name || v.categories?.name || ''}</div>
      <div class="card-footer">
        <span class="card-status">
          <span class="status-dot" style="background:${statusColor}; box-shadow: 0 0 8px ${statusColor}"></span>
          ${statusLabel}
        </span>
      </div>
    </div>
    ${isAdmin ? `<div style="position:absolute;top:12px;right:12px;z-index:2">
      <button class="btn btn-ghost btn-sm" style="padding:4px 12px;font-size:11px;background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.2)" onclick="event.stopPropagation();openEditVideo('${v.id}')">Edit</button>
    </div>` : ''}
  </div>`;
}

// ══════════════════════════════════════════════════════
// VIDEO PLAYER
// ══════════════════════════════════════════════════════
async function resolveWasabiPlaybackUrl(v) {
  if (v.video_url) return v.video_url;
  if (!v.storage_key) return null;

  const { data, error } = await invokeEdge(WASABI_PLAYBACK_FUNCTION, {
    body: { storageKey: v.storage_key, videoId: v.id }
  });

  if (error) throw error;
  return data?.playbackUrl || data?.url || null;
}

async function openVideo(id) {
  let v = allVideos.find(x => x.id === id);
  if (!v) return;

  // Always fetch the latest video state so workflow buttons are never stale
  const { data: fresh } = await sb.from('videos')
    .select('*, categories(name, slug, color), subcategories(name, slug)')
    .eq('id', id).single();
  if (fresh) {
    v = fresh;
    const idx = allVideos.findIndex(x => x.id === id);
    if (idx !== -1) allVideos[idx] = fresh;
  }

  const modal = document.getElementById('video-modal');
  const typeClass = v.video_type ? `type-${v.video_type.toLowerCase()}` : '';
  try {
    const playbackUrl = await resolveWasabiPlaybackUrl(v);
    if (!playbackUrl) {
      showToast('No playback URL available for this video', 'error');
      return;
    }
    document.getElementById('video-player').innerHTML = `
      <video controls autoplay playsinline style="width:100%;height:100%;background:black">
        <source src="${playbackUrl}">
        Your browser does not support HTML5 video.
      </video>`;
  } catch (err) {
    showToast('Could not load video playback URL', 'error');
    return;
  }

  document.getElementById('modal-tags').innerHTML = `
    ${v.video_type ? `<span class="card-tag ${typeClass}">${v.video_type}</span>` : ''}
    <span class="card-tag" style="background:rgba(255,255,255,0.08);color:var(--muted)">${v.categories?.name || ''}</span>
    ${v.subcategories?.name ? `<span class="card-tag" style="background:rgba(255,255,255,0.06);color:var(--muted)">${v.subcategories.name}</span>` : ''}`;

  document.getElementById('modal-title').textContent = v.title;
  document.getElementById('modal-desc').textContent = v.description || 'No description provided.';
  document.getElementById('modal-meta').innerHTML = `
    <div class="modal-meta-item"><strong>${v.video_type || '—'}</strong>Type</div>
    <div class="modal-meta-item"><strong>${v.subcategories?.name || '—'}</strong>Sub-category</div>`;

  modal.classList.add('open');

  currentVideoId = v.id;
  const isAdmin = currentProfile?.role === 'admin';
  const isReviewer = currentProfile?.is_reviewer === true;
  const feedbackSection = document.getElementById('feedback-section');
  if (isAdmin || isReviewer) {
    feedbackSection.classList.remove('hidden');
    loadFeedback(v.id);
  } else {
    feedbackSection.classList.add('hidden');
  }

  // Transcription — admin only. Shown for every video: Wasabi-backed videos
  // transcribe server-side; embedded/linked videos fall back to a local file pick.
  const transcribeSection = document.getElementById('video-transcribe-section');
  if (isAdmin) {
    transcribeSection.classList.remove('hidden');
    document.getElementById('video-transcript-box').classList.add('hidden');
    document.getElementById('video-transcript-text').textContent = '';
    const tb = document.getElementById('video-transcribe-btn');
    tb.disabled = false;
  } else {
    transcribeSection.classList.add('hidden');
  }
  // Reviewer section — Joe only
  const reviewerSection = document.getElementById('reviewer-section');
  if (isReviewer) {
    reviewerSection.classList.remove('hidden');
    updateReviewedBtnState(v);
  } else {
    reviewerSection.classList.add('hidden');
  }

  // Editor section — other admins (not the reviewer)
  const editorSection = document.getElementById('editor-section');
  if (isAdmin && !isReviewer) {
    editorSection.classList.remove('hidden');
    updateEditorBtnState(v);
  } else {
    editorSection.classList.add('hidden');
  }

  // Track watch
  if (currentUser) {
    sb.from('watch_progress').upsert({
      user_id: currentUser.id,
      video_id: v.id,
      last_watched_at: new Date().toISOString()
    }, { onConflict: 'user_id,video_id' });
  }
}

function closeVideoModal() {
  document.getElementById('video-modal').classList.remove('open');
  document.getElementById('video-player').innerHTML = '';
  resetComposer();
  currentVideoId = null;
}

// ══════════════════════════════════════════════════════
// ADMIN FEEDBACK — voice notes per video
// ══════════════════════════════════════════════════════
async function loadFeedback(videoId) {
  const list = document.getElementById('feedback-list');
  list.innerHTML = '<div class="feedback-empty">Loading…</div>';

  const { data, error } = await sb
    .from('video_feedback')
    .select('id, user_id, body, audio_path, image_path, duration_seconds, created_at, profiles:user_id(full_name)')
    .eq('video_id', videoId)
    .order('created_at', { ascending: false });

  if (error) {
    list.innerHTML = `<div class="feedback-empty">Could not load feedback: ${error.message}</div>`;
    return;
  }

  if (!data || data.length === 0) {
    list.innerHTML = '<div class="feedback-empty">No comments yet. Add the first one above.</div>';
    return;
  }

  const isAdmin = currentProfile?.role === 'admin';

  const items = await Promise.all(data.map(async (fb) => {
    const name = fb.profiles?.full_name || 'Admin';
    const when = new Date(fb.created_at).toLocaleString();
    const canDelete = fb.user_id === currentUser?.id;

    let audioHtml = '';
    let transcribeHtml = '';
    if (fb.audio_path) {
      const { data: signed } = await sb.storage.from(FEEDBACK_BUCKET).createSignedUrl(fb.audio_path, 60 * 60);
      if (signed?.signedUrl) audioHtml = `<audio controls src="${signed.signedUrl}"></audio>`;
      if (isAdmin) {
        transcribeHtml = `
          <button class="fb-transcribe-btn" onclick="transcribeFeedback('${fb.id}', '${fb.audio_path}', this)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>
            Transcribe
          </button>
          <div class="transcript-box hidden" id="fb-transcript-${fb.id}">
            <div class="transcript-toolbar">
              <span class="transcript-label">Transcript</span>
              <button class="btn btn-ghost btn-sm" onclick="copyTranscript('fb-transcript-text-${fb.id}', this)">Copy</button>
            </div>
            <div class="transcript-text" id="fb-transcript-text-${fb.id}"></div>
          </div>`;
      }
    }

    let imageHtml = '';
    if (fb.image_path) {
      const { data: signed } = await sb.storage.from(FEEDBACK_BUCKET).createSignedUrl(fb.image_path, 60 * 60);
      if (signed?.signedUrl) {
        imageHtml = `<a href="${signed.signedUrl}" target="_blank" rel="noopener" class="feedback-image-link"><img class="feedback-image" src="${signed.signedUrl}" alt="attachment"></a>`;
      }
    }

    const bodyHtml = fb.body ? `<div class="feedback-text">${escapeHtml(fb.body)}</div>` : '';

    return `
      <div class="feedback-item">
        <div class="feedback-item-header">
          <span><span class="feedback-item-author">${name}</span> · ${when}</span>
          ${canDelete ? `<button class="feedback-delete" onclick="deleteFeedback('${fb.id}')">Delete</button>` : ''}
        </div>
        ${bodyHtml}
        ${audioHtml}
        ${transcribeHtml}
        ${imageHtml}
      </div>`;
  }));

  list.innerHTML = items.join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/\n/g, '<br>');
}

async function deleteFeedback(id) {
  if (!confirm('Delete this comment?')) return;
  // Look up attached file paths so we can clean up storage too
  const { data: row } = await sb.from('video_feedback')
    .select('audio_path, image_path').eq('id', id).single();
  const paths = [row?.audio_path, row?.image_path].filter(Boolean);
  if (paths.length) await sb.storage.from(FEEDBACK_BUCKET).remove(paths).catch(() => {});

  const { error } = await sb.from('video_feedback').delete().eq('id', id);
  if (error) {
    showToast('Could not delete: ' + error.message, 'error');
    return;
  }
  showToast('Comment deleted', 'success');
  if (currentVideoId) loadFeedback(currentVideoId);
}

async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
    return;
  }
  await startRecording();
}

async function startRecording() {
  if (currentProfile?.role !== 'admin' || !currentVideoId) return;

  // Only one staged voice note at a time
  if (composerAudioBlob) {
    showToast('Remove the current voice note first', 'error');
    return;
  }

  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('Microphone access denied', 'error');
    return;
  }

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

  try {
    mediaRecorder = mimeType
      ? new MediaRecorder(recordingStream, { mimeType })
      : new MediaRecorder(recordingStream);
  } catch (err) {
    showToast('Recording not supported in this browser', 'error');
    stopMicStream();
    return;
  }

  recordedChunks = [];
  mediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  });
  mediaRecorder.addEventListener('stop', handleRecordingStop);

  mediaRecorder.start();
  recordingStartTime = Date.now();

  const btn = document.getElementById('comment-mic-btn');
  btn.classList.add('mic-recording');
  btn.title = 'Stop recording';

  const timer = document.getElementById('record-timer');
  timer.classList.remove('hidden');
  timer.textContent = '0:00';
  recordingTimerInterval = setInterval(updateRecordingTimer, 250);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

function stopMicStream() {
  if (recordingStream) {
    recordingStream.getTracks().forEach((t) => t.stop());
    recordingStream = null;
  }
}

function updateRecordingTimer() {
  const elapsed = Date.now() - recordingStartTime;
  if (elapsed >= MAX_RECORDING_MS) {
    stopRecording();
    return;
  }
  const total = Math.floor(elapsed / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  document.getElementById('record-timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function handleRecordingStop() {
  clearInterval(recordingTimerInterval);
  recordingTimerInterval = null;
  const durationMs = Date.now() - recordingStartTime;
  composerAudioDuration = Math.max(1, Math.round(durationMs / 1000));

  const btn = document.getElementById('comment-mic-btn');
  btn.classList.remove('mic-recording');
  btn.title = 'Record voice note';
  document.getElementById('record-timer').classList.add('hidden');

  stopMicStream();

  // Stage the recording for preview; it uploads only when Send is pressed
  composerAudioBlob = new Blob(recordedChunks, { type: recordedChunks[0]?.type || 'audio/webm' });
  recordedChunks = [];

  const player = document.getElementById('comment-audio-player');
  player.src = URL.createObjectURL(composerAudioBlob);
  document.getElementById('comment-audio-preview').classList.remove('hidden');
  document.getElementById('comment-attachments').classList.remove('hidden');
}

// ── Image attachment ──────────────────────────────────────────────
async function handleComposerImage(event) {
  const file = event.target.files?.[0];
  event.target.value = ''; // allow re-selecting the same file later
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('Please choose an image file', 'error');
    return;
  }
  try {
    composerImageFile = await downscaleImage(file, 1920, 0.85);
  } catch (_) {
    composerImageFile = file; // fall back to original if downscale fails
  }
  const thumb = document.getElementById('comment-image-thumb');
  thumb.src = URL.createObjectURL(composerImageFile);
  document.getElementById('comment-image-preview').classList.remove('hidden');
  document.getElementById('comment-attachments').classList.remove('hidden');
}

// Downscale/compress an image to a JPEG blob (keeps uploads small)
function downscaleImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('toBlob failed')),
        'image/jpeg', quality
      );
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function clearComposerAudio() {
  composerAudioBlob = null;
  composerAudioDuration = 0;
  const player = document.getElementById('comment-audio-player');
  if (player.src) { URL.revokeObjectURL(player.src); player.removeAttribute('src'); }
  document.getElementById('comment-audio-preview').classList.add('hidden');
  syncAttachmentsVisibility();
}

function clearComposerImage() {
  composerImageFile = null;
  const thumb = document.getElementById('comment-image-thumb');
  if (thumb.src) { URL.revokeObjectURL(thumb.src); thumb.removeAttribute('src'); }
  document.getElementById('comment-image-preview').classList.add('hidden');
  syncAttachmentsVisibility();
}

function syncAttachmentsVisibility() {
  const any = composerAudioBlob || composerImageFile;
  document.getElementById('comment-attachments').classList.toggle('hidden', !any);
}

function resetComposer() {
  // Stop any in-progress recording
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    try { mediaRecorder.stop(); } catch (_) {}
  }
  clearInterval(recordingTimerInterval);
  recordingTimerInterval = null;
  stopMicStream();
  recordedChunks = [];
  const text = document.getElementById('comment-text');
  if (text) text.value = '';
  clearComposerAudio();
  clearComposerImage();
}

// ── Submit a comment (text + optional audio + optional image) ──────
async function submitComment() {
  if (currentProfile?.role !== 'admin' || !currentVideoId) return;

  // Block submit while still recording
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    showToast('Stop the recording before sending', 'error');
    return;
  }

  const body = document.getElementById('comment-text').value.trim();
  if (!body && !composerAudioBlob && !composerImageFile) {
    showToast('Add a comment, voice note, or image first', 'error');
    return;
  }

  const sendBtn = document.getElementById('comment-send-btn');
  sendBtn.disabled = true;
  const sendHtml = sendBtn.innerHTML;
  sendBtn.textContent = 'Sending…';

  try {
    let audioPath = null;
    let imagePath = null;

    if (composerAudioBlob) {
      const ext = composerAudioBlob.type.includes('webm') ? 'webm' : 'ogg';
      audioPath = `${currentVideoId}/${currentUser.id}-${Date.now()}.${ext}`;
      const { error } = await sb.storage.from(FEEDBACK_BUCKET)
        .upload(audioPath, composerAudioBlob, { contentType: composerAudioBlob.type, upsert: false });
      if (error) throw error;
    }

    if (composerImageFile) {
      imagePath = `${currentVideoId}/img-${currentUser.id}-${Date.now()}.jpg`;
      const { error } = await sb.storage.from(FEEDBACK_BUCKET)
        .upload(imagePath, composerImageFile, { contentType: 'image/jpeg', upsert: false });
      if (error) throw error;
    }

    const { error: insErr } = await sb.from('video_feedback').insert({
      video_id:         currentVideoId,
      user_id:          currentUser.id,
      body:             body || null,
      audio_path:       audioPath,
      image_path:       imagePath,
      duration_seconds: composerAudioBlob ? composerAudioDuration : null,
    });
    if (insErr) throw insErr;

    resetComposer();
    showToast('Comment posted', 'success');
    loadFeedback(currentVideoId);
  } catch (err) {
    console.error('[feedback] submit failed:', err);
    const detail = err?.message || err?.error || err?.statusText || 'Unknown error';
    showToast('Could not post comment: ' + detail, 'error');
  } finally {
    sendBtn.disabled = false;
    sendBtn.innerHTML = sendHtml;
  }
}

// ══════════════════════════════════════════════════════
// TRANSCRIPTION (admin only) — OpenAI Whisper via edge function
// ══════════════════════════════════════════════════════
async function transcribeVideo() {
  const v = allVideos.find(x => x.id === currentVideoId);
  // Embedded/linked video with no stored file → transcribe from a locally-picked file.
  if (!v?.storage_key) {
    showToast('No stored file for this video — select the file to transcribe its audio.', 'info');
    document.getElementById('transcribe-file-input').click();
    return;
  }

  const btn = document.getElementById('video-transcribe-btn');
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Transcribing…';

  try {
    const { data, error } = await invokeEdge(TRANSCRIBE_FUNCTION, {
      body: { storageKey: v.storage_key },
    });
    const detail = error ? await parseFunctionError(error) : (data?.error || null);
    if (detail) {
      // Video too large for direct transcription → offer audio extraction
      if (/25\s*MB|too large|over OpenAI/i.test(detail)) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
        showToast('Video is over 25MB — select the file to transcribe just its audio.', 'error');
        document.getElementById('transcribe-file-input').click();
        return;
      }
      throw new Error(detail);
    }

    _showVideoTranscript(data.text);
  } catch (err) {
    showToast('Transcription failed: ' + (err?.message || 'unknown error'), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

function _showVideoTranscript(text) {
  document.getElementById('video-transcript-text').textContent = text || '(empty transcript)';
  document.getElementById('video-transcript-box').classList.remove('hidden');
}

// Fallback for large videos: extract compressed audio in-browser, send that
async function handleTranscribeFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  const btn = document.getElementById('video-transcribe-btn');
  btn.disabled = true;
  btn.textContent = 'Extracting audio…';

  try {
    const wav = await extractAudioToWav(file);
    if (wav.size > 25 * 1024 * 1024) {
      throw new Error('Audio is still over 25MB — video is too long (max ~13 min).');
    }
    btn.textContent = 'Transcribing…';
    const form = new FormData();
    form.append('file', wav, 'audio.wav');
    const { data, error } = await invokeEdge(TRANSCRIBE_FUNCTION, { body: form });
    const detail = error ? await parseFunctionError(error) : (data?.error || null);
    if (detail) throw new Error(detail);
    _showVideoTranscript(data.text);
  } catch (err) {
    showToast('Transcription failed: ' + (err?.message || 'unknown error'), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg> Transcribe video';
  }
}

// Decode any audio/video file → 16kHz mono 16-bit WAV (Whisper-friendly, small)
async function extractAudioToWav(file) {
  const arrayBuf = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const decodeCtx = new AC();
  const decoded = await decodeCtx.decodeAudioData(arrayBuf);
  decodeCtx.close();

  const targetRate = 16000;
  const length = Math.ceil(decoded.duration * targetRate);
  const offline = new OfflineAudioContext(1, length, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();

  return _audioBufferToWav(rendered);
}

function _audioBufferToWav(buffer) {
  const samples = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM chunk size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);          // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([ab], { type: 'audio/wav' });
}

async function transcribeFeedback(id, audioPath, btn) {
  const box = document.getElementById('fb-transcript-' + id);
  if (!box) return;
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Transcribing…';

  try {
    const { data, error } = await invokeEdge(TRANSCRIBE_FUNCTION, {
      body: { audioPath },
    });
    const detail = error ? await parseFunctionError(error) : (data?.error || null);
    if (detail) throw new Error(detail);

    box.querySelector('.transcript-text').textContent = data.text || '(empty transcript)';
    box.classList.remove('hidden');
    btn.style.display = 'none';
  } catch (err) {
    showToast('Transcription failed: ' + (err?.message || 'unknown error'), 'error');
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

async function copyTranscript(textId, btn) {
  const text = document.getElementById(textId)?.textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch (_) {
    showToast('Could not copy to clipboard', 'error');
  }
}

function closeModal(e) {
  if (e.target === document.getElementById('video-modal')) closeVideoModal();
}

// ══════════════════════════════════════════════════════
// ADMIN — ADD / EDIT VIDEO
// ══════════════════════════════════════════════════════
function showAdmin() {
  openAddVideo();
}

function openAddVideo() {
  editingVideoId = null;
  pendingWasabiFile = null;
  pendingThumbnail = null;
  document.getElementById('admin-modal-title').textContent = 'Add video slot';
  document.getElementById('v-title').value = '';
  document.getElementById('v-category').value = '';
  document.getElementById('v-subcat').innerHTML = '<option value="">Select sub-category…</option>';
  document.getElementById('v-type').value = '';
  document.getElementById('v-status').value = 'empty';
  document.getElementById('v-wasabi-file').value = '';
  document.getElementById('v-wasabi-url').value = '';
  document.getElementById('v-storage-key').value = '';
  document.getElementById('v-desc').value = '';
  document.getElementById('delete-video-btn').classList.add('hidden');
  hideUploadProgress();
  document.getElementById('admin-modal').classList.add('open');
}

function openEditVideo(id) {
  const v = allVideos.find(x => x.id === id);
  if (!v) return;

  editingVideoId = id;
  pendingWasabiFile = null;
  pendingThumbnail = null;
  document.getElementById('admin-modal-title').textContent = 'Edit video';
  document.getElementById('v-title').value = v.title || '';
  document.getElementById('v-category').value = v.category_id || '';
  loadSubcats(v.category_id).then(() => {
    document.getElementById('v-subcat').value = v.subcategory_id || '';
  });
  document.getElementById('v-type').value = v.video_type || '';
  document.getElementById('v-status').value = v.status || 'empty';
  document.getElementById('v-wasabi-file').value = '';
  document.getElementById('v-wasabi-url').value = v.video_url || '';
  document.getElementById('v-storage-key').value = v.storage_key || '';
  document.getElementById('v-desc').value = v.description || '';
  document.getElementById('delete-video-btn').classList.remove('hidden');
  hideUploadProgress();
  document.getElementById('admin-modal').classList.add('open');
}

function handleWasabiFileSelected(files) {
  pendingWasabiFile = files && files.length ? files[0] : null;
  pendingThumbnail = null;
  hideUploadProgress();

  if (pendingWasabiFile) {
    generateThumbnailDataUri(pendingWasabiFile)
      .then((dataUri) => {
        pendingThumbnail = dataUri;
      })
      .catch((err) => {
        console.warn('Thumbnail generation failed:', err);
        pendingThumbnail = null;
      });
  }
}

function generateThumbnailDataUri(file, seekSeconds = 1) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;

    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(objectUrl);
      fn();
    };

    video.addEventListener('loadedmetadata', () => {
      const target = Math.min(seekSeconds, Math.max(0, (video.duration || 2) * 0.1));
      try { video.currentTime = target; } catch (_) { /* ignore */ }
    });

    video.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        const targetWidth = 320;
        const scale = video.videoWidth ? targetWidth / video.videoWidth : 1;
        canvas.width = targetWidth;
        canvas.height = Math.round((video.videoHeight || 180) * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUri = canvas.toDataURL('image/jpeg', 0.6);
        finish(() => resolve(dataUri));
      } catch (err) {
        finish(() => reject(err));
      }
    });

    video.addEventListener('error', () => {
      finish(() => reject(new Error('Could not load video for thumbnail')));
    });

    setTimeout(() => {
      finish(() => reject(new Error('Thumbnail generation timed out')));
    }, 15000);
  });
}

function showUploadProgress() {
  const wrap = document.getElementById('upload-progress-wrap');
  if (wrap) wrap.classList.remove('hidden');
  setUploadProgress(0, 'Starting…');
}

function hideUploadProgress() {
  const wrap = document.getElementById('upload-progress-wrap');
  if (wrap) wrap.classList.add('hidden');
  setUploadProgress(0, '');
}

function setUploadProgress(percent, label) {
  const pct = Math.min(100, Math.max(0, Math.round(percent)));
  const bar = document.getElementById('upload-progress-bar');
  const pctEl = document.getElementById('upload-progress-pct');
  const labelEl = document.getElementById('upload-progress-label');
  if (bar) bar.style.width = pct + '%';
  if (pctEl) pctEl.textContent = pct + '%';
  if (labelEl && label) labelEl.textContent = label;
}

function isObjectSizeExceededError(err) {
  const m = (err?.message || String(err)).toLowerCase();
  return m.includes('maximum size') || m.includes('maximum allowed') || m.includes('too large') || m.includes('exceeded');
}

function xhrPresignedPutUpload(uploadUrl, file, contentType, onRatio) {
  return new Promise((resolve, reject) => {
    const ct = (contentType && contentType.trim()) || 'application/octet-stream';
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onRatio) onRatio(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 200 || xhr.status === 204 || (xhr.status >= 200 && xhr.status < 300)) {
        resolve();
        return;
      }
      console.error('[wasabi-upload] PUT HTTP', xhr.status);
      console.error('[wasabi-upload] response body:\n' + (xhr.responseText || '(empty)'));
      const codeMatch = xhr.responseText?.match(/<Code>([^<]+)<\/Code>/);
      const msgMatch = xhr.responseText?.match(/<Message>([^<]+)<\/Message>/);
      const code = codeMatch ? codeMatch[1] : '';
      const msg = msgMatch ? msgMatch[1] : '';
      const short = code || msg
        ? `${code}${code && msg ? ' — ' : ''}${msg}`
        : (xhr.responseText || '').slice(0, 180);
      reject(new Error(`Wasabi upload failed (${xhr.status}): ${short || 'see console for full XML'}`));
    });
    xhr.addEventListener('error', () => reject(new Error('Network error while uploading to Wasabi')));
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', ct);
    xhr.send(file);
  });
}

async function xhrSupabaseStorageUpload(storagePath, file, contentType, onRatio) {
  const { data: sessionData } = await sb.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) throw new Error('Not signed in');

  const url = `${SUPABASE_URL}/storage/v1/object/${VIDEO_STAGING_BUCKET}/${storagePath}`;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onRatio) onRatio(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      let msg = xhr.responseText || '';
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.message) msg = parsed.message;
        if (parsed?.error) msg = parsed.error;
      } catch (_) { /* ignore */ }
      reject(new Error(msg || `Staging upload failed (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('Network error while uploading to staging')));
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.send(file);
  });
}

function sanitizeUploadFileName(fileName) {
  return (fileName || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function parseFunctionError(error) {
  let msg = error?.message || String(error);
  try {
    if (error?.context && typeof error.context.json === 'function') {
      const body = await error.context.json();
      if (body?.error) msg = body.error;
    }
  } catch (_) { /* ignore */ }
  return msg;
}

async function uploadViaWasabiDirect(file, onProgress) {
  const contentType = (file.type && file.type.trim()) || 'application/octet-stream';
  onProgress?.(3, 'Preparing upload…');

  const { data, error } = await invokeEdge(WASABI_UPLOAD_INIT_FUNCTION, {
    body: {
      fileName: file.name,
      fileType: contentType,
      fileSize: file.size,
    },
  });

  if (error) {
    const msg = await parseFunctionError(error);
    if (msg.includes('Admin') || msg.includes('401') || msg.includes('Unauthorized')) {
      throw new Error('Upload denied: sign in as an admin user.');
    }
    throw new Error('Upload init failed: ' + msg);
  }

  const uploadUrl = data?.uploadUrl;
  const signedContentType = data?.contentType || contentType;
  const storageKey = data?.storageKey;
  if (!uploadUrl || !storageKey) {
    throw new Error('Invalid upload init response. Redeploy wasabi-upload-init.');
  }

  onProgress?.(8, 'Uploading to Wasabi…');
  await xhrPresignedPutUpload(uploadUrl, file, signedContentType, (ratio) => {
    onProgress?.(8 + ratio * 88, 'Uploading to Wasabi…');
  });

  onProgress?.(100, 'Upload complete');
  return { storageKey, publicUrl: data?.publicUrl || null };
}

async function uploadViaStaging(file, onProgress) {
  const contentType = (file.type && file.type.trim()) || 'application/octet-stream';
  const storagePath = `${currentUser.id}/${crypto.randomUUID()}-${sanitizeUploadFileName(file.name)}`;

  onProgress?.(5, 'Uploading (staging)…');
  await xhrSupabaseStorageUpload(storagePath, file, contentType, (ratio) => {
    onProgress?.(5 + ratio * 60, 'Uploading…');
  });

  onProgress?.(70, 'Copying to Wasabi…');
  const { data, error } = await invokeEdge(WASABI_TRANSFER_FUNCTION, {
    body: { storagePath, contentType },
  });

  if (error) {
    await sb.storage.from(VIDEO_STAGING_BUCKET).remove([storagePath]).catch(() => {});
    const msg = await parseFunctionError(error);
    throw new Error('Transfer to Wasabi failed: ' + msg);
  }

  const storageKey = data?.storageKey;
  if (!storageKey) throw new Error('Transfer returned no storage key.');

  onProgress?.(100, 'Upload complete');
  return { storageKey, publicUrl: data?.publicUrl || null };
}

/**
 * Small files: Supabase staging (if under plan limit).
 * Large files or size errors: direct Wasabi upload (up to 5GB).
 */
async function uploadToWasabiViaEdgeFunction(file, onProgress) {
  if (!currentUser?.id) throw new Error('You must be signed in to upload.');
  if (currentProfile?.role !== 'admin') throw new Error('Upload denied: admin account required.');

  // Always use direct presigned-URL upload — simpler, no staging bucket needed
  return uploadViaWasabiDirect(file, onProgress);
}

async function saveVideo() {
  const btn = document.getElementById('save-video-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const payload = {
    title: document.getElementById('v-title').value.trim(),
    video_source: 'wasabi',
    category_id: document.getElementById('v-category').value || null,
    subcategory_id: document.getElementById('v-subcat').value || null,
    video_type: document.getElementById('v-type').value || null,
    status: document.getElementById('v-status').value,
    youtube_id: null,
    video_url: document.getElementById('v-wasabi-url').value.trim() || null,
    storage_key: document.getElementById('v-storage-key').value.trim() || null,
    description: document.getElementById('v-desc').value.trim() || null,
  };

  if (pendingThumbnail) {
    payload.thumbnail_url = pendingThumbnail;
  }

  if (!payload.title) {
    showToast('Please enter a title', 'error');
    btn.disabled = false;
    btn.textContent = 'Save video';
    return;
  }

  if (pendingWasabiFile) {
    btn.textContent = 'Uploading…';
    showUploadProgress();
    try {
      const result = await uploadToWasabiViaEdgeFunction(pendingWasabiFile, (pct, label) => {
        setUploadProgress(pct, label);
      });
      payload.storage_key = result.storageKey;
      payload.video_url = result.publicUrl || payload.video_url || null;
      // Reflect the captured key in the UI so it's visible and recoverable if the save fails.
      document.getElementById('v-storage-key').value = result.storageKey;
      if (result.publicUrl) document.getElementById('v-wasabi-url').value = result.publicUrl;
      pendingWasabiFile = null;
      document.getElementById('v-wasabi-file').value = '';
    } catch (uploadErr) {
      hideUploadProgress();
      showToast('Upload failed: ' + (uploadErr.message || 'Unknown error'), 'error');
      btn.disabled = false;
      btn.textContent = 'Save video';
      return;
    }
    hideUploadProgress();
  }

  if (!payload.storage_key && !payload.video_url) {
    showToast('Upload a file or provide a Wasabi video URL/storage key', 'error');
    btn.disabled = false;
    btn.textContent = 'Save video';
    return;
  }

  const prevStatus = editingVideoId ? allVideos.find(v => v.id === editingVideoId)?.status : null;

  let error, insertedId;
  if (editingVideoId) {
    ({ error } = await sb.from('videos').update(payload).eq('id', editingVideoId));
  } else {
    payload.created_by = currentUser.id;
    const { data: inserted, error: insertErr } = await sb.from('videos').insert(payload).select('id').single();
    error = insertErr;
    insertedId = inserted?.id;
    console.log('[saveVideo] insert result:', { insertedId, insertErr });
  }

  if (error) {
    showToast('Error: ' + error.message, 'error');
  } else {
    showToast(editingVideoId ? 'Video updated' : 'Video slot created', 'success');
    if (!editingVideoId && insertedId) {
      // New draft uploaded — notify Joe (reviewer) so he knows it's in the queue
      console.log('[saveVideo] firing video_uploaded notify for', insertedId);
      invokeEdge(NOTIFY_FUNCTION, {
        body: { type: 'video_uploaded', videoId: insertedId, videoTitle: payload.title },
      }).then(r => console.log('[notify video_uploaded] response:', r))
        .catch(err => console.warn('[notify video_uploaded] error:', err));
    } else if (editingVideoId && payload.status === 'done' && prevStatus !== 'done') {
      notifyOnStatusDone(editingVideoId, payload.title);
    }
    document.getElementById('admin-modal').classList.remove('open');
    await loadVideos();
  }

  btn.disabled = false;
  btn.textContent = 'Save video';
}

async function deleteVideo() {
  if (!editingVideoId) return;
  if (!confirm('Are you sure you want to delete this video slot? This cannot be undone.')) return;

  const btn = document.getElementById('delete-video-btn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';

  const { error } = await sb.from('videos').delete().eq('id', editingVideoId);

  if (error) {
    showToast('Error: ' + error.message, 'error');
  } else {
    showToast('Video deleted', 'success');
    document.getElementById('admin-modal').classList.remove('open');
    await loadVideos();
  }

  btn.disabled = false;
  btn.textContent = 'Delete Video';
}

function closeAdminModal(e) {
  if (e.target === document.getElementById('admin-modal'))
    document.getElementById('admin-modal').classList.remove('open');
}

// ══════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════
function formatDuration(secs) {
  if (!secs) return '';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m} min`;
}

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ══════════════════════════════════════════════════════
// NOTIFICATIONS
// ══════════════════════════════════════════════════════
async function loadNotifications() {
  const { data } = await sb.from('notifications')
    .select('*, videos(title)')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(30);
  allNotifications = data || [];
  renderNotificationBell();
}

function subscribeToNotifications() {
  // ── Bell notifications ──────────────────────────────────────────────
  notifSubscription = sb.channel(`notifs-${currentUser.id}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'notifications',
      filter: `user_id=eq.${currentUser.id}`,
    }, payload => {
      allNotifications.unshift(payload.new);
      renderNotificationBell();
      showToast(payload.new.title, 'success');
    })
    .subscribe();

  // ── Video status changes (real-time modal refresh) ──────────────────
  // Fires whenever any video row is updated in the DB — covers status
  // changes from the edge function (more_changes_requested, reviewed, etc.)
  // Requires: ALTER PUBLICATION supabase_realtime ADD TABLE videos;
  sb.channel('video-status-changes')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'videos',
    }, payload => {
      const updated = payload.new;
      // Merge into allVideos cache (keep existing joined category data)
      const idx = allVideos.findIndex(v => v.id === updated.id);
      if (idx !== -1) {
        allVideos[idx] = { ...allVideos[idx], ...updated };
        // If this video is open in the modal, refresh the workflow buttons now
        if (currentVideoId === updated.id) {
          const isReviewer = currentProfile?.is_reviewer === true;
          const isAdmin    = currentProfile?.role === 'admin';
          if (isReviewer) updateReviewedBtnState(allVideos[idx]);
          if (isAdmin && !isReviewer) updateEditorBtnState(allVideos[idx]);
        }
      }
    })
    .subscribe();
}

async function refreshCurrentVideo() {
  if (!currentVideoId) return;
  const { data: video } = await sb.from('videos')
    .select('*, categories(name, slug, color), subcategories(name, slug)')
    .eq('id', currentVideoId)
    .single();
  if (!video) return;

  // Update local allVideos array
  const idx = allVideos.findIndex(v => v.id === currentVideoId);
  if (idx !== -1) allVideos[idx] = video;

  // Refresh whichever button section is visible
  const isReviewer = currentProfile?.is_reviewer === true;
  const isAdmin    = currentProfile?.role === 'admin';
  if (isReviewer) updateReviewedBtnState(video);
  if (isAdmin && !isReviewer) updateEditorBtnState(video);
}

function renderNotificationBell() {
  const unread = allNotifications.filter(n => !n.read).length;
  const badge = document.getElementById('notif-badge');
  if (badge) {
    badge.textContent = unread;
    badge.classList.toggle('hidden', unread === 0);
  }
  // Mirror the unread count onto the home-screen app icon (iOS 16.4+, desktop)
  setAppBadgeCount(unread);
}

// Set/clear the home-screen app icon badge number (Badging API)
function setAppBadgeCount(n) {
  try {
    if (!('setAppBadge' in navigator)) return;
    if (n > 0) navigator.setAppBadge(n);
    else navigator.clearAppBadge();
  } catch (_) { /* unsupported / not installed — ignore */ }
}

function toggleNotifPanel(e) {
  e.stopPropagation();
  const panel = document.getElementById('notif-panel');
  notifPanelOpen = !notifPanelOpen;
  panel.classList.toggle('hidden', !notifPanelOpen);
  if (notifPanelOpen) {
    renderNotifPanel();
    markAllNotifsRead();
  }
}

function renderNotifPanel() {
  const list = document.getElementById('notif-list');
  if (!allNotifications.length) {
    list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
    return;
  }
  list.innerHTML = allNotifications.slice(0, 25).map(n => `
    <div class="notif-item ${n.read ? 'read' : 'unread'}" onclick="notifClick('${n.video_id || ''}')">
      <div class="notif-title">${n.title}</div>
      ${n.message ? `<div class="notif-msg">${n.message}</div>` : ''}
      <div class="notif-time">${timeAgo(n.created_at)}</div>
    </div>
  `).join('');
}

async function markAllNotifsRead() {
  const unreadIds = allNotifications.filter(n => !n.read).map(n => n.id);
  if (!unreadIds.length) return;
  await sb.from('notifications').update({ read: true }).in('id', unreadIds);
  allNotifications.forEach(n => n.read = true);
  renderNotificationBell();
}

function notifClick(videoId) {
  if (!videoId) return;
  document.getElementById('notif-panel').classList.add('hidden');
  notifPanelOpen = false;
  const v = allVideos.find(x => x.id === videoId);
  if (v && (v.video_url || v.storage_key)) openVideo(videoId);
}

// ══════════════════════════════════════════════════════
// REVIEWER — mark as reviewed & notify
// ══════════════════════════════════════════════════════
async function markReviewed() {
  const isReviewer = currentProfile?.is_reviewer === true;
  if (!currentVideoId || !isReviewer) return;
  const v = allVideos.find(x => x.id === currentVideoId);
  if (!v) return;

  const btn = document.getElementById('mark-reviewed-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const type       = v.status === 'done' ? 'round2_reviewed' : 'round1_reviewed';
  const newRound   = type === 'round2_reviewed' ? 2 : 1;
  const reviewedAt = new Date().toISOString();

  // 1. Write to DB directly — triggers Ravi's realtime subscription instantly
  const { error } = await sb.from('videos').update({
    review_round: newRound,
    reviewed_at:  reviewedAt,
    reviewed_by:  currentUser.id,
  }).eq('id', currentVideoId);

  if (error) {
    showToast('Could not submit review: ' + error.message, 'error');
    btn.disabled = false;
    updateReviewedBtnState(v);
    return;
  }

  // 2. Update local state & UI immediately
  v.review_round = newRound;
  v.reviewed_at  = reviewedAt;
  showToast(
    type === 'round2_reviewed' ? 'Final approval sent!' : 'Review submitted — admins notified',
    'success'
  );
  btn.disabled = false;
  updateReviewedBtnState(v);

  // 3. Fire edge function in background for bell notifications + SMS only
  invokeEdge(NOTIFY_FUNCTION, {
    body: { type, videoId: currentVideoId, videoTitle: v.title },
  }).catch(err => console.warn('[markReviewed notify]', err));
}

function updateReviewedBtnState(v) {
  const btn = document.getElementById('mark-reviewed-btn');
  const moreBtn = document.getElementById('more-changes-btn');
  const statusEl = document.getElementById('reviewer-status');
  if (!btn || !v) return;
  const reviewedDate = v.reviewed_at ? new Date(v.reviewed_at).toLocaleDateString() : '';
  const checkSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const editSvg  = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

  // Show "More Changes" button only when awaiting final approval (status=done, not yet approved)
  const awaitingFinalApproval = v.status === 'done' && v.review_round < 2;
  moreBtn?.classList.toggle('hidden', !awaitingFinalApproval);

  if (v.status === 'done' && v.review_round >= 2) {
    btn.innerHTML = `${checkSvg} Final Approval Sent`;
    btn.disabled = true;
    moreBtn?.classList.add('hidden');
    setStatusText(statusEl, `Final approval given${reviewedDate ? ' on ' + reviewedDate : ''}`);
  } else if (v.status === 'done') {
    btn.innerHTML = `${checkSvg} Give Final Approval`;
    btn.disabled = false;
    setStatusText(statusEl, 'Revised and ready — approve or request more changes');
  } else if (v.status === 'draft' && v.review_round >= 1) {
    btn.innerHTML = `⏳ Waiting for revisions`;
    btn.disabled = true;
    moreBtn?.classList.add('hidden');
    setStatusText(statusEl, 'You requested more changes — editor has been notified');
  } else {
    btn.innerHTML = `${checkSvg} Mark as Reviewed`;
    btn.disabled = false;
    setStatusText(statusEl, '');
  }
}

async function requestMoreChanges() {
  const isReviewer = currentProfile?.is_reviewer === true;
  if (!currentVideoId || !isReviewer) return;
  const v = allVideos.find(x => x.id === currentVideoId);
  if (!v || v.status !== 'done') return;

  const moreBtn    = document.getElementById('more-changes-btn');
  const reviewedBtn = document.getElementById('mark-reviewed-btn');
  moreBtn.disabled    = true;
  reviewedBtn.disabled = true;
  moreBtn.textContent = 'Saving…';

  // 1. Write to DB directly — triggers Ravi's realtime subscription instantly
  const { error } = await sb.from('videos').update({
    status:       'draft',
    review_round: 1,
  }).eq('id', currentVideoId);

  if (error) {
    showToast('Could not request changes: ' + error.message, 'error');
    moreBtn.disabled    = false;
    reviewedBtn.disabled = false;
    updateReviewedBtnState(v);
    return;
  }

  // 2. Update local state & UI immediately
  v.status       = 'draft';
  v.review_round = 1;
  showToast('More changes requested — editors notified', 'success');
  updateReviewedBtnState(v);

  // 3. Fire edge function in background for bell notifications + SMS only
  invokeEdge(NOTIFY_FUNCTION, {
    body: { type: 'more_changes_requested', videoId: currentVideoId, videoTitle: v.title },
  }).catch(err => console.warn('[requestMoreChanges notify]', err));
}

// ── EDITOR ACTIONS ───────────────────────────────────
function setStatusText(el, text) {
  if (!el || el.textContent === text) return;
  el.style.opacity = '0';
  setTimeout(() => { el.textContent = text; el.style.opacity = '1'; }, 150);
}

function updateEditorBtnState(v) {
  const submitBtn   = document.getElementById('submit-review-btn');
  const markDoneBtn = document.getElementById('mark-done-btn');
  const publishBtn  = document.getElementById('publish-btn');
  const statusEl    = document.getElementById('editor-status');
  if (!markDoneBtn || !v) return;

  const showSubmit   = v.status === 'draft' && v.review_round === 0;
  const showMarkDone = v.status === 'draft' && v.review_round >= 1;
  const showPublish  = v.status === 'done'  && v.review_round >= 2;

  submitBtn?.classList.toggle('hidden', !showSubmit);
  markDoneBtn.classList.toggle('hidden', !showMarkDone);
  publishBtn.classList.toggle('hidden', !showPublish);

  const text =
    showSubmit   ? 'Upload done — submit when ready for Joe to review' :
    showMarkDone ? 'Joe requested changes — click when revisions are ready' :
    showPublish  ? 'Joe gave final approval — ready to publish' :
    v.status === 'done' && v.review_round < 2 ? 'Waiting for Joe\'s final approval' :
    v.status === 'published' ? 'Published ✓' : '';
  setStatusText(statusEl, text);
}

async function submitForReview() {
  if (!currentVideoId) return;
  const v = allVideos.find(x => x.id === currentVideoId);
  if (!v || v.status !== 'draft' || v.review_round !== 0) return;

  const btn = document.getElementById('submit-review-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  // 1. Touch the video row so Joe's realtime subscription picks it up
  //    (no status change needed here — draft+round=0 is correct state)
  //    Fire edge function in background for the bell notification
  showToast('Submitted for review — Joe has been notified', 'success');
  btn.disabled = false;
  updateEditorBtnState(v);

  invokeEdge(NOTIFY_FUNCTION, {
    body: { type: 'video_ready', videoId: currentVideoId, videoTitle: v.title },
  }).catch(err => console.warn('[submitForReview notify]', err));
}

async function markAsDone() {
  if (!currentVideoId) return;
  const v = allVideos.find(x => x.id === currentVideoId);
  if (!v || v.status !== 'draft') return;

  const btn = document.getElementById('mark-done-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const { error } = await sb.from('videos').update({ status: 'done' }).eq('id', currentVideoId);
  if (error) {
    showToast('Could not update status: ' + error.message, 'error');
    btn.disabled = false;
    updateEditorBtnState(v);
    return;
  }

  // Notify reviewer
  invokeEdge(NOTIFY_FUNCTION, {
    body: { type: 'video_ready', videoId: currentVideoId, videoTitle: v.title },
  }).catch(err => console.warn('[markAsDone notify]', err));

  v.status = 'done';
  showToast('Marked as done — Joe has been notified', 'success');
  btn.disabled = false;
  updateEditorBtnState(v);
}

async function publishVideo() {
  if (!currentVideoId) return;
  const v = allVideos.find(x => x.id === currentVideoId);
  if (!v) return;

  if (!confirm(`Publish "${v.title}"? It will become visible to all workers.`)) return;

  const btn = document.getElementById('publish-btn');
  btn.disabled = true;
  btn.textContent = 'Publishing…';

  const { error } = await sb.from('videos').update({ status: 'published' }).eq('id', currentVideoId);
  if (error) {
    showToast('Could not publish: ' + error.message, 'error');
    btn.disabled = false;
    return;
  }

  v.status = 'published';
  showToast(`"${v.title}" is now live!`, 'success');
  btn.disabled = false;
  updateEditorBtnState(v);
  closeVideoModal();
  await loadVideos();
}

function notifyOnStatusDone(videoId, videoTitle) {
  invokeEdge(NOTIFY_FUNCTION, {
    body: { type: 'video_ready', videoId, videoTitle },
  }).catch(err => console.warn('[notify video_ready]', err));
}

function timeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ══════════════════════════════════════════════════════
// MOBILE SIDEBAR
// ══════════════════════════════════════════════════════
function toggleSidebar() {
  const sidebar  = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const isOpen   = sidebar.classList.contains('open');
  if (isOpen) {
    closeSidebar();
  } else {
    sidebar.classList.add('open');
    backdrop.classList.add('visible');
    document.body.style.overflow = 'hidden'; // prevent background scroll
  }
}

function closeSidebar() {
  const sidebar  = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar.classList.remove('open');
  backdrop.classList.remove('visible');
  document.body.style.overflow = '';
}

// Auto-close sidebar when a nav item is tapped on mobile
document.addEventListener('click', e => {
  if (window.innerWidth > 768) return;
  const item = e.target.closest('.sidebar-item');
  if (item) closeSidebar();
});

// ── Sync mobile search input with desktop search state ──
document.addEventListener('DOMContentLoaded', () => {
  const mobileInput = document.getElementById('search-input-mobile');
  const desktopInput = document.getElementById('search-input');
  if (mobileInput && desktopInput) {
    mobileInput.addEventListener('input', () => {
      desktopInput.value = mobileInput.value;
    });
    desktopInput.addEventListener('input', () => {
      mobileInput.value = desktopInput.value;
    });
  }
});

// ══════════════════════════════════════════════════════
// PROFILE & SMS NOTIFICATIONS
// ══════════════════════════════════════════════════════

// Convert VAPID base64 key to Uint8Array for PushManager.subscribe()
function _vapidKey() {
  const b64 = VAPID_PUBLIC_KEY.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '='));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    showToast('Push notifications not supported on this browser', 'error');
    return false;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    showToast('Permission denied — enable notifications in your browser settings', 'error');
    return false;
  }
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing || await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: _vapidKey(),
  });
  const json = sub.toJSON();
  const { error } = await sb.from('push_subscriptions').upsert({
    user_id:  currentUser.id,
    endpoint: json.endpoint,
    p256dh:   json.keys.p256dh,
    auth:     json.keys.auth,
  }, { onConflict: 'endpoint' });
  if (error) { showToast('Push save failed: ' + error.message, 'error'); return false; }
  return true;
}

async function unsubscribeFromPush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe();
  }
}

async function getPushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  const permission = Notification.permission;
  if (permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'subscribed' : 'unsubscribed';
}

async function openProfileModal() {
  // Pre-fill with current profile data
  document.getElementById('profile-name').value = currentProfile?.full_name || '';
  document.getElementById('profile-save-status').style.display = 'none';

  // Reflect current push state on the toggle button
  const state = await getPushState();
  _renderPushBtn(state);

  document.getElementById('profile-modal').classList.add('open');
}

function _renderPushBtn(state) {
  const btn = document.getElementById('push-toggle-btn');
  const status = document.getElementById('push-status-text');
  if (!btn) return;
  if (state === 'unsupported') {
    btn.style.display = 'none';
    status.textContent = 'Not supported on this browser';
  } else if (state === 'denied') {
    btn.style.display = 'none';
    status.textContent = 'Blocked — enable in browser/phone settings';
    status.style.color = 'var(--error, #ff6b6b)';
  } else if (state === 'subscribed') {
    btn.textContent = 'Disable Push Notifications';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-ghost');
    status.textContent = '✓ Push notifications are ON for this device';
    status.style.color = 'var(--success, #4ade80)';
  } else {
    btn.textContent = 'Enable Push Notifications';
    btn.classList.add('btn-primary');
    btn.classList.remove('btn-ghost');
    status.textContent = 'Tap to get notified when videos need your attention';
    status.style.color = '';
  }
}

async function togglePushNotifications() {
  const btn = document.getElementById('push-toggle-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  const state = await getPushState();
  try {
    if (state === 'subscribed') {
      await unsubscribeFromPush();
    } else {
      await subscribeToPush();
    }
  } catch (err) {
    console.warn('[Push] toggle error:', err);
  }
  const newState = await getPushState();
  _renderPushBtn(newState);
  if (btn) btn.disabled = false;
}

function closeProfileModal(e) {
  if (e && e.target !== document.getElementById('profile-modal')) return;
  document.getElementById('profile-modal').classList.remove('open');
}

async function saveProfile() {
  const btn      = document.getElementById('profile-save-btn');
  const status   = document.getElementById('profile-save-status');
  const fullName = document.getElementById('profile-name').value.trim();

  btn.disabled = true;
  const { error } = await sb.from('profiles').update({
    full_name: fullName || null,
  }).eq('id', currentUser.id);

  btn.disabled = false;

  if (error) {
    showToast('Save failed: ' + error.message, 'error');
    return;
  }

  // Update local cache
  if (currentProfile) {
    currentProfile.full_name = fullName || null;
  }

  // Refresh the topbar name
  if (fullName) document.getElementById('user-name').textContent = fullName.split(' ')[0];

  status.textContent = '✓ Name saved';
  status.style.display = 'block';

  // Auto-close after a moment
  setTimeout(() => closeProfileModal(), 2000);
}

// ══════════════════════════════════════════════════════
// JOE'S RECORDINGS — CAPTURE
// ══════════════════════════════════════════════════════
// Recordings go to Wasabi (same bucket as videos) via wasabi-upload-init.
// Playback uses wasabi-playback-url with the storageKey directly.
let captureType       = 'audio';
let captureFacingMode = 'environment'; // 'environment'=back, 'user'=front
let captureStream     = null;
let captureRecorder   = null;
let captureChunks     = [];
let capturedBlob      = null;
let captureThumbnail  = null;  // base64 JPEG data URL for the recordings grid
let captureDuration   = 0;
let captureTimerInterval = null;
let captureStartTime     = 0;
let currentRecordingId   = null;  // for the viewer delete/download action
let currentStorageKey    = null;  // storage_key of the open recording

function openCaptureModal() {
  capturedBlob     = null;
  captureChunks    = [];
  captureThumbnail = null;
  captureType      = 'audio';
  currentRecordingId = null;
  document.getElementById('capture-title').value = '';
  document.getElementById('capture-save-btn').disabled = true;
  // Reset progress bar from any previous session
  _resetCaptureProgress();
  // Reset tabs to Audio
  document.querySelectorAll('.capture-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-audio').classList.add('active');
  document.getElementById('capture-modal').classList.remove('fullscreen-capture');
  document.getElementById('capture-modal').classList.add('open');
  _initCaptureUI('audio');
}

function _resetCaptureProgress() {
  document.getElementById('capture-progress-wrap').classList.add('hidden');
  document.getElementById('capture-progress-bar').style.width = '0%';
  document.getElementById('capture-progress-pct').textContent = '0%';
  document.getElementById('capture-progress-label').textContent = 'Uploading…';
}

function closeCaptureModal(e) {
  if (e && e.target !== document.getElementById('capture-modal')) return;
  _stopCaptureStream();
  if (captureRecorder && captureRecorder.state !== 'inactive') captureRecorder.stop();
  clearInterval(captureTimerInterval);
  document.getElementById('capture-modal').classList.remove('open', 'fullscreen-capture');
}

async function setCaptureType(type, tabEl) {
  _stopCaptureStream();
  if (captureRecorder && captureRecorder.state !== 'inactive') captureRecorder.stop();
  clearInterval(captureTimerInterval);
  captureType      = type;
  capturedBlob     = null;
  captureChunks    = [];
  captureThumbnail = null;
  document.querySelectorAll('.capture-tab').forEach(t => t.classList.remove('active'));
  if (tabEl) tabEl.classList.add('active');
  document.getElementById('capture-save-btn').disabled = true;
  _resetCaptureProgress();
  // Fullscreen layout for camera modes; regular modal for audio
  document.getElementById('capture-modal').classList.toggle('fullscreen-capture', type !== 'audio');
  _initCaptureUI(type);
}

async function _initCaptureUI(type) {
  const preview    = document.getElementById('capture-preview');
  const photoImg   = document.getElementById('capture-photo-result');
  const audioDisp  = document.getElementById('capture-audio-display');
  const startBtn   = document.getElementById('capture-start-btn');
  const stopBtn    = document.getElementById('capture-stop-btn');
  const retakeBtn  = document.getElementById('capture-retake-btn');
  const startLabel = document.getElementById('capture-start-label');
  const flipBtn    = document.getElementById('capture-flip-btn');

  // Reset
  preview.style.display   = 'none';
  photoImg.style.display  = 'none';
  audioDisp.style.display = 'none';
  startBtn.classList.remove('hidden', 'recording');
  stopBtn.classList.add('hidden');
  retakeBtn.classList.add('hidden');
  document.getElementById('capture-timer-display').textContent = '0:00';

  if (type === 'audio') {
    audioDisp.style.display = 'flex';
    startLabel.textContent  = 'Start Recording';
    flipBtn.classList.add('hidden');
  } else if (type === 'video') {
    startLabel.textContent = 'Start Recording';
    flipBtn.classList.remove('hidden');
    await _startCameraPreview(true, true);
  } else {
    startLabel.textContent = 'Take Photo';
    flipBtn.classList.remove('hidden');
    await _startCameraPreview(true, false);
  }
}

async function _startCameraPreview(video, audio) {
  try {
    const videoConstraints = video
      ? {
          facingMode: { ideal: captureFacingMode },
          width:      { ideal: 1920 },
          height:     { ideal: 1080 },
          frameRate:  { ideal: 30 },
        }
      : false;
    const audioConstraints = audio
      ? { sampleRate: { ideal: 48000 }, channelCount: { ideal: 2 }, echoCancellation: true, noiseSuppression: true }
      : false;
    captureStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: audioConstraints,
    });
    const preview = document.getElementById('capture-preview');
    preview.srcObject = captureStream;
    preview.style.display = 'block';
  } catch (err) {
    showToast('Camera/mic access denied: ' + err.message, 'error');
  }
}

async function flipCamera() {
  if (captureType === 'audio') return;
  // Toggle facing mode
  captureFacingMode = captureFacingMode === 'environment' ? 'user' : 'environment';
  const wasRecording = captureRecorder && captureRecorder.state === 'recording';

  _stopCaptureStream();
  await _startCameraPreview(true, captureType === 'video');

  // If we were recording, seamlessly restart the recorder on the new stream
  if (wasRecording && captureStream) {
    captureChunks = []; // discard pre-flip footage
    const mimeType = _bestVideoMime();
    const options  = {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 192_000,
    };
    captureRecorder = new MediaRecorder(captureStream, options);
    captureRecorder.ondataavailable = e => { if (e.data?.size > 0) captureChunks.push(e.data); };
    captureRecorder.onstop = () => {
      const actualMime = captureRecorder.mimeType || mimeType || 'video/webm';
      capturedBlob = new Blob(captureChunks, { type: actualMime });
      captureDuration = Math.round((Date.now() - captureStartTime) / 1000);
      _stopCaptureStream();
      document.getElementById('capture-save-btn').disabled = false;
    };
    captureRecorder.start(200);
  }
}

function _stopCaptureStream() {
  if (captureStream) {
    captureStream.getTracks().forEach(t => t.stop());
    captureStream = null;
  }
}

// Pick the best MIME type the browser actually supports
function _bestAudioMime() {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus',
          'audio/ogg', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
}
function _bestVideoMime() {
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus',
          'video/webm', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
}
// Map a MIME type string → file extension
function _mimeToExt(mime) {
  if (!mime) return 'webm';
  if (mime.includes('mp4'))  return 'mp4';
  if (mime.includes('ogg'))  return 'ogg';
  if (mime.includes('webm')) return 'webm';
  return 'webm';
}

async function startCapture() {
  if (captureType === 'photo') { _takePhoto(); return; }

  // Start mic/camera stream if not already running
  if (!captureStream) {
    await _startCameraPreview(captureType === 'video', true);
    if (!captureStream) return;
  }

  captureChunks = [];
  const mimeType = captureType === 'video' ? _bestVideoMime() : _bestAudioMime();
  const options  = {
    ...(mimeType ? { mimeType } : {}),
    ...(captureType === 'video'
      ? { videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 }
      : { audioBitsPerSecond: 192_000 }),
  };
  captureRecorder = new MediaRecorder(captureStream, options);
  captureRecorder.ondataavailable = e => { if (e.data?.size > 0) captureChunks.push(e.data); };
  captureRecorder.onstop = () => {
    // Use the actual MIME type the recorder chose — never hardcode it
    const actualMime = captureRecorder.mimeType || mimeType || 'audio/webm';
    capturedBlob = new Blob(captureChunks, { type: actualMime });
    captureDuration = Math.round((Date.now() - captureStartTime) / 1000);
    _stopCaptureStream();
    document.getElementById('capture-save-btn').disabled = false;
  };
  captureRecorder.start(200);
  captureStartTime = Date.now();

  // Timer
  captureTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - captureStartTime) / 1000);
    const m = Math.floor(secs / 60), s = secs % 60;
    document.getElementById('capture-timer-display').textContent =
      `${m}:${String(s).padStart(2, '0')}`;
    if (captureType === 'audio') {
      document.getElementById('capture-audio-display').style.display = 'flex';
    }
  }, 500);

  const startBtn = document.getElementById('capture-start-btn');
  startBtn.classList.add('recording');
  startBtn.classList.add('hidden');
  document.getElementById('capture-stop-btn').classList.remove('hidden');
}

// Snapshot the live preview into a small 320px-wide JPEG for the grid card
function _generateThumb() {
  const preview = document.getElementById('capture-preview');
  if (!preview || !preview.videoWidth) return null;
  try {
    const W = 320;
    const H = Math.round(preview.videoHeight * (W / preview.videoWidth)) || 180;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').drawImage(preview, 0, 0, W, H);
    return c.toDataURL('image/jpeg', 0.65);
  } catch { return null; }
}

function stopCapture() {
  // Grab a thumbnail BEFORE the stream is stopped (preview is still live)
  captureThumbnail = _generateThumb();
  clearInterval(captureTimerInterval);
  // Stop the recorder first; its onstop handler tears down the mic stream
  // AFTER the final chunk is flushed (stopping the stream too early can
  // truncate the last audio segment, especially on iOS Safari).
  if (captureRecorder && captureRecorder.state !== 'inactive') {
    captureRecorder.stop();
  } else {
    _stopCaptureStream();
  }
  document.getElementById('capture-stop-btn').classList.add('hidden');
  document.getElementById('capture-retake-btn').classList.remove('hidden');
}

function _takePhoto() {
  const preview = document.getElementById('capture-preview');
  const canvas  = document.createElement('canvas');
  canvas.width  = preview.videoWidth  || 1280;
  canvas.height = preview.videoHeight || 720;
  canvas.getContext('2d').drawImage(preview, 0, 0);

  // Generate a small thumbnail from the same frame
  try {
    const W = 320;
    const H = Math.round(canvas.height * (W / canvas.width)) || 180;
    const tc = document.createElement('canvas');
    tc.width = W; tc.height = H;
    tc.getContext('2d').drawImage(canvas, 0, 0, W, H);
    captureThumbnail = tc.toDataURL('image/jpeg', 0.65);
  } catch { captureThumbnail = null; }

  canvas.toBlob(blob => {
    capturedBlob = blob;
    captureDuration = 0;
    const photoImg = document.getElementById('capture-photo-result');
    photoImg.src = URL.createObjectURL(blob);
    photoImg.style.display = 'block';
    preview.style.display  = 'none';
    document.getElementById('capture-start-btn').classList.add('hidden');
    document.getElementById('capture-retake-btn').classList.remove('hidden');
    document.getElementById('capture-save-btn').disabled = false;
    _stopCaptureStream();
  }, 'image/jpeg', 0.96);
}

async function retakeCapture() {
  capturedBlob     = null;
  captureChunks    = [];
  captureThumbnail = null;
  document.getElementById('capture-save-btn').disabled = true;
  document.getElementById('capture-retake-btn').classList.add('hidden');
  document.getElementById('capture-start-btn').classList.remove('hidden', 'recording');
  document.getElementById('capture-photo-result').style.display = 'none';
  document.getElementById('capture-timer-display').textContent = '0:00';
  await _initCaptureUI(captureType);
}

async function saveRecording() {
  if (!capturedBlob) return;
  const saveBtn = document.getElementById('capture-save-btn');
  saveBtn.disabled = true;

  const ext   = captureType === 'photo' ? 'jpg' : _mimeToExt(capturedBlob.type);
  const mime  = captureType === 'photo' ? 'image/jpeg'
              : capturedBlob.type || (captureType === 'video' ? 'video/webm' : 'audio/webm');
  const fname = `recording-${captureType}-${Date.now()}.${ext}`;
  const title = document.getElementById('capture-title').value.trim() || null;

  // Wrap Blob in a File so the existing Wasabi upload helpers can use it
  const file = new File([capturedBlob], fname, { type: mime });

  // Show progress bar
  const progWrap  = document.getElementById('capture-progress-wrap');
  const progBar   = document.getElementById('capture-progress-bar');
  const progLabel = document.getElementById('capture-progress-label');
  const progPct   = document.getElementById('capture-progress-pct');
  progWrap.classList.remove('hidden');
  progBar.style.width = '0%';

  let storageKey;
  try {
    // Use the same direct-Wasabi path as large video uploads
    const result = await uploadViaWasabiDirect(file, (pct, label) => {
      progBar.style.width = pct + '%';
      progPct.textContent = Math.round(pct) + '%';
      if (label) progLabel.textContent = label;
    });
    storageKey = result.storageKey;
  } catch (err) {
    progWrap.classList.add('hidden');
    showToast('Upload failed: ' + err.message, 'error');
    saveBtn.disabled = false;
    return;
  }

  progBar.style.width = '100%';
  progPct.textContent = '100%';

  const { error: dbError } = await sb.from('joe_recordings').insert({
    created_by:     currentUser.id,
    type:           captureType,
    storage_key:    storageKey,
    title,
    duration_sec:   captureDuration || null,
    thumbnail_data: captureThumbnail || null,
  });

  if (dbError) {
    progWrap.classList.add('hidden');
    showToast('Could not save record: ' + dbError.message, 'error');
    saveBtn.disabled = false;
    return;
  }

  showToast('Recording saved to Wasabi!', 'success');
  closeCaptureModal();

  // Refresh count badge + recordings page if open
  loadRecordingsCount();
  if (document.getElementById('sidebar-recordings-item')?.classList.contains('active')) {
    showRecordingsPage(document.getElementById('sidebar-recordings-item'));
  }
}

// ══════════════════════════════════════════════════════
// JOE'S RECORDINGS — PAGE
// ══════════════════════════════════════════════════════
async function loadRecordingsCount() {
  const { count } = await sb.from('joe_recordings')
    .select('id', { count: 'exact', head: true });
  const el = document.getElementById('count-recordings');
  if (el) el.textContent = count ?? '—';
}

function _fmtDuration(secs) {
  if (!secs) return '';
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function showRecordingsPage(sidebarEl) {
  // Update sidebar active state
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  if (sidebarEl) sidebarEl.classList.add('active');

  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="loading"><div class="spinner"></div> Loading recordings…</div>';

  const { data: recs, error } = await sb.from('joe_recordings')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    main.innerHTML = '<div style="padding:40px;color:var(--muted)">Could not load recordings.</div>';
    return;
  }

  const isAdmin    = currentProfile?.role === 'admin';
  const isReviewer = currentProfile?.is_reviewer === true;

  let html = `
    <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
      <div>
        <div class="page-title">Joe's Recordings</div>
        <div class="page-sub">${recs.length} recording${recs.length !== 1 ? 's' : ''}</div>
      </div>
      ${isAdmin || isReviewer ? `<button class="btn btn-primary btn-sm" style="width:auto" onclick="openCaptureModal()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Recording
      </button>` : ''}
    </div>`;

  if (!recs.length) {
    html += `<div style="text-align:center;padding:60px 20px;color:var(--muted)">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="opacity:.3;margin-bottom:16px"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
      <div style="font-size:15px">No recordings yet.</div>
      <div style="font-size:13px;margin-top:6px">Click <strong>New Recording</strong> to get started.</div>
    </div>`;
    main.innerHTML = html;
    return;
  }

  html += '<div class="recordings-grid">';
  for (const r of recs) {
    const date  = new Date(r.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    const dur   = _fmtDuration(r.duration_sec);
    const label = r.title || `Untitled ${r.type}`;
    const typeIcon = r.type === 'photo'
      ? `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>`
      : r.type === 'video'
      ? `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`
      : `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;

    const thumbArea = r.thumbnail_data
      ? `<div class="recording-thumb" style="position:relative">
           <img src="${r.thumbnail_data}" alt="${label}" style="width:100%;height:100%;object-fit:cover;display:block">
           ${dur ? `<div class="recording-duration">${dur}</div>` : ''}
         </div>`
      : `<div class="recording-thumb-icon" style="position:relative">
           ${typeIcon}
           ${dur ? `<div class="recording-duration">${dur}</div>` : ''}
         </div>`;

    html += `
      <div class="recording-card" onclick="openRecordingViewer('${r.id}')">
        ${thumbArea}
        <div class="recording-body">
          <div class="recording-name">${label}</div>
          <div class="recording-meta">
            <span class="recording-type-badge ${r.type}">${r.type}</span>
            ${date}
          </div>
        </div>
      </div>`;
  }
  html += '</div>';
  main.innerHTML = html;
}

async function openRecordingViewer(id) {
  currentRecordingId = id;
  currentStorageKey  = null;
  const { data: r } = await sb.from('joe_recordings').select('*').eq('id', id).single();
  if (!r) return;
  currentStorageKey = r.storage_key;

  // Get a Wasabi signed URL (same edge function used for video playback)
  const { data: urlData, error: urlErr } = await invokeEdge(WASABI_PLAYBACK_FUNCTION, {
    body: { storageKey: r.storage_key },
  });

  if (urlErr || !urlData?.playbackUrl) {
    showToast('Could not load recording', 'error');
    return;
  }

  const url = urlData.playbackUrl;
  const label = r.title || `Untitled ${r.type}`;
  const date  = new Date(r.created_at).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });

  let playerHtml = '';
  if (r.type === 'photo') {
    playerHtml = `<img src="${url}" alt="${label}" style="width:100%;display:block;border-radius:var(--radius-lg) var(--radius-lg) 0 0;object-fit:contain;max-height:60vh;background:#000">`;
  } else if (r.type === 'video') {
    playerHtml = `<div class="video-wrapper" style="border-radius:var(--radius-lg) var(--radius-lg) 0 0">
      <video controls autoplay playsinline style="width:100%;height:100%;background:#000">
        <source src="${url}">
      </video>
    </div>`;
  } else {
    playerHtml = `<div style="padding:32px;background:rgba(0,0,0,0.3);border-radius:var(--radius-lg) var(--radius-lg) 0 0;display:flex;align-items:center;justify-content:center">
      <audio controls autoplay style="width:100%;outline:none">
        <source src="${url}">
      </audio>
    </div>`;
  }

  document.getElementById('recording-player-wrap').innerHTML = playerHtml;
  document.getElementById('recording-viewer-meta').innerHTML = `
    <div class="recording-viewer-title">${label}</div>
    <div class="recording-viewer-sub">${r.type.charAt(0).toUpperCase() + r.type.slice(1)} · ${date}${r.duration_sec ? ' · ' + _fmtDuration(r.duration_sec) : ''}</div>`;

  // Only show delete button for own recordings or admins
  const isOwn  = r.created_by === currentUser.id;
  const isAdmin = currentProfile?.role === 'admin';
  document.getElementById('recording-delete-btn').style.display = (isOwn || isAdmin) ? '' : 'none';

  document.getElementById('recording-modal').classList.add('open');
}

function closeRecordingModal(e) {
  if (e && e.target !== document.getElementById('recording-modal')) return;
  const wrap = document.getElementById('recording-player-wrap');
  wrap.innerHTML = ''; // stop playback
  document.getElementById('recording-modal').classList.remove('open');
  currentRecordingId = null;
  currentStorageKey  = null;
}

async function deleteRecording() {
  if (!currentRecordingId) return;
  if (!confirm('Delete this recording? This cannot be undone.')) return;

  const btn = document.getElementById('recording-delete-btn');
  if (btn) btn.disabled = true;

  // Delete the DB record and confirm a row actually came back — RLS can
  // silently delete 0 rows if the user isn't allowed. The file on Wasabi
  // is orphaned until a periodic cleanup job removes unreferenced keys.
  const { data, error } = await sb.from('joe_recordings')
    .delete()
    .eq('id', currentRecordingId)
    .select('id');

  if (btn) btn.disabled = false;

  if (error) {
    showToast('Could not delete: ' + error.message, 'error');
    return;
  }
  if (!data || data.length === 0) {
    showToast("Delete blocked — you don't have permission to remove this recording.", 'error');
    return;
  }

  showToast('Recording deleted', 'success');
  closeRecordingModal();
  loadRecordingsCount();

  // Refresh page if we're on recordings
  if (document.getElementById('sidebar-recordings-item')?.classList.contains('active')) {
    showRecordingsPage(document.getElementById('sidebar-recordings-item'));
  }
}

async function downloadRecording() {
  if (!currentStorageKey) return;

  const btn = document.getElementById('recording-download-btn');
  const origLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Preparing…';

  try {
    // Get a fresh signed URL with Content-Disposition: attachment baked in.
    // This tells Wasabi to serve the file as a download — no fetch/CORS needed.
    const { data, error } = await invokeEdge(WASABI_PLAYBACK_FUNCTION, {
      body: { storageKey: currentStorageKey, download: true },
    });
    if (error || !data?.playbackUrl) throw new Error(error?.message || 'Could not get download URL');

    // Navigate to the presigned URL — browser saves it automatically
    const a = document.createElement('a');
    a.href   = data.playbackUrl;
    a.target = '_blank';
    a.rel    = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('Download started', 'success');
  } catch (err) {
    showToast('Download failed: ' + err.message, 'error');
  } finally {
    btn.disabled  = false;
    btn.innerHTML = origLabel;
  }
}

// ══════════════════════════════════════════════════════
// BOOT — check existing session
// ══════════════════════════════════════════════════════
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) {
    await initApp(session.user);
  }

  // Listen for auth changes
  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT') {
      document.getElementById('app').style.display = 'none';
      document.getElementById('login-page').style.display = 'flex';
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeVideoModal();
      closeRecordingModal();
      closeCaptureModal();
      document.getElementById('admin-modal').classList.remove('open');
      document.getElementById('notif-panel')?.classList.add('hidden');
      notifPanelOpen = false;
      closeSidebar();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      const si = window.innerWidth <= 768
        ? document.getElementById('search-input-mobile')
        : document.getElementById('search-input');
      si?.focus();
    }
  });

  // Close notification panel on outside click
  document.addEventListener('click', e => {
    if (!notifPanelOpen) return;
    const wrap = document.getElementById('notif-wrap');
    if (wrap && !wrap.contains(e.target)) {
      document.getElementById('notif-panel').classList.add('hidden');
      notifPanelOpen = false;
    }
  });
})();

// ══════════════════════════════════════════════════════
// PWA — Register Service Worker
// ══════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('[SW] Registered, scope:', reg.scope))
      .catch(err => console.warn('[SW] Registration failed:', err));
  });
}
