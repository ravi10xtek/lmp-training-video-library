// ══════════════════════════════════════════════════════
// CONFIGURATION — Replace with your Supabase details
// ══════════════════════════════════════════════════════
const SUPABASE_URL = 'https://tdxwsgfjkpurtjmgwabr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkeHdzZ2Zqa3B1cnRqbWd3YWJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNjE3NzAsImV4cCI6MjA5NDczNzc3MH0.9t1S-8kw6LCp7WDDTvs7Um0REVCvIoQt-d8xoF9ITbA';

// ══════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
let allNotifications = [];
let notifPanelOpen = false;
let notifSubscription = null;
const NOTIFY_FUNCTION = 'notify-review';
const FEEDBACK_BUCKET = 'video-feedback';
const MAX_RECORDING_MS = 3 * 60 * 1000;

const WASABI_UPLOAD_INIT_FUNCTION = 'wasabi-upload-init';
const WASABI_TRANSFER_FUNCTION = 'wasabi-transfer';
const WASABI_PLAYBACK_FUNCTION = 'wasabi-playback-url';
const VIDEO_STAGING_BUCKET = 'video-uploads';
/** Supabase global storage limit is often 50MB — use direct Wasabi above this. */
const STAGING_MAX_BYTES = 45 * 1024 * 1024;

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
  }

  // Load data
  await Promise.all([loadCategories(), loadVideos()]);
  await loadNotifications();
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

  const { data, error } = await sb.functions.invoke(WASABI_PLAYBACK_FUNCTION, {
    body: { storageKey: v.storage_key, videoId: v.id }
  });

  if (error) throw error;
  return data?.playbackUrl || data?.url || null;
}

async function openVideo(id) {
  const v = allVideos.find(x => x.id === id);
  if (!v) return;

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
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
  }
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
    .select('id, user_id, audio_path, duration_seconds, created_at, profiles:user_id(full_name)')
    .eq('video_id', videoId)
    .order('created_at', { ascending: false });

  if (error) {
    list.innerHTML = `<div class="feedback-empty">Could not load feedback: ${error.message}</div>`;
    return;
  }

  if (!data || data.length === 0) {
    list.innerHTML = '<div class="feedback-empty">No feedback yet. Record one above.</div>';
    return;
  }

  const items = await Promise.all(data.map(async (fb) => {
    const { data: signed } = await sb.storage
      .from(FEEDBACK_BUCKET)
      .createSignedUrl(fb.audio_path, 60 * 60);
    const url = signed?.signedUrl || '';
    const name = fb.profiles?.full_name || 'Admin';
    const when = new Date(fb.created_at).toLocaleString();
    const canDelete = fb.user_id === currentUser?.id;
    return `
      <div class="feedback-item">
        <div class="feedback-item-header">
          <span><span class="feedback-item-author">${name}</span> · ${when}</span>
          ${canDelete ? `<button class="feedback-delete" onclick="deleteFeedback('${fb.id}', '${fb.audio_path}')">Delete</button>` : ''}
        </div>
        <audio controls src="${url}"></audio>
      </div>`;
  }));

  list.innerHTML = items.join('');
}

