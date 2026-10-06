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
	TrackName        string `json:"trackName"`
	ArtistName       string `json:"artistName"`
	PreviewURL       string `json:"previewUrl"`
	ArtworkURL100    string `json:"artworkUrl100"`
	TrackViewURL     string `json:"trackViewUrl"`
	CollectionName   string `json:"collectionName"`
	PrimaryGenreName string `json:"primaryGenreName,omitempty"`
	TrackTimeMillis  int64  `json:"trackTimeMillis,omitempty"`
}

type iTunesResponse struct {
	ResultCount int     `json:"resultCount"`
	Results     []Track `json:"results"`
}

var httpClient = &http.Client{
	Timeout: 10 * time.Second,
}

func fetchTracks(query string, limit int) ([]Track, error) {
	if limit <= 0 || limit > 50 {
		limit = 12
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

	// Normalize artwork URLs concurrently using goroutines
	var wg sync.WaitGroup
	results := make([]Track, len(data.Results))
	for i, track := range data.Results {
		wg.Add(1)
		go func(idx int, t Track) {
			defer wg.Done()
			t.TrackName = strings.TrimSpace(t.TrackName)
			t.ArtistName = strings.TrimSpace(t.ArtistName)
			t.CollectionName = strings.TrimSpace(t.CollectionName)
			results[idx] = t
		}(i, track)
	}
	wg.Wait()

	return results, nil
}

func searchHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		http.Error(w, "missing query param 'q'", http.StatusBadRequest)
		return
	}

	tracks, err := fetchTracks(query, 12)
	if err != nil {
		log.Printf("search error for %q: %v", query, err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(tracks); err != nil {
		log.Printf("failed to encode response: %v", err)
	}
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
	mux.Handle("/", http.FileServer(http.Dir(clientDir)))

	log.Printf("Serving client from: %s", clientDir)
	log.Printf("Server running at http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
