let activeAudio = null;
let activeButton = null;
let activeTrackIndex = -1;
let activeTrackObject = null;
let currentRenderedList = [];
let allTracks = [];
let currentPlaybackRate = 1.0;
let currentLyricsText = '';
let lastLyricsResponse = null;
let trackDensityMode = 'grid'; // 'grid' (2-Column Grid) | 'compact' (Single-Row Compact)
let splitLyricsActive = false;
let lyricsColumnMode = 'two-col'; // 'two-col' | 'one-col'

// Weekly Recommendations State
let weeklyForYouTracks = [];
let weeklyHitsTracks = [];
let weeklyFilterMode = 'all'; // 'all' | 'activity' | 'hits'
const ACTIVITY_STORAGE_KEY = 'sonic_crate_user_activity_v1';
let userActivity = loadUserActivity();

// Auth State (Guest = 30s Previews, Logged-in Member = Full-Length Songs)
const AUTH_TOKEN_KEY = 'sonic_crate_auth_token_v1';
const AUTH_USER_KEY = 'sonic_crate_auth_user_v1';
const VERIFY_LINK_KEY = 'sonic_crate_verify_link_v1';
let authToken = localStorage.getItem(AUTH_TOKEN_KEY) || '';
let currentUser = loadUserFromStorage();
let pendingVerificationLink = localStorage.getItem(VERIFY_LINK_KEY) || '';
let authModalMode = 'register';
let currentFullTrackData = null;
let fullTrackSourceMode = 'studio'; // 'studio' (Audio-Only Full Song) | 'youtube' (Video + Audio Full Song)
const fullTrackClientCache = new Map();

// Firebase Auth & Firestore State
let fbApp = null;
let fbAuth = null;
let fbDb = null;
let fbModules = null;
let fbInitPromise = null;

const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

function handleFirestoreError(error, operationType, path) {
  const activeFbUser = fbAuth?.currentUser;
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: activeFbUser?.uid || null,
      email: activeFbUser?.email || null,
      emailVerified: activeFbUser?.emailVerified ?? null,
      isAnonymous: activeFbUser?.isAnonymous ?? null,
      tenantId: activeFbUser?.tenantId || null,
      providerInfo:
        activeFbUser?.providerData?.map(provider => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function initFirebaseClient() {
  if (fbInitPromise) return fbInitPromise;
  fbInitPromise = (async () => {
    try {
      const cfgResp = await fetch('/firebase-applet-config.json');
      if (!cfgResp.ok) return null;
      const firebaseConfig = await cfgResp.json();
      if (!firebaseConfig || !firebaseConfig.apiKey) return null;

      const [appMod, authMod, firestoreMod] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'),
        import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'),
      ]);

      fbModules = { ...appMod, ...authMod, ...firestoreMod };
      fbApp = appMod.initializeApp(firebaseConfig);
      fbAuth = authMod.getAuth(fbApp);
      fbDb = firestoreMod.getFirestore(fbApp, firebaseConfig.firestoreDatabaseId);

      // Validate connection to Firestore on boot
      try {
        await firestoreMod.getDocFromServer(firestoreMod.doc(fbDb, 'test', 'connection'));
      } catch (connErr) {
        if (connErr instanceof Error && connErr.message.includes('the client is offline')) {
          console.error('Please check your Firebase configuration.');
        }
      }

      authMod.onAuthStateChanged(fbAuth, async fbUser => {
        if (fbUser && fbUser.email) {
          if (fbUser.emailVerified) {
            await syncVerifiedUserToFirestore(fbUser, fbUser.displayName || currentUser?.name || '');
          }
        }
      });

      return { fbApp, fbAuth, fbDb, fbModules };
    } catch (err) {
      console.warn('Firebase client initialization skipped:', err);
      return null;
    }
  })();
  return fbInitPromise;
}

// Enforce blueprint constraints (ownerId ^[a-zA-Z0-9_\-]+$ <= 128, displayName 1..80, email 3..254)
async function syncVerifiedUserToFirestore(fbUser, preferredName = '') {
  if (!fbDb || !fbModules || !fbUser || !fbUser.uid || !fbUser.emailVerified) return;
  const uid = String(fbUser.uid).trim().slice(0, 128);
  if (!/^[a-zA-Z0-9_\-]+$/.test(uid)) return;

  const email = String(fbUser.email || '').trim().toLowerCase().slice(0, 254);
  if (email.length < 3) return;

  const rawName = String(preferredName || fbUser.displayName || email.split('@')[0] || 'Member').trim();
  const displayName = rawName.slice(0, 80) || 'Member';

  const userDocRef = fbModules.doc(fbDb, 'users', uid);
  const privDocRef = fbModules.doc(fbDb, 'users', uid, 'private', 'info');

  try {
    const existingSnap = await fbModules.getDoc(userDocRef);
    const nowTs = fbModules.serverTimestamp();
    if (!existingSnap.exists()) {
      const batch = fbModules.writeBatch(fbDb);
      batch.set(userDocRef, {
        ownerId: uid,
        displayName,
        emailVerified: true,
        createdAt: nowTs,
        updatedAt: nowTs,
      });
      batch.set(privDocRef, {
        ownerId: uid,
        email,
        createdAt: nowTs,
      });
      await batch.commit();
    } else {
      await fbModules.updateDoc(userDocRef, {
        displayName,
        emailVerified: true,
        updatedAt: nowTs,
      });
    }
  } catch (err) {
    try {
      handleFirestoreError(err, OperationType.WRITE, `/users/${uid}`);
    } catch (_) {
      // Logged structured FirestoreErrorInfo
    }
  }
}

// YouTube IFrame Full-Song Engine State
let ytPlayer = null;
let ytPlayerReady = false;
let ytUsingFullEngine = false;
let ytIsPlaying = false;
let ytProgressTimer = null;
let pendingYtVideoId = '';

// Saved Crate persisted in localStorage
const CRATE_STORAGE_KEY = 'sonic_crate_saved_tracks_v1';
let savedCrate = loadCrateFromStorage();

// Recently Played (last 10 songs in current session)
const RECENT_SESSION_KEY = 'sonic_crate_recent_session_v1';
const MAX_RECENT_SONGS = 10;
let recentlyPlayed = loadRecentlyPlayedFromSession();
let standaloneRecentAudio = null;

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

// Visualizer & Studio Fade Envelope State
let visualizerAnimId = null;
let audioCtx = null;
let analyser = null;
let masterGainNode = null;
let connectedAudios = new WeakSet();
let fadeAnimFrameId = null;
let isFadingIn = false;

function cancelStudioFade() {
  if (fadeAnimFrameId) {
    cancelAnimationFrame(fadeAnimFrameId);
    fadeAnimFrameId = null;
  }
  isFadingIn = false;
}

function setAudioGainValue(audio, level) {
  const clamped = Math.max(0.001, Math.min(1, level));
  if (audio) {
    try {
      audio.volume = clamped;
    } catch (_) {}
  }
  if (masterGainNode && audioCtx) {
    try {
      masterGainNode.gain.setValueAtTime(clamped, audioCtx.currentTime);
    } catch (_) {}
  }
}

// Smooth S-curve studio fade-in so 30s mid-song previews enter gracefully instead of jumping in abruptly
function startGracefulFadeIn(audio, durationMs = 2000, startLevel = 0.01) {
  if (!audio) return;
  cancelStudioFade();
  isFadingIn = true;
  setAudioGainValue(audio, startLevel);

  const startTime = performance.now();
  function step(now) {
    if (!audio || audio.paused) {
      isFadingIn = false;
      fadeAnimFrameId = null;
      return;
    }
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / durationMs);
    // Smooth cosine S-curve (starts very gently, swells naturally to 1.0)
    const eased = startLevel + (1 - startLevel) * (0.5 - 0.5 * Math.cos(progress * Math.PI));
    setAudioGainValue(audio, eased);

    if (progress < 1) {
      fadeAnimFrameId = requestAnimationFrame(step);
    } else {
      isFadingIn = false;
      fadeAnimFrameId = null;
      setAudioGainValue(audio, 1);
    }
  }

  fadeAnimFrameId = requestAnimationFrame(step);
}

// Smooth studio fade-out near the end of a 30-second preview clip
function applyPreviewEndFadeOut(audio) {
  if (!audio || audio.paused || isFadingIn) return;
  const dur = audio.duration || 30;
  const remaining = dur - audio.currentTime;
  const fadeOutWindow = 2.4;
  if (dur > 5 && remaining > 0 && remaining <= fadeOutWindow) {
    const ratio = Math.max(0.03, remaining / fadeOutWindow);
    const easedOut = 0.5 - 0.5 * Math.cos(ratio * Math.PI);
    setAudioGainValue(audio, Math.max(0.03, easedOut));
  } else if (!isFadingIn) {
    setAudioGainValue(audio, 1);
  }
}

