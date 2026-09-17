// ══════════════════════════════════════════════════════
// CONFIGURATION — Replace with your Supabase details
// ══════════════════════════════════════════════════════
// A gitignored env.local.js (written by dev/setup-dev-db.ps1) can point a
// local copy at a separate dev project via window.LMP_ENV.
const SUPABASE_URL = window.LMP_ENV?.SUPABASE_URL || 'https://tdxwsgfjkpurtjmgwabr.supabase.co';
const SUPABASE_ANON_KEY = window.LMP_ENV?.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkeHdzZ2Zqa3B1cnRqbWd3YWJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNjE3NzAsImV4cCI6MjA5NDczNzc3MH0.9t1S-8kw6LCp7WDDTvs7Um0REVCvIoQt-d8xoF9ITbA';

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
// Which page owns #main-content. loadVideos() finishes after the user may
// already have navigated away, and renderVideos() would then overwrite
// whatever they opened — so every writer of #main-content claims it here.
let currentPage = 'library';
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
let notifPollTimer = null;
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
    document.getElementById('sidebar-manage-item').classList.remove('hidden');
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

  // Role-specific workflow folders: Joe (reviewer) sees TO REVIEW;
  // Ravi (editor = admin, not reviewer) sees TO EDIT + COMPLETED VIDEOS.
  const isEditor = profile?.role === 'admin' && !profile?.is_reviewer;
  const toggle = (id, show) => document.getElementById(id)?.classList.toggle('hidden', !show);
  toggle('folder-to-review', !!profile?.is_reviewer);
  toggle('folder-to-edit',   isEditor);
  toggle('folder-completed', isEditor);

  // Load data — scripts before videos so cards can show their script tag
  await Promise.all([loadCategories(), loadScripts()]);
  await loadVideos();
  await Promise.all([loadNotifications(), loadRecordingsCount()]);
  subscribeToNotifications();
  subscribeToScriptChanges();
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
  const { data, error } = await sb.from('videos').select(`
    *,
    categories(name, slug, color),
    subcategories(name, slug)
  `).order('sort_order').order('title');

  // A failed load and an genuinely empty library look identical once the rows
  // are dropped, so keep the error and let renderVideos() say which it was.
  videosLoadError = error ? (error.message || 'Could not load videos') : null;
  if (error) console.error('[videos] load failed:', error);
  allVideos = data || [];

  updateCounts();
  renderVideos();
}

let videosLoadError = null;

// In-pipeline statuses — hidden from the main browse, shown only in their folders
const WORKFLOW_STATUSES = ['to_review', 'to_edit', 'completed'];
const isWorkflowStatus = (s) => WORKFLOW_STATUSES.includes(s);

function updateCounts() {
  // All Videos / category counts reflect the published catalog only
  const visibleVideos = allVideos.filter(v => v.status === 'published');
  const total = visibleVideos.length;
  const ops  = visibleVideos.filter(v => v.categories?.slug === 'lmp-operations').length;
  const prop = visibleVideos.filter(v => v.categories?.slug === 'properties-contacts').length;
  const plmb = visibleVideos.filter(v => v.categories?.slug === 'plumbing-training').length;
  document.getElementById('count-all').textContent = total;
  document.getElementById('count-ops').textContent = ops;
  document.getElementById('count-prop').textContent = prop;
  document.getElementById('count-plmb').textContent = plmb;

  // Role-specific workflow folders
  const setCount = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  setCount('count-to-review', allVideos.filter(v => v.status === 'to_review').length);
  setCount('count-to-edit',   allVideos.filter(v => v.status === 'to_edit').length);
  setCount('count-completed', allVideos.filter(v => v.status === 'completed').length);

}

// ══════════════════════════════════════════════════════
// FILTERING & RENDERING
// ══════════════════════════════════════════════════════
function filterCategory(slug, el) {
  currentPage = 'library';
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
  el?.classList.add('active');
  renderVideos();
}

function filterSubcat(slug) {
  currentSubcatFilter = slug;
  renderVideos();
}

function filterStatus(status, el) {
  currentPage = 'library';
  currentStatus = status;
  currentFilter = 'all';
  currentSubcatFilter = 'all';
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  el?.classList.add('active');
  renderVideos();
}

// Workflow folders (TO REVIEW / TO EDIT / COMPLETED) call filterStatus() directly
// from the sidebar with the matching status key.

function handleSearch(val) {
  // Searching from another page brings you back to the library.
  currentPage = 'library';
  currentSearch = val.toLowerCase();
  renderVideos();
}

