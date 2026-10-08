import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import NodeCache from 'node-cache';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import csrf from 'csurf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

app.use(helmet());
app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => {
  // Enforce HTTPS in production
  if (process.env.NODE_ENV === 'production' && req.protocol !== 'https') {
    return res.status(403).send('HTTPS required');
  }
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGINS || '*');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

const USERS_FILE = path.join(__dirname, 'Song', 'server', 'users.json');
const usersByEmail = new Map();

// Secure caches with TTL
const ytCache = new NodeCache({ stdTTL: 3600 }); // 1 hour
const streamCache = new NodeCache({ stdTTL: 1800 }); // 30 min

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per IP
  message: 'Too many auth attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const csrfProtection = csrf({ cookie: true });

function loadUsersFromDisk() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const list = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
      if (Array.isArray(list)) {
        list.forEach((u) => {
          if (u && u.email) usersByEmail.set(u.email.toLowerCase(), u);
        });
      }
    }
  } catch (_) {
    // Ignore read errors
  }
}

function saveUsersToDisk() {
  try {
    const list = Array.from(usersByEmail.values());
    // Write with restricted permissions (0600 = owner only)
    fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), { mode: 0o600, encoding: 'utf-8' });
  } catch (err) {
    console.error('Failed to save users:', err);
  }
}

function verifyFilePermissions() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      const stats = fs.statSync(USERS_FILE);
      if ((stats.mode & 0o077) !== 0) {
        console.warn('⚠️  users.json has insecure permissions; fixing...');
        fs.chmodSync(USERS_FILE, 0o600);
      }
    } catch (_) {}
  }
}

loadUsersFromDisk();
verifyFilePermissions();

async function hashPassword(password) {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
}

async function verifyPassword(plaintext, hash) {
  return await bcrypt.compare(plaintext, hash);
}

function generateSessionToken(email) {
  return jwt.sign(
    { email, iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function verifySessionToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return null;
  }
}

function authenticateRequest(req) {
  const authHeader = String(req.headers.authorization || '').trim();
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token && req.query.token) {
    token = String(req.query.token).trim();
  }
  if (!token) return null;
  
  const decoded = verifySessionToken(token);
  if (!decoded) return null;
  
  return usersByEmail.get(decoded.email) || null;
}

function normalizeTrack(item, recReason = '') {
  const artwork100 = item.artworkUrl100 || '';
  const obj = {
    trackId: item.trackId || 0,
    artistId: item.artistId || 0,
    collectionId: item.collectionId || 0,
    trackName: (item.trackName || '').trim(),
    artistName: (item.artistName || '').trim(),
    previewUrl: item.previewUrl || '',
    artworkUrl100: artwork100,
    artworkUrl600: artwork100 ? artwork100.replace('100x100bb', '600x600bb') : '',
    trackViewUrl: item.trackViewUrl || '',
    collectionName: (item.collectionName || '').trim(),
    primaryGenreName: item.primaryGenreName || '',
    trackTimeMillis: item.trackTimeMillis || 0,
    releaseDate: item.releaseDate || '',
    trackPrice: item.trackPrice || 0,
    currency: item.currency || 'USD',
  };
  if (recReason || item.recReason) {
    obj.recReason = recReason || item.recReason;
  }
  return obj;
}

async function fetchTracksHelper(query, limit = 20, recReason = '') {
  const searchURL = `https://itunes.apple.com/search?term=${encodeURIComponent(query.trim())}&media=music&entity=song&limit=${limit}`;
  const response = await fetch(searchURL);
  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data.results)
    ? data.results.map((item) => normalizeTrack(item, recReason))
    : [];
}

