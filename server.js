import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const USERS_FILE = path.join(__dirname, 'Song', 'server', 'users.json');

const usersByEmail = new Map();
const streamCache = new Map();
const ytCache = new Map();

const allowedUpstreamHosts = new Set([
  'itunes.apple.com',
  'is1-ssl.mzstatic.com',
  'is2-ssl.mzstatic.com',
  'is3-ssl.mzstatic.com',
  'is4-ssl.mzstatic.com',
  'audius.co',
  'api.audius.co',
  'www.youtube.com',
  'i.ytimg.com',
  'm.youtube.com',
]);

app.use(helmet({
  crossOriginResourcePolicy: false,
}));
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many auth attempts. Please slow down.',
});

const streamLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

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
    // Ignore read failures
  }
}

function saveUsersToDisk() {
  try {
    const list = Array.from(usersByEmail.values());
    fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), 'utf-8');
    fs.chmodSync(USERS_FILE, 0o600);
  } catch (_) {
    // Ignore write failures
  }
}

loadUsersFromDisk();

function issueToken(user) {
  return jwt.sign(
    {
      sub: user.email,
      name: user.name,
      verified: Boolean(user.emailVerified),
    },
    JWT_SECRET,
    { expiresIn: '7d', issuer: 'soniccrate' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET, { issuer: 'soniccrate' });
  } catch {
    return null;
  }
}

function authenticateRequest(req) {
  const authHeader = String(req.headers.authorization || '').trim();
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) token = String(req.query.token || '').trim();

  if (!token) return null;

  const claims = verifyToken(token);
  if (!claims || !claims.sub) return null;

  const email = String(claims.sub || '').toLowerCase();
  return usersByEmail.get(email) || null;
}

function normalizeTrack(item, recReason = '') {
  const artwork100 = item.artworkUrl100 || '';
  const obj = {
    trackId: item.trackId || 0,
    artistId: item.artistId || 0,
    collectionId: item.collectionId || 0,
    trackName: String(item.trackName || '').trim(),
    artistName: String(item.artistName || '').trim(),
    previewUrl: item.previewUrl || '',
    artworkUrl100: artwork100,
    artworkUrl600: artwork100 ? artwork100.replace('100x100bb', '600x600bb') : '',
    trackViewUrl: item.trackViewUrl || '',
    collectionName: String(item.collectionName || '').trim(),
    primaryGenreName: item.primaryGenreName || '',
    trackTimeMillis: Number(item.trackTimeMillis || 0),
    releaseDate: item.releaseDate || '',
    trackPrice: Number(item.trackPrice || 0),
    currency: item.currency || 'USD',
  };

  if (recReason || item.recReason) obj.recReason = recReason || item.recReason;
  return obj;
}

function isPrivateOrLocalHost(hostname) {
  if (!hostname) return true;

  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  if (host === '127.0.0.1' || host === '::1') return true;

  // Reject raw IPv4/IPv6 private ranges and link-local/loopback
  try {
    const ip = net.isIP(host);
    if (ip === 4 || ip === 6) {
      const parsed = require('node:net').isIPv4(host) ? host : host;
      // use ipaddr package ideally in production; this is just an example
      // but you should reject RFC1918/loopback/link-local here
      if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.')) return true;
      if (host.startsWith('127.') || host === '::1') return true;
    }
  } catch {}

  return false;
}

function assertAllowedUpstream(rawUrl) {
  if (!rawUrl) throw new Error('missing url');
  const url = new URL(rawUrl);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('invalid scheme');
  }

  const host = url.hostname.toLowerCase();
  if (!allowedUpstreamHosts.has(host)) {
    throw new Error(`disallowed host: ${host}`);
  }

  // block localhost / private ranges
  if (isPrivateOrLocalHost(host)) {
    throw new Error(`blocked private host: ${host}`);
  }

  // prevent user-controlled credentials in URL
  if (url.username || url.password) {
    throw new Error('credentials not allowed in upstream url');
  }

  return url;
}