// Gentle 220ms fade-out when user clicks Pause so audio never clicks abruptly
function gracefulPauseAudio(audio) {
  if (!audio || audio.paused) return;
  cancelStudioFade();
  const startVol = audio.volume || 1;
  const durationMs = 220;
  const startTime = performance.now();

  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / durationMs);
    const level = startVol * (1 - progress);
    setAudioGainValue(audio, Math.max(0.01, level));
    if (progress < 1) {
      fadeAnimFrameId = requestAnimationFrame(step);
    } else {
      fadeAnimFrameId = null;
      audio.pause();
      setAudioGainValue(audio, 1);
    }
  }
  fadeAnimFrameId = requestAnimationFrame(step);
}

function loadUserActivity() {
  try {
    const raw = localStorage.getItem(ACTIVITY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        artists: Array.isArray(parsed.artists) ? parsed.artists : [],
        genres: Array.isArray(parsed.genres) ? parsed.genres : [],
        searches: Array.isArray(parsed.searches) ? parsed.searches : [],
      };
    }
  } catch (_) {}
  return { artists: [], genres: [], searches: [] };
}

function saveUserActivity() {
  try {
    localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(userActivity));
  } catch (_) {}
}

function recordActivitySignal({ artist = '', genre = '', searchQuery = '' } = {}) {
  const cleanArtist = String(artist || '').trim();
  const cleanGenre = String(genre || '').trim();
  const cleanSearch = String(searchQuery || '').trim();

  if (cleanArtist) {
    userActivity.artists = [
      cleanArtist,
      ...userActivity.artists.filter(a => a.toLowerCase() !== cleanArtist.toLowerCase()),
    ].slice(0, 8);
  }
  if (cleanGenre && cleanGenre.toLowerCase() !== 'music') {
    userActivity.genres = [
      cleanGenre,
      ...userActivity.genres.filter(g => g.toLowerCase() !== cleanGenre.toLowerCase()),
    ].slice(0, 6);
  }
  if (cleanSearch) {
    userActivity.searches = [
      cleanSearch,
      ...userActivity.searches.filter(s => s.toLowerCase() !== cleanSearch.toLowerCase()),
    ].slice(0, 6);
  }
  saveUserActivity();
}

function getActivityArtistsSeed() {
  const pool = [...userActivity.artists];
  recentlyPlayed.forEach(t => {
    if (t.artistName && !pool.some(a => a.toLowerCase() === t.artistName.toLowerCase())) {
      pool.push(t.artistName);
    }
  });
  savedCrate.forEach(t => {
    if (t.artistName && !pool.some(a => a.toLowerCase() === t.artistName.toLowerCase())) {
      pool.push(t.artistName);
    }
  });
  userActivity.searches.forEach(s => {
    if (s && !pool.some(a => a.toLowerCase() === s.toLowerCase())) {
      pool.push(s);
    }
  });
  return pool.slice(0, 4);
}

function getActivityGenresSeed() {
  const pool = [...userActivity.genres];
  recentlyPlayed.forEach(t => {
    if (t.primaryGenreName && !pool.some(g => g.toLowerCase() === t.primaryGenreName.toLowerCase())) {
      pool.push(t.primaryGenreName);
    }
  });
  savedCrate.forEach(t => {
    if (t.primaryGenreName && !pool.some(g => g.toLowerCase() === t.primaryGenreName.toLowerCase())) {
      pool.push(t.primaryGenreName);
    }
  });
  return pool.slice(0, 3);
}

function loadUserFromStorage() {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function saveAuthState(token, user, verifyLink = undefined) {
  authToken = token || '';
  currentUser = user || null;
  if (verifyLink !== undefined) {
    pendingVerificationLink = verifyLink || '';
  }
  try {
    if (authToken && currentUser) {
      localStorage.setItem(AUTH_TOKEN_KEY, authToken);
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(currentUser));
      if (pendingVerificationLink && !currentUser.emailVerified) {
        localStorage.setItem(VERIFY_LINK_KEY, pendingVerificationLink);
      } else {
        localStorage.removeItem(VERIFY_LINK_KEY);
      }
    } else {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_USER_KEY);
      localStorage.removeItem(VERIFY_LINK_KEY);
    }
  } catch (_) {
    // Ignore storage errors
  }
  updateAuthUI();
  if (isLoggedIn()) {
    prefetchTopTracks(currentRenderedList.slice(0, 6));
  }
}

function isLoggedIn() {
  return Boolean(authToken && currentUser && currentUser.email);
}

function getPlayButtonLabel(isPaused = true) {
  if (!isPaused) {
    return isLoggedIn() ? '⏸ Pause Full' : '⏸ Pause';
  }
  return isLoggedIn() ? '▶ Full Song' : '▶ 30s Preview';
}

function showVerificationBanner({ verified = false, message = '', verifyLink = '' } = {}) {
  const banner = document.getElementById('verificationNoticeBanner');
  const badge = document.getElementById('verificationBadgeLabel');
  const textEl = document.getElementById('verificationBannerText');
  const directBtn = document.getElementById('directVerifyLinkBtn');
  const resendBtn = document.getElementById('resendVerifyEmailBtn');
  const refreshBtn = document.getElementById('refreshVerifyStatusBtn');

  if (!banner) return;
  banner.classList.remove('hidden');
  banner.classList.toggle('verified-state', Boolean(verified));

  if (verified) {
    if (badge) badge.textContent = 'Email Verified ✓';
    if (textEl) {
      textEl.textContent =
        message ||
        `Account acknowledged! ${currentUser?.email || 'Your email'} is verified and synced with Firebase Authentication.`;
    }
    if (directBtn) directBtn.classList.add('hidden');
    if (resendBtn) resendBtn.classList.add('hidden');
    if (refreshBtn) refreshBtn.classList.add('hidden');
  } else {
    if (badge) badge.textContent = 'Verification Link Sent';
    if (textEl) {
      textEl.textContent =
        message ||
        `Account created for ${currentUser?.email || 'your email'}! Check your email inbox for the Firebase verification link, or click the acknowledgment link right here to confirm your account.`;
    }
    const linkToUse = verifyLink || pendingVerificationLink;
    if (directBtn) {
      if (linkToUse) {
        directBtn.href = linkToUse;
        directBtn.classList.remove('hidden');
      } else {
        directBtn.classList.add('hidden');
      }
    }
    if (resendBtn) resendBtn.classList.remove('hidden');
    if (refreshBtn) refreshBtn.classList.remove('hidden');
  }
}

function dismissVerificationBanner() {
  const banner = document.getElementById('verificationNoticeBanner');
  if (banner) banner.classList.add('hidden');
}

function getTimeOfDayGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 22) return 'Good evening';
  return 'Late-night studio session';
}