async function fetchWeeklyHitsHelper(limit = 12) {
  try {
    const rssURL = `https://itunes.apple.com/us/rss/topsongs/limit=${limit}/json`;
    const r = await fetch(rssURL);
    if (r.ok) {
      const data = await r.json();
      const entries = data?.feed?.entry || [];
      if (Array.isArray(entries) && entries.length > 0) {
        const hits = [];
        entries.forEach((entry, idx) => {
          const trackId = Number(entry?.id?.attributes?.['im:id'] || 0);
          const imgs = Array.isArray(entry?.['im:image']) ? entry['im:image'] : [];
          const art100 = imgs.length ? imgs[imgs.length - 1].label : '';
          const art600 = art100 ? art100.replace('170x170bb', '600x600bb') : '';
          const links = Array.isArray(entry?.link) ? entry.link : [];
          let previewUrl = '';
          let trackViewUrl = '';
          links.forEach((l) => {
            const attrs = l?.attributes || {};
            if ((attrs.type && attrs.type.includes('audio')) || attrs.rel === 'enclosure') {
              previewUrl = attrs.href || '';
            } else if (attrs.rel === 'alternate' && !trackViewUrl) {
              trackViewUrl = attrs.href || '';
            }
          });
          const trackName = (entry?.['im:name']?.label || '').trim();
          const artistName = (entry?.['im:artist']?.label || '').trim();
          if (previewUrl && trackName) {
            hits.push({
              trackId,
              artistId: 0,
              collectionId: 0,
              trackName,
              artistName,
              collectionName: (entry?.['im:collection']?.['im:name']?.label || '').trim(),
              previewUrl,
              artworkUrl100: art100,
              artworkUrl600: art600,
              trackViewUrl,
              primaryGenreName: entry?.category?.attributes?.label || '',
              releaseDate: entry?.['im:releaseDate']?.label || '',
              trackTimeMillis: 210000,
              recReason: `Weekly Global Chart #${idx + 1}`,
            });
          }
        });
        if (hits.length > 0) return hits;
      }
    }
  } catch (_) {}

  try {
    const fallback = await fetchTracksHelper('top hits 2025', limit);
    return fallback.map((t, i) => ({
      ...t,
      recReason: `Weekly Hit #${i + 1}`,
    }));
  } catch (_) {
    return [];
  }
}

app.post('/auth/register', authLimiter, csrfProtection, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!name || !email || password.length < 6) {
    return res.status(400).send('Name, valid email, and password (min 6 chars) are required');
  }

  if (usersByEmail.has(email)) {
    return res.status(409).send('An account with that email already exists. Please sign in.');
  }

  try {
    const passwordHash = await hashPassword(password);
    const record = {
      name,
      email,
      passwordHash,
      emailVerified: false,
      verificationToken: crypto.randomBytes(32).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    usersByEmail.set(email, record);
    saveUsersToDisk();

    const token = generateSessionToken(email);
    const verificationLink = `/?verifyToken=${encodeURIComponent(record.verificationToken)}&email=${encodeURIComponent(email)}&_internal=verify`;

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json({
      token,
      user: {
        name: record.name,
        email: record.email,
        emailVerified: record.emailVerified,
      },
      verificationLink,
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).send('Registration failed');
  }
});

app.post('/auth/login', authLimiter, csrfProtection, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  try {
    const record = usersByEmail.get(email);
    const passwordMatches = record ? await verifyPassword(password, record.passwordHash) : false;

    if (!record || !passwordMatches) {
      return res.status(401).send('Invalid email or password');
    }

    if (!record.verificationToken) {
      record.verificationToken = crypto.randomBytes(32).toString('hex');
      usersByEmail.set(email, record);
      saveUsersToDisk();
    }

    const token = generateSessionToken(email);
    const verificationLink =
      !record.emailVerified && record.verificationToken
        ? `/?verifyToken=${encodeURIComponent(record.verificationToken)}&email=${encodeURIComponent(email)}&_internal=verify`
        : '';

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json({
      token,
      user: {
        uid: record.uid || '',
        name: record.name,
        email: record.email,
        emailVerified: Boolean(record.emailVerified),
      },
      verificationLink,
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).send('Login failed');
  }
});

