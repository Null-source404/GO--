# iTunes Search CLI / App

A lightweight, fast media search tool built in Go that interfaces with Apple's public iTunes Search API. Built to explore Go's concurrency, strict typing, and zero-dependency compilation.

![App Screenshot](Song/screenshot-2026-08-04.png)

## Features

- **Instant Search:** Query track, album, and artist metadata directly from the command line / app interface.
- **Fast Parsing:** Statically typed JSON unmarshaling mapped to Apple's API schema.
- **Concurrent Requests:** Handles metadata and artwork payload fetches using goroutines.
- **Zero External Dependencies:** Built leveraging Go's standard library (`net/http`, `encoding/json`).
- **Single Binary:** Cross-compiles into a standalone executable.

## Tech Stack

- **Language:** Go (1.20+)
- **API:** Apple iTunes Search API
- **UI / Library:** Standard Library (`net/http`) + HTML/CSS/Vanilla JS Client

## Architecture & Code Highlights

```text
GO--/
├── Song/
│   ├── client/
│   │   ├── index.html    # Web UI layout and search controls
│   │   ├── index.css     # Responsive dark-theme styling
│   │   └── script.js     # Fetch logic, live filtering, and audio preview player
│   ├── server/
│   │   └── main.go       # Struct definitions matching iTunes JSON schema,
│   │                     # HTTP client, endpoint queries, and payload parsing
│   └── go.mod            # Go module definition (zero external dependencies)
└── README.md
```

### JSON Response Mapping
The iTunes API returns mixed-type, optional fields. Go's strict struct tagging ensures predictable memory layout and safe fallback handling:

```go
type Track struct {
	TrackName        string `json:"trackName"`
	ArtistName       string `json:"artistName"`
	PreviewURL       string `json:"previewUrl"`
	ArtworkURL100    string `json:"artworkUrl100"`
	TrackViewURL     string `json:"trackViewUrl"`
	CollectionName   string `json:"collectionName"`
	PrimaryGenreName string `json:"primaryGenreName,omitempty"`
	TrackTimeMillis  int64  `json:"trackTimeMillis,omitempty"`
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

Then open **http://localhost:8080** in your browser to search songs, filter results, and play audio previews.

*(Optional) You can also query tracks directly from the command line using the `-q` flag:*

```bash
go run main.go -q "Daft Punk"
```

3. **Build executable binary:**

```bash
go build -o itunes-search main.go
./itunes-search
```

## License
MIT
