import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).send("missing query param 'q'");
  }

  const searchURL = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=12`;

  try {
    const response = await fetch(searchURL);
    if (!response.ok) {
      return res.status(500).send('failed to reach iTunes API');
    }

    const data = await response.json();
    const results = Array.isArray(data.results)
      ? data.results.map((item) => ({
          trackName: (item.trackName || '').trim(),
          artistName: (item.artistName || '').trim(),
          previewUrl: item.previewUrl || '',
          artworkUrl100: item.artworkUrl100 || '',
          trackViewUrl: item.trackViewUrl || '',
          collectionName: (item.collectionName || '').trim(),
          primaryGenreName: item.primaryGenreName || '',
          trackTimeMillis: item.trackTimeMillis || 0,
        }))
      : [];

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json(results);
  } catch (err) {
    return res.status(500).send('failed to reach iTunes API');
  }
});

const clientDir = path.join(__dirname, 'Song', 'client');
app.use(express.static(clientDir));

app.get('*', (req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