app.post('/auth/firebase-sync', authLimiter, csrfProtection, async (req, res) => {
  const uid = String(req.body?.uid || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  let name = String(req.body?.name || '').trim();
  const emailVerified = Boolean(req.body?.emailVerified);

  if (!email) {
    return res.status(400).send('email is required');
  }
  if (!name) {
    name = email.split('@')[0];
  }

  try {
    let record = usersByEmail.get(email);
    if (!record) {
      record = {
        uid,
        name,
        email,
        passwordHash: '', // Firebase auth, no local password
        emailVerified,
        verificationToken: crypto.randomBytes(32).toString('hex'),
        createdAt: new Date().toISOString(),
      };
    } else {
      if (uid) record.uid = uid;
      if (name) record.name = name;
      if (emailVerified) record.emailVerified = true;
      if (!record.verificationToken) record.verificationToken = crypto.randomBytes(32).toString('hex');
    }
    usersByEmail.set(email, record);
    saveUsersToDisk();

    const token = generateSessionToken(email);
    const verificationLink =
      !record.emailVerified && record.verificationToken
        ? `/?verifyToken=${encodeURIComponent(record.verificationToken)}&email=${encodeURIComponent(email)}&_internal=verify`
        : '';

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json({
      token,
      user: {
        uid: record.uid || '',
        name: record.name,
        email: record.email,
        emailVerified: Boolean(record.emailVerified),
      },
      verificationLink,
    });
  } catch (err) {
    console.error('Firebase sync error:', err);
    return res.status(500).send('Firebase sync failed');
  }
});

app.get('/auth/verify', authLimiter, (req, res) => {
  const verifyTok = String(req.query.verifyToken || '').trim();
  const email = String(req.query.email || '').trim().toLowerCase();
  const isInternal = req.query._internal === 'verify';

  if (!isInternal) {
    return res.status(400).send('Invalid verification link');
  }

  const record = usersByEmail.get(email);
  if (!record) {
    return res.status(400).send('Invalid or expired verification link');
  }

  let tokenValid = false;
  if (verifyTok && record.verificationToken) {
    try {
      tokenValid = crypto.timingSafeEqual(
        Buffer.from(verifyTok),
        Buffer.from(record.verificationToken)
      );
    } catch (_) {
      tokenValid = false;
    }
  }

  if (!tokenValid) {
    return res.status(400).send('Invalid or expired verification link');
  }

  record.emailVerified = true;
  usersByEmail.set(email, record);
  saveUsersToDisk();

  const token = generateSessionToken(email);

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({
    token,
    user: {
      uid: record.uid || '',
      name: record.name,
      email: record.email,
      emailVerified: true,
    },
  });
});

app.post('/auth/logout', csrfProtection, (req, res) => {
  // JWT is stateless; logout is client-side (discard token)
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({ ok: true });
});

app.get('/auth/me', (req, res) => {
  const user = authenticateRequest(req);
  if (!user) {
    return res.status(401).send('unauthorized');
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({
    uid: user.uid || '',
    name: user.name,
    email: user.email,
    emailVerified: Boolean(user.emailVerified),
  });
});

async function isYouTubeEmbeddable(videoId) {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`;
    const r = await fetch(oembedUrl);
    return r.ok;
  } catch (_) {
    return false;
  }
}

async function lookupYouTubeVideoID(trackName, artistName) {
  const cacheKey = `${trackName.trim()}::${artistName.trim()}`.toLowerCase();
  if (ytCache.has(cacheKey)) {
    return ytCache.get(cacheKey);
  }

  const query = `${trackName} ${artistName} official audio`;
  const searchURL = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  try {
    const resp = await fetch(searchURL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!resp.ok) return '';
    const html = await resp.text();
    const matches = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)].map((m) => m[1]);
    const candidates = [...new Set(matches)].slice(0, 5);
    if (!candidates.length) return '';

    const checks = await Promise.all(candidates.map((id) => isYouTubeEmbeddable(id)));
    const validIdx = checks.findIndex(Boolean);
    const chosen = validIdx >= 0 ? candidates[validIdx] : candidates[0];
    ytCache.set(cacheKey, chosen);
    return chosen;
  } catch (_) {
    return '';
  }
}

function isValidAudioUrl(url) {
  try {
    const parsed = new URL(url);
    const allowed = ['itunes.apple.com', 'audius.co', 'youtube.com', 'youtu.be'];
    return allowed.some(domain => parsed.hostname.includes(domain));
  } catch (_) {
    return false;
  }
}

async function resolveDirectFullSongURL(trackName, artistName) {
  const cacheKey = `${trackName.trim()}::${artistName.trim()}`.toLowerCase();
  if (streamCache.has(cacheKey)) {
    return streamCache.get(cacheKey);
  }

  const query = `${trackName} ${artistName}`.trim();

  try {
    const r2 = await fetch(
      `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=soniccrate`,
      { signal: AbortSignal.timeout(1200) }
    );
    if (r2.ok) {
      const j2 = await r2.json();
      const first = j2.data?.[0];
      if (first && first.id) {
        const audiusStream = `https://api.audius.co/v1/tracks/${encodeURIComponent(first.id)}/stream?app_name=soniccrate`;
        if (isValidAudioUrl(audiusStream)) {
          streamCache.set(cacheKey, audiusStream);
          return audiusStream;
        }
      }
    }
  } catch (_) {}

  return '';
}

