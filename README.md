# iTunes Search CLI / App (SonicCrate)

A lightweight, fast media search and music discovery studio built in Go that interfaces with Apple's public iTunes Search API and LRCLIB's synced lyrics catalog. Built to explore Go's concurrency (`sync.WaitGroup` goroutines), strict typing, session authentication, and zero-dependency compilation.

![App Screenshot](Song/screenshot-2026-08-04.png)

## Features

- **Instant Search & Filtering:** Query track, album, and artist metadata directly from the command line or web studio interface, with live client-side filtering and sorting (relevance, release year, track duration).
- **Tiered Playback (Guest 30s Previews vs. Registered Full Songs):**
  - **Guest Mode (Before Login):** Play 30-second iTunes audio previews immediately without an account.
  - **Registered Member Mode (After Login):** Create an account or sign in (`/auth/register`, `/auth/login`) to unlock the `/fulltrack` endpoint, providing uninterrupted full-length multi-minute studio audio streams and official full-song YouTube Music matching.
- **Studio Listening Deck & Vinyl Pitch Control:** Features a real-time 32-bar HTML5 Canvas frequency spectrum visualizer, interactive time scrubber, continuous auto-advance queue, and Vinyl Speed controls (`0.85x Slowed`, `1.0x Studio`, `1.18x Nightcore`).
- **Synced Lyrics Studio & Artist Discographies:** Concurrently fetches time-synced LRC/plain lyrics (`/lyrics`) and full artist album discographies (`/artist`) via Go goroutines.
- **Blind Audio Listening Quiz & Saved Crate:** Test your music ear with a 4-option mystery audio trivia mode, bookmark favorite songs into a persistent crate, and export `.m3u` playlists.
- **Fast Parsing & Concurrent Requests:** Statically typed JSON unmarshaling and parallel payload fetching using Go's `sync.WaitGroup` and `sync.RWMutex`.
- **Zero External Dependencies:** Built purely on Go's standard library (`net/http`, `encoding/json`, `crypto/sha256`, `crypto/rand`, `sync`).
- **Single Binary:** Cross-compiles into a standalone executable with automatic static client directory resolution.

## Tech Stack

- **Language:** Go (1.20+)
- **APIs:** Apple iTunes Search API, LRCLIB Synced Lyrics API, Full-Track Stream Resolver
- **UI / Library:** Go Standard Library (`net/http`) + HTML5 / CSS3 / Vanilla JS Studio Client (Web Audio API & Canvas Visualizer)

## Architecture & Code Highlights

```text
GO--/
├── Song/
│   ├── client/
│   │   ├── index.html               # Two-column Studio UI, Listening Deck, Auth modal & Quiz view
│   │   ├── index.css                # Responsive dark-slate studio styling
│   │   └── script.js                # Auth state, full-song switching, visualizer, quiz & crate logic
│   ├── server/
│   │   └── main.go                  # Go HTTP server, concurrent iTunes/Lyrics/Artist fetchers,
│   │                                # SHA-256 Auth handlers (/auth/*) & Full-Track resolver (/fulltrack)
│   ├── go.mod                       # Go module definition (zero external dependencies)
│   └── screenshot-2026-08-04.png    # Application interface preview
└── README.md
```

### Server Endpoints (`Song/server/main.go`)

| Endpoint | Method | Auth | Description |
| :--- | :--- | :--- | :--- |
| `/search?q=<query>` | `GET` | Public | Queries iTunes Search API and normalizes track metadata + 600x600 artwork concurrently. |
| `/artist?name=<artist>` | `GET` | Public | Uses 2 parallel goroutines to fetch top tracks and studio albums simultaneously. |
| `/lyrics?track=<t>&artist=<a>` | `GET` | Public | Fetches time-synced LRC and plain lyrics from LRCLIB. |
| `/auth/register` | `POST` | Public | Registers a new user (`name`, `email`, `password`), stores SHA-256 hash, and returns a Bearer token. |
| `/auth/login` | `POST` | Public | Authenticates an existing user and returns a session Bearer token. |
| `/auth/me` & `/auth/logout` | `GET`/`POST` | Bearer | Validates or terminates the active user session. |
| `/fulltrack?track=<t>&artist=<a>` | `GET` | Bearer | Protected endpoint returning full-length multi-minute audio stream + official YouTube track ID. |

### JSON Response Mapping
The iTunes API returns mixed-type, optional fields. Go's strict struct tagging ensures predictable memory layout and safe fallback handling:

```go
type Track struct {
	TrackID          int64   `json:"trackId"`
	ArtistID         int64   `json:"artistId"`
	CollectionID     int64   `json:"collectionId"`
	TrackName        string  `json:"trackName"`
	ArtistName       string  `json:"artistName"`
	PreviewURL       string  `json:"previewUrl"`
	ArtworkURL100    string  `json:"artworkUrl100"`
	ArtworkURL600    string  `json:"artworkUrl600"`
	TrackViewURL     string  `json:"trackViewUrl"`
	CollectionName   string  `json:"collectionName"`
	PrimaryGenreName string  `json:"primaryGenreName,omitempty"`
	TrackTimeMillis  int64   `json:"trackTimeMillis,omitempty"`
	ReleaseDate      string  `json:"releaseDate,omitempty"`
	TrackPrice       float64 `json:"trackPrice,omitempty"`
	Currency         string  `json:"currency,omitempty"`
}
```

## Quick Start

### Prerequisites
- Go 1.20 or higher installed.

### Installation & Run

1. **Clone the repository:**

```bash
git clone https://github.com/Null-source404/GO--.git
cd GO--/Song/server
```

2. **Run the web application directly:**

```bash
go run main.go
```

3. **Open the application in your browser:**
   - Visit **http://localhost:8080**
   - **Guest Mode:** Search any artist or track and click **▶ Play 30s Preview** to listen to previews, view synced lyrics, explore artist discographies, or play the **Blind Quiz**.
   - **Full-Song Member Mode:** Click **Sign In / Register** in the top navigation bar to create an account. Once signed in, track buttons upgrade to **▶ Play Full Song**, unlocking full-length audio streams and the Official Full Song Embed switcher in the Listening Deck.

4. **(Optional) Query tracks directly from the command line:**

```bash
go run main.go -q "Daft Punk"
```

5. **Build a standalone executable binary:**

```bash
go build -o itunes-search main.go
./itunes-search
```

## License
MIT
