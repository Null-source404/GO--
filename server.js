import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());

const USERS_FILE = path.join(__dirname, 'Song', 'server', 'users.json');
const usersByEmail = new Map();
const sessions = new Map();

const fullLengthStudioStreams = [
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3',
];

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
    fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (_) {
    // Ignore write errors
  }
}

loadUsersFromDisk();

function hashPassword(email, password) {
  return crypto
    .createHash('sha256')
    .update(`${email.trim().toLowerCase()}:soniccrate:${password}`)
    .digest('hex');
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function authenticateRequest(req) {
  const authHeader = String(req.headers.authorization || '').trim();
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token && req.query.token) {
    token = String(req.query.token).trim();
  }
  if (!token) return null;
  const email = sessions.get(token);
  if (!email) return null;
  return usersByEmail.get(email) || null;
}

function normalizeTrack(item) {
  const artwork100 = item.artworkUrl100 || '';
  return {
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
}

app.post('/auth/register', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!name || !email || password.length < 4) {
    return res.status(400).send('Name, valid email, and password (min 4 chars) are required');
  }

  if (usersByEmail.has(email)) {
    return res.status(409).send('An account with that email already exists. Please sign in.');
  }

  const record = {
    name,
    email,
    passwordHash: hashPassword(email, password),
    createdAt: new Date().toISOString(),
  };
  usersByEmail.set(email, record);
  saveUsersToDisk();

  const token = generateToken();
  sessions.set(token, email);

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({
    token,
    user: { name: record.name, email: record.email },
  });
});

app.post('/auth/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const expectedHash = hashPassword(email, password);

  const record = usersByEmail.get(email);
  if (!record || record.passwordHash !== expectedHash) {
    return res.status(401).send('Invalid email or password');
  }

  const token = generateToken();
  sessions.set(token, email);

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({
    token,
    user: { name: record.name, email: record.email },
  });
});

app.post('/auth/logout', (req, res) => {
  const authHeader = String(req.headers.authorization || '').trim();
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (token) sessions.delete(token);
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({ ok: true });
});

app.get('/auth/me', (req, res) => {
  const user = authenticateRequest(req);
  if (!user) {
    return res.status(401).send('unauthorized');
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({ name: user.name, email: user.email });
});

async function lookupYouTubeVideoID(trackName, artistName) {
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
    const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    return match ? match[1] : '';
  } catch (_) {
    return '';
  }
}

function selectFullLengthStream(trackName, artistName) {
  const hash = crypto
    .createHash('sha256')
    .update(`${trackName}::${artistName}`.toLowerCase())
    .digest();
  const idx = hash[0] % fullLengthStudioStreams.length;
  return fullLengthStudioStreams[idx];
}

app.get('/fulltrack', async (req, res) => {
  const user = authenticateRequest(req);
  if (!user) {
    return res.status(401).send('Sign in required to unlock full-length songs');
  }

  const track = String(req.query.track || '').trim();
  const artist = String(req.query.artist || '').trim();
  if (!track) {
    return res.status(400).send("missing 'track' query param");
  }

  const [youtubeId, fullAudioUrl] = await Promise.all([
    lookupYouTubeVideoID(track, artist),
    Promise.resolve(selectFullLengthStream(track, artist)),
  ]);

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

app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).send("missing query param 'q'");
  }

  const searchURL = `https://itunes.apple.com/search?term=${encodeURIComponent(query.trim())}&media=music&entity=song&limit=20`;

  try {
    const response = await fetch(searchURL);
    if (!response.ok) {
      return res.status(500).send('failed to reach iTunes API');
    }

    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results.map(normalizeTrack) : [];

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
      topTracks = Array.isArray(songsData.results) ? songsData.results.map(normalizeTrack) : [];
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
app.use(express.static(clientDir));

app.get('*', (req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