app.get('/stream', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const track = String(req.query.track || '').trim();
  const artist = String(req.query.artist || '').trim();
  const previewUrl = String(req.query.preview || '').trim();

  // Validate previewUrl against whitelist
  if (previewUrl && !isValidAudioUrl(previewUrl)) {
    return res.status(400).send('Invalid audio URL');
  }

  const user = authenticateRequest(req);
  let targetUrl = '';

  if (user && track) {
    targetUrl = await resolveDirectFullSongURL(track, artist);
  }
  if (!targetUrl) {
    targetUrl = previewUrl;
  }
  if (!targetUrl) {
    return res.status(404).send('no audio stream available');
  }

  const headers = { 'User-Agent': 'Mozilla/5.0' };
  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  try {
    let upstream = await fetch(targetUrl, { headers });
    if (!upstream.ok && previewUrl && targetUrl !== previewUrl) {
      upstream = await fetch(previewUrl, { headers });
    }
    if (!upstream.ok || !upstream.body) {
      return res.status(502).send('failed to fetch upstream audio');
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const cr = upstream.headers.get('content-range');
    if (cr) res.setHeader('Content-Range', cr);
    res.setHeader('Accept-Ranges', 'bytes');

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).send('stream proxy error');
    }
  }
});

app.get('/fulltrack', async (req, res) => {
  const user = authenticateRequest(req);
  if (!user) {
    return res.status(401).send('Sign in required to unlock full-length songs');
  }

  const track = String(req.query.track || '').trim();
  const artist = String(req.query.artist || '').trim();
  const preview = String(req.query.preview || '').trim();
  const authHeader = String(req.headers.authorization || '').trim();
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : String(req.query.token || '').trim();

  if (!track) {
    return res.status(400).send("missing 'track' query param");
  }

  const youtubeId = await lookupYouTubeVideoID(track, artist);
  const fullAudioUrl = `/stream?track=${encodeURIComponent(track)}&artist=${encodeURIComponent(artist)}&preview=${encodeURIComponent(preview)}&token=${encodeURIComponent(token)}`;

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({
    trackName: track,
    artistName: artist,
    fullAudioUrl,
    youtubeId,
    source: 'Full-Length Member Stream',
    authenticated: true,
  });
});

app.get('/recommendations', async (req, res) => {
  const rawArtists = String(req.query.artists || '').trim();
  const rawGenres = String(req.query.genres || '').trim();
  const rawExclude = String(req.query.exclude || '').trim();

  const excludeSet = new Set(
    rawExclude
      ? rawExclude
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []
  );

  const seeds = [];
  const basis = [];

  if (rawArtists) {
    rawArtists
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3)
      .forEach((artist) => {
        seeds.push({
          term: artist,
          reason: `Based on your activity with ${artist}`,
        });
        basis.push(artist);
      });
  }

  if (rawGenres) {
    rawGenres
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((genre) => {
        if (seeds.length < 4) {
          seeds.push({
            term: `${genre} hits`,
            reason: `Matched to your ${genre} listening sessions`,
          });
          basis.push(genre);
        }
      });
  }

  if (seeds.length === 0) {
    seeds.push(
      { term: 'Daft Punk', reason: 'Studio Discovery · Electronic Essentials' },
      { term: 'The Weeknd', reason: 'Studio Discovery · Synthwave & Pop' },
      { term: 'Tame Impala', reason: 'Studio Discovery · Modern Psychedelia' }
    );
    basis.push('Electronic Essentials', 'Synthwave & Pop', 'Modern Psychedelia');
  }

  try {
    const [weeklyHits, ...forYouPools] = await Promise.all([
      fetchWeeklyHitsHelper(12),
      ...seeds.map((s) => fetchTracksHelper(s.term, 8, s.reason).catch(() => [])),
    ]);

    const seen = new Set();
    const forYou = [];

    for (let round = 0; round < 8 && forYou.length < 12; round++) {
      for (let sIdx = 0; sIdx < forYouPools.length; sIdx++) {
        const pool = forYouPools[sIdx] || [];
        if (round < pool.length) {
          const t = pool[round];
          const idStr = String(t.trackId || '');
          if (t.trackId && !seen.has(t.trackId) && !excludeSet.has(idStr) && t.previewUrl) {
            seen.add(t.trackId);
            forYou.push(t);
            if (forYou.length >= 12) break;
          }
        }
      }
    }

    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((now - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
    const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json({
      weekLabel: `Week ${weekNum} · ${dateStr}`,
      activityBasis: basis,
      forYou,
      weeklyHits,
    });
  } catch (err) {
    return res.status(500).send('failed to load recommendations');
  }
});

app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).send("missing query param 'q'");
  }

  try {
    const results = await fetchTracksHelper(query, 20);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json(results);
  } catch (err) {
    return res.status(500).send('failed to reach iTunes API');
  }
});

