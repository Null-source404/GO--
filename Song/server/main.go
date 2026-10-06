package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

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

type Album struct {
	CollectionID   int64  `json:"collectionId"`
	CollectionName string `json:"collectionName"`
	ArtistName     string `json:"artistName"`
	ArtworkURL100  string `json:"artworkUrl100"`
	ReleaseDate    string `json:"releaseDate"`
	TrackCount     int    `json:"trackCount"`
	PrimaryGenre   string `json:"primaryGenreName"`
	CollectionURL  string `json:"collectionViewUrl"`
}

type iTunesResponse struct {
	ResultCount int     `json:"resultCount"`
	Results     []Track `json:"results"`
}

type iTunesAlbumResponse struct {
	ResultCount int     `json:"resultCount"`
	Results     []Album `json:"results"`
}

type ArtistProfileResponse struct {
	ArtistName string  `json:"artistName"`
	TopTracks  []Track `json:"topTracks"`
	Albums     []Album `json:"albums"`
}

type LrcLibItem struct {
	TrackName    string `json:"trackName"`
	ArtistName   string `json:"artistName"`
	AlbumName    string `json:"albumName"`
	PlainLyrics  string `json:"plainLyrics"`
	SyncedLyrics string `json:"syncedLyrics"`
}

type LyricsResponse struct {
	TrackName    string `json:"trackName"`
	ArtistName   string `json:"artistName"`
	PlainLyrics  string `json:"plainLyrics"`
	SyncedLyrics string `json:"syncedLyrics"`
	Found        bool   `json:"found"`
}

var httpClient = &http.Client{
	Timeout: 10 * time.Second,
}

func setCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func fetchTracks(query string, limit int) ([]Track, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	searchURL := fmt.Sprintf(
		"https://itunes.apple.com/search?term=%s&media=music&entity=song&limit=%d",
		url.QueryEscape(query),
		limit,
	)

	resp, err := httpClient.Get(searchURL)
	if err != nil {
		return nil, fmt.Errorf("failed to reach iTunes API: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("iTunes API returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var data iTunesResponse
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	// Normalize metadata and upgrade artwork resolution concurrently using goroutines
	var wg sync.WaitGroup
	results := make([]Track, len(data.Results))
	for i, track := range data.Results {
		wg.Add(1)
		go func(idx int, t Track) {
			defer wg.Done()
			t.TrackName = strings.TrimSpace(t.TrackName)
			t.ArtistName = strings.TrimSpace(t.ArtistName)
			t.CollectionName = strings.TrimSpace(t.CollectionName)
			if t.ArtworkURL100 != "" {
				t.ArtworkURL600 = strings.Replace(t.ArtworkURL100, "100x100bb", "600x600bb", 1)
			}
			results[idx] = t
		}(i, track)
	}
	wg.Wait()

	return results, nil
}

func searchHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		http.Error(w, "missing query param 'q'", http.StatusBadRequest)
		return
	}

	tracks, err := fetchTracks(query, 20)
	if err != nil {
		log.Printf("search error for %q: %v", query, err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tracks)
}

func artistHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	artistName := strings.TrimSpace(r.URL.Query().Get("name"))
	if artistName == "" {
		http.Error(w, "missing query param 'name'", http.StatusBadRequest)
		return
	}

	var (
		topTracks []Track
		albums    []Album
		wg        sync.WaitGroup
	)

	wg.Add(2)

	// Goroutine 1: Fetch top songs for artist
	go func() {
		defer wg.Done()
		tracks, err := fetchTracks(artistName, 10)
		if err == nil {
			topTracks = tracks
		}
	}()

	// Goroutine 2: Fetch albums / discography for artist
	go func() {
		defer wg.Done()
		albumURL := fmt.Sprintf(
			"https://itunes.apple.com/search?term=%s&media=music&entity=album&limit=8",
			url.QueryEscape(artistName),
		)
		resp, err := httpClient.Get(albumURL)
		if err != nil {
			return
		}
		defer resp.Body.Close()

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return
		}

		var data iTunesAlbumResponse
		if err := json.Unmarshal(body, &data); err == nil {
			albums = data.Results
		}
	}()

	wg.Wait()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ArtistProfileResponse{
		ArtistName: artistName,
		TopTracks:  topTracks,
		Albums:     albums,
	})
}

func lyricsHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	track := strings.TrimSpace(r.URL.Query().Get("track"))
	artist := strings.TrimSpace(r.URL.Query().Get("artist"))
	if track == "" || artist == "" {
		http.Error(w, "missing 'track' or 'artist' query param", http.StatusBadRequest)
		return
	}

	searchURL := fmt.Sprintf(
		"https://lrclib.net/api/search?track_name=%s&artist_name=%s",
		url.QueryEscape(track),
		url.QueryEscape(artist),
	)

	req, err := http.NewRequest(http.MethodGet, searchURL, nil)
	if err != nil {
		http.Error(w, "failed to create request", http.StatusInternalServerError)
		return
	}
	req.Header.Set("User-Agent", "Go-iTunes-Music-Explorer/1.0")

	resp, err := httpClient.Do(req)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(LyricsResponse{TrackName: track, ArtistName: artist, Found: false})
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(LyricsResponse{TrackName: track, ArtistName: artist, Found: false})
		return
	}

	var items []LrcLibItem
	if err := json.Unmarshal(body, &items); err == nil && len(items) > 0 {
		for _, item := range items {
			if item.PlainLyrics != "" || item.SyncedLyrics != "" {
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(LyricsResponse{
					TrackName:    item.TrackName,
					ArtistName:   item.ArtistName,
					PlainLyrics:  item.PlainLyrics,
					SyncedLyrics: item.SyncedLyrics,
					Found:        true,
				})
				return
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(LyricsResponse{
		TrackName:  track,
		ArtistName: artist,
		Found:      false,
	})
}

func resolveClientDir() string {
	candidates := []string{
		filepath.Join("..", "client"),
		"client",
		filepath.Join("Song", "client"),
	}

	if _, currentFile, _, ok := runtime.Caller(0); ok {
		candidates = append(candidates, filepath.Join(filepath.Dir(currentFile), "..", "client"))
	}

	if exePath, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exePath)
		candidates = append(candidates,
			filepath.Join(exeDir, "client"),
			filepath.Join(exeDir, "..", "client"),
		)
	}

	for _, dir := range candidates {
		info, err := os.Stat(filepath.Join(dir, "index.html"))
		if err == nil && !info.IsDir() {
			absDir, err := filepath.Abs(dir)
			if err == nil {
				return absDir
			}
			return dir
		}
	}

	return filepath.Join("..", "client")
}

func main() {
	cliQuery := flag.String("q", "", "Search query to run directly in CLI mode (optional)")
	portFlag := flag.String("port", "", "Port to run the HTTP server on (default 8080)")
	flag.Parse()

	if strings.TrimSpace(*cliQuery) != "" {
		tracks, err := fetchTracks(*cliQuery, 12)
		if err != nil {
			log.Fatalf("Search failed: %v", err)
		}
		if len(tracks) == 0 {
			fmt.Println("No songs found for that search.")
			return
		}
		for i, t := range tracks {
			fmt.Printf("%2d. %s — %s (%s)\n", i+1, t.TrackName, t.ArtistName, t.CollectionName)
			if t.PreviewURL != "" {
				fmt.Printf("    Preview: %s\n", t.PreviewURL)
			}
		}
		return
	}

	port := *portFlag
	if port == "" {
		port = os.Getenv("PORT")
	}
	if port == "" {
		port = "8080"
	}

	clientDir := resolveClientDir()

	mux := http.NewServeMux()
	mux.HandleFunc("/search", searchHandler)
	mux.HandleFunc("/artist", artistHandler)
	mux.HandleFunc("/lyrics", lyricsHandler)
	mux.Handle("/", http.FileServer(http.Dir(clientDir)))

	log.Printf("Serving client from: %s", clientDir)
	log.Printf("Server running at http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
