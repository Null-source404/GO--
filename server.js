import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

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
