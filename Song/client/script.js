let activeAudio = null;
let allTracks = [];
let currentTrackLabel = '';

function stopOtherAudio(currentAudio) {
  if (activeAudio && activeAudio !== currentAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
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

function renderTracks(tracks) {
  const container = document.getElementById('results');
  container.innerHTML = '';

  if (!Array.isArray(tracks) || tracks.length === 0) {
    container.innerHTML = '<div class="status">No songs found for that search.</div>';
    return;
  }

  const countLabel = document.getElementById('resultsCount');
  countLabel.textContent = `${tracks.length} matching songs`;

  tracks.forEach(track => {
    const div = document.createElement('div');
    div.className = 'track';
    div.dataset.title = track.trackName || 'Untitled track';
    div.dataset.artist = track.artistName || 'Unknown artist';

    const artwork = track.artworkUrl100 ? `<img src="${track.artworkUrl100}" alt="album art">` : '';
    const title = track.trackName || 'Untitled track';
    const artist = track.artistName || 'Unknown artist';
    const album = track.collectionName ? `<div class="meta">${track.collectionName}</div>` : '';
    const preview = track.previewUrl
      ? `
        <div class="preview-row">
          <button class="play-btn" type="button">▶ Play preview</button>
          <audio preload="none" class="preview-audio"><source src="${track.previewUrl}" type="audio/mpeg"></audio>
        </div>
      `
      : '<div class="meta">Preview not available for this track.</div>';

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
    const button = audio.parentElement.querySelector('.play-btn');

    button.addEventListener('click', () => {
      stopOtherAudio(audio);
      const card = audio.closest('.track');
      if (card) {
        updateNowPlaying(card.dataset.title, card.dataset.artist);
      }
      audio.play().catch(() => {
        updateNowPlaying('', '');
      });
    });

    audio.addEventListener('play', () => {
      const card = audio.closest('.track');
      if (card) {
        updateNowPlaying(card.dataset.title, card.dataset.artist);
      }
    });
    audio.addEventListener('ended', () => updateNowPlaying('', ''));
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

async function search() {
  const query = document.getElementById('query').value.trim();
  if (!query) return;

  const container = document.getElementById('results');
  container.innerHTML = '<div class="status">Searching...</div>';

  try {
    const res = await fetch(`http://localhost:8080/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) {
      throw new Error('Unable to reach the music server');
    }

    const tracks = await res.json();
    allTracks = Array.isArray(tracks) ? tracks : [];
    container.innerHTML = '';

    if (!allTracks.length) {
      document.getElementById('resultsCount').textContent = 'No results yet';
      updateNowPlaying('', '');
      container.innerHTML = '<div class="status">No songs found for that search.</div>';
      return;
    }

    renderTracks(allTracks);
  } catch (error) {
    container.innerHTML = `<div class="status error">${error.message}</div>`;
  }
}