function getFilteredVideos() {
  const isAdmin = currentProfile?.role === 'admin';
  return allVideos.filter(v => {
    if (!isAdmin && v.status !== 'published') return false;
    if (isWorkflowStatus(currentStatus)) {
      // A workflow folder is open (TO REVIEW / TO EDIT / COMPLETED)
      if (v.status !== currentStatus) return false;
    } else if (currentStatus === 'empty') {
      // "Empty slots" filter — unpublished slots the editor can fill
      if (v.status !== 'empty' && v.status !== 'raw') return false;
    } else {
      // All Videos / category / Published views show only published videos —
      // nothing in-pipeline or unpublished leaks into the public catalog.
      if (v.status !== 'published') return false;
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
  if (currentPage !== 'library') return;
  parkVideoForm();
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
  const STATUS_TITLES = {
    empty: 'Empty slots', published: 'Published',
    to_review: 'To Review', to_edit: 'To Edit', completed: 'Completed Videos',
  };
  const catLabel = STATUS_TITLES[currentStatus]
    || (currentFilter === 'all' ? 'All Videos'
        : allCategories.find(c => c.slug === currentFilter)?.name || 'Videos');
  html += `<div class="page-header">
    <div class="page-title">${catLabel}</div>
    <div class="page-sub">${videos.length} ${currentStatus === 'empty' ? `slot${videos.length !== 1 ? 's' : ''}` : `video${videos.length !== 1 ? 's' : ''}`}${currentSearch ? ` matching "${escapeHtml(currentSearch)}"` : ''}</div>
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
    html += emptyStateHtml(isAdmin);
  } else {
    html += `<div class="video-grid">`;
    videos.forEach(v => { html += renderVideoCard(v, isAdmin); });
    html += `</div>`;
  }

  main.innerHTML = html;
}

// "No videos found" was shown for a failed load, an unfilled library and a
// bad search alike. Each of those needs a different next step.
function emptyStateHtml(isAdmin) {
  if (videosLoadError) {
    return `<div class="empty-state">
      <h3>Couldn't load the library</h3>
      <p>${escapeHtml(videosLoadError)}</p>
      <p style="margin-top:10px"><button class="btn btn-ghost btn-sm" style="width:auto" onclick="loadVideos()">Try again</button></p>
    </div>`;
  }
  if (currentSearch) {
    return `<div class="empty-state">
      <h3>Nothing matches "${escapeHtml(currentSearch)}"</h3>
      <p>Try fewer words, or search by category name.</p>
    </div>`;
  }
  if (currentStatus === 'empty') {
    return `<div class="empty-state">
      <h3>No unfilled slots</h3>
      <p>Every slot has a video. Nice.</p>
    </div>`;
  }
  if (isWorkflowStatus(currentStatus)) {
    const where = { to_review: 'waiting for review', to_edit: 'waiting to be edited', completed: 'finished and waiting to publish' }[currentStatus];
    return `<div class="empty-state">
      <h3>Nothing here</h3>
      <p>No videos are ${where} right now.</p>
    </div>`;
  }
  // The common case on a fresh install: slots exist, none are published yet.
  const unfilled = allVideos.filter(v => v.status === 'empty' || v.status === 'raw').length;
  if (isAdmin && unfilled) {
    return `<div class="empty-state">
      <h3>Nothing published yet</h3>
      <p>${unfilled} slot${unfilled !== 1 ? 's are' : ' is'} waiting to be filled. Start a project to script one, or open a slot to upload a video.</p>
      <p style="margin-top:10px">
        <button class="btn btn-ghost btn-sm" style="width:auto" onclick="showManageVideosPage(null, 'empty')">See empty slots</button>
      </p>
    </div>`;
  }
  return `<div class="empty-state">
    <h3>No videos yet</h3>
    <p>${isAdmin ? 'Add a video slot to get started.' : 'Nothing has been published here yet — check back soon.'}</p>
  </div>`;
}

function renderVideoCard(v, isAdmin) {
  const typeClass = v.video_type ? `type-${v.video_type.toLowerCase()}` : 'status-empty';
  const STATUS_META = {
    published: { color: 'var(--teal)', label: 'Published' },
    to_review: { color: '#f5a524',     label: 'To Review' },
    to_edit:   { color: '#3b82f6',     label: 'To Edit' },
    completed: { color: '#a855f7',     label: 'Completed' },
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

  // Round badge for the review/edit folders so Joe can tell a first review from
  // a re-review at a glance. Round 1 is subtle; revisions (round ≥ 2) stand out.
  const round = v.review_round || 1;
  const roundBadge = (v.status === 'to_review' || v.status === 'to_edit')
    ? `<span class="card-tag round-badge${round > 1 ? ' is-revision' : ''}">${round > 1 ? `Revision ${round - 1}` : '1st review'}</span>`
    : '';

  const playableStatus = v.status === 'published' || isWorkflowStatus(v.status);
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
        ${roundBadge}
        ${isAdmin ? scriptTagHtml(scriptForVideo(v.id)) : ''}
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
  renderModalScriptLink(v.id);

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
  // Reviewer decision (Joe) — only actionable while in the TO REVIEW folder
  const reviewerSection = document.getElementById('reviewer-section');
  if (isReviewer && v.status === 'to_review') {
    reviewerSection.classList.remove('hidden');
    updateReviewedBtnState(v);
  } else {
    reviewerSection.classList.add('hidden');
  }

  // Editor actions (Ravi) — Mark as Done (to_edit), Publish (completed), or
  // Submit a freshly-uploaded slot (empty/raw)
  const editorSection = document.getElementById('editor-section');
  const editorActionable = ['empty', 'raw', 'to_edit', 'completed'].includes(v.status);
  if (isAdmin && !isReviewer && editorActionable) {
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

  // Only show the current review cycle's feedback. When Ravi resubmits, the
  // video's review_round increments, so prior-round notes are hidden (but kept).
  const round = allVideos.find(x => x.id === videoId)?.review_round || 1;

  const { data, error } = await sb
    .from('video_feedback')
    .select('id, user_id, body, audio_path, image_path, duration_seconds, created_at, profiles:user_id(full_name)')
    .eq('video_id', videoId)
    .eq('review_round', round)
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

  await ensureFreshSession();   // attach a valid token — avoids anon 403 on upload/insert

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
      review_round:     allVideos.find(x => x.id === currentVideoId)?.review_round || 1,
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
// Manage videos is a page, not a modal. The add/edit form markup still lives in
// #admin-modal (never opened now); it is moved into the page while in use and
// parked back before any page rewrites #main-content, so its inputs survive.
const VIDEO_STATUS_LABELS = {
  empty: 'Empty slot', raw: 'Raw', to_review: 'To Review', to_edit: 'To Edit',
  completed: 'Completed', published: 'Published',
};

function parkVideoForm() {
  const form = document.getElementById('video-form');
  const home = document.querySelector('#admin-modal .modal');
  if (form && home && form.parentElement !== home) home.appendChild(form);
}

function showAdmin() {
  showManageVideosPage(document.getElementById('sidebar-manage-item'));
}

// Status filter on the Manage videos page (moved here from the sidebar — admin only)
let manageStatusFilter = 'all';
const MANAGE_STATUS_FILTERS = [
  { key: 'all',       label: 'All',         match: () => true },
  { key: 'published', label: 'Published',   match: v => v.status === 'published' },
  { key: 'empty',     label: 'Empty slots', match: v => v.status === 'empty' || v.status === 'raw' },
  { key: 'to_review', label: 'To Review',   match: v => v.status === 'to_review' },
  { key: 'to_edit',   label: 'To Edit',     match: v => v.status === 'to_edit' },
  { key: 'completed', label: 'Completed',   match: v => v.status === 'completed' },
];

function showManageVideosPage(sidebarEl, statusFilter) {
  if (currentProfile?.role !== 'admin') return;
  if (statusFilter) manageStatusFilter = statusFilter;
  currentPage = 'manage';
  parkVideoForm();
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  (sidebarEl || document.getElementById('sidebar-manage-item'))?.classList.add('active');

  const activeFilter = MANAGE_STATUS_FILTERS.find(f => f.key === manageStatusFilter) || MANAGE_STATUS_FILTERS[0];
  const shown = allVideos.filter(activeFilter.match);
  const chips = MANAGE_STATUS_FILTERS.map(f => `
    <button class="manage-chip ${f.key === activeFilter.key ? 'active' : ''}" onclick="showManageVideosPage(null, '${f.key}')">
      ${f.label} <span class="manage-chip-count">${allVideos.filter(f.match).length}</span>
    </button>`).join('');

  const rows = shown.map(v => `
    <tr>
      <td>${escapeHtml(v.title || 'Untitled')}</td>
      <td>${escapeHtml(v.categories?.name || '—')}${v.subcategories?.name ? ` › ${escapeHtml(v.subcategories.name)}` : ''}</td>
      <td>${escapeHtml(v.video_type || '—')}</td>
      <td><span class="card-tag status-${v.status}">${VIDEO_STATUS_LABELS[v.status] || escapeHtml(v.status || '')}</span></td>
      <td style="text-align:right"><button class="btn btn-ghost btn-sm" style="width:auto;margin-top:0;padding:4px 12px;font-size:12px" onclick="openEditVideo('${v.id}')">Edit</button></td>
    </tr>`).join('');

  document.getElementById('main-content').innerHTML = `
    <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
      <div>
        <div class="page-title">Manage videos</div>
        <div class="page-sub">${shown.length} video${shown.length !== 1 ? 's' : ''}${activeFilter.key !== 'all' ? ` · ${activeFilter.label}` : ''}</div>
      </div>
      <button class="btn btn-primary btn-sm" style="width:auto;margin-top:0" onclick="openAddVideo()">+ Add video slot</button>
    </div>
    <div class="manage-chips">${chips}</div>
    <div id="manage-form-slot" class="manage-form-panel hidden"></div>
    <div class="manage-table-wrap">
      <table class="manage-table">
        <thead><tr><th>Title</th><th>Category</th><th>Type</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" style="color:var(--muted)">No videos with this status.</td></tr>'}</tbody>
      </table>
    </div>`;
}

function mountVideoForm() {
  if (currentPage !== 'manage' || !document.getElementById('manage-form-slot')) showManageVideosPage();
  const slot = document.getElementById('manage-form-slot');
  const form = document.getElementById('video-form');
  if (!slot || !form) return;
  slot.appendChild(form);
  slot.classList.remove('hidden');
  document.getElementById('v-status-group').classList.toggle('hidden', currentProfile?.role !== 'admin');
  slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeVideoForm() {
  parkVideoForm();
  document.getElementById('manage-form-slot')?.classList.add('hidden');
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
  mountVideoForm();
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
  mountVideoForm();
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

  await ensureFreshSession();   // attach a valid token — avoids anon 403 on the write
  let error, insertedId;
  if (editingVideoId) {
    ({ error } = await sb.from('videos').update(payload).eq('id', editingVideoId));
  } else {
    payload.created_by = currentUser.id;
    payload.review_round = 1;
    // Insert in an editor-visible state ('raw') so we can read the new id back
    // under RLS, then promote into Joe's TO REVIEW with a minimal update below.
    payload.status = 'raw';
    const { data: inserted, error: insertErr } = await sb.from('videos').insert(payload).select('id').single();
    error = insertErr;
    insertedId = inserted?.id;
    console.log('[saveVideo] insert result:', { insertedId, insertErr });
  }

  if (error) {
    showToast('Error: ' + error.message, 'error');
  } else {
    if (!editingVideoId && insertedId) {
      // Promote the freshly-uploaded video into Joe's TO REVIEW queue.
      // Via RPC — editor can't SELECT a to_review row, so a plain update 403s.
      const { error: promoteErr } = await sb.rpc('set_video_status', { p_video_id: insertedId, p_status: 'to_review' });
      if (promoteErr) {
        showToast('Uploaded, but could not submit for review: ' + promoteErr.message, 'error');
      } else {
        showToast('Uploaded — sent to Joe for review', 'success');
        invokeEdge(NOTIFY_FUNCTION, {
          body: { type: 'video_uploaded', videoId: insertedId, videoTitle: payload.title },
        }).catch(err => console.warn('[notify video_uploaded] error:', err));
      }
    } else {
      showToast('Video updated', 'success');
    }
    closeVideoForm();
    await loadVideos();
    if (currentPage === 'manage') showManageVideosPage();
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
    closeVideoForm();
    await loadVideos();
    if (currentPage === 'manage') showManageVideosPage();
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
  const { data, error } = await sb.from('notifications')
    .select('*, videos(title)')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) return; // keep what we have rather than blanking the bell
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
      if (allNotifications.some(n => n.id === payload.new.id)) return;
      allNotifications.unshift(payload.new);
      renderNotificationBell();
      showToast(payload.new.title, 'success');
    })
    .subscribe(status => {
      // Catch anything that arrived while the socket was (re)connecting
      if (status === 'SUBSCRIBED') loadNotifications();
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.warn('[notifications] realtime', status);
    });

  // Fallback so the bell stays current even if realtime isn't delivering:
  // refetch when the tab comes back into view, and poll lightly while visible.
  if (!notifPollTimer) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && currentUser) loadNotifications();
    });
    notifPollTimer = setInterval(() => {
      if (currentUser && document.visibilityState === 'visible') loadNotifications();
    }, 30000);
  }

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
    <div class="notif-item ${n.read ? 'read' : 'unread'}" onclick="notifClick('${n.video_id || ''}', '${n.script_id || ''}')">
      <div class="notif-title">${n.title}</div>
      ${n.message ? `<div class="notif-msg">${n.message}</div>` : ''}
      <div class="notif-time">${timeAgo(n.created_at)}</div>
      ${n.read ? `<button class="notif-dismiss" title="Dismiss" aria-label="Dismiss notification" onclick="event.stopPropagation();dismissNotification('${n.id}')">✕</button>` : ''}
    </div>
  `).join('');
}

async function dismissNotification(id) {
  const prev = allNotifications;
  allNotifications = allNotifications.filter(n => n.id !== id);
  renderNotifPanel();
  renderNotificationBell();
  const { error } = await sb.from('notifications').delete().eq('id', id);
  if (error) {
    allNotifications = prev;
    renderNotifPanel();
    renderNotificationBell();
    showToast('Could not dismiss: ' + error.message, 'error');
  }
}

async function markAllNotifsRead() {
  const unreadIds = allNotifications.filter(n => !n.read).map(n => n.id);
  if (!unreadIds.length) return;
  await sb.from('notifications').update({ read: true }).in('id', unreadIds);
  allNotifications.forEach(n => n.read = true);
  renderNotificationBell();
}

function notifClick(videoId, scriptId) {
  if (!videoId && !scriptId) return;
  document.getElementById('notif-panel').classList.add('hidden');
  notifPanelOpen = false;
  if (scriptId) { openScript(scriptId); return; }
  const v = allVideos.find(x => x.id === videoId);
  if (v && (v.video_url || v.storage_key)) openVideo(videoId);
}

// ══════════════════════════════════════════════════════
// REVIEWER — mark as reviewed & notify
// ══════════════════════════════════════════════════════
// Canonical reviewer-button labels (restored by updateReviewedBtnState).
const SEND_BACK_BTN_HTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Send back for edits';
const MARK_COMPLETE_BTN_HTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Mark as Complete';

// Joe sends the video back to Ravi's TO EDIT folder with his feedback.
async function sendBackForEdits() {
  await reviewerDecision({
    status: 'to_edit',
    guardStatus: 'to_review',
    btnId: 'send-back-btn',
    notifyType: 'more_changes_requested',
    successMsg: 'Sent back for edits — Ravi notified',
    errorMsg: 'Could not send back',
  });
}

// Joe approves the video — it moves to Ravi's COMPLETED VIDEOS folder.
async function markComplete() {
  await reviewerDecision({
    status: 'completed',
    guardStatus: 'to_review',
    btnId: 'mark-complete-btn',
    notifyType: 'round2_reviewed',
    successMsg: 'Marked complete — moved to Ravi\'s Completed Videos',
    errorMsg: 'Could not mark complete',
  });
}

// Shared handler for the reviewer's two decisions (send back / complete).
async function reviewerDecision({ status, guardStatus, btnId, notifyType, successMsg, errorMsg }) {
  const isReviewer = currentProfile?.is_reviewer === true;
  if (!currentVideoId || !isReviewer) return;
  const v = allVideos.find(x => x.id === currentVideoId);
  if (!v || v.status !== guardStatus) return;

  const videoId = currentVideoId;
  const title = v.title;
  const btn = document.getElementById(btnId);
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  const otherBtn = document.getElementById(btnId === 'send-back-btn' ? 'mark-complete-btn' : 'send-back-btn');
  if (otherBtn) otherBtn.disabled = true;

  await ensureFreshSession();
  const reviewedAt = new Date().toISOString();
  // Transition via SECURITY DEFINER RPC — a plain update would 403 because the
  // row leaves Joe's read-visibility once it's no longer 'to_review'.
  const { error } = await sb.rpc('set_video_status', { p_video_id: videoId, p_status: status });

  if (error) {
    showToast(`${errorMsg}: ${error.message}`, 'error');
    updateReviewedBtnState(v);   // restores labels + re-enables
    return;
  }

  v.status = status;
  v.reviewed_at = reviewedAt;
  showToast(successMsg, 'success');
  // The video has left Joe's TO REVIEW folder — close + refresh his list
  closeVideoModal();
  await loadVideos();

  invokeEdge(NOTIFY_FUNCTION, {
    body: { type: notifyType, videoId, videoTitle: title },
  }).catch(err => console.warn('[reviewerDecision notify]', err));
}

function updateReviewedBtnState(v) {
  const sendBackBtn = document.getElementById('send-back-btn');
  const completeBtn = document.getElementById('mark-complete-btn');
  const statusEl = document.getElementById('reviewer-status');
  if (!sendBackBtn || !v) return;

  // Restore canonical labels + enabled state (recovers from a stuck "Saving…").
  sendBackBtn.disabled = false; sendBackBtn.innerHTML = SEND_BACK_BTN_HTML;
  if (completeBtn) { completeBtn.disabled = false; completeBtn.innerHTML = MARK_COMPLETE_BTN_HTML; }

  const round = v.review_round || 1;
  setStatusText(statusEl, round > 1
    ? `Revision round ${round} — send back for more edits, or mark complete`
    : 'Review this video — send back with feedback, or mark complete');
}

// ── EDITOR ACTIONS ───────────────────────────────────
function setStatusText(el, text) {
  if (!el || el.textContent === text) return;
  el.style.opacity = '0';
  setTimeout(() => { el.textContent = text; el.style.opacity = '1'; }, 150);
}

// Canonical labels for the workflow buttons. Click handlers overwrite these
// with transient text ("Saving…" etc.); updateEditorBtnState restores them so
// a failed/interrupted action never leaves a button stuck.
const SUBMIT_BTN_HTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Submit for Review';
const MARK_DONE_BTN_HTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Mark as Done';
const PUBLISH_BTN_HTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4 20-7z"/></svg> Publish Video';

function updateEditorBtnState(v) {
  const submitBtn   = document.getElementById('submit-review-btn');
  const markDoneBtn = document.getElementById('mark-done-btn');
  const publishBtn  = document.getElementById('publish-btn');
  const statusEl    = document.getElementById('editor-status');
  if (!markDoneBtn || !v) return;

  // Restore canonical label + enabled state — recovers from any prior
  // transient "Saving…"/"Sending…"/"Publishing…" left by a failed action.
  if (submitBtn)  { submitBtn.disabled  = false; submitBtn.innerHTML  = SUBMIT_BTN_HTML; }
  markDoneBtn.disabled = false; markDoneBtn.innerHTML = MARK_DONE_BTN_HTML;
  if (publishBtn) { publishBtn.disabled = false; publishBtn.innerHTML = PUBLISH_BTN_HTML; }

  const showSubmit   = v.status === 'empty' || v.status === 'raw';
  const showMarkDone = v.status === 'to_edit';
  const showPublish  = v.status === 'completed';

  submitBtn?.classList.toggle('hidden', !showSubmit);
  markDoneBtn.classList.toggle('hidden', !showMarkDone);
  publishBtn.classList.toggle('hidden', !showPublish);

  const text =
    showSubmit   ? 'Upload done — submit for Joe to review' :
    showMarkDone ? 'Joe requested changes — click when revisions are ready' :
    showPublish  ? 'Approved by Joe — ready to publish' :
    v.status === 'to_review' ? 'Waiting for Joe to review' :
    v.status === 'published' ? 'Published ✓' : '';
  setStatusText(statusEl, text);
}

// Ravi submits a freshly-uploaded slot → Joe's TO REVIEW (review cycle 1).
async function submitForReview() {
  if (!currentVideoId) return;
  const v = allVideos.find(x => x.id === currentVideoId);
  if (!v || !(v.status === 'empty' || v.status === 'raw')) return;

  const btn = document.getElementById('submit-review-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  await ensureFreshSession();
  const { error } = await sb.rpc('set_video_status', { p_video_id: currentVideoId, p_status: 'to_review' });
  if (error) {
    showToast('Could not submit: ' + error.message, 'error');
    updateEditorBtnState(v);   // restores label + re-enables
    return;
  }

  v.status = 'to_review';
  v.review_round = 1;
  const videoId = currentVideoId, title = v.title;
  showToast('Submitted for review — Joe has been notified', 'success');
  closeVideoModal();
  await loadVideos();

  invokeEdge(NOTIFY_FUNCTION, {
    body: { type: 'video_ready', videoId, videoTitle: title },
  }).catch(err => console.warn('[submitForReview notify]', err));
}

// Ravi finished a revision → back to Joe's TO REVIEW. Bumping review_round
// hides the previous round's feedback once it's in Joe's hands again.
async function markAsDone() {
  if (!currentVideoId) return;
  const v = allVideos.find(x => x.id === currentVideoId);
  if (!v || v.status !== 'to_edit') return;

  const btn = document.getElementById('mark-done-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  await ensureFreshSession();
  const nextRound = (v.review_round || 1) + 1;
  // RPC bumps review_round server-side (to_edit → to_review) and avoids the
  // read-visibility 403 that a plain update hits.
  const { error } = await sb.rpc('set_video_status', { p_video_id: currentVideoId, p_status: 'to_review' });
  if (error) {
    showToast('Could not update status: ' + error.message, 'error');
    updateEditorBtnState(v);   // restores label + re-enables
    return;
  }

  v.status = 'to_review';
  v.review_round = nextRound;
  const videoId = currentVideoId, title = v.title;
  showToast('Marked as done — Joe has been notified', 'success');
  closeVideoModal();
  await loadVideos();

  invokeEdge(NOTIFY_FUNCTION, {
    body: { type: 'video_ready', videoId, videoTitle: title },
  }).catch(err => console.warn('[markAsDone notify]', err));
}

async function publishVideo() {
  if (!currentVideoId) return;
  const v = allVideos.find(x => x.id === currentVideoId);
  if (!v || v.status !== 'completed') return;

  if (!confirm(`Publish "${v.title}"? It will become visible to all workers.`)) return;

  const btn = document.getElementById('publish-btn');
  btn.disabled = true;
  btn.textContent = 'Publishing…';

  await ensureFreshSession();
  const { error } = await sb.rpc('set_video_status', { p_video_id: currentVideoId, p_status: 'published' });
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
  currentPage = 'recordings';
  // Update sidebar active state
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  if (sidebarEl) sidebarEl.classList.add('active');

  parkVideoForm();
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
      closeScriptModal();
      closeScriptNewModal();
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
  // Auto-reload once when a newly-activated SW takes control, so a fresh deploy
  // applies itself without the user hard-refreshing.
  let _swReloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_swReloaded) return;
    _swReloaded = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        console.log('[SW] Registered, scope:', reg.scope);
        // Check for a new version on every load
        reg.update();
      })
      .catch(err => console.warn('[SW] Registration failed:', err));
  });
}