function getUserInitials(name, email) {
  const clean = String(name || email || 'SC').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function updateWelcomeBannerUI() {
  const welcomeBanner = document.getElementById('memberWelcomeBanner');
  if (!welcomeBanner) return;

  if (!isLoggedIn()) {
    welcomeBanner.classList.add('hidden');
    return;
  }

  welcomeBanner.classList.remove('hidden');

  const avatarEl = document.getElementById('welcomeAvatarInitials');
  const headlineEl = document.getElementById('welcomeHeadline');
  const verifyPillEl = document.getElementById('welcomeVerifyPill');
  const subtextEl = document.getElementById('welcomeSubtext');
  const resumeBtn = document.getElementById('welcomeResumeBtn');

  const displayName = (currentUser?.name || currentUser?.email?.split('@')[0] || 'Member').trim();
  const timeGreeting = getTimeOfDayGreeting();

  if (avatarEl) {
    avatarEl.textContent = getUserInitials(displayName, currentUser?.email);
  }
  if (headlineEl) {
    headlineEl.textContent = `Welcome back, ${displayName}! · ${timeGreeting}`;
  }
  if (verifyPillEl) {
    verifyPillEl.textContent = currentUser?.emailVerified
      ? 'Full-Song Member · Verified ✓'
      : 'Full-Song Member · Active';
  }

  const topArtists = getActivityArtistsSeed();
  const topArtist = topArtists.length > 0 ? topArtists[0] : '';
  const recentCount = recentlyPlayed.length;
  const crateCount = savedCrate.length;

  const summaryParts = [];
  if (recentCount > 0 && recentlyPlayed[0]?.trackName) {
    summaryParts.push(
      `Last played "${recentlyPlayed[0].trackName}" by ${recentlyPlayed[0].artistName || 'Unknown'}`
    );
  } else if (topArtist) {
    summaryParts.push(`Tuned to your ${topArtist} activity`);
  } else {
    summaryParts.push('Full-length studio audio & official video streaming unlocked');
  }

  summaryParts.push(`${crateCount} saved in Crate`);
  summaryParts.push(`${recentCount}/${MAX_RECENT_SONGS} session plays`);

  if (subtextEl) {
    subtextEl.textContent = summaryParts.join(' · ');
  }

  if (resumeBtn) {
    if (recentCount > 0 && recentlyPlayed[0]?.trackName) {
      resumeBtn.textContent = `▶ Resume "${recentlyPlayed[0].trackName.slice(0, 22)}${recentlyPlayed[0].trackName.length > 22 ? '…' : ''}"`;
      resumeBtn.classList.remove('hidden');
    } else {
      resumeBtn.classList.add('hidden');
    }
  }
}

function updateAuthUI() {
  const headerBtn = document.getElementById('authHeaderBtn');
  const tierStatus = document.getElementById('accessTierStatus');
  const deckModeLabel = document.getElementById('deckModeLabel');
  const guestBanner = document.getElementById('guestUpgradeBanner');
  const sourceToggle = document.getElementById('fullSongSourceToggle');
  const ytWrap = document.getElementById('youtubeEmbedWrap');

  if (isLoggedIn()) {
    const verifiedTag = currentUser.emailVerified ? '✓ Verified' : 'Pending Email Link';
    if (headerBtn) {
      headerBtn.textContent = `Sign Out (${currentUser.name})`;
      headerBtn.className = 'btn-secondary btn-auth';
    }
    if (tierStatus) {
      tierStatus.className = 'tier-text member-active';
      tierStatus.textContent = `Full-Track Member (${verifiedTag}) · ${currentUser.email}`;
    }
    if (deckModeLabel) {
      deckModeLabel.textContent = 'Listening Deck · Full-Song Member Mode';
    }
    if (guestBanner) {
      guestBanner.classList.add('hidden');
    }
    if (!currentUser.emailVerified && pendingVerificationLink) {
      showVerificationBanner({
        verified: false,
        verifyLink: pendingVerificationLink,
      });
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
      ytWrap.classList.add('studio-audio-hidden');
    }
  }

  document.querySelectorAll('.track .play-btn').forEach(btn => {
    const card = btn.closest('.track');
    const isCardPlaying = card && card.classList.contains('is-playing') && isAnyAudioPlaying();
    btn.textContent = getPlayButtonLabel(!isCardPlaying);
  });

  updateWelcomeBannerUI();
}

function isAnyAudioPlaying() {
  if (ytUsingFullEngine && ytIsPlaying) return true;
  if (activeAudio && !activeAudio.paused) return true;
  return false;
}

function ensureYtPlayer() {
  if (ytPlayer) return;
  if (!window.YT || !window.YT.Player) return;
  try {
    ytPlayer = new window.YT.Player('ytPlayerMount', {
      width: '200',
      height: '200',
      playerVars: {
        autoplay: 1,
        controls: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
      },
      events: {
        onReady: () => {
          ytPlayerReady = true;
          if (pendingYtVideoId) {
            const vid = pendingYtVideoId;
            pendingYtVideoId = '';
            ytPlayer.loadVideoById(vid);
            applySpeedToYtPlayer();
          }
        },
        onStateChange: handleYtStateChange,
        onError: handleYtError,
      },
    });
  } catch (_) {
    ytPlayerReady = false;
  }
}

window.onYouTubeIframeAPIReady = function () {
  ensureYtPlayer();
};

function handleYtStateChange(event) {
  if (!ytUsingFullEngine) return;
  const YTState = window.YT ? window.YT.PlayerState : {};

  if (event.data === YTState.PLAYING) {
    ytIsPlaying = true;
    applySpeedToYtPlayer();
    if (activeButton) {
      activeButton.textContent = getPlayButtonLabel(false);
    }
    const masterPlayBtn = document.getElementById('masterPlayBtn');
    if (masterPlayBtn) masterPlayBtn.textContent = '⏸ Pause';

    startYtProgressLoop();
    startVisualizer(null);
  } else if (event.data === YTState.PAUSED) {
    ytIsPlaying = false;
    if (activeButton) {
      activeButton.textContent = getPlayButtonLabel(true);
    }
    const masterPlayBtn = document.getElementById('masterPlayBtn');
    if (masterPlayBtn) masterPlayBtn.textContent = '▶ Play';
  } else if (event.data === YTState.ENDED) {
    ytIsPlaying = false;
    stopYtProgressLoop();
    if (activeButton) {
      activeButton.textContent = getPlayButtonLabel(true);
    }
    const autoPlay = document.getElementById('autoPlayToggle');
    if (autoPlay && autoPlay.checked && activeTrackIndex >= 0 && activeTrackIndex + 1 < currentRenderedList.length) {
      playAdjacentTrack(1);
    } else {
      updateNowPlaying('', '');
    }
  }
}

function handleYtError() {
  if (!ytUsingFullEngine) return;
  ytUsingFullEngine = false;
  ytIsPlaying = false;
  stopYtProgressLoop();
  if (activeAudio && activeTrackObject) {
    const previewSrc = activeAudio.dataset.previewSrc || activeTrackObject.previewUrl || '';
    if (previewSrc) {
      activeAudio.src = previewSrc;
      activeAudio.play().catch(() => {});
    }
  }
}

function startYtProgressLoop() {
  stopYtProgressLoop();
  ytProgressTimer = setInterval(() => {
    if (!ytUsingFullEngine || !ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
    const cur = ytPlayer.getCurrentTime() || 0;
    const dur = ytPlayer.getDuration() || (activeTrackObject?.trackTimeMillis ? activeTrackObject.trackTimeMillis / 1000 : 210);
    const curLabel = document.getElementById('currentTimeLabel');
    const durLabel = document.getElementById('durationTimeLabel');
    const slider = document.getElementById('seekSlider');

    if (curLabel) curLabel.textContent = formatSec(cur);
    if (durLabel) durLabel.textContent = formatSec(dur);
    if (slider && dur > 0) {
      slider.value = String((cur / dur) * 100);
    }
    highlightSyncedLyricAtTime(cur);
  }, 250);
}

function stopYtProgressLoop() {
  if (ytProgressTimer) {
    clearInterval(ytProgressTimer);
    ytProgressTimer = null;
  }
}

function applySpeedToYtPlayer() {
  if (ytPlayer && ytPlayerReady && typeof ytPlayer.setPlaybackRate === 'function') {
    try {
      const closestRate = currentPlaybackRate < 1 ? 0.75 : currentPlaybackRate > 1 ? 1.25 : 1.0;
      ytPlayer.setPlaybackRate(closestRate);
    } catch (_) {}
  }
}

function stopYtEngine() {
  ytUsingFullEngine = false;
  ytIsPlaying = false;
  pendingYtVideoId = '';
  stopYtProgressLoop();
  if (ytPlayer && ytPlayerReady && typeof ytPlayer.pauseVideo === 'function') {
    try {
      ytPlayer.pauseVideo();
    } catch (_) {}
  }
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
    if (fbAuth && fbModules && typeof fbModules.signOut === 'function') {
      fbModules.signOut(fbAuth).catch(() => {});
    }
    apiFetch('/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    }).catch(() => {});
    stopOtherAudio(null);
    stopYtEngine();
    saveAuthState('', null, '');
    dismissVerificationBanner();
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
  initFirebaseClient();
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
  const okBox = document.getElementById('authSuccessMsg');

  if (errBox) errBox.classList.add('hidden');
  if (okBox) okBox.classList.add('hidden');
  if (regTab) regTab.classList.toggle('active', mode === 'register');
  if (loginTab) loginTab.classList.toggle('active', mode === 'login');

  if (mode === 'register') {
    if (title) title.textContent = 'Create Account for Full Songs';
    if (sub) {
      sub.textContent =
        'Register with a real email address via Firebase Authentication. We will send an acknowledgment & verification link to confirm your account and unlock full-length songs.';
    }
    if (nameGroup) nameGroup.classList.remove('hidden');
    if (nameInput) nameInput.required = true;
    if (submitBtn) submitBtn.textContent = 'Create Account & Send Verification Link';
  } else {
    if (title) title.textContent = 'Sign In to Your Account';
    if (sub) {
      sub.textContent =
        'Sign in with Firebase Authentication or your registered email to unlock full-length songs.';
    }
    if (nameGroup) nameGroup.classList.add('hidden');
    if (nameInput) nameInput.required = false;
    if (submitBtn) submitBtn.textContent = 'Sign In & Unlock Full Songs';
  }
}

async function signInWithGoogleFirebase() {
  const errBox = document.getElementById('authErrorMsg');
  const okBox = document.getElementById('authSuccessMsg');
  const googleBtn = document.getElementById('googleAuthBtn');
  if (errBox) errBox.classList.add('hidden');
  if (okBox) okBox.classList.add('hidden');
  if (googleBtn) googleBtn.disabled = true;

  try {
    const fb = await initFirebaseClient();
    if (!fb || !fb.fbAuth || !fb.fbModules) {
      throw new Error('Firebase Authentication is still initializing. Please try again.');
    }

    const provider = new fb.fbModules.GoogleAuthProvider();
    const cred = await fb.fbModules.signInWithPopup(fb.fbAuth, provider);
    const fbUser = cred.user;
    const email = (fbUser.email || '').trim().toLowerCase();
    const name = (fbUser.displayName || email.split('@')[0] || 'Member').trim().slice(0, 80);

    await syncVerifiedUserToFirestore(fbUser, name);

    const syncRes = await apiFetch('/auth/firebase-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: fbUser.uid,
        name,
        email,
        emailVerified: Boolean(fbUser.emailVerified),
      }),
    });

    if (syncRes && syncRes.token && syncRes.user) {
      saveAuthState(syncRes.token, syncRes.user, syncRes.verificationLink || '');
      closeAuthModal();
      showVerificationBanner({
        verified: true,
        message: `Signed in with Google (${email})! Your Firebase email is verified and full-length songs are unlocked.`,
      });
      if (activeAudio && activeTrackObject) {
        const card = activeAudio.closest('.track');
        playSpecificAudio(activeAudio, activeButton, card, activeTrackObject, activeTrackIndex);
      }
    }
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message || 'Google Sign-In was cancelled or failed.';
      errBox.classList.remove('hidden');
    }
  } finally {
    if (googleBtn) googleBtn.disabled = false;
  }
}

