let activeAudio = null;
let activeButton = null;
let activeTrackIndex = -1;
let activeTrackObject = null;
let currentRenderedList = [];
let allTracks = [];
let currentPlaybackRate = 1.0;
let currentLyricsText = '';

// Auth State (Guest = 30s Previews, Logged-in Member = Full-Length Songs)
const AUTH_TOKEN_KEY = 'sonic_crate_auth_token_v1';
const AUTH_USER_KEY = 'sonic_crate_auth_user_v1';
let authToken = localStorage.getItem(AUTH_TOKEN_KEY) || '';
let currentUser = loadUserFromStorage();
let authModalMode = 'register';
let currentFullTrackData = null;
let fullTrackSourceMode = 'studio'; // 'studio' | 'youtube'

// Saved Crate persisted in localStorage
const CRATE_STORAGE_KEY = 'sonic_crate_saved_tracks_v1';
let savedCrate = loadCrateFromStorage();

// Blind Quiz State
let quizState = {
  score: 0,
  total: 0,
  streak: 0,
  currentTrack: null,
  options: [],
  answered: false,
  audio: null,
};

// Visualizer State
let visualizerAnimId = null;
let audioCtx = null;
let analyser = null;
let connectedAudios = new WeakSet();

function loadUserFromStorage() {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function saveAuthState(token, user) {
  authToken = token || '';
  currentUser = user || null;
  try {
    if (authToken && currentUser) {
      localStorage.setItem(AUTH_TOKEN_KEY, authToken);
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(currentUser));
    } else {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_USER_KEY);
    }
  } catch (_) {
    // Ignore storage errors
  }
  updateAuthUI();
}

function isLoggedIn() {
  return Boolean(authToken && currentUser && currentUser.email);
}

function getPlayButtonLabel(isPaused = true) {
  if (!isPaused) {
    return isLoggedIn() ? '⏸ Pause Full Song' : '⏸ Pause Preview';
  }
  return isLoggedIn() ? '▶ Play Full Song' : '▶ Play 30s Preview';
}

function updateAuthUI() {
  const headerBtn = document.getElementById('authHeaderBtn');
  const tierStatus = document.getElementById('accessTierStatus');
  const deckModeLabel = document.getElementById('deckModeLabel');
  const guestBanner = document.getElementById('guestUpgradeBanner');
  const sourceToggle = document.getElementById('fullSongSourceToggle');
  const ytWrap = document.getElementById('youtubeEmbedWrap');

  if (isLoggedIn()) {
    if (headerBtn) {
      headerBtn.textContent = `Sign Out (${currentUser.name})`;
      headerBtn.className = 'btn-secondary btn-auth';
    }
    if (tierStatus) {
      tierStatus.className = 'tier-text member-active';
      tierStatus.textContent = `Full-Track Member · Signed in as ${currentUser.name}`;
    }
    if (deckModeLabel) {
      deckModeLabel.textContent = 'Listening Deck · Full-Song Member Mode';
    }
    if (guestBanner) {
      guestBanner.classList.add('hidden');
    }
  } else {
    if (headerBtn) {
      headerBtn.textContent = 'Sign In / Register';
      headerBtn.className = 'btn-primary btn-auth';
    }
    if (tierStatus) {
      tierStatus.className = 'tier-text';
      tierStatus.innerHTML = `Guest Mode · 30s Previews (<a href="#auth" onclick="openAuthModal('register'); return false;">Register for Full Songs</a>)`;
    }
    if (deckModeLabel) {
      deckModeLabel.textContent = 'Listening Deck · 30s Preview Mode';
    }
    if (guestBanner) {
      guestBanner.classList.remove('hidden');
    }
    if (sourceToggle) {
      sourceToggle.classList.add('hidden');
    }
    if (ytWrap) {
      ytWrap.classList.add('hidden');
      ytWrap.innerHTML = '';
    }
  }

  // Refresh button labels on visible track cards
  document.querySelectorAll('.track .play-btn').forEach(btn => {
    const card = btn.closest('.track');
    const audio = card ? card.querySelector('.preview-audio') : null;
    const isPlaying = audio && !audio.paused;
    btn.textContent = getPlayButtonLabel(!isPlaying);
  });
}