async function deleteFeedback(id, path) {
  if (!confirm('Delete this feedback?')) return;
  await sb.storage.from(FEEDBACK_BUCKET).remove([path]).catch(() => {});
  const { error } = await sb.from('video_feedback').delete().eq('id', id);
  if (error) {
    showToast('Could not delete: ' + error.message, 'error');
    return;
  }
  showToast('Feedback deleted', 'success');
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

  const btn = document.getElementById('record-btn');
  btn.classList.add('record-btn-recording');
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg> Stop';

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

async function handleRecordingStop() {
  clearInterval(recordingTimerInterval);
  recordingTimerInterval = null;
  const durationMs = Date.now() - recordingStartTime;
  const durationSec = Math.max(1, Math.round(durationMs / 1000));

  const btn = document.getElementById('record-btn');
  btn.classList.remove('record-btn-recording');
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg> Uploading…';
  btn.disabled = true;
  document.getElementById('record-timer').classList.add('hidden');

  stopMicStream();

  const blob = new Blob(recordedChunks, { type: recordedChunks[0]?.type || 'audio/webm' });
  recordedChunks = [];

  const ext = (blob.type.includes('webm') ? 'webm' : 'ogg');
  const path = `${currentVideoId}/${currentUser.id}-${Date.now()}.${ext}`;

  try {
    const { error: upErr } = await sb.storage
      .from(FEEDBACK_BUCKET)
      .upload(path, blob, { contentType: blob.type, upsert: false });
    if (upErr) throw upErr;

    const { error: insErr } = await sb.from('video_feedback').insert({
      video_id: currentVideoId,
      user_id: currentUser.id,
      audio_path: path,
      duration_seconds: durationSec,
    });
    if (insErr) throw insErr;

    showToast('Feedback saved', 'success');
    loadFeedback(currentVideoId);
  } catch (err) {
    console.error('[feedback] save failed:', err);
    const detail = err?.message || err?.error || err?.statusText || JSON.stringify(err) || 'Unknown error';
    showToast('Could not save feedback: ' + detail, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg> Record feedback';
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

  const { data, error } = await sb.functions.invoke(WASABI_UPLOAD_INIT_FUNCTION, {
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
  const { data, error } = await sb.functions.invoke(WASABI_TRANSFER_FUNCTION, {
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

  if (file.size > STAGING_MAX_BYTES) {
    return uploadViaWasabiDirect(file, onProgress);
  }

  try {
    return await uploadViaStaging(file, onProgress);
  } catch (err) {
    if (!isObjectSizeExceededError(err)) throw err;
    onProgress?.(2, 'File too large for staging — using direct upload…');
    return uploadViaWasabiDirect(file, onProgress);
  }
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

  let error;
  if (editingVideoId) {
    ({ error } = await sb.from('videos').update(payload).eq('id', editingVideoId));
  } else {
    payload.created_by = currentUser.id;
    ({ error } = await sb.from('videos').insert(payload));
  }

  if (error) {
    showToast('Error: ' + error.message, 'error');
  } else {
    showToast(editingVideoId ? 'Video updated' : 'Video slot created', 'success');
    if (editingVideoId && payload.status === 'done' && prevStatus !== 'done') {
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
}

function renderNotificationBell() {
  const unread = allNotifications.filter(n => !n.read).length;
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  badge.textContent = unread;
  badge.classList.toggle('hidden', unread === 0);
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
  btn.textContent = 'Sending…';

  const type = v.status === 'done' ? 'round2_reviewed' : 'round1_reviewed';
  const { error } = await sb.functions.invoke(NOTIFY_FUNCTION, {
    body: { type, videoId: currentVideoId, videoTitle: v.title },
  });

  if (error) {
    showToast('Could not send review notification', 'error');
    btn.disabled = false;
    updateReviewedBtnState(v);
    return;
  }

  v.review_round = type === 'round2_reviewed' ? 2 : 1;
  v.reviewed_at = new Date().toISOString();
  showToast(
    type === 'round2_reviewed' ? 'Final approval sent!' : 'Review submitted — admins notified',
    'success'
  );
  btn.disabled = false;
  updateReviewedBtnState(v);
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
    statusEl.textContent = `Final approval given${reviewedDate ? ' on ' + reviewedDate : ''}`;
  } else if (v.status === 'done') {
    btn.innerHTML = `${checkSvg} Give Final Approval`;
    btn.disabled = false;
    statusEl.textContent = 'Revised and ready — approve or request more changes';
  } else if (v.status === 'draft' && v.review_round >= 1) {
    // Joe sent more changes, now waiting for the editor to revise
    btn.innerHTML = `⏳ Waiting for revisions`;
    btn.disabled = true;
    moreBtn?.classList.add('hidden');
    statusEl.textContent = 'You requested more changes — editor has been notified';
  } else {
    btn.innerHTML = `${checkSvg} Mark as Reviewed`;
    btn.disabled = false;
    statusEl.textContent = '';
  }
}

async function requestMoreChanges() {
  const isAdmin = currentProfile?.role === 'admin';
  const isReviewer = currentProfile?.is_reviewer === true;
  if (!currentVideoId || (!isAdmin && !isReviewer)) return;
  const v = allVideos.find(x => x.id === currentVideoId);
  if (!v || v.status !== 'done') return;

  const moreBtn = document.getElementById('more-changes-btn');
  const reviewedBtn = document.getElementById('mark-reviewed-btn');
  moreBtn.disabled = true;
  reviewedBtn.disabled = true;
  moreBtn.textContent = 'Sending…';

  const { error } = await sb.functions.invoke(NOTIFY_FUNCTION, {
    body: { type: 'more_changes_requested', videoId: currentVideoId, videoTitle: v.title },
  });

  if (error) {
    showToast('Could not send notification', 'error');
    moreBtn.disabled = false;
    reviewedBtn.disabled = false;
    updateReviewedBtnState(v);
    return;
  }

  // Edge function resets status to draft server-side — reflect locally
  v.status = 'draft';
  v.review_round = 1;
  showToast('More changes requested — editors notified', 'success');
  updateReviewedBtnState(v);
}

// ── EDITOR ACTIONS ───────────────────────────────────
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

  if (showSubmit) {
    statusEl.textContent = 'Upload done — submit when ready for Joe to review';
  } else if (showMarkDone) {
    statusEl.textContent = 'Joe requested changes — click when revisions are ready';
  } else if (showPublish) {
    statusEl.textContent = 'Joe gave final approval — ready to publish';
  } else if (v.status === 'done' && v.review_round < 2) {
    statusEl.textContent = 'Waiting for Joe\'s final approval';
  } else if (v.status === 'published') {
    statusEl.textContent = 'Published ✓';
  } else {
    statusEl.textContent = '';
  }
}

async function submitForReview() {
  if (!currentVideoId) return;
  const v = allVideos.find(x => x.id === currentVideoId);
  if (!v || v.status !== 'draft' || v.review_round !== 0) return;

  const btn = document.getElementById('submit-review-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  // Notify reviewer (Joe)
  const { error } = await sb.functions.invoke(NOTIFY_FUNCTION, {
    body: { type: 'video_ready', videoId: currentVideoId, videoTitle: v.title },
  });

  if (error) {
    showToast('Could not send notification', 'error');
    btn.disabled = false;
    updateEditorBtnState(v);
    return;
  }

  showToast('Submitted for review — Joe has been notified', 'success');
  btn.disabled = false;
  updateEditorBtnState(v);
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
  sb.functions.invoke(NOTIFY_FUNCTION, {
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
  sb.functions.invoke(NOTIFY_FUNCTION, {
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
      document.getElementById('admin-modal').classList.remove('open');
      document.getElementById('notif-panel')?.classList.add('hidden');
      notifPanelOpen = false;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      document.getElementById('search-input').focus();
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