// ══════════════════════════════════════════════════════
// SCRIPT PROJECTS — confirm the narration with Joe BEFORE producing video
//
// A script is the start of a video's project: it's created against a slot
// (category → sub-category → empty slot) with a content writer assigned, and
// an editor assigned later. The writer drafts → "Send to Joe" renders a cheap
// OpenAI TTS preview (cached per paragraph, only changed paragraphs re-render)
// → Joe listens on his phone, leaves voice notes (auto-transcribed) →
// Approve / Needs changes. The approved version is pinned to the video slot.
//
// Roles: Ravi = admin (manages projects, can also write). Joe = reviewer.
// Writers/editors are plain accounts; access comes purely from assignment.
// ══════════════════════════════════════════════════════
const SCRIPT_TTS_FUNCTION = 'script-tts';
const SCRIPT_AUDIO_BUCKET = 'script-audio';
// PostgREST needs the FK name to embed profiles twice (writer + editor)
const SCRIPT_SELECT = `*, videos(id, title, status, thumbnail_url, storage_key, video_url, description, duration_seconds), categories(name, slug), subcategories(name),
  writer:profiles!scripts_writer_id_fkey(full_name), editor:profiles!scripts_editor_id_fkey(full_name)`;

const SCRIPT_STATUS_META = {
  draft:    { color: 'var(--muted)', label: 'Draft' },
  sent:     { color: '#f5a524',      label: 'With Joe' },
  changes:  { color: '#60a5fa',      label: 'Changes requested' },
  approved: { color: 'var(--teal)',  label: 'Approved' },
};

// A project = making one video. Stage 1 is the script, stage 2 is the video.
// The script row carries the project; `videos.status` drives stage 2.
const PROJECT_VIDEO_META = {
  empty:     { key: 'empty',     label: 'Not started' },
  raw:       { key: 'raw',       label: 'Raw footage' },
  to_review: { key: 'to_review', label: 'To review' },
  to_edit:   { key: 'to_edit',   label: 'To edit' },
  completed: { key: 'completed', label: 'Completed' },
  published: { key: 'published', label: 'Published' },
};

// → { n, of, name, detail, done } — `n` is the stage the project is sitting in.
function projectStage(s) {
  if (!s || s.status !== 'approved') {
    return {
      n: 1, of: 2, name: 'Script', done: false,
      detail: SCRIPT_STATUS_META[s?.status]?.label || 'Draft',
    };
  }
  const vs = s.videos?.status || 'empty';
  const meta = PROJECT_VIDEO_META[vs] || PROJECT_VIDEO_META.empty;
  return { n: 2, of: 2, name: 'Video', done: vs === 'published', detail: meta.label, vkey: meta.key };
}

function projectStageHtml(s) {
  const st = projectStage(s);
  return `
    <div class="proj-stage" title="Stage ${st.n} of ${st.of}: ${st.name} — ${st.detail}">
      <span class="proj-step ${st.n >= 1 ? 'on' : ''} ${st.n > 1 ? 'past' : ''}">Script</span>
      <span class="proj-arrow">›</span>
      <span class="proj-step ${st.n >= 2 ? 'on' : ''} ${st.done ? 'past' : ''}">Video</span>
      ${st.n === 2 ? `<span class="proj-stage-detail">${escapeHtml(st.detail)}</span>` : ''}
    </div>`;
}

let allScripts = [];
let allProfiles = [];
let currentScriptId = null;
let currentScript = null;         // scripts row (+ embeds)
let scriptVersions = [];          // ascending by version
let scriptTab = 'script';         // which step tab the project modal shows
let scriptViewVersionId = null;   // version shown in player + feedback
let scriptDraftPreview = null;    // paragraphs rendered for the unsent draft (not a version)
let scriptSending = false;

// Player state — one <audio>, a queue of paragraph indices, signed URLs by path
const sp = { audio: null, paragraphs: [], queue: [], pos: -1, urls: {}, playing: false };

// Script feedback composer (text + voice note) — separate from the video composer
let scAudioBlob = null, scAudioDuration = 0, scRecorder = null, scStream = null, scChunks = [];
let scTimerInterval = null, scRecStart = 0;

// ── Roles ────────────────────────────────────────────────────
const isStaffUser    = () => currentProfile?.role === 'admin' || currentProfile?.is_reviewer === true;
const isReviewerUser = () => currentProfile?.is_reviewer === true;
// Ravi: creates projects, assigns people, links slots
const canManageScripts = () => currentProfile?.role === 'admin' && !currentProfile?.is_reviewer;
// Who may edit the text: the manager, or the assigned writer
const canWriteScript   = (s) => !!s && (canManageScripts() || s.writer_id === currentUser?.id);
const isScriptAssignee = (s) => !!s && (s.writer_id === currentUser?.id || s.editor_id === currentUser?.id);
const canCommentScript = (s) => isStaffUser() || isScriptAssignee(s);

function profileName(p) {
  const n = p?.full_name || '';
  return n.includes('@') ? n.split('@')[0] : (n || 'Unnamed');
}

// ── Data ─────────────────────────────────────────────────────
async function loadScripts() {
  // Everyone may call this — RLS returns staff everything, assignees their own.
  const { data, error } = await sb.from('scripts').select(SCRIPT_SELECT).order('updated_at', { ascending: false });
  if (error) { console.warn('[scripts] load failed:', error.message); return; }
  allScripts = data || [];

  // Sidebar entry + bell for anyone who has a project, not just staff
  const hasScripts = isStaffUser() || allScripts.length > 0;
  document.getElementById('sidebar-scripts')?.classList.toggle('hidden', !hasScripts);
  if (hasScripts) document.getElementById('notif-wrap')?.classList.remove('hidden');
  updateScriptsCount();
}

async function loadProfiles() {
  if (!canManageScripts()) return;
  const { data } = await sb.from('profiles').select('id, full_name, role, is_reviewer').order('full_name');
  allProfiles = data || [];
}

// "Waiting on you" per role
function scriptNeedsMe(s) {
  const me = currentUser?.id;
  if (isReviewerUser() && s.status === 'sent') return true;
  if (s.writer_id === me && (s.status === 'draft' || s.status === 'changes')) return true;
  if (canManageScripts() && !s.writer_id && (s.status === 'draft' || s.status === 'changes')) return true;
  if (s.editor_id === me && s.status === 'approved') return true;
  return false;
}

function updateScriptsCount() {
  const el = document.getElementById('count-scripts');
  if (!el) return;
  // Every other sidebar badge counts the things behind it, so this one does
  // too — it used to show only the "waiting on you" subset, which read as 0
  // whenever projects existed but none were yours to act on. The waiting
  // count survives as the amber highlight and the title.
  const waiting = allScripts.filter(scriptNeedsMe).length;
  el.textContent = allScripts.length;
  el.classList.toggle('needs-you', waiting > 0);
  el.title = waiting
    ? `${allScripts.length} project${allScripts.length !== 1 ? 's' : ''}, ${waiting} waiting on you`
    : `${allScripts.length} project${allScripts.length !== 1 ? 's' : ''}`;
}

function scriptForVideo(videoId) {
  return allScripts.find(s => s.video_id === videoId) || null;
}

// Tag shown on a video card for its linked script
function scriptTagHtml(s) {
  if (!s) return '';
  if (s.status === 'approved') return `<span class="card-tag script-ok">Script ✓ v${s.current_version}</span>`;
  return `<span class="card-tag script-wip">Script: ${SCRIPT_STATUS_META[s.status]?.label || s.status}</span>`;
}

function renderModalScriptLink(videoId) {
  const box = document.getElementById('modal-script-link');
  if (!box) return;
  const s = scriptForVideo(videoId);
  if (!s || !(isStaffUser() || isScriptAssignee(s))) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const approved = s.status === 'approved';
  box.classList.toggle('is-wip', !approved);
  box.innerHTML = `
    <span>${approved
      ? `<strong style="color:var(--teal)">Script approved</strong> — v${s.current_version} is the signed-off narration for this video.`
      : `<strong style="color:#f5a524">Script not approved yet</strong> — ${SCRIPT_STATUS_META[s.status]?.label || s.status}.`}</span>
    <button class="btn btn-ghost btn-sm" style="width:auto" onclick="closeVideoModal();openScript('${s.id}')">Open script</button>`;
  box.classList.remove('hidden');
}