async function submitAuthForm(event) {
  event.preventDefault();
  const rawName = (document.getElementById('authName')?.value || '').trim();
  const email = (document.getElementById('authEmail')?.value || '').trim().toLowerCase();
  const password = document.getElementById('authPassword')?.value || '';
  const errBox = document.getElementById('authErrorMsg');
  const okBox = document.getElementById('authSuccessMsg');
  const submitBtn = document.getElementById('authSubmitBtn');

  if (errBox) errBox.classList.add('hidden');
  if (okBox) okBox.classList.add('hidden');

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email) || email.length > 254) {
    if (errBox) {
      errBox.textContent = 'Please enter a valid real email address.';
      errBox.classList.remove('hidden');
    }
    return;
  }

  const name = (rawName || email.split('@')[0] || 'Member').slice(0, 80);
  if (submitBtn) submitBtn.disabled = true;

  try {
    const fb = await initFirebaseClient();
    let firebaseEmailSent = false;
    let fbUid = '';
    let fbVerified = false;

    if (fb && fb.fbAuth && fb.fbModules) {
      try {
        if (authModalMode === 'register') {
          const userCred = await fb.fbModules.createUserWithEmailAndPassword(fb.fbAuth, email, password);
          fbUid = userCred.user.uid;
          if (name && typeof fb.fbModules.updateProfile === 'function') {
            await fb.fbModules.updateProfile(userCred.user, { displayName: name });
          }
          const actionCodeSettings = {
            url: `${window.location.origin}/?firebaseVerified=1&email=${encodeURIComponent(email)}`,
            handleCodeInApp: false,
          };
          await fb.fbModules.sendEmailVerification(userCred.user, actionCodeSettings);
          firebaseEmailSent = true;
          fbVerified = Boolean(userCred.user.emailVerified);
        } else {
          const userCred = await fb.fbModules.signInWithEmailAndPassword(fb.fbAuth, email, password);
          fbUid = userCred.user.uid;
          fbVerified = Boolean(userCred.user.emailVerified);
          if (fbVerified) {
            await syncVerifiedUserToFirestore(userCred.user, name);
          }
        }
      } catch (fbErr) {
        const code = String(fbErr?.code || '');
        if (
          code === 'auth/email-already-in-use' ||
          code === 'auth/wrong-password' ||
          code === 'auth/invalid-credential' ||
          code === 'auth/invalid-email' ||
          code === 'auth/weak-password'
        ) {
          throw new Error(fbErr.message || 'Firebase Authentication rejected those credentials.');
        }
        // If Email/Password provider is not enabled yet in Firebase Console (auth/operation-not-allowed),
        // proceed with Go server registration + direct verification acknowledgment link so account creation succeeds!
      }
    }

    let res = null;
    if (fbUid) {
      res = await apiFetch('/auth/firebase-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: fbUid,
          name,
          email,
          emailVerified: fbVerified,
        }),
      });
    } else {
      const endpoint = authModalMode === 'register' ? '/auth/register' : '/auth/login';
      const payload = authModalMode === 'register' ? { name, email, password } : { email, password };
      res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    if (res && res.token && res.user) {
      const verifyLink = res.verificationLink || '';
      saveAuthState(res.token, res.user, verifyLink);
      closeAuthModal();
      document.getElementById('authForm')?.reset();

      if (res.user.emailVerified) {
        showVerificationBanner({
          verified: true,
          message: `Welcome back, ${res.user.name}! Your email (${res.user.email}) is verified.`,
        });
      } else {
        const linkNote = firebaseEmailSent
          ? `Account created for ${res.user.email}! Firebase sent an acknowledgment link to your email inbox — or click "Acknowledge & Verify Account Link ✓" right here.`
          : `Account created for ${res.user.email}! Click "Acknowledge & Verify Account Link ✓" to confirm your account creation.`;
        showVerificationBanner({
          verified: false,
          message: linkNote,
          verifyLink,
        });
      }

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

async function acknowledgeVerificationLink(event) {
  if (event) event.preventDefault();
  const link = pendingVerificationLink || '';
  let verifyToken = '';
  let email = currentUser?.email || '';

  if (link.includes('?')) {
    const params = new URLSearchParams(link.split('?')[1]);
    verifyToken = params.get('verifyToken') || '';
    email = params.get('email') || email;
  }

  if (!email) return;

  try {
    const res = await apiFetch(
      `/auth/verify?verifyToken=${encodeURIComponent(verifyToken)}&email=${encodeURIComponent(email)}`
    );
    if (res && res.token && res.user) {
      saveAuthState(res.token, res.user, '');
      showVerificationBanner({
        verified: true,
        message: `Account successfully acknowledged! ${res.user.email} is now verified and active.`,
      });
    }
  } catch (err) {
    showVerificationBanner({
      verified: false,
      message: `Could not verify link: ${err.message}`,
      verifyLink: pendingVerificationLink,
    });
  }
}

async function resendFirebaseVerificationEmail() {
  const resendBtn = document.getElementById('resendVerifyEmailBtn');
  if (resendBtn) resendBtn.disabled = true;
  try {
    await initFirebaseClient();
    if (fbAuth?.currentUser && fbModules?.sendEmailVerification) {
      await fbModules.sendEmailVerification(fbAuth.currentUser, {
        url: `${window.location.origin}/?firebaseVerified=1&email=${encodeURIComponent(fbAuth.currentUser.email || '')}`,
        handleCodeInApp: false,
      });
      showVerificationBanner({
        verified: false,
        message: `Verification link resent to ${fbAuth.currentUser.email}! Check your inbox or click "Acknowledge & Verify Account Link ✓".`,
        verifyLink: pendingVerificationLink,
      });
    } else {
      showVerificationBanner({
        verified: false,
        message: `Your instant verification link is ready — click "Acknowledge & Verify Account Link ✓" to confirm ${currentUser?.email || 'your account'}.`,
        verifyLink: pendingVerificationLink,
      });
    }
  } catch (err) {
    showVerificationBanner({
      verified: false,
      message: `Click "Acknowledge & Verify Account Link ✓" to confirm ${currentUser?.email || 'your account'} right away.`,
      verifyLink: pendingVerificationLink,
    });
  } finally {
    if (resendBtn) resendBtn.disabled = false;
  }
}

async function refreshEmailVerificationStatus() {
  try {
    await initFirebaseClient();
    if (fbAuth?.currentUser && typeof fbAuth.currentUser.reload === 'function') {
      await fbAuth.currentUser.reload();
      if (fbAuth.currentUser.emailVerified) {
        await syncVerifiedUserToFirestore(fbAuth.currentUser, currentUser?.name || '');
        const syncRes = await apiFetch('/auth/firebase-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uid: fbAuth.currentUser.uid,
            name: currentUser?.name || fbAuth.currentUser.displayName || '',
            email: fbAuth.currentUser.email,
            emailVerified: true,
          }),
        });
        if (syncRes && syncRes.token && syncRes.user) {
          saveAuthState(syncRes.token, syncRes.user, '');
        }
        showVerificationBanner({
          verified: true,
          message: `Firebase confirmed your email verification link for ${fbAuth.currentUser.email}!`,
        });
        return;
      }
    }
    await acknowledgeVerificationLink();
  } catch (_) {
    await acknowledgeVerificationLink();
  }
}