app.get('/artist', async (req, res) => {
  const artistName = req.query.name;
  if (!artistName || typeof artistName !== 'string' || !artistName.trim()) {
    return res.status(400).send("missing query param 'name'");
  }

  const encoded = encodeURIComponent(artistName.trim());
  const songsURL = `https://itunes.apple.com/search?term=${encoded}&media=music&entity=song&limit=10`;
  const albumsURL = `https://itunes.apple.com/search?term=${encoded}&media=music&entity=album&limit=8`;

  try {
    const [songsResp, albumsResp] = await Promise.all([
      fetch(songsURL).catch(() => null),
      fetch(albumsURL).catch(() => null),
    ]);

    let topTracks = [];
    let albums = [];

    if (songsResp && songsResp.ok) {
      const songsData = await songsResp.json();
      topTracks = Array.isArray(songsData.results) ? songsData.results.map((i) => normalizeTrack(i)) : [];
    }

    if (albumsResp && albumsResp.ok) {
      const albumsData = await albumsResp.json();
      albums = Array.isArray(albumsData.results)
        ? albumsData.results.map((a) => ({
            collectionId: a.collectionId || 0,
            collectionName: a.collectionName || '',
            artistName: a.artistName || '',
            artworkUrl100: a.artworkUrl100 || '',
            releaseDate: a.releaseDate || '',
            trackCount: a.trackCount || 0,
            primaryGenreName: a.primaryGenreName || '',
            collectionViewUrl: a.collectionViewUrl || '',
          }))
        : [];
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json({
      artistName: artistName.trim(),
      topTracks,
      albums,
    });
  } catch (err) {
    return res.status(500).send('failed to fetch artist profile');
  }
});

app.get('/lyrics', async (req, res) => {
  const track = req.query.track;
  const artist = req.query.artist;
  if (!track || !artist) {
    return res.status(400).send("missing 'track' or 'artist' query param");
  }

  const searchURL = `https://lrclib.net/api/search?track_name=${encodeURIComponent(String(track).trim())}&artist_name=${encodeURIComponent(String(artist).trim())}`;

  try {
    const response = await fetch(searchURL, {
      headers: { 'User-Agent': 'Go-iTunes-Music-Explorer/1.0' },
    });
    if (response.ok) {
      const items = await response.json();
      if (Array.isArray(items) && items.length > 0) {
        const match = items.find((i) => i.plainLyrics || i.syncedLyrics);
        if (match) {
          res.setHeader('Access-Control-Allow-Origin', '*');
          return res.json({
            trackName: match.trackName || track,
            artistName: match.artistName || artist,
            plainLyrics: match.plainLyrics || '',
            syncedLyrics: match.syncedLyrics || '',
            found: true,
          });
        }
      }
    }
  } catch (_) {
    // Fallback below
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({
    trackName: String(track),
    artistName: String(artist),
    plainLyrics: '',
    syncedLyrics: '',
    found: false,
  });
});

const clientDir = path.join(__dirname, 'Song', 'client');

function resolveFirebaseRuntimeConfig() {
  if (process.env.FIREBASE_API_KEY && process.env.FIREBASE_PROJECT_ID) {
    return {
      configured: true,
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
      appId: process.env.FIREBASE_APP_ID || '',
      firestoreDatabaseId: process.env.FIREBASE_FIRESTORE_DATABASE_ID || '(default)',
    };
  }

  const rootConfig = path.join(__dirname, 'firebase-applet-config.json');
  if (fs.existsSync(rootConfig)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(rootConfig, 'utf8'));
      if (parsed && parsed.apiKey && !String(parsed.apiKey).includes('your_firebase_api_key')) {
        return { configured: true, ...parsed };
      }
    } catch (_) {}
  }

  return { configured: false };
}

app.get(['/api/firebase-config', '/firebase-applet-config.json'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json(resolveFirebaseRuntimeConfig());
});

app.use(express.static(clientDir));

app.get('*', (req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  if (process.env.NODE_ENV === 'production') {
    console.log('⚠️  Production mode: HTTPS required, CSRF protection enabled, rate limiting active');
  }
});