// ── Projects page (a project = one video: script, then video) ─
async function showScriptsPage(sidebarEl) {
  currentPage = 'projects';
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  if (sidebarEl) sidebarEl.classList.add('active');

  parkVideoForm();
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="loading"><div class="spinner"></div> Loading projects…</div>';
  await loadScripts();
  if (currentPage !== 'projects') return;
  if (canManageScripts() && !allProfiles.length) await loadProfiles();
  if (currentPage !== 'projects') return;

  const count = (fn) => allScripts.filter(fn).length;
  const group = (s) => projGroup(s);
  const statsHtml = [
    ['Total projects',   allScripts.length,                                   ''],
    ['Needs attention',  count(s => group(s) === 'attention'),                'pj-amber'],
    ['In progress',      count(s => group(s) === 'progress'),                 'pj-blue'],
    ['Ready to publish', count(s => group(s) === 'ready'),                    'pj-green'],
    ['Published',        count(s => group(s) === 'done'),                     ''],
  ].map(([label, n, cls]) => `<div class="pj-stat"><div class="pj-stat-n">${n}</div><div class="pj-stat-l ${cls}">${label}</div></div>`).join('');

  const opt = (list, sel) => list.map(([v, l]) => `<option value="${escapeHtmlAttr(v)}" ${v === sel ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('');
  const f = projFilters;
  const peopleOf = (idKey, objKey) => [...new Map(allScripts.filter(s => s[idKey]).map(s => [s[idKey], profileName(s[objKey] || {})])).entries()];

  main.innerHTML = `
    <div class="page-header pj-header">
      <div>
        <div class="page-title">Video Projects</div>
        <div class="page-sub">create andpublish training videos.</div>
      </div>
      ${canManageScripts() ? `<button class="btn btn-primary btn-sm" style="width:auto;margin-top:0" onclick="openScriptNewModal()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New video project
      </button>` : ''}
    </div>
    <div class="pj-stats">${statsHtml}</div>
    <div class="pj-toolbar">
      <div class="pj-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="pj-q" placeholder="Search projects…" value="${escapeHtmlAttr(f.q)}" oninput="projSetFilter('q', this.value)">
      </div>
      <select class="pj-select" onchange="projSetFilter('cat', this.value)">
        <option value="">Category</option>${opt(allCategories.map(c => [c.id, c.name]), f.cat)}
      </select>
      <select class="pj-select" onchange="projSetFilter('stage', this.value)">
        <option value="">Stage</option>${opt(Object.entries(PROJ_STAGES).map(([k, v]) => [k, k === 'review' ? 'Review (script)' : k === 'vreview' ? 'Review (video)' : v.label]), f.stage)}
      </select>
      <select class="pj-select" onchange="projSetFilter('writer', this.value)">
        <option value="">Writer</option>${opt(peopleOf('writer_id', 'writer'), f.writer)}
      </select>
      <select class="pj-select" onchange="projSetFilter('editor', this.value)">
        <option value="">Editor</option>${opt(peopleOf('editor_id', 'editor'), f.editor)}
      </select>
      <div class="pj-viewtoggle">
        <button class="${projView === 'list' ? 'active' : ''}" onclick="projSetView('list')">☰ List</button>
        <button class="${projView === 'board' ? 'active' : ''}" onclick="projSetView('board')">▦ Board</button>
      </div>
    </div>
    <div id="pj-body"></div>`;
  renderProjectsBody();
}

// ── Video Projects view (list / board) ───────────────────────
// Stages derived from the script status + the linked video slot's status.
const PROJ_STAGES = {
  script:    { label: 'Script',    step: 1, cls: 'st-amber'  },
  review:    { label: 'Review',    step: 2, cls: 'st-blue'   },
  video:     { label: 'Video',     step: 3, cls: 'st-purple' },
  vreview:   { label: 'Review',    step: 4, cls: 'st-blue'   },
  completed: { label: 'Completed', step: 5, cls: 'st-green'  },
  published: { label: 'Published', step: 6, cls: 'st-teal'   },
};
const PROJ_STEPS = 6;
const PROJ_GROUPS = [
  { key: 'attention', label: 'Needs your attention', dot: '#f5a524' },
  { key: 'progress',  label: 'In progress',          dot: '#3b82f6' },
  { key: 'ready',     label: 'Ready to publish',     dot: '#22c55e' },
  { key: 'done',      label: 'Published',            dot: 'var(--muted)' },
];
const PROJ_GROUP_LIMIT = 5;
let projFilters  = { q: '', cat: '', stage: '', writer: '', editor: '' };
let projView     = 'list';
let projExpanded = new Set();

function projStage(s) {
  if (s.status === 'draft' || s.status === 'changes' || !s.status) return 'script';
  if (s.status === 'sent') return 'review';
  const vs = s.videos?.status || 'empty';
  if (vs === 'to_review') return 'vreview';
  if (vs === 'completed') return 'completed';
  if (vs === 'published') return 'published';
  return 'video'; // empty / raw / to_edit — the video is being made or fixed
}

function projGroup(s) {
  const st = projStage(s);
  if (st === 'published') return 'done';
  if (scriptNeedsMe(s)) return 'attention';
  if (st === 'completed') return 'ready';
  return 'progress';
}


// Who the project is sitting with right now, by stage:
// script → writer, video → editor, either review → client (reviewer),
// completed / published → admin.
function projCurrentPerson(s) {
  const byRole = (fn, fallback) => { const p = allProfiles.find(fn); return p ? profileName(p) : fallback; };
  switch (projStage(s)) {
    case 'script':  return s.writer ? profileName(s.writer) : 'Writer';
    case 'video':   return s.editor ? profileName(s.editor) : 'Editor';
    case 'review':
    case 'vreview': return byRole(p => p.is_reviewer, 'Client');
    default:        return byRole(p => p.role === 'admin' && !p.is_reviewer, 'Admin');
  }
}

function projAvatar(name) {
  if (!name || name === '—') return '<span class="pj-muted">—</span>';
  const palette = ['#f97316', '#3b82f6', '#a855f7', '#22c55e', '#ec4899', '#eab308', '#14b8a6'];
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="pj-person"><span class="pj-avatar" style="background:${palette[h % palette.length]}">${escapeHtml(name[0].toUpperCase())}</span>${escapeHtml(name)}</span>`;
}

function projSetFilter(key, val) { projFilters[key] = val; renderProjectsBody(); }
function projSetView(v) { projView = v; showScriptsPage(document.getElementById('sidebar-scripts-item')); }
function projToggleGroup(key) { projExpanded.has(key) ? projExpanded.delete(key) : projExpanded.add(key); renderProjectsBody(); }

function projFiltered() {
  const f = projFilters, q = f.q.trim().toLowerCase();
  return allScripts.filter(s =>
    (!q || [s.title, s.videos?.title, s.categories?.name, s.subcategories?.name].some(x => (x || '').toLowerCase().includes(q))) &&
    (!f.cat || s.category_id === f.cat) &&
    (!f.stage || projStage(s) === f.stage) &&
    (!f.writer || s.writer_id === f.writer) &&
    (!f.editor || s.editor_id === f.editor));
}

function renderProjectsBody() {
  const body = document.getElementById('pj-body');
  if (!body) return;
  const list = projFiltered();

  if (!allScripts.length || !list.length) {
    body.innerHTML = `<div class="pj-empty">${!allScripts.length
      ? (canManageScripts() ? 'No projects yet. Click <strong>New video project</strong> to start the first one.' : 'Nothing has been assigned to you yet.')
      : 'No projects match these filters.'}</div>`;
    return;
  }

  if (projView === 'board') {
    body.innerHTML = `<div class="pj-board">${Object.entries(PROJ_STAGES).map(([k, st]) => {
      const items = list.filter(s => projStage(s) === k);
      return `<div class="pj-col">
        <div class="pj-col-head"><span class="pj-stage ${st.cls}">${st.label}</span><span class="pj-muted">${items.length}</span></div>
        ${items.map(s => `<div class="pj-card" onclick="openScript('${s.id}')">
          <div class="pj-title">${escapeHtml(s.title)}</div>
          <div class="pj-sub">${escapeHtml([s.categories?.name, s.subcategories?.name].filter(Boolean).join(' › '))}</div>
          <div class="pj-card-foot">${projAvatar(projCurrentPerson(s))}<span class="pj-muted">${timeAgo(s.updated_at || s.created_at)}</span></div>
        </div>`).join('') || '<div class="pj-muted" style="padding:8px">—</div>'}
      </div>`;
    }).join('')}</div>`;
    return;
  }

  body.innerHTML = PROJ_GROUPS.map(g => {
    const items = list.filter(s => projGroup(s) === g.key);
    if (!items.length) return '';
    const expanded = projExpanded.has(g.key);
    const shown = expanded ? items : items.slice(0, PROJ_GROUP_LIMIT);
    const more = items.length - shown.length;
    return `
      <div class="pj-group">
        <div class="pj-group-head">
          <span class="pj-group-dot" style="background:${g.dot}"></span>
          <span class="pj-group-label">${g.label} (${items.length})</span>
          ${items.length > PROJ_GROUP_LIMIT ? `<a class="pj-link" onclick="projToggleGroup('${g.key}')">${expanded ? 'Show less' : 'View all'}</a>` : ''}
        </div>
        <div class="pj-table-wrap"><table class="pj-table">
          <thead><tr><th>Project</th><th>Category</th><th>Stage</th><th>Progress</th><th>Writer</th><th>Editor</th><th>Updated</th></tr></thead>
          <tbody>${shown.map(projRow).join('')}</tbody>
        </table></div>
        ${more > 0 ? `<a class="pj-link pj-more" onclick="projToggleGroup('${g.key}')">Show ${more} more project${more !== 1 ? 's' : ''}</a>` : ''}
      </div>`;
  }).join('');
  projStartMarquees(body);
}

// Names wider than the fixed column slide back and forth instead of wrapping.
function projStartMarquees(root) {
  root.querySelectorAll('.pj-marquee').forEach(box => {
    const inner = box.firstElementChild;
    const overflow = inner.scrollWidth - box.clientWidth;
    box.classList.toggle('sliding', overflow > 0);
    if (overflow > 0) {
      inner.style.setProperty('--pj-shift', `-${overflow + 8}px`);
      inner.style.animationDuration = `${Math.max(4, overflow / 20 + 3)}s`;
    }
  });
}

function projRow(s) {
  const stKey = projStage(s), st = PROJ_STAGES[stKey];
  const dotColor = { 'st-amber': '#f5a524', 'st-blue': '#3b82f6', 'st-purple': '#a855f7', 'st-green': '#22c55e', 'st-teal': 'var(--teal)' }[st.cls];
  const dots = Array.from({ length: PROJ_STEPS }, (_, k) => k + 1).map(i => `<span class="pj-dot" style="${i <= st.step ? `background:${dotColor}` : ''}"></span>`).join('');
  const thumb = s.videos?.thumbnail_url
    ? `<img src="${escapeHtmlAttr(s.videos.thumbnail_url)}" alt="" loading="lazy">`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3"/></svg>`;
  return `
    <tr class="${scriptNeedsMe(s) ? 'needs-me' : ''}" onclick="openScript('${s.id}')">
      <td><div class="pj-proj"><div class="pj-thumb">${thumb}</div><div>
        <div class="pj-marquee"><span class="pj-title">${escapeHtml(s.title)}</span></div>
        <div class="pj-marquee"><span class="pj-sub">${escapeHtml([s.categories?.name, s.subcategories?.name].filter(Boolean).join(' › ') || '—')}</span></div>
      </div></div></td>
      <td>${s.categories?.name ? `<span class="pj-chip">${escapeHtml(s.categories.name)}</span>` : '<span class="pj-muted">—</span>'}</td>
      <td><span class="pj-stage ${st.cls}">${st.label}</span></td>
      <td><div class="pj-dots">${dots}</div></td>
      <td>${projAvatar(s.writer ? profileName(s.writer) : '—')}</td>
      <td>${projAvatar(s.editor ? profileName(s.editor) : '—')}</td>
      <td class="pj-muted">${timeAgo(s.updated_at || s.created_at)}</td>
    </tr>`;
}

// ── New project (starts with its script) ─────────────────────
function peopleOptions(selectedId, { allowNone, noneLabel } = {}) {
  let html = allowNone ? `<option value="">${noneLabel || 'Assign later'}</option>` : '';
  allProfiles.forEach(p => {
    const you = p.id === currentUser?.id ? ' (you)' : '';
    const tag = p.is_reviewer ? ' · reviewer' : p.role === 'admin' ? ' · admin' : '';
    html += `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(profileName(p))}${you}${tag}</option>`;
  });
  return html;
}

async function openScriptNewModal() {
  if (!allProfiles.length) await loadProfiles();
  const catSel = document.getElementById('sc-new-category');
  catSel.innerHTML = '<option value="">Select category…</option>' +
    allCategories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  document.getElementById('sc-new-subcat').innerHTML = '<option value="">Select sub-category…</option>';
  document.getElementById('sc-new-video').innerHTML  = '<option value="">Pick a sub-category first…</option>';
  document.getElementById('sc-new-title').value = '';
  document.getElementById('sc-new-title').dataset.auto = '';
  document.getElementById('sc-new-writer').innerHTML = peopleOptions(currentUser.id);
  document.getElementById('sc-new-editor').innerHTML = peopleOptions(null, { allowNone: true });
  document.getElementById('script-new-modal').classList.add('open');
}

function scNewCategoryChanged(catId) {
  const sub = document.getElementById('sc-new-subcat');
  sub.innerHTML = '<option value="">Select sub-category…</option>' +
    allSubcats.filter(s => s.category_id === catId).map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  scNewSubcatChanged('');
}

// Slots in this sub-category that don't have a script yet. Empty slots first —
// that's what scripts are for; slots already in production come last and
// published videos are excluded (their script stage is long gone).
function scNewSubcatChanged(subId) {
  const sel = document.getElementById('sc-new-video');
  if (!subId) { sel.innerHTML = '<option value="">Pick a sub-category first…</option>'; scNewVideoChanged(''); return; }
  const taken = new Set(allScripts.map(s => s.video_id).filter(Boolean));
  const rank = v => (v.status === 'empty' ? 0 : v.status === 'raw' ? 1 : 2);
  const slots = allVideos
    .filter(v => v.subcategory_id === subId && !taken.has(v.id) && v.status !== 'published')
    .sort((a, b) => rank(a) - rank(b) || (a.sort_order || 0) - (b.sort_order || 0) || a.title.localeCompare(b.title));
  sel.innerHTML = slots.length
    ? '<option value="">Select a slot…</option>' + slots.map(v =>
        `<option value="${v.id}">${escapeHtml(v.title)}${v.status !== 'empty' ? ` · ${v.status.replace('_', ' ')}` : ''}</option>`).join('')
    : '<option value="">No free slots in this sub-category</option>';
  scNewVideoChanged('');
}

// Title follows the slot until the user types their own
function scNewVideoChanged(videoId) {
  const title = document.getElementById('sc-new-title');
  const v = allVideos.find(x => x.id === videoId);
  if (!title.value || title.value === title.dataset.auto) {
    title.value = v?.title || '';
    title.dataset.auto = v?.title || '';
  }
}

function closeScriptNewModal(e) {
  if (e && e.target !== document.getElementById('script-new-modal')) return;
  document.getElementById('script-new-modal').classList.remove('open');
}

async function createScript() {
  if (!canManageScripts()) return;
  const categoryId    = document.getElementById('sc-new-category').value || null;
  const subcategoryId = document.getElementById('sc-new-subcat').value || null;
  const videoId       = document.getElementById('sc-new-video').value || null;
  const title         = document.getElementById('sc-new-title').value.trim();
  const writerId      = document.getElementById('sc-new-writer').value || null;
  const editorId      = document.getElementById('sc-new-editor').value || null;
  if (!title) { showToast('Give the script a title', 'error'); return; }
  if (!writerId) { showToast('Pick a content writer', 'error'); return; }

  const btn = document.getElementById('sc-new-create-btn');
  btn.disabled = true; btn.textContent = 'Creating…';
  await ensureFreshSession();
  const { data, error } = await sb.from('scripts')
    .insert({
      title, video_id: videoId, category_id: categoryId, subcategory_id: subcategoryId,
      writer_id: writerId, editor_id: editorId, created_by: currentUser.id, status: 'draft',
    })
    .select('id').single();
  btn.disabled = false; btn.textContent = 'Create project';
  if (error) { showToast('Could not create: ' + error.message, 'error'); return; }

  closeScriptNewModal();
  showToast('Project started', 'success');
  notifyAssigned(data.id, title, 'writer', writerId);
  if (editorId) notifyAssigned(data.id, title, 'editor', editorId);

  await loadScripts();
  renderVideos();
  if (document.getElementById('sidebar-scripts-item')?.classList.contains('active')) {
    showScriptsPage(document.getElementById('sidebar-scripts-item'));
  }
  openScript(data.id);
}

function notifyAssigned(scriptId, scriptTitle, role, assigneeId) {
  if (!assigneeId || assigneeId === currentUser?.id) return;
  invokeEdge(NOTIFY_FUNCTION, {
    body: { type: 'script_assigned', scriptId, scriptTitle, assigneeId, assigneeRole: role },
  }).catch(err => console.warn('[notify script_assigned]', err));
}

// Re-assign from inside the script modal (manager only)
async function assignScript(role, userId) {
  if (!canManageScripts() || !currentScriptId) return;
  const col = role === 'editor' ? 'editor_id' : 'writer_id';
  if (role === 'writer' && !userId) { showToast('A script needs a writer', 'error'); renderScriptModal(); return; }
  await ensureFreshSession();
  const { error } = await sb.from('scripts').update({ [col]: userId || null }).eq('id', currentScriptId);
  if (error) { showToast('Could not assign: ' + error.message, 'error'); renderScriptModal(); return; }
  currentScript[col] = userId || null;
  const p = allProfiles.find(x => x.id === userId);
  currentScript[role] = p ? { full_name: p.full_name } : null;
  showToast(p ? `${profileName(p)} assigned as ${role}` : `${role} cleared`, 'success');
  notifyAssigned(currentScriptId, currentScript.title, role, userId);
  renderScriptModal();
  loadScripts();
}

// ── Script modal ─────────────────────────────────────────────
async function openScript(id, versionId = null) {
  stopScriptPlayer();
  if (id !== currentScriptId) scriptTab = 'script';
  if (canManageScripts() && !allProfiles.length) await loadProfiles();
  const [{ data: s, error }, { data: vers }] = await Promise.all([
    sb.from('scripts').select(SCRIPT_SELECT).eq('id', id).single(),
    sb.from('script_versions').select('*').eq('script_id', id).order('version'),
  ]);
  if (error || !s) { showToast('Could not open script', 'error'); return; }

  currentScript = s;
  currentScriptId = id;
  scriptVersions = vers || [];
  scriptViewVersionId = versionId || scriptVersions.at(-1)?.id || null;
  scriptDraftPreview = null;
  resetScriptComposer();

  renderScriptModal();
  document.getElementById('script-modal').classList.add('open');
  document.getElementById('script-modal').scrollTop = 0;
  loadScriptFeedback();
}

function closeScriptModal(e) {
  if (e && e.target !== document.getElementById('script-modal')) return;
  stopScriptPlayer();
  resetScriptComposer();
  document.getElementById('script-modal').classList.remove('open');
  currentScriptId = null; currentScript = null;
  projectAssets = []; projectAssetUrls = {}; projVideoToken++;
  scriptTab = 'script';
  scriptVersions = []; scriptViewVersionId = null; scriptDraftPreview = null;
}

function setScriptTab(tab) {
  if (tab === scriptTab) return;
  scriptTab = tab;
  stopScriptPlayer();
  // Back on the script tab, the player should follow the version being viewed again
  if (tab === 'script') scriptPlayerLoad(scriptDraftPreview || viewedVersion()?.paragraphs || []);
  document.getElementById('sc-pane-script')?.toggleAttribute('hidden', tab === 'video');
  document.getElementById('sc-pane-video')?.toggleAttribute('hidden', tab !== 'video');
  document.querySelectorAll('.sc-step').forEach((b, i) => b.classList.toggle('active', (i === 1) === (tab === 'video')));
  if (tab === 'video') { loadProjectVideo(); loadProjectAssets(); }
}

function viewedVersion() {
  return scriptVersions.find(v => v.id === scriptViewVersionId) || null;
}

function selectScriptVersion(versionId) {
  stopScriptPlayer();
  scriptViewVersionId = versionId;
  scriptDraftPreview = null;
  renderScriptModal();
  loadScriptFeedback();
}

function renderScriptModal() {
  const s = currentScript;
  const body = document.getElementById('script-modal-body');
  if (!s || !body) return;

  const meta     = SCRIPT_STATUS_META[s.status] || SCRIPT_STATUS_META.draft;
  const latest   = scriptVersions.at(-1) || null;
  const view     = viewedVersion();
  const isLatest = view && latest && view.id === latest.id;
  const manager  = canManageScripts();
  const writer   = canWriteScript(s);
  const reviewer = isReviewerUser();
  const where    = [s.categories?.name, s.subcategories?.name].filter(Boolean).join(' › ');

  // ── Header ──
  let html = `
    <div class="card-tags" style="margin-bottom:0">
      <span class="card-tag sc-status-${s.status}">${meta.label}</span>
      ${latest ? `<span class="card-tag sc-version">v${latest.version}${s.status === 'approved' ? ' · locked' : ''}</span>` : '<span class="card-tag sc-version">not sent yet</span>'}
    </div>
    <div class="sc-title">${escapeHtml(s.title)}${manager ? ` <a class="sc-link" style="font-size:12px;font-weight:400" onclick="renameScript()">rename</a>` : ''}</div>
    <div class="sc-sub">
      ${where ? `${escapeHtml(where)} · ` : ''}
      ${s.videos?.title
        ? `Slot: <strong style="color:var(--white);font-weight:500">${escapeHtml(s.videos.title)}</strong>`
        : 'No slot linked'}
      ${manager ? ` · <a onclick="linkScriptVideo()">${s.video_id ? 'change slot' : 'link a slot'}</a>` : ''}
      ${latest ? ` · sent ${timeAgo(latest.created_at)}` : ''}
    </div>`;

  // ── Project team ──
  const person = (p) => p ? escapeHtml(profileName(p)) : '<span style="color:var(--muted)">—</span>';
  html += `
    <div class="sc-team">
      <div class="sc-team-role">
        <span class="sc-team-label">Content writer</span>
        ${manager
          ? `<select class="form-select sc-team-select" onchange="assignScript('writer', this.value)">${peopleOptions(s.writer_id)}</select>`
          : `<span class="sc-team-name">${person(s.writer)}${s.writer_id === currentUser?.id ? ' (you)' : ''}</span>`}
      </div>
      <div class="sc-team-role">
        <span class="sc-team-label">Editor</span>
        ${manager
          ? `<select class="form-select sc-team-select" onchange="assignScript('editor', this.value)">${peopleOptions(s.editor_id, { allowNone: true })}</select>`
          : `<span class="sc-team-name">${person(s.editor)}${s.editor_id === currentUser?.id ? ' (you)' : ''}</span>`}
      </div>
    </div>`;

  // ── Step tabs: 1 Script (narration + approval), 2 Video (the produced video + assets) ──
  html += `
    <div class="sc-steps">
      <button class="sc-step ${scriptTab === 'script' ? 'active' : ''}" onclick="setScriptTab('script')"><span class="sc-step-n">1</span>Script</button>
      <button class="sc-step ${scriptTab === 'video' ? 'active' : ''}" onclick="setScriptTab('video')"><span class="sc-step-n">2</span>Video</button>
    </div>
    <div id="sc-pane-script" ${scriptTab === 'video' ? 'hidden' : ''}>`;

  // ── Version tabs (only once there's more than one round) ──
  if (scriptVersions.length > 1) {
    const dotColor = (v) => v.decision === 'approved' ? 'var(--teal)' : v.decision === 'changes' ? '#60a5fa' : '#f5a524';
    html += `<div class="sc-version-tabs">` + scriptVersions.map(v => `
      <button class="sc-vtab ${v.id === scriptViewVersionId ? 'active' : ''}" onclick="selectScriptVersion('${v.id}')" title="${v.decision}">
        v${v.version}<span class="dot" style="background:${dotColor(v)}"></span>
      </button>`).join('') + `</div>`;
  }

  // ── Player: the viewed version, or the writer's unsent draft preview ──
  const showingDraft = !!scriptDraftPreview;
  const paragraphs = showingDraft ? scriptDraftPreview : (view?.paragraphs || []);
  if (paragraphs.length) {
    const changed = showingDraft ? 0 : (view?.changed_count || 0);
    const label = showingDraft ? 'Draft preview' : `Version ${view.version}`;
    const note = showingDraft
      ? 'Not sent yet — this is what Joe will hear.'
      : (view.version > 1
          ? (changed ? `${changed} of ${view.total_count} paragraph${view.total_count !== 1 ? 's' : ''} changed since v${view.version - 1}` : `No text changes since v${view.version - 1}`)
          : `${view.total_count} paragraph${view.total_count !== 1 ? 's' : ''}`);
    html += renderScriptPlayerHtml(paragraphs, { label, note, changed });
  } else if (!latest && !writer) {
    html += `<div class="sc-locked" style="background:rgba(255,255,255,0.03);border-color:rgba(255,255,255,0.1)"><div class="sc-locked-text">Nothing to listen to yet — the writer hasn't sent a version.</div></div>`;
  }

  // ── Reviewer decision (Joe) — only on the latest version while it's with him ──
  if (reviewer && s.status === 'sent' && isLatest) {
    html += `
      <div class="workflow-section" id="sc-reviewer-section">
        <div class="workflow-section-label">Your decision on v${latest.version}</div>
        <div class="reviewer-buttons">
          <button class="btn-more-changes" id="sc-changes-btn" onclick="scriptDecision('changes')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Needs changes
          </button>
          <button class="btn-reviewer" id="sc-approve-btn" onclick="scriptDecision('approved')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Approve script
          </button>
        </div>
        <div class="reviewer-status">Listen, leave voice notes below on anything to change, then decide. Approving locks the text.</div>
      </div>`;
  }

  // ── Approved: locked text, visible to everyone on the project ──
  if (s.status === 'approved') {
    html += `
      <div class="sc-locked">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <div class="sc-locked-text"><strong>Approved by Joe</strong> ${s.approved_at ? timeAgo(s.approved_at) : ''} — v${latest?.version} is locked. ${s.editor_id === currentUser?.id ? 'Record the final narration from this text and produce the video.' : 'The editor produces the video from this text.'} Any further change is a new version that needs approval again.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" style="width:auto;margin-top:0" onclick="copyApprovedScript(this)">Copy text</button>
          ${writer ? `<button class="btn btn-ghost btn-sm" style="width:auto;margin-top:0" onclick="startScriptRevision()">Start a revision</button>` : ''}
        </div>
      </div>`;
  }

  // ── Writer's editor ──
  if (writer && s.status !== 'approved') {
    const draftText = s.draft_body ?? latest?.body ?? '';
    const ctx =
      s.status === 'changes' ? `Joe asked for changes on v${latest?.version}. His notes are below — edit and send v${(latest?.version || 0) + 1}.` :
      s.status === 'sent'    ? `v${latest?.version} is with Joe. You can keep editing; sending again replaces it with v${latest.version + 1}.` :
      latest                 ? `Editing a new draft after v${latest.version}.` :
                               'Write the narration. Blank line between paragraphs; start a line with # for a section heading (it\'s read aloud as "Section: …").';
    html += `
      <div class="sc-editor">
        <div class="workflow-section-label">Script text</div>
        <textarea class="form-input" id="sc-body" placeholder="# Intro&#10;&#10;Hi, I'm Joe, master plumber at Loch Monster Plumbing…&#10;&#10;# Step one&#10;&#10;First thing you do on site is…" oninput="scriptDraftDirty()">${escapeHtmlAttr(draftText)}</textarea>
        <div class="sc-editor-hint">${ctx}<br>Only paragraphs whose text changed get re-rendered — an edit to a few lines costs a few cents.</div>
        <div class="sc-btn-row">
          <button class="btn btn-ghost btn-sm" id="sc-save-btn" onclick="saveScriptDraft()">Save draft</button>
          <button class="btn btn-ghost btn-sm" id="sc-preview-btn" onclick="previewScriptDraft()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Preview audio
          </button>
          <button class="btn btn-primary btn-sm" id="sc-send-btn" onclick="sendScriptToJoe()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            Send to Joe${latest ? ` as v${latest.version + 1}` : ''}
          </button>
        </div>
        <div class="sc-editor-status" id="sc-editor-status"></div>
      </div>`;
  }

  // ── Feedback ──
  const canComment = canCommentScript(s);
  html += `
    <div class="feedback-section" style="display:block">
      <div class="feedback-header"><h3>Feedback on ${view ? `v${view.version}` : 'this script'}</h3></div>
      ${canComment ? `
      <div class="comment-composer">
        <textarea id="sc-comment-text" class="comment-input" rows="2" placeholder="${reviewer ? 'Say what to change — a voice note is fastest' : 'Reply or leave a note…'}"></textarea>
        <div class="comment-attachments hidden" id="sc-comment-attachments">
          <div class="comment-attach comment-audio-preview" id="sc-comment-audio-preview">
            <audio controls id="sc-comment-audio-player"></audio>
            <button class="attach-remove" onclick="clearScriptComposerAudio()" title="Remove audio">✕</button>
          </div>
        </div>
        <div class="comment-toolbar">
          <div class="comment-tools">
            <button class="comment-tool-btn" id="sc-mic-btn" onclick="toggleScriptRecording()" title="Record voice note">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
            </button>
            <span class="record-timer hidden" id="sc-record-timer">0:00</span>
          </div>
          <button class="btn btn-primary btn-sm" id="sc-comment-send-btn" onclick="submitScriptComment()" style="width:auto;margin-top:0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            Send
          </button>
        </div>
      </div>` : ''}
      <div class="feedback-list" id="sc-feedback-list"><div class="feedback-empty">Loading…</div></div>
    </div>`;

  // Close the script pane; the video pane holds the produced video and its assets
  html += `</div><div id="sc-pane-video" ${scriptTab === 'video' ? '' : 'hidden'}>${renderProjectHubHtml(s)}</div>`;

  body.innerHTML = html;

  // Wire the player to whatever is showing
  if (scriptTab === 'video') { loadProjectVideo(); loadProjectAssets(); }
  if (paragraphs.length) scriptPlayerLoad(paragraphs);
}

// Textarea content must be escaped but keep newlines as-is (escapeHtml turns them into <br>)
function escapeHtmlAttr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function scriptDraftDirty() {
  // A fresh draft preview no longer matches the text — hide it so nobody is misled
  if (scriptDraftPreview) {
    scriptDraftPreview = null;
    setScriptEditorStatus('Text changed since the last preview.', '');
  }
}

async function renameScript() {
  const t = prompt('Script title', currentScript?.title || '');
  if (t == null || !t.trim() || t.trim() === currentScript.title) return;
  const { error } = await sb.from('scripts').update({ title: t.trim() }).eq('id', currentScriptId);
  if (error) { showToast('Rename failed: ' + error.message, 'error'); return; }
  currentScript.title = t.trim();
  renderScriptModal(); loadScripts();
}

async function linkScriptVideo() {
  const taken = new Set(allScripts.filter(s => s.id !== currentScriptId).map(s => s.video_id).filter(Boolean));
  // Prefer slots in the script's own sub-category, then everything else
  const sub = currentScript?.subcategory_id;
  const choices = allVideos
    .filter(v => !taken.has(v.id) && v.status !== 'published')
    .sort((a, b) => ((b.subcategory_id === sub) - (a.subcategory_id === sub)) || a.title.localeCompare(b.title));
  if (!choices.length) { showToast('No unlinked video slots', 'error'); return; }
  const list = choices.map((v, i) => `${i + 1}. ${v.title}${v.status !== 'empty' ? ` (${v.status})` : ''}`).join('\n');
  const ans = prompt(`Link to which video slot? Enter a number (0 to unlink):\n\n${list}`);
  if (ans == null) return;
  const n = parseInt(ans, 10);
  if (Number.isNaN(n) || n < 0 || n > choices.length) return;
  const v = n === 0 ? null : choices[n - 1];
  const patch = { video_id: v?.id || null };
  if (v) { patch.category_id = v.category_id || null; patch.subcategory_id = v.subcategory_id || null; }
  const { error } = await sb.from('scripts').update(patch).eq('id', currentScriptId);
  if (error) { showToast('Could not link: ' + error.message, 'error'); return; }
  Object.assign(currentScript, patch, { videos: v ? { title: v.title, status: v.status } : null });
  if (v) {
    currentScript.categories    = allCategories.find(c => c.id === v.category_id) || null;
    currentScript.subcategories = allSubcats.find(x => x.id === v.subcategory_id) || null;
  }
  renderScriptModal(); loadScripts().then(renderVideos);
}

// ── Player ───────────────────────────────────────────────────
function renderScriptPlayerHtml(paragraphs, { label, note, changed }) {
  const changedIdx = paragraphs.map((p, i) => p.changed ? i : -1).filter(i => i >= 0);
  const rows = paragraphs.map((p, i) => `
    <div class="sp-para ${p.heading ? 'heading' : ''} ${p.changed ? 'changed' : ''} ${p.audio_path ? '' : 'no-audio'}" id="sp-para-${i}" onclick="spPlayFrom(${i})">
      <span class="sp-para-num">${p.heading ? '§' : i + 1}</span>
      <span>${escapeHtml(p.text)}</span>
      ${p.changed ? '<span class="sp-chip changed">Changed</span>' : '<span></span>'}
    </div>`).join('');

  return `
    <div class="sp-wrap">
      <div class="sp-head">
        <span class="sp-head-label">${label} · preview voice</span>
        <span class="sp-head-note">${note}</span>
      </div>
      <div class="sp-controls">
        <button class="sp-btn primary" id="sp-play-all" onclick="spPlayAll()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Play all
        </button>
        ${changedIdx.length ? `<button class="sp-btn changes" id="sp-play-changes" onclick="spPlayChanges()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Play changes only (${changedIdx.length})
        </button>` : ''}
        <button class="sp-btn" id="sp-pause" onclick="spTogglePause()" disabled>Pause</button>
        <button class="sp-btn" id="sp-stop" onclick="stopScriptPlayer()" disabled>Stop</button>
        <span class="sp-now" id="sp-now">Tap a paragraph to start there</span>
      </div>
      <div class="sp-list" id="sp-list">${rows}</div>
    </div>`;
}

async function scriptPlayerLoad(paragraphs) {
  sp.paragraphs = paragraphs;
  sp.urls = {};
  const paths = [...new Set(paragraphs.map(p => p.audio_path).filter(Boolean))];
  if (!paths.length) return;
  const { data, error } = await sb.storage.from(SCRIPT_AUDIO_BUCKET).createSignedUrls(paths, 60 * 60);
  if (error) { console.warn('[script player] sign failed:', error.message); return; }
  (data || []).forEach(d => { if (d.signedUrl) sp.urls[d.path] = d.signedUrl; });
}

function spEnsureAudio() {
  if (sp.audio) return sp.audio;
  const a = new Audio();
  a.preload = 'auto';
  a.addEventListener('ended', () => spNext());
  a.addEventListener('error', () => { console.warn('[script player] clip error'); spNext(); });
  sp.audio = a;
  return a;
}

function spPlayAll() {
  spPlayQueue(sp.paragraphs.map((_, i) => i));
}

// Changed paragraphs plus the one before each, so Joe hears them in context
function spPlayChanges() {
  const q = new Set();
  sp.paragraphs.forEach((p, i) => { if (p.changed) { if (i > 0) q.add(i - 1); q.add(i); } });
  spPlayQueue([...q].sort((a, b) => a - b));
}

function spPlayFrom(i) {
  if (!sp.paragraphs[i]?.audio_path) return;
  spPlayQueue(sp.paragraphs.map((_, k) => k).filter(k => k >= i));
}

function spPlayQueue(indices) {
  sp.queue = indices.filter(i => sp.paragraphs[i]?.audio_path);
  sp.pos = -1;
  spNext();
}

function spNext() {
  sp.pos += 1;
  if (sp.pos >= sp.queue.length) { stopScriptPlayer(true); return; }
  const i = sp.queue[sp.pos];
  const p = sp.paragraphs[i];
  const url = sp.urls[p.audio_path];
  if (!url) { spNext(); return; }

  const a = spEnsureAudio();
  a.src = url;
  a.play().catch(err => { console.warn('[script player] play blocked:', err); });
  sp.playing = true;
  spHighlight(i);

  // Warm the next clip so paragraph boundaries don't stall on mobile
  const nextI = sp.queue[sp.pos + 1];
  const nextUrl = nextI != null ? sp.urls[sp.paragraphs[nextI]?.audio_path] : null;
  if (nextUrl) { const pre = new Audio(); pre.preload = 'auto'; pre.src = nextUrl; }

  spRenderControls();
}

function spHighlight(i) {
  document.querySelectorAll('.sp-para.active').forEach(el => el.classList.remove('active'));
  const el = document.getElementById(`sp-para-${i}`);
  if (!el) return;
  el.classList.add('active');
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function spTogglePause() {
  const a = sp.audio;
  if (!a || !sp.queue.length) return;
  if (a.paused) { a.play().catch(() => {}); sp.playing = true; }
  else { a.pause(); sp.playing = false; }
  spRenderControls();
}

function spRenderControls() {
  const pause = document.getElementById('sp-pause');
  const stop  = document.getElementById('sp-stop');
  const now   = document.getElementById('sp-now');
  const active = sp.queue.length > 0 && sp.pos >= 0 && sp.pos < sp.queue.length;
  if (pause) { pause.disabled = !active; pause.textContent = sp.playing ? 'Pause' : 'Resume'; }
  if (stop)  stop.disabled = !active;
  if (now) {
    now.textContent = active
      ? `Playing ${sp.pos + 1} of ${sp.queue.length}${sp.queue.length !== sp.paragraphs.length ? ' (selection)' : ''}`
      : 'Tap a paragraph to start there';
  }
}

function stopScriptPlayer(finished = false) {
  if (sp.audio) { try { sp.audio.pause(); } catch (_) {} sp.audio.removeAttribute('src'); }
  sp.queue = []; sp.pos = -1; sp.playing = false;
  document.querySelectorAll('.sp-para.active').forEach(el => el.classList.remove('active'));
  spRenderControls();
  const now = document.getElementById('sp-now');
  if (now && finished) now.textContent = 'Finished';
}

// ── Rendering (writer): loop the edge function until every paragraph is cached ──
async function renderScriptAudio(text, onProgress) {
  let totalRendered = 0, totalChars = 0, rounds = 0, result;
  do {
    const { data, error } = await invokeEdge(SCRIPT_TTS_FUNCTION, { body: { text, scriptId: currentScriptId } });
    const detail = error ? await parseFunctionError(error) : (data?.error || null);
    if (detail) throw new Error(detail);
    result = data;
    totalRendered += result.rendered || 0;
    totalChars    += result.charsRendered || 0;
    if (result.warning) console.warn('[script-tts]', result.warning);
    onProgress?.({ done: result.paragraphs.length - result.pending, total: result.paragraphs.length, pending: result.pending });
    if (result.pending > 0 && result.rendered === 0) {
      throw new Error(result.warning || 'Rendering stalled — try again');
    }
    if (++rounds > 80) throw new Error('Rendering took too many rounds');
  } while (result.pending > 0);
  return { paragraphs: result.paragraphs, rendered: totalRendered, chars: totalChars, model: result.model, voice: result.voice };
}

function setScriptEditorStatus(text, cls = '') {
  const el = document.getElementById('sc-editor-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'sc-editor-status ' + cls;
}

function scriptEditorBusy(busy) {
  ['sc-save-btn', 'sc-preview-btn', 'sc-send-btn'].forEach(id => {
    const b = document.getElementById(id); if (b) b.disabled = busy;
  });
}

async function saveScriptDraft() {
  const text = document.getElementById('sc-body')?.value ?? '';
  scriptEditorBusy(true);
  await ensureFreshSession();
  const { error } = await sb.from('scripts').update({ draft_body: text || null }).eq('id', currentScriptId);
  scriptEditorBusy(false);
  if (error) { setScriptEditorStatus('Save failed: ' + error.message, 'err'); return; }
  currentScript.draft_body = text || null;
  setScriptEditorStatus('Draft saved.', 'ok');
  loadScripts();
}

async function previewScriptDraft() {
  const text = document.getElementById('sc-body')?.value.trim();
  if (!text) { setScriptEditorStatus('Write something first.', 'err'); return; }
  scriptEditorBusy(true);
  try {
    setScriptEditorStatus('Rendering preview…');
    const r = await renderScriptAudio(text, ({ done, total }) => setScriptEditorStatus(`Rendering preview… ${done}/${total} paragraphs`));
    // Mark what differs from the latest sent version so the preview shows Joe's view
    const prevHashes = new Set((scriptVersions.at(-1)?.paragraphs || []).map(p => p.hash));
    scriptDraftPreview = r.paragraphs.map(p => ({ ...p, changed: scriptVersions.length ? !prevHashes.has(p.hash) : false }));
    // Keep the unsaved text: renderScriptModal re-reads draft_body, so stash it first
    currentScript.draft_body = text;
    renderScriptModal();
    setScriptEditorStatus(r.rendered
      ? `Preview ready — rendered ${r.rendered} new paragraph${r.rendered !== 1 ? 's' : ''} (${r.chars.toLocaleString()} chars), rest from cache.`
      : 'Preview ready — everything was already cached, nothing rendered.', 'ok');
    document.getElementById('sp-list')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (err) {
    setScriptEditorStatus('Preview failed: ' + (err.message || err), 'err');
  } finally {
    scriptEditorBusy(false);
  }
}

async function sendScriptToJoe() {
  if (scriptSending) return;
  const text = document.getElementById('sc-body')?.value.trim();
  if (!text) { setScriptEditorStatus('Write something first.', 'err'); return; }

  const latest = scriptVersions.at(-1) || null;
  scriptSending = true;
  scriptEditorBusy(true);
  const sendBtn = document.getElementById('sc-send-btn');
  const sendHtml = sendBtn?.innerHTML;
  if (sendBtn) sendBtn.textContent = 'Rendering…';

  try {
    setScriptEditorStatus('Rendering audio…');
    const r = await renderScriptAudio(text, ({ done, total }) => setScriptEditorStatus(`Rendering audio… ${done}/${total} paragraphs`));

    // Diff against the previous version by paragraph hash
    const prevHashes = new Set((latest?.paragraphs || []).map(p => p.hash));
    const paragraphs = r.paragraphs.map(p => ({ ...p, changed: latest ? !prevHashes.has(p.hash) : false }));
    const changedCount = paragraphs.filter(p => p.changed).length;

    if (latest && changedCount === 0 && paragraphs.length === (latest.paragraphs || []).length) {
      if (!confirm(`Nothing changed since v${latest.version}. Send it to Joe again anyway?`)) {
        setScriptEditorStatus('Not sent.'); return;
      }
    }

    if (sendBtn) sendBtn.textContent = 'Sending…';
    await ensureFreshSession();
    const versionNo = (latest?.version || 0) + 1;
    const { data: ver, error: verErr } = await sb.from('script_versions').insert({
      script_id: currentScriptId,
      version: versionNo,
      body: text,
      paragraphs,
      changed_count: changedCount,
      total_count: paragraphs.length,
      created_by: currentUser.id,
    }).select('id').single();
    if (verErr) throw verErr;

    const { error: scErr } = await sb.from('scripts').update({
      status: 'sent',
      current_version: versionNo,
      draft_body: null,
    }).eq('id', currentScriptId);
    if (scErr) throw scErr;

    const title = currentScript.title;
    showToast(`v${versionNo} sent — Joe has been notified`, 'success');
    invokeEdge(NOTIFY_FUNCTION, {
      body: { type: 'script_sent', scriptId: currentScriptId, scriptTitle: title, versionNo },
    }).catch(err => console.warn('[notify script_sent]', err));

    await loadScripts();
    await openScript(currentScriptId, ver.id);
  } catch (err) {
    setScriptEditorStatus('Send failed: ' + (err.message || err), 'err');
    if (sendBtn && sendHtml) sendBtn.innerHTML = sendHtml;
  } finally {
    scriptSending = false;
    scriptEditorBusy(false);
  }
}

async function startScriptRevision() {
  const latest = scriptVersions.at(-1);
  if (!latest) return;
  if (!confirm(`Start a revision of the approved v${latest.version}? Joe will need to approve the new version.`)) return;
  await ensureFreshSession();
  const { error } = await sb.from('scripts').update({ status: 'draft', draft_body: latest.body }).eq('id', currentScriptId);
  if (error) { showToast('Could not start revision: ' + error.message, 'error'); return; }
  await loadScripts();
  openScript(currentScriptId);
}

async function copyApprovedScript(btn) {
  const v = scriptVersions.find(x => x.id === currentScript?.approved_version_id) || scriptVersions.at(-1);
  if (!v) return;
  try {
    await navigator.clipboard.writeText(v.body);
    const orig = btn.textContent; btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch (_) { showToast('Could not copy to clipboard', 'error'); }
}

// ── Reviewer decision (Joe) ──────────────────────────────────
async function scriptDecision(decision) {
  if (!isReviewerUser() || !currentScriptId) return;
  const latest = scriptVersions.at(-1);
  if (!latest || currentScript.status !== 'sent') return;

  if (decision === 'changes') {
    const { count } = await sb.from('script_feedback')
      .select('id', { count: 'exact', head: true })
      .eq('version_id', latest.id).eq('user_id', currentUser.id);
    if (!count && !confirm("You haven't left any feedback on this version. Send it back anyway?")) return;
  } else if (!confirm(`Approve v${latest.version}? The text is locked and the final narration is recorded from it.`)) {
    return;
  }

  const approveBtn = document.getElementById('sc-approve-btn');
  const changesBtn = document.getElementById('sc-changes-btn');
  [approveBtn, changesBtn].forEach(b => { if (b) b.disabled = true; });
  const btn = decision === 'approved' ? approveBtn : changesBtn;
  if (btn) btn.textContent = 'Saving…';

  await ensureFreshSession();
  const now = new Date().toISOString();
  const { error: vErr } = await sb.from('script_versions')
    .update({ decision, decided_at: now, decided_by: currentUser.id })
    .eq('id', latest.id);
  const scriptPatch = decision === 'approved'
    ? { status: 'approved', approved_version_id: latest.id, approved_at: now, approved_by: currentUser.id }
    : { status: 'changes' };
  const { error: sErr } = vErr ? { error: vErr } : await sb.from('scripts').update(scriptPatch).eq('id', currentScriptId);

  if (vErr || sErr) {
    showToast('Could not save decision: ' + (vErr || sErr).message, 'error');
    renderScriptModal();
    return;
  }

  const title = currentScript.title, scriptId = currentScriptId, versionNo = latest.version;
  showToast(decision === 'approved' ? `v${versionNo} approved — the team has been notified` : 'Sent back for changes — the writer has been notified', 'success');
  invokeEdge(NOTIFY_FUNCTION, {
    body: { type: decision === 'approved' ? 'script_approved' : 'script_changes', scriptId, scriptTitle: title, versionNo },
  }).catch(err => console.warn('[notify script decision]', err));

  await loadScripts();
  if (decision === 'approved') { closeScriptModal(); showScriptsPage(document.getElementById('sidebar-scripts-item')); }
  else openScript(scriptId);
}

// ── Feedback ─────────────────────────────────────────────────
async function loadScriptFeedback() {
  const list = document.getElementById('sc-feedback-list');
  if (!list || !currentScriptId) return;

  let q = sb.from('script_feedback')
    .select('id, user_id, version_id, body, audio_path, image_path, duration_seconds, transcript, created_at, profiles:user_id(full_name)')
    .eq('script_id', currentScriptId)
    .order('created_at', { ascending: false });
  // Feedback is per version; before any version exists, show unscoped notes
  q = scriptViewVersionId ? q.eq('version_id', scriptViewVersionId) : q.is('version_id', null);
  const { data, error } = await q;

  if (error) { list.innerHTML = `<div class="feedback-empty">Could not load feedback: ${error.message}</div>`; return; }
  if (!data?.length) { list.innerHTML = '<div class="feedback-empty">No feedback on this version yet.</div>'; return; }

  const isAdmin = currentProfile?.role === 'admin';
  const items = await Promise.all(data.map(async (fb) => {
    const name = fb.profiles ? profileName(fb.profiles) : 'Team';
    const when = new Date(fb.created_at).toLocaleString();
    const canDelete = fb.user_id === currentUser?.id;

    let audioHtml = '';
    if (fb.audio_path) {
      const { data: signed } = await sb.storage.from(FEEDBACK_BUCKET).createSignedUrl(fb.audio_path, 60 * 60);
      if (signed?.signedUrl) audioHtml = `<audio controls src="${signed.signedUrl}"></audio>`;
      if (fb.transcript) {
        audioHtml += `<div class="sc-transcript"><span class="sc-transcript-label">Transcript</span>${escapeHtml(fb.transcript)}</div>`;
      } else if (isAdmin) {
        audioHtml += `<div class="sc-transcript pending" id="sc-transcript-${fb.id}">Not transcribed yet ·
          <a class="sc-link" onclick="transcribeScriptFeedback('${fb.id}', '${fb.audio_path}')">transcribe now</a></div>`;
      }
    }
    const bodyHtml = fb.body ? `<div class="feedback-text">${escapeHtml(fb.body)}</div>` : '';

    return `
      <div class="feedback-item">
        <div class="feedback-item-header">
          <span><span class="feedback-item-author">${escapeHtml(name)}</span> · ${when}</span>
          ${canDelete ? `<button class="feedback-delete" onclick="deleteScriptFeedback('${fb.id}')">Delete</button>` : ''}
        </div>
        ${bodyHtml}
        ${audioHtml}
      </div>`;
  }));
  list.innerHTML = items.join('');
}

// Whisper via the existing transcribe function (admin-only on the server, so
// Joe's own upload triggers it). Stored on the row so the writer reads text.
async function transcribeScriptFeedback(fbId, audioPath) {
  if (currentProfile?.role !== 'admin') return;
  const box = document.getElementById(`sc-transcript-${fbId}`);
  if (box) box.textContent = 'Transcribing…';
  try {
    const { data, error } = await invokeEdge(TRANSCRIBE_FUNCTION, { body: { audioPath } });
    const detail = error ? await parseFunctionError(error) : (data?.error || null);
    if (detail) throw new Error(detail);
    const text = (data.text || '').trim() || '(empty transcript)';
    await sb.from('script_feedback').update({ transcript: text }).eq('id', fbId);
    if (currentScriptId) loadScriptFeedback();
  } catch (err) {
    console.warn('[script transcript]', err);
    if (box) box.innerHTML = `Transcription failed · <a class="sc-link" onclick="transcribeScriptFeedback('${fbId}', '${audioPath}')">retry</a>`;
  }
}

async function deleteScriptFeedback(id) {
  if (!confirm('Delete this note?')) return;
  const { data: row } = await sb.from('script_feedback').select('audio_path, image_path').eq('id', id).single();
  const paths = [row?.audio_path, row?.image_path].filter(Boolean);
  if (paths.length) await sb.storage.from(FEEDBACK_BUCKET).remove(paths).catch(() => {});
  const { error } = await sb.from('script_feedback').delete().eq('id', id);
  if (error) { showToast('Could not delete: ' + error.message, 'error'); return; }
  loadScriptFeedback();
}

async function submitScriptComment() {
  if (!canCommentScript(currentScript) || !currentScriptId) return;
  if (scRecorder && scRecorder.state === 'recording') { showToast('Stop the recording before sending', 'error'); return; }

  const body = document.getElementById('sc-comment-text')?.value.trim() || '';
  if (!body && !scAudioBlob) { showToast('Add a note or a voice note first', 'error'); return; }

  const sendBtn = document.getElementById('sc-comment-send-btn');
  const sendHtml = sendBtn.innerHTML;
  sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
  await ensureFreshSession();

  try {
    let audioPath = null;
    if (scAudioBlob) {
      const ext = scAudioBlob.type.includes('webm') ? 'webm' : scAudioBlob.type.includes('mp4') ? 'm4a' : 'ogg';
      audioPath = `scripts/${currentScriptId}/${currentUser.id}-${Date.now()}.${ext}`;
      const { error } = await sb.storage.from(FEEDBACK_BUCKET)
        .upload(audioPath, scAudioBlob, { contentType: scAudioBlob.type, upsert: false });
      if (error) throw error;
    }

    const { data: inserted, error: insErr } = await sb.from('script_feedback').insert({
      script_id: currentScriptId,
      version_id: scriptViewVersionId,
      user_id: currentUser.id,
      body: body || null,
      audio_path: audioPath,
      duration_seconds: scAudioBlob ? scAudioDuration : null,
    }).select('id').single();
    if (insErr) throw insErr;

    resetScriptComposer();
    showToast('Note posted', 'success');
    await loadScriptFeedback();
    // Transcribe in the background — the list refreshes when it lands
    if (audioPath) transcribeScriptFeedback(inserted.id, audioPath);
  } catch (err) {
    showToast('Could not post: ' + (err?.message || 'Unknown error'), 'error');
  } finally {
    sendBtn.disabled = false; sendBtn.innerHTML = sendHtml;
  }
}

// ── Voice-note recorder for the script composer ──────────────
async function toggleScriptRecording() {
  if (scRecorder && scRecorder.state === 'recording') { scRecorder.stop(); return; }
  if (scAudioBlob) { showToast('Remove the current voice note first', 'error'); return; }
  try {
    scStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) { showToast('Microphone access denied', 'error'); return; }

  const mimeType = _bestAudioMime();
  try {
    scRecorder = mimeType ? new MediaRecorder(scStream, { mimeType }) : new MediaRecorder(scStream);
  } catch (_) {
    showToast('Recording not supported in this browser', 'error');
    scStopStream(); return;
  }
  scChunks = [];
  scRecorder.addEventListener('dataavailable', e => { if (e.data?.size > 0) scChunks.push(e.data); });
  scRecorder.addEventListener('stop', scHandleRecordingStop);
  scRecorder.start();
  scRecStart = Date.now();

  const btn = document.getElementById('sc-mic-btn');
  btn?.classList.add('mic-recording');
  const timer = document.getElementById('sc-record-timer');
  if (timer) { timer.classList.remove('hidden'); timer.textContent = '0:00'; }
  scTimerInterval = setInterval(() => {
    const elapsed = Date.now() - scRecStart;
    if (elapsed >= MAX_RECORDING_MS) { scRecorder?.stop(); return; }
    const t = Math.floor(elapsed / 1000);
    if (timer) timer.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }, 250);
}

function scStopStream() {
  if (scStream) { scStream.getTracks().forEach(t => t.stop()); scStream = null; }
}

function scHandleRecordingStop() {
  clearInterval(scTimerInterval); scTimerInterval = null;
  scAudioDuration = Math.max(1, Math.round((Date.now() - scRecStart) / 1000));
  document.getElementById('sc-mic-btn')?.classList.remove('mic-recording');
  document.getElementById('sc-record-timer')?.classList.add('hidden');
  scStopStream();
  scAudioBlob = new Blob(scChunks, { type: scChunks[0]?.type || scRecorder?.mimeType || 'audio/webm' });
  scChunks = [];
  const player = document.getElementById('sc-comment-audio-player');
  if (player) player.src = URL.createObjectURL(scAudioBlob);
  document.getElementById('sc-comment-attachments')?.classList.remove('hidden');
}

function clearScriptComposerAudio() {
  scAudioBlob = null; scAudioDuration = 0;
  const player = document.getElementById('sc-comment-audio-player');
  if (player?.src) { URL.revokeObjectURL(player.src); player.removeAttribute('src'); }
  document.getElementById('sc-comment-attachments')?.classList.add('hidden');
}

function resetScriptComposer() {
  if (scRecorder && scRecorder.state === 'recording') { try { scRecorder.stop(); } catch (_) {} }
  clearInterval(scTimerInterval); scTimerInterval = null;
  scStopStream(); scChunks = [];
  const text = document.getElementById('sc-comment-text');
  if (text) text.value = '';
  clearScriptComposerAudio();
}

// ── Realtime: keep the Scripts count + page fresh when someone else acts ──
function subscribeToScriptChanges() {
  sb.channel('script-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'scripts' }, async () => {
      await loadScripts();
      if (document.getElementById('sidebar-scripts-item')?.classList.contains('active')) {
        showScriptsPage(document.getElementById('sidebar-scripts-item'));
      }
    })
    .subscribe();
}

// ══════════════════════════════════════════════════════
// PROJECT ASSETS — the video plus everything that goes with it
// (finalized audio, original audio, transcript, other files).
// Shown at the top of the project modal beside the slot's video.
// ══════════════════════════════════════════════════════
const PROJECT_ASSETS_BUCKET = 'project-assets';
const PROJ_ASSET_KINDS = {
  final_audio:    { label: 'Finalized audio', accept: 'audio/*',                    empty: 'No finalized narration yet.' },
  original_audio: { label: 'Original audio',  accept: 'audio/*,video/*',            empty: 'No original recording yet.' },
  transcript:     { label: 'Transcript',      accept: '.txt,.srt,.vtt,text/plain',  empty: 'No transcript yet.' },
  other:          { label: 'Other assets',    accept: '*/*',                        empty: 'No other files yet.' },
};
let projectAssets    = [];   // rows for currentScriptId
let projectAssetUrls = {};   // storage_path → signed URL
let projVideoToken   = 0;    // guards a slow playback lookup against a modal switch

const canAddProjectAssets   = (s) => isStaffUser() || isScriptAssignee(s);
const canDeleteProjectAsset = (a) => isStaffUser() || a.created_by === currentUser?.id;

function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// The hub's skeleton — panels fill in once the assets and playback URL load.
function renderProjectHubHtml(s) {
  const v = s.videos;
  const manager = canManageScripts();
  const panels = Object.entries(PROJ_ASSET_KINDS).map(([kind, k]) => `
    <div class="pa-panel ${kind === 'transcript' || kind === 'other' ? 'pa-panel-tall' : ''}" id="pa-panel-${kind}">
      <div class="pa-panel-head">
        <span class="pa-panel-title">${k.label}</span>
        <span class="pa-panel-actions" id="pa-actions-${kind}"></span>
      </div>
      <div class="pa-panel-body" id="pa-body-${kind}"><span class="pa-empty">Loading…</span></div>
    </div>`).join('');

  const videoInner = v
    ? `<div class="pa-video-msg">Loading video…</div>`
    : `<div class="pa-video-msg">No video slot linked yet.${manager ? ` <a class="sc-link" onclick="linkScriptVideo()">Link a slot</a>` : ''}</div>`;

  return `
    <div class="pa-hub">
      <div class="pa-main">
        <div class="pa-video" id="pa-video">${videoInner}</div>
        ${v ? `<div class="pa-video-foot">
          <span class="pa-video-title">${escapeHtml(v.title)}</span>
          <span class="pa-item-meta">${v.status ? `Slot status: ${escapeHtml(String(v.status).replace('_', ' '))}` : ''}${v.duration_seconds ? ` · ${formatDuration(v.duration_seconds)}` : ''}</span>
          ${v.storage_key || v.video_url ? `<a class="sc-link" onclick="openVideo('${v.id}')">Open in library</a>` : ''}
        </div>` : ''}
      </div>
      <div class="pa-side">${panels}</div>
    </div>`;
}

async function loadProjectVideo() {
  const s = currentScript, v = s?.videos;
  const box = document.getElementById('pa-video');
  if (!v || !box) return;
  const token = ++projVideoToken;
  if (!v.storage_key && !v.video_url) {
    const hint = (s.editor_id === currentUser?.id || isStaffUser()) ? ' Upload it from the library once it is produced.' : '';
    box.innerHTML = `<div class="pa-video-msg">${v.thumbnail_url ? `<img src="${escapeHtmlAttr(v.thumbnail_url)}" alt="">` : ''}<span>No video uploaded to this slot yet.${hint}</span></div>`;
    return;
  }
  try {
    const url = await resolveWasabiPlaybackUrl(v);
    if (token !== projVideoToken) return;
    if (!url) throw new Error('no url');
    const poster = v.thumbnail_url ? `poster="${escapeHtmlAttr(v.thumbnail_url)}"` : '';
    box.innerHTML = `<video controls playsinline preload="metadata" ${poster}><source src="${url}">Your browser does not support HTML5 video.</video>`;
  } catch (err) {
    if (token !== projVideoToken) return;
    console.warn('[project video]', err);
    box.innerHTML = `<div class="pa-video-msg">Could not load the video. <a class="sc-link" onclick="loadProjectVideo()">Retry</a></div>`;
  }
}

async function loadProjectAssets() {
  const id = currentScriptId;
  if (!id) return;
  const { data, error } = await sb.from('project_assets')
    .select('*, profiles:created_by(full_name)')
    .eq('script_id', id)
    .order('created_at', { ascending: false });
  if (id !== currentScriptId) return;
  if (error) {
    console.warn('[project assets] load failed:', error.message);
    projectAssets = [];
    renderProjectAssets(error.message);
    return;
  }
  projectAssets = data || [];
  projectAssetUrls = {};
  const paths = projectAssets.map(a => a.storage_path).filter(Boolean);
  if (paths.length) {
    const { data: signed, error: sErr } = await sb.storage.from(PROJECT_ASSETS_BUCKET).createSignedUrls(paths, 60 * 60);
    if (id !== currentScriptId) return;
    if (sErr) console.warn('[project assets] sign failed:', sErr.message);
    (signed || []).forEach(d => { if (d.signedUrl) projectAssetUrls[d.path] = d.signedUrl; });
  }
  renderProjectAssets();
}

function renderProjectAssets(loadError) {
  const s = currentScript;
  if (!s) return;
  const canAdd = canAddProjectAssets(s);
  const v = s.videos;

  Object.entries(PROJ_ASSET_KINDS).forEach(([kind, k]) => {
    const body = document.getElementById(`pa-body-${kind}`);
    const actions = document.getElementById(`pa-actions-${kind}`);
    if (!body || !actions) return;

    let act = '';
    if (canAdd) {
      if (kind === 'transcript') {
        if (v?.storage_key && isStaffUser()) act += `<button class="pa-add" id="pa-transcribe-btn" onclick="transcribeProjectVideo()">Transcribe video</button>`;
        act += `<button class="pa-add" onclick="pasteProjectTranscript()">Paste</button>`;
      }
      act += `<button class="pa-add" onclick="pickProjectAsset('${kind}')">+ Upload</button>`;
    }
    actions.innerHTML = act;

    if (loadError) { body.innerHTML = `<span class="pa-empty">Could not load (${escapeHtml(loadError)}).</span>`; return; }
    const items = projectAssets.filter(a => a.kind === kind);
    // Finalized audio and transcript fill in automatically from the approved script (step 1)
    const derived = kind === 'final_audio' ? approvedAudioItemHtml(s) : kind === 'transcript' ? approvedTranscriptItemHtml(s) : '';
    if (!items.length && !derived) { body.innerHTML = `<span class="pa-empty">${k.empty}</span>`; return; }
    body.innerHTML = derived + items.map(a => projectAssetItemHtml(a)).join('');
  });
}

// ── Derived from step 1: the approved script version ─────────
function approvedScriptVersion(s) {
  if (s?.status !== 'approved') return null;
  return scriptVersions.find(v => v.id === s.approved_version_id) || scriptVersions.at(-1) || null;
}

function approvedPendingNote(s) {
  const latest = scriptVersions.at(-1);
  const state = s.status === 'sent' ? `v${latest?.version} is with Joe` : s.status === 'changes' ? `Joe asked for changes on v${latest?.version}` : 'the script is still being written';
  return `<span class="pa-empty">Fills in automatically once Joe approves the script — ${state}.</span>`;
}

function approvedAudioItemHtml(s) {
  const v = approvedScriptVersion(s);
  if (!v) return approvedPendingNote(s);
  const withAudio = (v.paragraphs || []).filter(p => p.audio_path).length;
  if (!withAudio) return `<span class="pa-empty">Approved v${v.version} has no rendered audio yet.</span>`;
  return `
    <div class="pa-item pa-derived">
      <div class="pa-item-row">
        <span class="pa-item-name">Approved narration · v${v.version}</span>
        <span class="pa-chip-auto">from script</span>
      </div>
      <div class="pa-item-row">
        <button class="sp-btn primary" style="padding:6px 12px;font-size:12px" onclick="paPlayApproved()"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Play all</button>
        <button class="sp-btn" style="padding:6px 12px;font-size:12px" onclick="spTogglePause()">Pause</button>
        <button class="sp-btn" style="padding:6px 12px;font-size:12px" onclick="stopScriptPlayer()">Stop</button>
      </div>
      <span class="pa-item-meta">${withAudio} paragraph${withAudio !== 1 ? 's' : ''} · preview voice · approved ${s.approved_at ? timeAgo(s.approved_at) : ''}. Upload Joe's recorded narration below to replace it.</span>
    </div>`;
}

function approvedTranscriptItemHtml(s) {
  const v = approvedScriptVersion(s);
  if (!v) return approvedPendingNote(s);
  return `
    <div class="pa-item pa-derived">
      <div class="pa-item-row">
        <span class="pa-item-name">Approved script · v${v.version}</span>
        <span class="pa-chip-auto">from script</span>
        <button class="pa-del" onclick="copyProjectText('approved', this)">Copy</button>
      </div>
      <div class="pa-transcript" id="pa-text-approved">${escapeHtml(v.body || '')}</div>
      <span class="pa-item-meta">${v.total_count || (v.paragraphs || []).length} paragraphs · approved ${s.approved_at ? timeAgo(s.approved_at) : ''}</span>
    </div>`;
}

async function paPlayApproved() {
  const v = approvedScriptVersion(currentScript);
  if (!v) return;
  stopScriptPlayer();
  await scriptPlayerLoad(v.paragraphs || []);
  if (scriptTab === 'video') spPlayAll();
}

function projectAssetItemHtml(a) {
  const url = a.storage_path ? projectAssetUrls[a.storage_path] : null;
  const who = a.profiles ? profileName(a.profiles) : '';
  const meta = [who, timeAgo(a.created_at), a.size_bytes ? formatBytes(a.size_bytes) : ''].filter(Boolean).join(' · ');
  const del = canDeleteProjectAsset(a) ? `<button class="pa-del" title="Remove" onclick="deleteProjectAsset('${a.id}')">✕</button>` : '';
  const isAudio = (a.mime_type || '').startsWith('audio/') || /\.(mp3|m4a|wav|ogg|webm|aac)$/i.test(a.file_name || '');

  if (a.kind === 'transcript' && a.body) {
    return `
      <div class="pa-item">
        <div class="pa-item-row">
          <span class="pa-item-name">${escapeHtml(a.file_name || 'Transcript')}</span>
          <button class="pa-del" onclick="copyProjectText('${a.id}', this)">Copy</button>${del}
        </div>
        <div class="pa-transcript" id="pa-text-${a.id}">${escapeHtml(a.body)}</div>
        <span class="pa-item-meta">${meta}</span>
      </div>`;
  }
  const name = escapeHtml(a.file_name || 'File');
  return `
    <div class="pa-item">
      <div class="pa-item-row">
        ${url ? `<a class="pa-item-name" href="${url}" target="_blank" rel="noopener" title="${escapeHtmlAttr(a.file_name || '')}">${name}</a>`
              : `<span class="pa-item-name">${name}</span>`}
        ${del}
      </div>
      ${url && isAudio ? `<audio controls preload="none" src="${url}"></audio>` : ''}
      <span class="pa-item-meta">${meta}</span>
    </div>`;
}

function copyProjectText(id, btn) {
  const text = document.getElementById(`pa-text-${id}`)?.textContent || '';
  navigator.clipboard?.writeText(text).then(() => {
    const orig = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = orig; }, 1500);
  }).catch(() => showToast('Could not copy', 'error'));
}

function pickProjectAsset(kind) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = PROJ_ASSET_KINDS[kind]?.accept || '*/*';
  input.multiple = kind === 'other';
  input.onchange = () => { [...input.files].forEach(f => uploadProjectAsset(kind, f)); };
  input.click();
}

async function uploadProjectAsset(kind, file) {
  const scriptId = currentScriptId;
  if (!scriptId || !file) return;
  const body = document.getElementById(`pa-body-${kind}`);
  const status = document.createElement('div');
  status.className = 'pa-item pa-uploading';
  status.textContent = `Uploading ${file.name}…`;
  body?.prepend(status);

  await ensureFreshSession();
  try {
    const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
    const path = `${scriptId}/${kind}/${Date.now()}-${safe}`;
    const { error: upErr } = await sb.storage.from(PROJECT_ASSETS_BUCKET)
      .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (upErr) throw upErr;

    // A small text transcript file is also stored as text so it can be read in place
    let text = null;
    if (kind === 'transcript' && file.size < 512 * 1024) {
      try { text = (await file.text()).trim() || null; } catch (_) { /* keep the file only */ }
    }

    const { error: insErr } = await sb.from('project_assets').insert({
      script_id: scriptId, kind, storage_path: path, file_name: file.name,
      mime_type: file.type || null, size_bytes: file.size, body: text, created_by: currentUser.id,
    });
    if (insErr) throw insErr;
    showToast(`${PROJ_ASSET_KINDS[kind].label}: ${file.name} added`, 'success');
  } catch (err) {
    console.error('[project assets] upload failed:', err);
    showToast('Upload failed: ' + (err?.message || 'unknown error'), 'error');
  } finally {
    status.remove();
    if (scriptId === currentScriptId) loadProjectAssets();
  }
}

async function pasteProjectTranscript() {
  const text = prompt('Paste the transcript text:');
  if (text == null || !text.trim()) return;
  const { error } = await sb.from('project_assets').insert({
    script_id: currentScriptId, kind: 'transcript', body: text.trim(),
    file_name: 'Pasted transcript', created_by: currentUser.id,
  });
  if (error) { showToast('Could not save transcript: ' + error.message, 'error'); return; }
  loadProjectAssets();
}

// Whisper on the slot's stored video, saved as a transcript asset
async function transcribeProjectVideo() {
  const s = currentScript, v = s?.videos;
  if (!v?.storage_key) { showToast('No stored video to transcribe', 'error'); return; }
  const scriptId = currentScriptId;
  const btn = document.getElementById('pa-transcribe-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Transcribing…'; }
  try {
    const { data, error } = await invokeEdge(TRANSCRIBE_FUNCTION, { body: { storageKey: v.storage_key } });
    const detail = error ? await parseFunctionError(error) : (data?.error || null);
    if (detail) {
      throw new Error(/25\s*MB|too large|over OpenAI/i.test(detail)
        ? 'Video is over 25MB — transcribe it from the library (it can extract the audio there), then paste or upload the text here.'
        : detail);
    }
    const text = (data?.text || '').trim();
    if (!text) throw new Error('empty transcript');
    if (scriptId !== currentScriptId) return;
    const { error: insErr } = await sb.from('project_assets').insert({
      script_id: scriptId, kind: 'transcript', body: text,
      file_name: `Transcript of ${v.title}`, created_by: currentUser.id,
    });
    if (insErr) throw insErr;
    showToast('Transcript saved', 'success');
    loadProjectAssets();
  } catch (err) {
    showToast('Transcription failed: ' + (err?.message || 'unknown error'), 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Transcribe video'; }
  }
}

async function deleteProjectAsset(id) {
  const a = projectAssets.find(x => x.id === id);
  if (!a) return;
  if (!confirm(`Remove "${a.file_name || 'this item'}" from the project?`)) return;
  const { error } = await sb.from('project_assets').delete().eq('id', id);
  if (error) { showToast('Could not remove: ' + error.message, 'error'); return; }
  if (a.storage_path) await sb.storage.from(PROJECT_ASSETS_BUCKET).remove([a.storage_path]).catch(() => {});
  loadProjectAssets();
}