async function verifyExistingSession() {
  if (!authToken) {
    updateAuthUI();
    return;
  }
  try {
    const user = await apiFetch('/auth/me', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (user && user.email) {
      saveAuthState(authToken, user);
    } else {
      saveAuthState('', null);
    }
  } catch (_) {
    saveAuthState('', null);
  }
}

function handleAuthHeaderClick() {
  if (isLoggedIn()) {
    apiFetch('/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    }).catch(() => {});
    stopOtherAudio(null);
    saveAuthState('', null);
    updateNowPlaying('', '');
  } else {
    openAuthModal('register');
  }
}

function openAuthModal(mode = 'register') {
  const modal = document.getElementById('authModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  switchAuthMode(mode);
}

function closeAuthModal() {
  const modal = document.getElementById('authModal');
  if (modal) modal.classList.add('hidden');
}

function switchAuthMode(mode) {
  authModalMode = mode;
  const title = document.getElementById('authModalTitle');
  const sub = document.getElementById('authModalSub');
  const nameGroup = document.getElementById('nameFieldGroup');
  const nameInput = document.getElementById('authName');
  const submitBtn = document.getElementById('authSubmitBtn');
  const regTab = document.getElementById('tabRegisterBtn');
  const loginTab = document.getElementById('tabLoginBtn');
  const errBox = document.getElementById('authErrorMsg');

  if (errBox) errBox.classList.add('hidden');
  if (regTab) regTab.classList.toggle('active', mode === 'register');
  if (loginTab) loginTab.classList.toggle('active', mode === 'login');

  if (mode === 'register') {
    if (title) title.textContent = 'Create Account for Full Songs';
    if (sub) sub.textContent = 'Guests can play 30-second iTunes previews. Register an account on the Go server to unlock full-length song streaming.';
    if (nameGroup) nameGroup.classList.remove('hidden');
    if (nameInput) nameInput.required = true;
    if (submitBtn) submitBtn.textContent = 'Create Account & Unlock Full Songs';
  } else {
    if (title) title.textContent = 'Sign In to Your Account';
    if (sub) sub.textContent = 'Sign in to switch from 30-second guest previews to full-length songs.';
    if (nameGroup) nameGroup.classList.add('hidden');
    if (nameInput) nameInput.required = false;
    if (submitBtn) submitBtn.textContent = 'Sign In & Unlock Full Songs';
  }
}

async function submitAuthForm(event) {
  event.preventDefault();
  const name = (document.getElementById('authName')?.value || '').trim();
  const email = (document.getElementById('authEmail')?.value || '').trim();
  const password = document.getElementById('authPassword')?.value || '';
  const errBox = document.getElementById('authErrorMsg');
  const submitBtn = document.getElementById('authSubmitBtn');

  if (errBox) errBox.classList.add('hidden');
  if (submitBtn) submitBtn.disabled = true;

  const endpoint = authModalMode === 'register' ? '/auth/register' : '/auth/login';
  const payload = authModalMode === 'register' ? { name, email, password } : { email, password };

  try {
    const res = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res && res.token && res.user) {
      saveAuthState(res.token, res.user);
      closeAuthModal();
      document.getElementById('authForm')?.reset();

      // If a song is currently loaded or playing in 30s preview mode, upgrade it immediately to Full Song!
      if (activeAudio && activeTrackObject) {
        const card = activeAudio.closest('.track');
        playSpecificAudio(activeAudio, activeButton, card, activeTrackObject, activeTrackIndex);
      }
    }
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message || 'Authentication failed. Please check your details.';
      errBox.classList.remove('hidden');
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function loadCrateFromStorage() {
  try {
    const raw = localStorage.getItem(CRATE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function saveCrateToStorage() {
  try {
    localStorage.setItem(CRATE_STORAGE_KEY, JSON.stringify(savedCrate));
  } catch (_) {
    // Ignore storage quota errors
  }
  updateCrateCountUI();
}

function updateCrateCountUI() {
  const badge = document.getElementById('crateNavCount');
  if (badge) {
    badge.textContent = String(savedCrate.length);
  }
}

function isTrackInCrate(track) {
  if (!track) return false;
  const key = track.trackId || `${track.trackName}::${track.artistName}`;
  return savedCrate.some(item => (item.trackId || `${item.trackName}::${item.artistName}`) === key);
}

function toggleTrackInCrate(index) {
  const track = currentRenderedList[index];
  if (!track) return;

  const key = track.trackId || `${track.trackName}::${track.artistName}`;
  const existingIdx = savedCrate.findIndex(
    item => (item.trackId || `${item.trackName}::${item.artistName}`) === key
  );

  if (existingIdx >= 0) {
    savedCrate.splice(existingIdx, 1);
  } else {
    savedCrate.unshift(track);
  }
  saveCrateToStorage();
  renderTracks(currentRenderedList);
  if (!document.getElementById('view-crate').classList.contains('hidden')) {
    renderCrateView();
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Resilient API helper that works both when served from the Go server (http://localhost:8080)
// or AI Studio preview, AND if index.html is opened directly from the filesystem.
async function apiFetch(pathAndQuery, options = {}) {
  const endpoints = [pathAndQuery, `http://localhost:8080${pathAndQuery}`];
  let lastError = null;

  for (const url of endpoints) {
    try {
      const res = await fetch(url, options);
      if (res.ok) {
        return await res.json();
      }
      const errText = await res.text();
      lastError = new Error(errText || `Request failed (${res.status})`);
      // If it's an explicit 4xx auth/validation response from a reachable server, throw immediately
      if (res.status >= 400 && res.status < 500) {
        throw lastError;
      }
    } catch (err) {
      lastError = err;
      if (err.message && !err.message.includes('Failed to fetch') && !err.message.includes('NetworkError')) {
        throw err;
      }
    }
  }
  throw lastError || new Error('Unable to reach the Go music server.');
}

function stopOtherAudio(currentAudio) {
  if (activeAudio && activeAudio !== currentAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    if (activeButton) {
      activeButton.textContent = getPlayButtonLabel(true);
    }
  }
  if (quizState.audio && quizState.audio !== currentAudio) {
    quizState.audio.pause();
  }
  activeAudio = currentAudio;
}

function updateNowPlaying(title, artist, trackObj, indexInList, isFullSong = false) {
  const nowPlaying = document.getElementById('nowPlaying');
  const subMeta = document.getElementById('deckSubMeta');
  const artworkWrap = document.getElementById('deckArtworkWrap');
  const queuePos = document.getElementById('deckQueuePos');
  const masterPlayBtn = document.getElementById('masterPlayBtn');

  if (title && artist) {
    const modeTag = isFullSong ? '[Full Song]' : '[30s Preview]';
    nowPlaying.textContent = `Now playing: ${title} — ${artist}`;
    const album = trackObj && trackObj.collectionName ? trackObj.collectionName : 'Single';
    const year = trackObj && trackObj.releaseDate ? trackObj.releaseDate.slice(0, 4) : '';
    subMeta.textContent = [modeTag, album, trackObj?.primaryGenreName, year].filter(Boolean).join(' · ');

    const artUrl = (trackObj && (trackObj.artworkUrl600 || trackObj.artworkUrl100)) || '';
    if (artUrl) {
      artworkWrap.innerHTML = `<img src="${escapeHtml(artUrl)}" alt="${escapeHtml(title)} cover" referrerpolicy="no-referrer">`;
    }
    if (typeof indexInList === 'number' && indexInList >= 0) {
      queuePos.textContent = `Track ${indexInList + 1} / ${currentRenderedList.length}`;
    } else {
      queuePos.textContent = isFullSong ? 'Full Track' : '30s Preview';
    }
    if (masterPlayBtn) {
      masterPlayBtn.textContent = '⏸ Pause';
    }
  } else {
    nowPlaying.textContent = 'Pick a song to start listening.';
    subMeta.textContent = isLoggedIn()
      ? 'Full-Track Member Mode active — select any track to play the full song.'
      : 'Guests hear 30s previews. Register to unlock full songs.';
    queuePos.textContent = 'Idle';
    if (masterPlayBtn) {
      masterPlayBtn.textContent = '▶ Play';
    }
  }
}

function formatDuration(ms) {
  if (!ms || typeof ms !== 'number' || ms <= 0) return '';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

function formatSec(sec) {
  if (!sec || isNaN(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? '0' : ''}${rem}`;
}

function renderTracks(tracks, targetContainerId = 'results') {
  const container = document.getElementById(targetContainerId);
  const countLabel = document.getElementById('resultsCount');
  if (!container) return;
  container.innerHTML = '';

  if (targetContainerId === 'results') {
    currentRenderedList = Array.isArray(tracks) ? tracks : [];
  }

  if (!Array.isArray(tracks) || tracks.length === 0) {
    if (targetContainerId === 'results' && countLabel) {
      countLabel.textContent = allTracks.length
        ? `0 of ${allTracks.length} matching songs`
        : 'No results yet';
    }
    container.innerHTML = '<div class="status">No songs found for that search.</div>';
    return;
  }

  if (targetContainerId === 'results' && countLabel) {
    countLabel.textContent =
      tracks.length === allTracks.length
        ? `${tracks.length} matching songs`
        : `${tracks.length} of ${allTracks.length} matching songs`;
  }

  tracks.forEach((track, idx) => {
    const div = document.createElement('div');
    div.className = 'track';

    const rawTitle = track.trackName || 'Untitled track';
    const rawArtist = track.artistName || 'Unknown artist';
    div.dataset.title = rawTitle;
    div.dataset.artist = rawArtist;
    div.dataset.index = String(idx);

    const title = escapeHtml(rawTitle);
    const artist = escapeHtml(rawArtist);
    const artwork = track.artworkUrl100
      ? `<img src="${escapeHtml(track.artworkUrl100)}" alt="${title} album art" loading="lazy" referrerpolicy="no-referrer">`
      : '';

    const duration = formatDuration(track.trackTimeMillis);
    const genre = track.primaryGenreName ? escapeHtml(track.primaryGenreName) : '';
    const year = track.releaseDate ? escapeHtml(track.releaseDate.slice(0, 4)) : '';
    const albumText = track.collectionName ? escapeHtml(track.collectionName) : '';
    const metaParts = [albumText, genre, year, duration].filter(Boolean);
    const album = metaParts.length ? `<div class="meta mono-num">${metaParts.join(' · ')}</div>` : '';

    const inCrate = isTrackInCrate(track);
    const saveLabel = inCrate ? '★ Saved in Crate' : '+ Save to Crate';
    const saveClass = inCrate ? 'action-chip-btn saved' : 'action-chip-btn';

    const itunesLink = track.trackViewUrl
      ? `<a class="itunes-link" href="${escapeHtml(track.trackViewUrl)}" target="_blank" rel="noopener noreferrer">Open in iTunes ↗</a>`
      : '';

    const playBtnText = getPlayButtonLabel(true);

    const preview = track.previewUrl
      ? `
        <div class="preview-row">
          <button class="play-btn" type="button">${playBtnText}</button>
          <button class="action-chip-btn" type="button" onclick="loadLyricsForTrack(${idx})">Lyrics</button>
          <button class="action-chip-btn" type="button" onclick="inspectArtist(${idx})">Artist Discography</button>
          <button class="${saveClass}" type="button" onclick="toggleTrackInCrate(${idx})">${saveLabel}</button>
          ${itunesLink}
        </div>
        <audio preload="none" crossorigin="anonymous" class="preview-audio" data-preview-src="${escapeHtml(track.previewUrl)}"><source src="${escapeHtml(track.previewUrl)}" type="audio/mpeg"></audio>
      `
      : `<div class="meta">Preview not available for this track. ${itunesLink}</div>`;

    div.innerHTML = `
      <div class="track-card">
        ${artwork}
        <div class="track-info">
          <div class="track-header-row">
            <strong>${title}</strong>
          </div>
          <button type="button" class="artist-btn" onclick="inspectArtist(${idx})" title="Explore ${artist} discography">${artist}</button>
          ${album}
          ${preview}
        </div>
      </div>
    `;
    container.appendChild(div);
  });

  bindTrackAudioEvents(container, tracks);
}

function bindTrackAudioEvents(container, tracks) {
  const audios = container.querySelectorAll('.preview-audio');
  audios.forEach((audio, idx) => {
    const card = audio.closest('.track');
    const button = card ? card.querySelector('.play-btn') : null;
    const trackObj = tracks[idx];

    if (button) {
      button.addEventListener('click', () => {
        if (!audio.paused) {
          audio.pause();
          return;
        }
        playSpecificAudio(audio, button, card, trackObj, idx);
      });
    }

    audio.addEventListener('play', () => {
      stopOtherAudio(audio);
      activeButton = button;
      activeTrackIndex = idx;
      activeTrackObject = trackObj;
      applySpeedToAudio(audio);

      container.querySelectorAll('.track').forEach(el => el.classList.remove('is-playing'));
      if (card) card.classList.add('is-playing');

      if (button) {
        button.textContent = getPlayButtonLabel(false);
      }
      if (card) {
        updateNowPlaying(card.dataset.title, card.dataset.artist, trackObj, idx, isLoggedIn());
      }
      startVisualizer(audio);
      if (trackObj) {
        fetchAndRenderLyrics(trackObj.trackName, trackObj.artistName);
      }
    });

    audio.addEventListener('timeupdate', () => {
      if (activeAudio === audio) {
        const curLabel = document.getElementById('currentTimeLabel');
        const durLabel = document.getElementById('durationTimeLabel');
        const slider = document.getElementById('seekSlider');
        const dur = audio.duration || (isLoggedIn() ? (trackObj?.trackTimeMillis ? trackObj.trackTimeMillis / 1000 : 210) : 30);
        if (curLabel) curLabel.textContent = formatSec(audio.currentTime);
        if (durLabel) durLabel.textContent = formatSec(dur);
        if (slider && dur > 0) {
          slider.value = String((audio.currentTime / dur) * 100);
        }
      }
    });

    audio.addEventListener('pause', () => {
      if (button) {
        button.textContent = getPlayButtonLabel(true);
      }
      const masterPlayBtn = document.getElementById('masterPlayBtn');
      if (masterPlayBtn && activeAudio === audio) {
        masterPlayBtn.textContent = '▶ Play';
      }
    });

    audio.addEventListener('ended', () => {
      if (button) {
        button.textContent = getPlayButtonLabel(true);
      }
      if (card) card.classList.remove('is-playing');

      const autoPlay = document.getElementById('autoPlayToggle');
      if (autoPlay && autoPlay.checked && idx + 1 < audios.length) {
        const nextAudio = audios[idx + 1];
        const nextCard = nextAudio.closest('.track');
        const nextBtn = nextCard ? nextCard.querySelector('.play-btn') : null;
        playSpecificAudio(nextAudio, nextBtn, nextCard, tracks[idx + 1], idx + 1);
      } else {
        updateNowPlaying('', '');
      }
    });
  });
}

async function playSpecificAudio(audio, button, card, trackObj, idx) {
  stopOtherAudio(audio);
  activeButton = button;
  activeTrackIndex = idx;
  activeTrackObject = trackObj;

  const sourceToggle = document.getElementById('fullSongSourceToggle');
  const ytWrap = document.getElementById('youtubeEmbedWrap');

  // If the user is logged in, fetch the unlocked Full-Length Song stream from the Go backend (/fulltrack)
  if (isLoggedIn() && trackObj) {
    if (button) button.textContent = 'Loading Full Song...';
    try {
      const fullData = await apiFetch(
        `/fulltrack?track=${encodeURIComponent(trackObj.trackName)}&artist=${encodeURIComponent(trackObj.artistName)}`,
        {
          headers: { Authorization: `Bearer ${authToken}` },
        }
      );
      currentFullTrackData = fullData;

      if (fullData && fullData.fullAudioUrl) {
        if (audio.dataset.loadedSrc !== fullData.fullAudioUrl) {
          audio.src = fullData.fullAudioUrl;
          audio.dataset.loadedSrc = fullData.fullAudioUrl;
          audio.load();
        }
      }

      if (sourceToggle) {
        if (fullData && fullData.youtubeId) {
          sourceToggle.classList.remove('hidden');
        } else {
          sourceToggle.classList.add('hidden');
        }
      }

      if (fullTrackSourceMode === 'youtube' && fullData && fullData.youtubeId) {
        renderYoutubeEmbed(fullData.youtubeId);
        updateNowPlaying(trackObj.trackName, trackObj.artistName, trackObj, idx, true);
        fetchAndRenderLyrics(trackObj.trackName, trackObj.artistName);
        if (button) button.textContent = getPlayButtonLabel(false);
        return;
      } else if (ytWrap) {
        ytWrap.classList.add('hidden');
        ytWrap.innerHTML = '';
      }
    } catch (_) {
      // Fallback to preview stream if fulltrack fails
    }
  } else {
    // Guest Mode: ensure 30-second preview URL is used
    currentFullTrackData = null;
    if (sourceToggle) sourceToggle.classList.add('hidden');
    if (ytWrap) {
      ytWrap.classList.add('hidden');
      ytWrap.innerHTML = '';
    }
    const previewSrc = audio.dataset.previewSrc || (trackObj && trackObj.previewUrl) || '';
    if (previewSrc && audio.dataset.loadedSrc && audio.dataset.loadedSrc !== previewSrc) {
      audio.src = previewSrc;
      audio.dataset.loadedSrc = previewSrc;
      audio.load();
    }
  }

  applySpeedToAudio(audio);
  audio.play().catch(() => {
    audio.removeAttribute('crossorigin');
    audio.load();
    applySpeedToAudio(audio);
    audio.play().catch(() => {
      updateNowPlaying('', '');
      if (button) button.textContent = getPlayButtonLabel(true);
    });
  });
}

function switchFullTrackSource(mode) {
  fullTrackSourceMode = mode;
  document.getElementById('srcBtnStudio')?.classList.toggle('active', mode === 'studio');
  document.getElementById('srcBtnYoutube')?.classList.toggle('active', mode === 'youtube');

  const ytWrap = document.getElementById('youtubeEmbedWrap');
  if (mode === 'youtube' && currentFullTrackData && currentFullTrackData.youtubeId) {
    if (activeAudio && !activeAudio.paused) {
      activeAudio.pause();
    }
    renderYoutubeEmbed(currentFullTrackData.youtubeId);
  } else {
    if (ytWrap) {
      ytWrap.classList.add('hidden');
      ytWrap.innerHTML = '';
    }
    if (activeAudio && activeTrackObject) {
      const card = activeAudio.closest('.track');
      playSpecificAudio(activeAudio, activeButton, card, activeTrackObject, activeTrackIndex);
    }
  }
}

function renderYoutubeEmbed(videoId) {
  const ytWrap = document.getElementById('youtubeEmbedWrap');
  if (!ytWrap || !videoId) return;
  ytWrap.classList.remove('hidden');
  ytWrap.innerHTML = `
    <iframe
      src="https://www.youtube-nocookie.com/embed/${escapeHtml(videoId)}?autoplay=1&rel=0"
      title="Official Full Track Player"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowfullscreen>
    </iframe>
  `;
}

function applySpeedToAudio(audio) {
  if (!audio) return;
  audio.playbackRate = currentPlaybackRate;
  if ('preservesPitch' in audio) {
    audio.preservesPitch = currentPlaybackRate === 1.0;
  } else if ('mozPreservesPitch' in audio) {
    audio.mozPreservesPitch = currentPlaybackRate === 1.0;
  } else if ('webkitPreservesPitch' in audio) {
    audio.webkitPreservesPitch = currentPlaybackRate === 1.0;
  }
}

function setPlaybackSpeed(rate) {
  currentPlaybackRate = rate;
  document.querySelectorAll('.pitch-controls .seg-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.rate) === rate);
  });
  if (activeAudio) {
    applySpeedToAudio(activeAudio);
  }
}

function toggleMasterPlayback() {
  if (activeAudio) {
    if (activeAudio.paused) {
      activeAudio.play();
    } else {
      activeAudio.pause();
    }
    return;
  }
  const firstBtn = document.querySelector('#results .play-btn');
  if (firstBtn) {
    firstBtn.click();
  }
}

function playAdjacentTrack(direction) {
  const audios = document.querySelectorAll('#results .preview-audio');
  if (!audios.length) return;
  let nextIdx = activeTrackIndex + direction;
  if (nextIdx < 0) nextIdx = 0;
  if (nextIdx >= audios.length) nextIdx = 0;
  const targetAudio = audios[nextIdx];
  const card = targetAudio ? targetAudio.closest('.track') : null;
  const btn = card ? card.querySelector('.play-btn') : null;
  if (btn) btn.click();
}

document.addEventListener('DOMContentLoaded', () => {
  updateCrateCountUI();
  verifyExistingSession();
  drawIdleVisualizer();

  const slider = document.getElementById('seekSlider');
  if (slider) {
    slider.addEventListener('input', () => {
      if (activeAudio && activeAudio.duration) {
        activeAudio.currentTime = (Number(slider.value) / 100) * activeAudio.duration;
      }
    });
  }

  const queryInput = document.getElementById('query');
  if (queryInput && !queryInput.value) {
    queryInput.value = 'Daft Punk';
    search();
  }
});

// Visualizer Canvas
function drawIdleVisualizer() {
  const canvas = document.getElementById('visualizerCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const bars = 32;
  const barWidth = (canvas.width - (bars - 1) * 3) / bars;
  ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
  for (let i = 0; i < bars; i++) {
    const h = 6 + Math.sin(i * 0.4) * 3;
    ctx.fillRect(i * (barWidth + 3), canvas.height - h, barWidth, h);
  }
}

function startVisualizer(audio) {
  const canvas = document.getElementById('visualizerCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  try {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    if (!connectedAudios.has(audio) && audio.getAttribute('crossorigin')) {
      const src = audioCtx.createMediaElementSource(audio);
      src.connect(analyser);
      analyser.connect(audioCtx.destination);
      connectedAudios.add(audio);
    }
  } catch (_) {
    // Fallback to rhythmic envelope if browser restricts cross-origin Web Audio
  }

  if (visualizerAnimId) cancelAnimationFrame(visualizerAnimId);
  const bufferLength = analyser ? analyser.frequencyBinCount : 32;
  const dataArray = new Uint8Array(bufferLength);

  function renderFrame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const isPlaying = activeAudio && !activeAudio.paused;

    if (analyser && isPlaying) {
      analyser.getByteFrequencyData(dataArray);
    }

    const bars = 32;
    const barWidth = (canvas.width - (bars - 1) * 3) / bars;
    const t = performance.now() / 160;

    for (let i = 0; i < bars; i++) {
      let val = dataArray[i] || 0;
      if (isPlaying && val === 0) {
        val = (Math.sin(t + i * 0.45) * 0.45 + Math.cos(t * 1.7 - i * 0.3) * 0.35 + 0.6) * 145 * currentPlaybackRate;
      } else if (!isPlaying) {
        val = 12;
      }
      const barHeight = Math.max(4, (val / 255) * (canvas.height - 8));
      ctx.fillStyle = isPlaying ? '#10b981' : 'rgba(56, 189, 248, 0.25)';
      ctx.fillRect(i * (barWidth + 3), canvas.height - barHeight, barWidth, barHeight);
    }

    if (isPlaying) {
      visualizerAnimId = requestAnimationFrame(renderFrame);
    }
  }

  renderFrame();
}

// Lyrics Studio (calls Go backend /lyrics endpoint)
function loadLyricsForTrack(index) {
  const track = currentRenderedList[index];
  if (!track) return;
  fetchAndRenderLyrics(track.trackName, track.artistName);
  focusLyricsStudio();
}

function focusLyricsStudio() {
  const panel = document.getElementById('lyrics-panel');
  if (panel) {
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

async function fetchAndRenderLyrics(trackName, artistName) {
  const label = document.getElementById('lyricsTrackLabel');
  const content = document.getElementById('lyricsContent');
  const copyBtn = document.getElementById('copyLyricsBtn');
  if (!content || !label) return;

  label.textContent = `${trackName} — ${artistName}`;
  content.innerHTML = '<div class="lyrics-empty">Fetching synced lyrics from Go backend...</div>';
  if (copyBtn) copyBtn.classList.add('hidden');

  try {
    const data = await apiFetch(
      `/lyrics?track=${encodeURIComponent(trackName)}&artist=${encodeURIComponent(artistName)}`
    );
    if (data && data.found && (data.syncedLyrics || data.plainLyrics)) {
      currentLyricsText = data.plainLyrics || data.syncedLyrics;
      if (copyBtn) copyBtn.classList.remove('hidden');

      if (data.syncedLyrics) {
        const lines = data.syncedLyrics.split('\n').filter(Boolean);
        content.innerHTML = lines
          .map(line => {
            const match = line.match(/^\[(\d{2}:\d{2})\.\d{2,3}\]\s*(.*)$/);
            if (match) {
              return `<div class="lyric-line synced-time"><span class="lyric-timestamp mono-num">${escapeHtml(match[1])}</span><span>${escapeHtml(match[2] || '♪')}</span></div>`;
            }
            return `<div class="lyric-line">${escapeHtml(line)}</div>`;
          })
          .join('');
      } else {
        content.textContent = data.plainLyrics;
      }
    } else {
      currentLyricsText = '';
      content.innerHTML = `<div class="lyrics-empty">No archived lyrics found for "${escapeHtml(trackName)}". Try playing another track from the search results.</div>`;
    }
  } catch (_) {
    content.innerHTML = '<div class="lyrics-empty">Unable to load lyrics at this moment.</div>';
  }
}

function copyCurrentLyrics() {
  if (!currentLyricsText) return;
  navigator.clipboard?.writeText(currentLyricsText);
  const copyBtn = document.getElementById('copyLyricsBtn');
  if (copyBtn) {
    const prev = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyBtn.textContent = prev;
    }, 1500);
  }
}

// Artist Discography Spotlight (calls Go backend /artist endpoint using concurrent goroutines)
async function inspectArtist(index) {
  const track = currentRenderedList[index];
  if (!track || !track.artistName) return;

  const spotlight = document.getElementById('artistSpotlight');
  if (!spotlight) return;

  spotlight.classList.remove('hidden');
  spotlight.innerHTML = `<div class="status">Loading ${escapeHtml(track.artistName)} discography via Go concurrent worker...</div>`;

  try {
    const data = await apiFetch(`/artist?name=${encodeURIComponent(track.artistName)}`);
    const albums = Array.isArray(data.albums) ? data.albums : [];

    if (!albums.length) {
      spotlight.innerHTML = `
        <div class="spotlight-top">
          <h2>${escapeHtml(track.artistName)} — Discography</h2>
          <button type="button" class="btn-ghost btn-sm" onclick="closeArtistSpotlight()">Close ✕</button>
        </div>
        <div class="meta">No additional albums found for this artist.</div>
      `;
      return;
    }

    const albumCards = albums
      .map(album => {
        const year = album.releaseDate ? album.releaseDate.slice(0, 4) : '';
        const count = album.trackCount ? `${album.trackCount} tracks` : '';
        const meta = [year, count].filter(Boolean).join(' · ');
        const safeAlbumName = escapeHtml(album.collectionName || 'Album');
        return `
          <button type="button" class="album-item" onclick="quickSearch(${escapeHtml(JSON.stringify(`${track.artistName} ${album.collectionName}`))})">
            <img src="${escapeHtml(album.artworkUrl100 || '')}" alt="${safeAlbumName}" loading="lazy" referrerpolicy="no-referrer">
            <span class="album-title">${safeAlbumName}</span>
            <span class="album-meta mono-num">${escapeHtml(meta)}</span>
          </button>
        `;
      })
      .join('');

    spotlight.innerHTML = `
      <div class="spotlight-top">
        <h2>${escapeHtml(track.artistName)} — Studio Albums &amp; Releases</h2>
        <button type="button" class="btn-ghost btn-sm" onclick="closeArtistSpotlight()">Close ✕</button>
      </div>
      <div class="album-strip">${albumCards}</div>
    `;
  } catch (_) {
    spotlight.classList.add('hidden');
  }
}

function closeArtistSpotlight() {
  const spotlight = document.getElementById('artistSpotlight');
  if (spotlight) spotlight.classList.add('hidden');
}

function filterResults() {
  const filterValue = (document.getElementById('filterInput')?.value || '').trim().toLowerCase();
  const sortMode = document.getElementById('sortSelect')?.value || 'default';

  let filtered = allTracks.filter(track => {
    if (!filterValue) return true;
    const title = (track.trackName || '').toLowerCase();
    const artist = (track.artistName || '').toLowerCase();
    const album = (track.collectionName || '').toLowerCase();
    return title.includes(filterValue) || artist.includes(filterValue) || album.includes(filterValue);
  });

  if (sortMode === 'year-desc') {
    filtered = [...filtered].sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')));
  } else if (sortMode === 'year-asc') {
    filtered = [...filtered].sort((a, b) => String(a.releaseDate || '').localeCompare(String(b.releaseDate || '')));
  } else if (sortMode === 'duration-desc') {
    filtered = [...filtered].sort((a, b) => (b.trackTimeMillis || 0) - (a.trackTimeMillis || 0));
  }

  renderTracks(filtered);
}

function quickSearch(term) {
  const input = document.getElementById('query');
  if (input) {
    input.value = term;
    switchTab('discover');
    search();
  }
}

async function search() {
  const query = document.getElementById('query').value.trim();
  if (!query) return;

  stopOtherAudio(null);
  updateNowPlaying('', '');
  closeArtistSpotlight();

  const container = document.getElementById('results');
  container.innerHTML = '<div class="status">Searching...</div>';

  try {
    const tracks = await apiFetch(`/search?q=${encodeURIComponent(query)}`);
    allTracks = Array.isArray(tracks) ? tracks : [];
    container.innerHTML = '';

    if (!allTracks.length) {
      document.getElementById('resultsCount').textContent = 'No results yet';
      updateNowPlaying('', '');
      container.innerHTML = '<div class="status">No songs found for that search.</div>';
      return;
    }

    filterResults();
  } catch (error) {
    container.innerHTML = `<div class="status error">${escapeHtml(error.message)}</div>`;
  }
}

// Navigation Tabs: Discover | Blind Quiz | Saved Crate
function switchTab(tabName) {
  ['discover', 'quiz', 'crate'].forEach(name => {
    const view = document.getElementById(`view-${name}`);
    const nav = document.getElementById(`nav-${name}`);
    if (view) view.classList.toggle('hidden', name !== tabName);
    if (nav) nav.classList.toggle('active', name === tabName);
  });

  if (tabName === 'quiz') {
    startNewQuizRound();
  } else if (tabName === 'crate') {
    renderCrateView();
  }
}

// Blind Listening Quiz Mode
function startNewQuizRound() {
  const body = document.getElementById('quizBody');
  if (!body) return;

  const playablePool = allTracks.filter(t => t.previewUrl && t.trackName);
  if (playablePool.length < 4) {
    body.innerHTML = `
      <div class="status">
        Search for an artist or genre with at least 4 previewable songs first to play the Blind Audio Quiz.
      </div>
    `;
    return;
  }

  stopOtherAudio(null);
  quizState.answered = false;

  const shuffled = [...playablePool].sort(() => Math.random() - 0.5).slice(0, 4);
  const answer = shuffled[Math.floor(Math.random() * shuffled.length)];
  quizState.currentTrack = answer;
  quizState.options = shuffled;

  if (quizState.audio) {
    quizState.audio.pause();
  }
  quizState.audio = new Audio(answer.previewUrl);
  quizState.audio.play().catch(() => {});

  const optionButtons = shuffled
    .map(
      (opt, idx) => `
      <button type="button" class="quiz-option-btn" id="quiz-opt-${idx}" onclick="submitQuizGuess(${idx})">
        <strong>${escapeHtml(opt.trackName)}</strong>
        <span class="meta">${escapeHtml(opt.artistName)} · ${escapeHtml(opt.collectionName || 'Single')}</span>
      </button>
    `
    )
    .join('');

  body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;">
      <div>
        <strong>Mystery Track Playing...</strong>
        <div class="meta">Which song from your current catalog is playing right now?</div>
      </div>
      <div style="display:flex;gap:0.5rem;">
        <button type="button" class="btn-secondary" onclick="replayQuizAudio()">🔊 Replay Mystery Clip</button>
        <button type="button" class="btn-primary" onclick="startNewQuizRound()">Skip / Next Round →</button>
      </div>
    </div>
    <div class="quiz-options">${optionButtons}</div>
    <div id="quizFeedback"></div>
  `;
}

function replayQuizAudio() {
  if (quizState.audio) {
    quizState.audio.currentTime = 0;
    quizState.audio.play().catch(() => {});
  }
}

function submitQuizGuess(selectedIndex) {
  if (quizState.answered) return;
  quizState.answered = true;
  quizState.total += 1;

  const chosen = quizState.options[selectedIndex];
  const correct = quizState.currentTrack;
  const isCorrect = chosen && correct && chosen.trackName === correct.trackName;

  if (isCorrect) {
    quizState.score += 1;
    quizState.streak += 1;
  } else {
    quizState.streak = 0;
  }

  document.getElementById('quizScore').textContent = `${quizState.score} / ${quizState.total}`;
  document.getElementById('quizStreak').textContent = String(quizState.streak);

  quizState.options.forEach((opt, idx) => {
    const btn = document.getElementById(`quiz-opt-${idx}`);
    if (!btn) return;
    btn.disabled = true;
    if (opt.trackName === correct.trackName) {
      btn.classList.add('correct');
    } else if (idx === selectedIndex && !isCorrect) {
      btn.classList.add('wrong');
    }
  });

  const feedback = document.getElementById('quizFeedback');
  if (feedback && correct) {
    const msg = isCorrect ? 'Spot on! You nailed that track.' : `Not quite — the mystery track was "${correct.trackName}".`;
    feedback.innerHTML = `
      <div class="track" style="margin-top:0.75rem;">
        <div class="track-card">
          ${correct.artworkUrl100 ? `<img src="${escapeHtml(correct.artworkUrl100)}" alt="cover" referrerpolicy="no-referrer">` : ''}
          <div class="track-info">
            <strong>${escapeHtml(msg)}</strong>
            <div class="meta">${escapeHtml(correct.trackName)} — ${escapeHtml(correct.artistName)} (${escapeHtml(correct.collectionName || '')})</div>
            <button type="button" class="btn-primary" style="margin-top:0.4rem;" onclick="startNewQuizRound()">Next Mystery Track →</button>
          </div>
        </div>
      </div>
    `;
  }
}

// Saved Crate View & M3U Export
function renderCrateView() {
  const container = document.getElementById('crateResults');
  if (!container) return;

  if (!savedCrate.length) {
    container.innerHTML = '<div class="status">Your crate is empty. Click "+ Save to Crate" on any song in Discover to build your playlist.</div>';
    return;
  }

  currentRenderedList = savedCrate;
  renderTracks(savedCrate, 'crateResults');
}

function playAllCrate() {
  if (!savedCrate.length) return;
  renderCrateView();
  const firstBtn = document.querySelector('#crateResults .play-btn');
  if (firstBtn) firstBtn.click();
}

function clearCrate() {
  savedCrate = [];
  saveCrateToStorage();
  renderCrateView();
}

function exportCrateM3U() {
  const list = savedCrate.length ? savedCrate : allTracks;
  if (!list.length) return;

  const lines = ['#EXTM3U'];
  list.forEach(track => {
    if (track.previewUrl) {
      const secs = track.trackTimeMillis ? Math.round(track.trackTimeMillis / 1000) : 30;
      lines.push(`#EXTINF:${secs},${track.artistName || 'Unknown'} - ${track.trackName || 'Track'}`);
      lines.push(track.previewUrl);
    }
  });

  const blob = new Blob([lines.join('\n')], { type: 'audio/x-mpegurl;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sonic-crate-playlist.m3u';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