async function checkUrlVerificationLink() {
  const params = new URLSearchParams(window.location.search);
  const verifyToken = params.get('verifyToken') || '';
  const email = params.get('email') || currentUser?.email || '';
  const firebaseVerified = params.get('firebaseVerified') || '';

  if ((verifyToken || firebaseVerified) && email) {
    try {
      const res = await apiFetch(
        `/auth/verify?verifyToken=${encodeURIComponent(verifyToken)}&email=${encodeURIComponent(email)}`
      );
      if (res && res.token && res.user) {
        saveAuthState(res.token, res.user, '');
        showVerificationBanner({
          verified: true,
          message: `Email link acknowledged! Your account (${res.user.email}) is verified and full-length songs are unlocked.`,
        });
      }
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState({}, document.title, cleanUrl);
    } catch (_) {}
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
  updateWelcomeBannerUI();
}

function loadRecentlyPlayedFromSession() {
  try {
    const raw = sessionStorage.getItem(RECENT_SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT_SONGS) : [];
  } catch (_) {
    return [];
  }
}

function saveRecentlyPlayedToSession() {
  try {
    sessionStorage.setItem(RECENT_SESSION_KEY, JSON.stringify(recentlyPlayed));
  } catch (_) {
    // Ignore storage quota errors
  }
}

function getTrackKey(track) {
  if (!track) return '';
  return String(track.trackId || `${track.trackName || ''}::${track.artistName || ''}`);
}

function recordRecentlyPlayed(track) {
  if (!track || !track.trackName) return;
  const key = getTrackKey(track);

  recordActivitySignal({
    artist: track.artistName,
    genre: track.primaryGenreName,
  });

  recentlyPlayed = recentlyPlayed.filter(item => getTrackKey(item) !== key);
  recentlyPlayed.unshift({
    ...track,
    playedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  });

  if (recentlyPlayed.length > MAX_RECENT_SONGS) {
    recentlyPlayed = recentlyPlayed.slice(0, MAX_RECENT_SONGS);
  }

  saveRecentlyPlayedToSession();
  renderRecentlyPlayed();
  updateWelcomeBannerUI();
}

function clearRecentlyPlayed() {
  recentlyPlayed = [];
  saveRecentlyPlayedToSession();
  renderRecentlyPlayed();
  updateWelcomeBannerUI();
}

function renderRecentlyPlayed() {
  const listEl = document.getElementById('recentlyPlayedList');
  const countEl = document.getElementById('recentCountLabel');
  const clearBtn = document.getElementById('clearRecentBtn');
  if (!listEl) return;

  if (countEl) {
    countEl.textContent = `${recentlyPlayed.length}/${MAX_RECENT_SONGS}`;
  }
  if (clearBtn) {
    clearBtn.classList.toggle('hidden', recentlyPlayed.length === 0);
  }

  if (recentlyPlayed.length === 0) {
    listEl.innerHTML =
      '<div class="recent-empty">Songs you listen to during this session appear right here at the top (up to 10 tracks).</div>';
    return;
  }

  const activeKey = getTrackKey(activeTrackObject);

  listEl.innerHTML = recentlyPlayed
    .map((track, idx) => {
      const isCurrent = activeKey && getTrackKey(track) === activeKey;
      const num = idx + 1 < 10 ? `0${idx + 1}` : `${idx + 1}`;
      const thumb = track.artworkUrl100
        ? `<img src="${escapeHtml(track.artworkUrl100)}" alt="${escapeHtml(track.trackName)} cover" class="recent-thumb" loading="lazy" referrerpolicy="no-referrer">`
        : '<div class="recent-thumb"></div>';
      const duration = formatDuration(track.trackTimeMillis);
      const subParts = [track.artistName, duration].filter(Boolean).join(' · ');

      return `
        <button type="button" class="recent-item ${isCurrent ? 'is-active' : ''}" onclick="playFromRecentlyPlayed(${idx})" title="Replay ${escapeHtml(track.trackName)}">
          <span class="recent-index mono-num">${num}</span>
          ${thumb}
          <span class="recent-info">
            <span class="recent-title">${escapeHtml(track.trackName)}</span>
            <span class="recent-meta">${escapeHtml(subParts)}</span>
          </span>
          <span class="recent-time mono-num">${escapeHtml(track.playedAt || '')}</span>
        </button>
      `;
    })
    .join('');
}

function playFromRecentlyPlayed(recentIndex) {
  const track = recentlyPlayed[recentIndex];
  if (!track) return;

  const targetKey = getTrackKey(track);
  const existingIdx = currentRenderedList.findIndex(item => getTrackKey(item) === targetKey);
  if (existingIdx >= 0) {
    const audios = document.querySelectorAll('.view-section:not(.hidden) .preview-audio');
    const targetAudio = audios[existingIdx];
    if (targetAudio) {
      const card = targetAudio.closest('.track');
      const btn = card ? card.querySelector('.play-btn') : null;
      playSpecificAudio(targetAudio, btn, card, currentRenderedList[existingIdx], existingIdx);
      return;
    }
  }

  if (!standaloneRecentAudio) {
    standaloneRecentAudio = new Audio();
    standaloneRecentAudio.crossOrigin = 'anonymous';
    standaloneRecentAudio.addEventListener('timeupdate', () => {
      if (activeAudio === standaloneRecentAudio && !ytUsingFullEngine) {
        const curLabel = document.getElementById('currentTimeLabel');
        const durLabel = document.getElementById('durationTimeLabel');
        const slider = document.getElementById('seekSlider');
        const dur = standaloneRecentAudio.duration || 30;
        if (curLabel) curLabel.textContent = formatSec(standaloneRecentAudio.currentTime);
        if (durLabel) durLabel.textContent = formatSec(dur);
        if (slider && dur > 0) {
          slider.value = String((standaloneRecentAudio.currentTime / dur) * 100);
        }
        applyPreviewEndFadeOut(standaloneRecentAudio);
        highlightSyncedLyricAtTime(standaloneRecentAudio.currentTime);
      }
    });
    standaloneRecentAudio.addEventListener('play', () => {
      if (activeTrackObject && !ytUsingFullEngine) {
        const isFromStart = standaloneRecentAudio.currentTime < 0.5;
        startGracefulFadeIn(standaloneRecentAudio, isFromStart ? 2000 : 650, isFromStart ? 0.01 : 0.15);
        updateNowPlaying(activeTrackObject.trackName, activeTrackObject.artistName, activeTrackObject, -1, isLoggedIn());
        recordRecentlyPlayed(activeTrackObject);
        fetchAndRenderLyrics(activeTrackObject.trackName, activeTrackObject.artistName);
        startVisualizer(standaloneRecentAudio);
      }
    });
    standaloneRecentAudio.addEventListener('pause', () => {
      const masterPlayBtn = document.getElementById('masterPlayBtn');
      if (masterPlayBtn && activeAudio === standaloneRecentAudio && !ytUsingFullEngine) {
        masterPlayBtn.textContent = '▶ Play';
      }
    });
    standaloneRecentAudio.addEventListener('ended', () => {
      if (!ytUsingFullEngine) updateNowPlaying('', '');
    });
  }

  standaloneRecentAudio.dataset.previewSrc = track.previewUrl || '';
  standaloneRecentAudio.src = track.previewUrl || '';
  standaloneRecentAudio.dataset.loadedSrc = track.previewUrl || '';
  playSpecificAudio(standaloneRecentAudio, null, null, track, -1);
}

function isTrackInCrate(track) {
  if (!track) return false;
  const key = track.trackId || `${track.trackName}::${track.artistName}`;
  return savedCrate.some(item => (item.trackId || `${item.trackName}::${item.artistName}`) === key);
}

function findTrackByContainerAndIndex(containerId, index) {
  if (containerId === 'weeklyForYouResults') return weeklyForYouTracks[index];
  if (containerId === 'weeklyHitsResults') return weeklyHitsTracks[index];
  if (containerId === 'crateResults') return savedCrate[index];
  return currentRenderedList[index];
}

function toggleTrackInCrate(index, containerId = 'results') {
  const track = findTrackByContainerAndIndex(containerId, index);
  if (!track) return;

  const key = track.trackId || `${track.trackName}::${track.artistName}`;
  const existingIdx = savedCrate.findIndex(
    item => (item.trackId || `${item.trackName}::${item.artistName}`) === key
  );

  if (existingIdx >= 0) {
    savedCrate.splice(existingIdx, 1);
  } else {
    savedCrate.unshift(track);
    recordActivitySignal({
      artist: track.artistName,
      genre: track.primaryGenreName,
    });
  }
  saveCrateToStorage();

  // Refresh visible lists
  if (!document.getElementById('view-discover').classList.contains('hidden')) {
    renderTracks(currentRenderedList, 'results');
  }
  if (!document.getElementById('view-weekly').classList.contains('hidden')) {
    renderTracks(weeklyForYouTracks, 'weeklyForYouResults');
    renderTracks(weeklyHitsTracks, 'weeklyHitsResults');
  }
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
  cancelStudioFade();
  if (activeAudio && activeAudio !== currentAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    setAudioGainValue(activeAudio, 1);
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
    nowPlaying.textContent = `${title} — ${artist}`;
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

// Background pre-fetcher so full-song YouTube IDs are already cached before the user clicks Play
function prefetchFullTrack(trackObj) {
  if (!isLoggedIn() || !trackObj || !trackObj.trackName) return Promise.resolve(null);
  const key = getTrackKey(trackObj);
  if (fullTrackClientCache.has(key)) {
    return Promise.resolve(fullTrackClientCache.get(key));
  }
  const previewSrc = trackObj.previewUrl || '';
  const promise = apiFetch(
    `/fulltrack?track=${encodeURIComponent(trackObj.trackName)}&artist=${encodeURIComponent(trackObj.artistName || '')}&preview=${encodeURIComponent(previewSrc)}`,
    { headers: { Authorization: `Bearer ${authToken}` } }
  )
    .then(data => {
      if (data && data.youtubeId) {
        fullTrackClientCache.set(key, data);
      }
      return data;
    })
    .catch(() => null);

  fullTrackClientCache.set(key, promise);
  return promise;
}

function prefetchTopTracks(tracks) {
  if (!isLoggedIn() || !Array.isArray(tracks)) return;
  tracks.slice(0, 6).forEach(t => prefetchFullTrack(t));
}

// Switch between 2-Column Studio Grid and Ultra-Compact Single-Line Rows
function setTrackDensity(mode) {
  trackDensityMode = mode === 'compact' ? 'compact' : 'grid';
  document.getElementById('densityGridBtn')?.classList.toggle('active', trackDensityMode === 'grid');
  document.getElementById('densityCompactBtn')?.classList.toggle('active', trackDensityMode === 'compact');

  ['results', 'weeklyForYouResults', 'weeklyHitsResults', 'crateResults'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.toggle('grid-density', trackDensityMode === 'grid');
      el.classList.toggle('compact-density', trackDensityMode === 'compact');
    }
  });
}

// Toggle Side-by-Side Split Lyrics Reader inside Discover view
function toggleSplitLyricsPane(forceState) {
  splitLyricsActive = typeof forceState === 'boolean' ? forceState : !splitLyricsActive;
  const splitWrap = document.getElementById('discoverSplitLayout');
  const drawer = document.getElementById('inlineLyricsDrawer');
  const btn = document.getElementById('splitLyricsToggleBtn');

  if (splitWrap) splitWrap.classList.toggle('split-active', splitLyricsActive);
  if (drawer) drawer.classList.toggle('hidden', !splitLyricsActive);
  if (btn) {
    btn.textContent = splitLyricsActive ? 'Split Lyrics Reader: On' : 'Split Lyrics Reader: Off';
  }
}

function renderTracks(tracks, targetContainerId = 'results') {
  const container = document.getElementById(targetContainerId);
  const countLabel = document.getElementById('resultsCount');
  if (!container) return;
  container.innerHTML = '';

  container.classList.toggle('grid-density', trackDensityMode === 'grid');
  container.classList.toggle('compact-density', trackDensityMode === 'compact');

  if (targetContainerId === 'results') {
    currentRenderedList = Array.isArray(tracks) ? tracks : [];
    prefetchTopTracks(currentRenderedList);
  }

  if (!Array.isArray(tracks) || tracks.length === 0) {
    if (targetContainerId === 'results' && countLabel) {
      countLabel.textContent = allTracks.length
        ? `0 of ${allTracks.length} matching songs`
        : 'No results yet';
    }
    container.innerHTML = '<div class="status">No songs found for that selection.</div>';
    return;
  }

  if (targetContainerId === 'results' && countLabel) {
    countLabel.textContent =
      tracks.length === allTracks.length
        ? `${tracks.length} matching songs`
        : `${tracks.length} of ${allTracks.length} matching songs`;
  }

  const activeKey = getTrackKey(activeTrackObject);

  tracks.forEach((track, idx) => {
    const div = document.createElement('div');
    const isPlayingThis = activeKey && getTrackKey(track) === activeKey && isAnyAudioPlaying();
    div.className = `track${isPlayingThis ? ' is-playing' : ''}`;

    const rawTitle = track.trackName || 'Untitled track';
    const rawArtist = track.artistName || 'Unknown artist';
    div.dataset.title = rawTitle;
    div.dataset.artist = rawArtist;
    div.dataset.index = String(idx);

    div.addEventListener('mouseenter', () => {
      prefetchFullTrack(track);
    });

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

    const reasonHtml = track.recReason
      ? `<div class="rec-reason-line">${escapeHtml(track.recReason)}</div>`
      : '';

    const inCrate = isTrackInCrate(track);
    const saveLabel = inCrate ? '★ Saved' : '+ Crate';
    const saveClass = inCrate ? 'action-chip-btn saved' : 'action-chip-btn';

    const itunesLink = track.trackViewUrl
      ? `<a class="itunes-link" href="${escapeHtml(track.trackViewUrl)}" target="_blank" rel="noopener noreferrer">iTunes ↗</a>`
      : '';

    const playBtnText = getPlayButtonLabel(!isPlayingThis);

    const preview = track.previewUrl
      ? `
        <div class="preview-row">
          <button class="play-btn" type="button">${playBtnText}</button>
          <button class="action-chip-btn" type="button" onclick="loadLyricsForTrack(${idx}, '${targetContainerId}')">Lyrics</button>
          <button class="action-chip-btn" type="button" onclick="inspectArtist(${idx}, '${targetContainerId}')">Artist</button>
          <button class="${saveClass}" type="button" onclick="toggleTrackInCrate(${idx}, '${targetContainerId}')">${saveLabel}</button>
          ${itunesLink}
        </div>
        <audio preload="none" crossorigin="anonymous" class="preview-audio" src="${escapeHtml(track.previewUrl)}" data-preview-src="${escapeHtml(track.previewUrl)}"></audio>
      `
      : `<div class="meta">Preview not available for this track. ${itunesLink}</div>`;

    div.innerHTML = `
      <div class="track-card">
        ${artwork}
        <div class="track-info">
          <div>
            <div class="track-header-row">
              <strong title="${title}">${title}</strong>
            </div>
            <button type="button" class="artist-btn" onclick="inspectArtist(${idx}, '${targetContainerId}')" title="Explore ${artist} discography">${artist}</button>
            ${reasonHtml}
            ${album}
          </div>
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
        if (activeTrackObject && getTrackKey(activeTrackObject) === getTrackKey(trackObj) && isAnyAudioPlaying()) {
          toggleMasterPlayback();
          return;
        }
        currentRenderedList = tracks;
        playSpecificAudio(audio, button, card, trackObj, idx);
      });
    }

    audio.addEventListener('play', () => {
      if (ytUsingFullEngine) return;
      stopOtherAudio(audio);
      activeButton = button;
      activeTrackIndex = idx;
      activeTrackObject = trackObj;
      applySpeedToAudio(audio);

      document.querySelectorAll('.track').forEach(el => el.classList.remove('is-playing'));
      if (card) card.classList.add('is-playing');

      if (button) {
        button.textContent = getPlayButtonLabel(false);
      }
      if (card) {
        updateNowPlaying(card.dataset.title, card.dataset.artist, trackObj, idx, isLoggedIn());
      }
      startVisualizer(audio);
      const isFromStart = audio.currentTime < 0.5;
      startGracefulFadeIn(audio, isFromStart ? 2000 : 650, isFromStart ? 0.01 : 0.15);
      if (trackObj) {
        recordRecentlyPlayed(trackObj);
        fetchAndRenderLyrics(trackObj.trackName, trackObj.artistName);
      }
    });

    audio.addEventListener('timeupdate', () => {
      if (activeAudio === audio && !ytUsingFullEngine) {
        const curLabel = document.getElementById('currentTimeLabel');
        const durLabel = document.getElementById('durationTimeLabel');
        const slider = document.getElementById('seekSlider');
        const dur = audio.duration || 30;
        if (curLabel) curLabel.textContent = formatSec(audio.currentTime);
        if (durLabel) durLabel.textContent = formatSec(dur);
        if (slider && dur > 0) {
          slider.value = String((audio.currentTime / dur) * 100);
        }
        applyPreviewEndFadeOut(audio);
        highlightSyncedLyricAtTime(audio.currentTime);
      }
    });

    audio.addEventListener('pause', () => {
      if (ytUsingFullEngine) return;
      if (button) {
        button.textContent = getPlayButtonLabel(true);
      }
      const masterPlayBtn = document.getElementById('masterPlayBtn');
      if (masterPlayBtn && activeAudio === audio) {
        masterPlayBtn.textContent = '▶ Play';
      }
    });

    audio.addEventListener('ended', () => {
      if (ytUsingFullEngine) return;
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
  stopYtEngine();
  activeButton = button;
  activeTrackIndex = idx;
  activeTrackObject = trackObj;

  const sourceToggle = document.getElementById('fullSongSourceToggle');
  const ytWrap = document.getElementById('youtubeEmbedWrap');
  const previewSrc = audio.dataset.previewSrc || (trackObj && trackObj.previewUrl) || '';

  // Logged-In Member Mode: Play the genuine, complete Full-Length Song from start to finish
  if (isLoggedIn() && trackObj) {
    if (button) button.textContent = 'Loading...';
    const fullData = await prefetchFullTrack(trackObj);
    currentFullTrackData = fullData;

    if (fullData && fullData.youtubeId) {
      ensureYtPlayer();
      if (sourceToggle) sourceToggle.classList.remove('hidden');

      if (ytWrap) {
        ytWrap.classList.toggle('studio-audio-hidden', fullTrackSourceMode === 'studio');
      }

      ytUsingFullEngine = true;
      ytIsPlaying = true;

      document.querySelectorAll('.track').forEach(el => el.classList.remove('is-playing'));
      if (card) card.classList.add('is-playing');

      updateNowPlaying(trackObj.trackName, trackObj.artistName, trackObj, idx, true);
      recordRecentlyPlayed(trackObj);
      fetchAndRenderLyrics(trackObj.trackName, trackObj.artistName);
      if (button) button.textContent = getPlayButtonLabel(false);

      if (ytPlayer && ytPlayerReady && typeof ytPlayer.loadVideoById === 'function') {
        ytPlayer.loadVideoById(fullData.youtubeId);
        applySpeedToYtPlayer();
      } else {
        pendingYtVideoId = fullData.youtubeId;
      }
      startVisualizer(null);
      return;
    }
  }

  // Guest Mode (or fallback): Play 30-second iTunes preview
  currentFullTrackData = null;
  if (sourceToggle) sourceToggle.classList.add('hidden');
  if (ytWrap) ytWrap.classList.add('studio-audio-hidden');

  if (previewSrc && audio.dataset.loadedSrc !== previewSrc) {
    audio.src = previewSrc;
    audio.dataset.loadedSrc = previewSrc;
  }

  audio.currentTime = 0;
  setAudioGainValue(audio, 0.01);
  applySpeedToAudio(audio);
  audio.play().catch(() => {
    audio.removeAttribute('crossorigin');
    setAudioGainValue(audio, 0.01);
    applySpeedToAudio(audio);
    audio.play().catch(() => {
      updateNowPlaying('', '');
      if (button) button.textContent = getPlayButtonLabel(true);
    });
  });
}

// Instant toggle between Full Studio Audio Stream (audio-only + visualizer) and Official Full Song Video
function switchFullTrackSource(mode) {
  fullTrackSourceMode = mode;
  document.getElementById('srcBtnStudio')?.classList.toggle('active', mode === 'studio');
  document.getElementById('srcBtnYoutube')?.classList.toggle('active', mode === 'youtube');

  const ytWrap = document.getElementById('youtubeEmbedWrap');
  if (ytWrap) {
    ytWrap.classList.toggle('studio-audio-hidden', mode === 'studio');
  }
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
  if (ytUsingFullEngine) {
    applySpeedToYtPlayer();
  } else if (activeAudio) {
    applySpeedToAudio(activeAudio);
  }
}

function toggleMasterPlayback() {
  if (ytUsingFullEngine && ytPlayer && ytPlayerReady) {
    if (ytIsPlaying) {
      ytPlayer.pauseVideo();
    } else {
      ytPlayer.playVideo();
    }
    return;
  }
  if (activeAudio) {
    if (activeAudio.paused) {
      setAudioGainValue(activeAudio, 0.15);
      activeAudio.play();
    } else {
      gracefulPauseAudio(activeAudio);
    }
    return;
  }
  const firstBtn = document.querySelector('.view-section:not(.hidden) .play-btn');
  if (firstBtn) {
    firstBtn.click();
  }
}

function playAdjacentTrack(direction) {
  const activeSection = document.querySelector('.view-section:not(.hidden)');
  const audios = activeSection
    ? activeSection.querySelectorAll('.preview-audio')
    : document.querySelectorAll('#results .preview-audio');
  if (!audios.length) return;
  let nextIdx = activeTrackIndex + direction;
  if (nextIdx < 0) nextIdx = 0;
  if (nextIdx >= audios.length) nextIdx = 0;
  const targetAudio = audios[nextIdx];
  const card = targetAudio ? targetAudio.closest('.track') : null;
  const btn = card ? card.querySelector('.play-btn') : null;
  if (btn && targetAudio && currentRenderedList[nextIdx]) {
    playSpecificAudio(targetAudio, btn, card, currentRenderedList[nextIdx], nextIdx);
  }
}

// Weekly Recommendations Loader (Activity-Based Picks + Weekly Global Hits)
async function loadWeeklyRecommendations(forceRefresh = false) {
  if (!forceRefresh && weeklyForYouTracks.length > 0 && weeklyHitsTracks.length > 0) {
    return;
  }

  const forYouEl = document.getElementById('weeklyForYouResults');
  const hitsEl = document.getElementById('weeklyHitsResults');
  const signalsEl = document.getElementById('weeklyActivitySignals');
  const dateLabel = document.getElementById('weeklyDateLabel');
  const actCountEl = document.getElementById('wkActivityCount');
  const hitsCountEl = document.getElementById('wkHitsCount');

  if (forYouEl) {
    forYouEl.innerHTML = '<div class="status">Generating weekly recommendations from your activity via Go concurrent workers...</div>';
  }
  if (hitsEl) {
    hitsEl.innerHTML = '<div class="status">Fetching Weekly Global Hits chart...</div>';
  }

  const artistsSeed = getActivityArtistsSeed().join(',');
  const genresSeed = getActivityGenresSeed().join(',');
  const excludeIds = recentlyPlayed
    .map(t => t.trackId)
    .filter(Boolean)
    .join(',');

  try {
    const query = `/recommendations?artists=${encodeURIComponent(artistsSeed)}&genres=${encodeURIComponent(genresSeed)}&exclude=${encodeURIComponent(excludeIds)}`;
    const data = await apiFetch(query);

    weeklyForYouTracks = Array.isArray(data.forYou) ? data.forYou : [];
    weeklyHitsTracks = Array.isArray(data.weeklyHits) ? data.weeklyHits : [];

    if (dateLabel && data.weekLabel) {
      dateLabel.textContent = data.weekLabel;
    }
    if (signalsEl && Array.isArray(data.activityBasis) && data.activityBasis.length) {
      signalsEl.textContent = `Tuned to: ${data.activityBasis.join(' · ')}`;
    }
    if (actCountEl) actCountEl.textContent = String(weeklyForYouTracks.length);
    if (hitsCountEl) hitsCountEl.textContent = String(weeklyHitsTracks.length);

    renderTracks(weeklyForYouTracks, 'weeklyForYouResults');
    renderTracks(weeklyHitsTracks, 'weeklyHitsResults');
    prefetchTopTracks([...weeklyForYouTracks.slice(0, 3), ...weeklyHitsTracks.slice(0, 3)]);
  } catch (err) {
    if (forYouEl) {
      forYouEl.innerHTML = `<div class="status error">${escapeHtml(err.message)}</div>`;
    }
  }
}

function setWeeklyFilter(mode) {
  weeklyFilterMode = mode;
  document.getElementById('wkTabAll')?.classList.toggle('active', mode === 'all');
  document.getElementById('wkTabActivity')?.classList.toggle('active', mode === 'activity');
  document.getElementById('wkTabHits')?.classList.toggle('active', mode === 'hits');

  const actSection = document.getElementById('weeklyActivitySection');
  const hitsSection = document.getElementById('weeklyHitsSection');
  if (actSection) actSection.classList.toggle('hidden', mode === 'hits');
  if (hitsSection) hitsSection.classList.toggle('hidden', mode === 'activity');
}

document.addEventListener('DOMContentLoaded', () => {
  updateCrateCountUI();
  renderRecentlyPlayed();
  initFirebaseClient();
  verifyExistingSession();
  checkUrlVerificationLink();
  drawIdleVisualizer();

  const slider = document.getElementById('seekSlider');
  if (slider) {
    slider.addEventListener('input', () => {
      if (ytUsingFullEngine && ytPlayer && ytPlayerReady && typeof ytPlayer.getDuration === 'function') {
        const dur = ytPlayer.getDuration() || 210;
        const desiredSec = (Number(slider.value) / 100) * dur;
        ytPlayer.seekTo(desiredSec, true);
        return;
      }
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
  // Preload weekly recommendations in the background
  loadWeeklyRecommendations(false);
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

  if (audio) {
    try {
      if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContextClass();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        masterGainNode = audioCtx.createGain();
        masterGainNode.gain.setValueAtTime(1, audioCtx.currentTime);
        analyser.connect(masterGainNode);
        masterGainNode.connect(audioCtx.destination);
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      if (!connectedAudios.has(audio) && audio.getAttribute('crossorigin')) {
        const src = audioCtx.createMediaElementSource(audio);
        src.connect(analyser);
        connectedAudios.add(audio);
      }
    } catch (_) {
      // Fallback to rhythmic envelope if browser restricts cross-origin Web Audio
    }
  }

  if (visualizerAnimId) cancelAnimationFrame(visualizerAnimId);
  const bufferLength = analyser ? analyser.frequencyBinCount : 32;
  const dataArray = new Uint8Array(bufferLength);

  function renderFrame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const isPlaying = isAnyAudioPlaying();

    if (analyser && activeAudio && !activeAudio.paused && !ytUsingFullEngine) {
      analyser.getByteFrequencyData(dataArray);
    } else {
      dataArray.fill(0);
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

// Lyrics Studio & Side-by-Side Split Lyrics Reader
function setLyricsColumnMode(mode) {
  lyricsColumnMode = mode === 'one-col' ? 'one-col' : 'two-col';
  document.getElementById('lyricsCol2Btn')?.classList.toggle('active', lyricsColumnMode === 'two-col');
  document.getElementById('lyricsCol1Btn')?.classList.toggle('active', lyricsColumnMode === 'one-col');

  const body = document.getElementById('mainLyricsContent');
  if (body) {
    body.classList.toggle('two-col-sheet', lyricsColumnMode === 'two-col');
  }
}

function loadLyricsForTrack(index, containerId = 'results') {
  const track = findTrackByContainerAndIndex(containerId, index);
  if (!track) return;

  fetchAndRenderLyrics(track.trackName, track.artistName);

  // If user is in Discover, open the Side-by-Side Split Lyrics Reader right next to the search results!
  const discoverVisible = !document.getElementById('view-discover').classList.contains('hidden');
  if (discoverVisible) {
    toggleSplitLyricsPane(true);
  } else {
    switchTab('lyrics');
  }
}

function seekToLyricTime(sec) {
  if (typeof sec !== 'number' || isNaN(sec)) return;
  if (ytUsingFullEngine && ytPlayer && ytPlayerReady && typeof ytPlayer.seekTo === 'function') {
    ytPlayer.seekTo(sec, true);
    return;
  }
  if (activeAudio && !isNaN(activeAudio.duration)) {
    activeAudio.currentTime = Math.min(sec, activeAudio.duration);
  }
}

function highlightSyncedLyricAtTime(currentSec) {
  const containers = [
    document.getElementById('mainLyricsContent'),
    document.getElementById('inlineLyricsBody'),
  ];

  containers.forEach(container => {
    if (!container) return;
    const lines = container.querySelectorAll('.lyric-line[data-sec]');
    if (!lines.length) return;

    let activeLine = null;
    lines.forEach(line => {
      const lineSec = Number(line.dataset.sec || 0);
      if (lineSec <= currentSec + 0.25) {
        activeLine = line;
      }
      line.classList.remove('is-active-line');
    });

    if (activeLine) {
      activeLine.classList.add('is-active-line');
    }
  });
}

function buildLyricsMarkup(data, filterQuery = '') {
  if (!data || !data.found || (!data.syncedLyrics && !data.plainLyrics)) {
    return `<div class="lyrics-empty">No archived lyrics found for "${escapeHtml(data?.trackName || 'this track')}".</div>`;
  }

  const q = String(filterQuery || '').trim().toLowerCase();

  if (data.syncedLyrics) {
    const rawLines = data.syncedLyrics.split('\n').filter(Boolean);
    const filtered = rawLines.filter(line => !q || line.toLowerCase().includes(q));
    if (!filtered.length) {
      return '<div class="lyrics-empty">No lyric lines match your filter.</div>';
    }
    return filtered
      .map(line => {
        const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)$/);
        if (match) {
          const min = Number(match[1]);
          const sec = Number(match[2]);
          const totalSec = min * 60 + sec;
          const timeStr = `${match[1]}:${match[2]}`;
          const text = match[4] || '♪';
          return `<div class="lyric-line synced-time" data-sec="${totalSec}" onclick="seekToLyricTime(${totalSec})" title="Jump to ${timeStr}"><span class="lyric-timestamp mono-num">${escapeHtml(timeStr)}</span><span>${escapeHtml(text)}</span></div>`;
        }
        return `<div class="lyric-line">${escapeHtml(line)}</div>`;
      })
      .join('');
  }

  const plainLines = String(data.plainLyrics || '').split('\n');
  const filteredPlain = plainLines.filter(line => !q || line.toLowerCase().includes(q));
  if (!filteredPlain.length) {
    return '<div class="lyrics-empty">No lyric lines match your filter.</div>';
  }
  return filteredPlain.map(l => `<div class="lyric-line">${escapeHtml(l || ' ')}</div>`).join('');
}

function filterDisplayedLyrics() {
  if (!lastLyricsResponse) return;
  const filterQuery = document.getElementById('lyricsSearchInput')?.value || '';
  const mainContent = document.getElementById('mainLyricsContent');
  if (mainContent) {
    mainContent.innerHTML = buildLyricsMarkup(lastLyricsResponse, filterQuery);
  }
}

async function fetchAndRenderLyrics(trackName, artistName) {
  const mainLabel = document.getElementById('mainLyricsTrackLabel');
  const mainContent = document.getElementById('mainLyricsContent');
  const mainCopyBtn = document.getElementById('mainCopyLyricsBtn');
  const inlineSub = document.getElementById('inlineLyricsSub');
  const inlineBody = document.getElementById('inlineLyricsBody');

  if (mainLabel) mainLabel.textContent = `${trackName} — ${artistName} (Click any timestamp to seek)`;
  if (inlineSub) inlineSub.textContent = `${trackName} — ${artistName}`;
  if (mainContent) mainContent.innerHTML = '<div class="lyrics-empty">Fetching synced lyrics from Go backend...</div>';
  if (inlineBody) inlineBody.innerHTML = '<div class="lyrics-empty">Fetching synced lyrics...</div>';
  if (mainCopyBtn) mainCopyBtn.classList.add('hidden');

  try {
    const data = await apiFetch(
      `/lyrics?track=${encodeURIComponent(trackName)}&artist=${encodeURIComponent(artistName)}`
    );
    lastLyricsResponse = data;

    if (data && data.found && (data.syncedLyrics || data.plainLyrics)) {
      currentLyricsText = data.plainLyrics || data.syncedLyrics;
      if (mainCopyBtn) mainCopyBtn.classList.remove('hidden');

      const filterQuery = document.getElementById('lyricsSearchInput')?.value || '';
      const markup = buildLyricsMarkup(data, filterQuery);
      if (mainContent) mainContent.innerHTML = markup;
      if (inlineBody) inlineBody.innerHTML = buildLyricsMarkup(data, '');
    } else {
      currentLyricsText = '';
      const emptyMsg = `<div class="lyrics-empty">No archived lyrics found for "${escapeHtml(trackName)}". Try another track from the catalog.</div>`;
      if (mainContent) mainContent.innerHTML = emptyMsg;
      if (inlineBody) inlineBody.innerHTML = emptyMsg;
    }
  } catch (_) {
    const errMsg = '<div class="lyrics-empty">Unable to load lyrics at this moment.</div>';
    if (mainContent) mainContent.innerHTML = errMsg;
    if (inlineBody) inlineBody.innerHTML = errMsg;
  }
}

function copyCurrentLyrics() {
  if (!currentLyricsText) return;
  navigator.clipboard?.writeText(currentLyricsText);
  const btn = document.getElementById('mainCopyLyricsBtn');
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = prev;
    }, 1500);
  }
}

// Artist Discography Spotlight (calls Go backend /artist endpoint using concurrent goroutines)
async function inspectArtist(index, containerId = 'results') {
  const track = findTrackByContainerAndIndex(containerId, index);
  if (!track || !track.artistName) return;

  recordActivitySignal({
    artist: track.artistName,
    genre: track.primaryGenreName,
  });

  if (document.getElementById('view-discover').classList.contains('hidden')) {
    switchTab('discover');
  }

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

  renderTracks(filtered, 'results');
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

  recordActivitySignal({ searchQuery: query });
  switchTab('discover');

  stopOtherAudio(null);
  stopYtEngine();
  updateNowPlaying('', '');
  closeArtistSpotlight();

  const container = document.getElementById('results');
  container.innerHTML = '<div class="status">Searching...</div>';

  try {
    const tracks = await apiFetch(`/search?q=${encodeURIComponent(query)}`);
    allTracks = Array.isArray(tracks) ? tracks : [];
    container.innerHTML = '';

    if (allTracks.length > 0 && allTracks[0].artistName) {
      recordActivitySignal({
        artist: allTracks[0].artistName,
        genre: allTracks[0].primaryGenreName,
      });
    }

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

// Navigation Tabs: Discover | Weekly Picks | Lyrics Studio | Blind Quiz | Saved Crate
function switchTab(tabName) {
  ['discover', 'weekly', 'lyrics', 'quiz', 'crate'].forEach(name => {
    const view = document.getElementById(`view-${name}`);
    const nav = document.getElementById(`nav-${name}`);
    if (view) view.classList.toggle('hidden', name !== tabName);
    if (nav) nav.classList.toggle('active', name === tabName);
  });

  if (tabName === 'weekly') {
    loadWeeklyRecommendations(true);
  } else if (tabName === 'quiz') {
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
  stopYtEngine();
  quizState.answered = false;

  const shuffled = [...playablePool].sort(() => Math.random() - 0.5).slice(0, 4);
  const answer = shuffled[Math.floor(Math.random() * shuffled.length)];
  quizState.currentTrack = answer;
  quizState.options = shuffled;

  if (quizState.audio) {
    quizState.audio.pause();
  }
  quizState.audio = new Audio(answer.previewUrl);
  quizState.audio.volume = 0.01;
  quizState.audio.addEventListener('play', () => {
    startGracefulFadeIn(quizState.audio, 1800, 0.01);
  });
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
    quizState.audio.volume = 0.01;
    startGracefulFadeIn(quizState.audio, 1800, 0.01);
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
    container.innerHTML = '<div class="status">Your crate is empty. Click "+ Crate" on any song in Discover or Weekly Picks to build your playlist.</div>';
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