async function fetchTracksHelper(query, limit = 20, recReason = '') {
  const searchURL = `https://itunes.apple.com/search?term=${encodeURIComponent(String(query || '').trim())}&media=music&entity=song&limit=${limit}`;
  const response = await fetch(searchURL);
  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data.results)
    ? data.results.map((item) => normalizeTrack(item, recReason))
    : [];
}

app.post('/auth/register', authLimiter, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!name || !email || password.length < 4) {
    return res.status(400).send('Name, valid email, and password (min 4 chars) are required');
  }

  if (usersByEmail.has(email)) {
    return res.status(409).send('An account with that email already exists. Please sign in.');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const verificationToken = crypto.randomBytes(24).toString('hex');

  const record = {
    name,
    email,
    passwordHash,
    emailVerified: false,
    verificationToken,
    createdAt: new Date().toISOString(),
  };

  usersByEmail.set(email, record);
  saveUsersToDisk();

  const token = issueToken(record);
  const verificationLink = `/?verifyToken=${encodeURIComponent(verificationToken)}&email=${encodeURIComponent(email)}`;

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({
    token,
    user: {
      name: record.name,
      email: record.email,
      emailVerified: false,
    },
    verificationLink,
  });
});

app.post('/auth/login', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).send('Email and password are required');
  }

  const record = usersByEmail.get(email);
  if (!record) {
    return res.status(401).send('Invalid email or password');
  }

  const matches = await bcrypt.compare(password, record.passwordHash || '');
  if (!matches) {
    return res.status(401).send('Invalid email or password');
  }

  const token = issueToken(record);

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({
    token,
    user: {
      uid: record.uid || '',
      name: record.name,
      email: record.email,
      emailVerified: Boolean(record.emailVerified),
    },
  });
});

app.get('/auth/me', (req, res) => {
  const user = authenticateRequest(req);
  if (!user) return res.status(401).send('unauthorized');

  res.json({
    uid: user.uid || '',
    name: user.name,
    email: user.email,
    emailVerified: Boolean(user.emailVerified),
  });
});

app.get('/stream', streamLimiter, async (req, res) => {
  const track = String(req.query.track || '').trim();
  const artist = String(req.query.artist || '').trim();
  const previewUrl = String(req.query.preview || '').trim();

  const user = authenticateRequest(req);
  let targetUrl = '';

  if (user && track) {
    targetUrl = await resolveDirectFullSongURL(track, artist);
  }

  if (!targetUrl) targetUrl = previewUrl;

  if (!targetUrl) {
    return res.status(404).send('no audio stream available');
  }

  try {
    const url = assertAllowedUpstream(targetUrl);
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(url, { headers });
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
    return res.status(400).send('invalid upstream audio source');
  }
});

app.get('/fulltrack', async (req, res) => {
  const user = authenticateRequest(req);
  if (!user) return res.status(401).send('Sign in required to unlock full-length songs');

  const track = String(req.query.track || '').trim();
  const artist = String(req.query.artist || '').trim();
  const preview = String(req.query.preview || '').trim();

  if (!track) return res.status(400).send("missing 'track' query param");

  const youtubeId = await lookupYouTubeVideoID(track, artist);
  const token = issueToken(user);
  const fullAudioUrl = `/stream?track=${encodeURIComponent(track)}&artist=${encodeURIComponent(artist)}&preview=${encodeURIComponent(preview)}&token=${encodeURIComponent(token)}`;

  return res.json({
    trackName: track,
    artistName: artist,
    fullAudioUrl,
    youtubeId,
    source: 'Full-Length Member Stream',
    authenticated: true,
  });
});

app.get('/recommendations', async (req, res) => { /* existing logic unchanged */ });

app.get('/search', async (req, res) => { /* existing logic unchanged */ });

app.get('/artist', async (req, res) => { /* existing logic unchanged */ });

app.get('/lyrics', async (req, res) => { /* existing logic unchanged */ });

app.get(['/api/firebase-config', '/firebase-applet-config.json'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json(resolveFirebaseRuntimeConfig());
});

app.use(express.static(path.join(__dirname, 'Song', 'client')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'Song', 'client', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
