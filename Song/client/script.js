let activeAudio = null;
let activeButton = null;
let allTracks = [];

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stopOtherAudio(currentAudio) {
  if (activeAudio && activeAudio !== currentAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    if (activeButton) {
      activeButton.textContent = '▶ Play preview';
    }
  }
  activeAudio = currentAudio;
}

function updateNowPlaying(title, artist) {
  const nowPlaying = document.getElementById('nowPlaying');
  if (title && artist) {
    nowPlaying.textContent = `Now playing: ${title} — ${artist}`;
  } else {
    nowPlaying.textContent = 'Pick a song to start listening.';
  }
}

function formatDuration(ms) {
  if (!ms || typeof ms !== 'number' || ms <= 0) return '';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

function renderTracks(tracks) {
  const container = document.getElementById('results');
  const countLabel = document.getElementById('resultsCount');
  container.innerHTML = '';

  if (!Array.isArray(tracks) || tracks.length === 0) {
    countLabel.textContent = allTracks.length
      ? `0 of ${allTracks.length} matching songs`
      : 'No results yet';
    container.innerHTML = '<div class="status">No songs found for that search.</div>';
    return;
  }

  countLabel.textContent =
    tracks.length === allTracks.length
      ? `${tracks.length} matching songs`
      : `${tracks.length} of ${allTracks.length} matching songs`;

  tracks.forEach(track => {
    const div = document.createElement('div');
    div.className = 'track';

    const rawTitle = track.trackName || 'Untitled track';
    const rawArtist = track.artistName || 'Unknown artist';
    div.dataset.title = rawTitle;
    div.dataset.artist = rawArtist;

    const title = escapeHtml(rawTitle);
    const artist = escapeHtml(rawArtist);
    const artwork = track.artworkUrl100
      ? `<img src="${escapeHtml(track.artworkUrl100)}" alt="${title} album art" loading="lazy">`
      : '';

    const duration = formatDuration(track.trackTimeMillis);
    const genre = track.primaryGenreName ? escapeHtml(track.primaryGenreName) : '';
    const albumText = track.collectionName ? escapeHtml(track.collectionName) : '';
    const metaParts = [albumText, genre, duration].filter(Boolean);
    const album = metaParts.length ? `<div class="meta">${metaParts.join(' • ')}</div>` : '';

    const itunesLink = track.trackViewUrl
      ? `<a class="itunes-link" href="${escapeHtml(track.trackViewUrl)}" target="_blank" rel="noopener noreferrer">View on iTunes ↗</a>`
      : '';

    const preview = track.previewUrl
      ? `
        <div class="preview-row">
          <button class="play-btn" type="button">▶ Play preview</button>
          ${itunesLink}
        </div>
        <audio controls preload="none" class="preview-audio"><source src="${escapeHtml(track.previewUrl)}" type="audio/mpeg"></audio>
      `
      : `<div class="meta">Preview not available for this track. ${itunesLink}</div>`;

    div.innerHTML = `
      <div class="track-card">
        ${artwork}
        <div class="track-info">
          <strong>${title}</strong>
          <div class="artist">${artist}</div>
          ${album}
          ${preview}
        </div>
      </div>
    `;
    container.appendChild(div);
  });

  const audios = container.querySelectorAll('.preview-audio');
  audios.forEach(audio => {
    const card = audio.closest('.track');
    const button = card ? card.querySelector('.play-btn') : null;

    if (button) {
      button.addEventListener('click', () => {
        if (!audio.paused) {
          audio.pause();
          return;
        }
        stopOtherAudio(audio);
        activeButton = button;
        audio.play().catch(() => {
          updateNowPlaying('', '');
          button.textContent = '▶ Play preview';
        });
      });
    }

    audio.addEventListener('play', () => {
      stopOtherAudio(audio);
      activeButton = button;
      if (button) {
        button.textContent = '⏸ Pause preview';
      }
      if (card) {
        updateNowPlaying(card.dataset.title, card.dataset.artist);
      }
    });

    audio.addEventListener('pause', () => {
      if (button) {
        button.textContent = '▶ Play preview';
      }
      if (activeAudio === audio && audio.ended) {
        updateNowPlaying('', '');
      }
    });

    audio.addEventListener('ended', () => {
      if (button) {
        button.textContent = '▶ Play preview';
      }
      updateNowPlaying('', '');
    });
  });
}

function filterResults() {
  const filterValue = document.getElementById('filterInput').value.trim().toLowerCase();
  if (!filterValue) {
    renderTracks(allTracks);
    return;
  }

  const filtered = allTracks.filter(track => {
    const title = (track.trackName || '').toLowerCase();
    const artist = (track.artistName || '').toLowerCase();
    const album = (track.collectionName || '').toLowerCase();
    return title.includes(filterValue) || artist.includes(filterValue) || album.includes(filterValue);
  });

  renderTracks(filtered);
}

async function fetchSearchResults(query) {
  const encoded = encodeURIComponent(query);
  // Use relative /search when served by the backend, with fallback to localhost:8080 if index.html is opened directly
  const endpoints = [`/search?q=${encoded}`, `http://localhost:8080/search?q=${encoded}`];

  for (const url of endpoints) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return await res.json();
      }
    } catch (_) {
      // Try next endpoint
    }
  }
  throw new Error('Unable to reach the music server. Make sure the Go server is running.');
}

async function search() {
  const query = document.getElementById('query').value.trim();
  if (!query) return;

  stopOtherAudio(null);
  updateNowPlaying('', '');

  const container = document.getElementById('results');
  container.innerHTML = '<div class="status">Searching...</div>';

  try {
    const tracks = await fetchSearchResults(query);
    allTracks = Array.isArray(tracks) ? tracks : [];
    container.innerHTML = '';

    if (!allTracks.length) {
      document.getElementById('resultsCount').textContent = 'No results yet';
      updateNowPlaying('', '');
      container.innerHTML = '<div class="status">No songs found for that search.</div>';
      return;
    }

    const filterInput = document.getElementById('filterInput');
    if (filterInput && filterInput.value.trim()) {
      filterResults();
    } else {
      renderTracks(allTracks);
    }
  } catch (error) {
    container.innerHTML = `<div class="status error">${escapeHtml(error.message)}</div>`;
  }
}
