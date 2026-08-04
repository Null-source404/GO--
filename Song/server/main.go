package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path/filepath"
	"runtime"
)

type Track struct {
	TrackName     string `json:"trackName"`
	ArtistName    string `json:"artistName"`
	PreviewURL    string `json:"previewUrl"`
	ArtworkURL100 string `json:"artworkUrl100"`
	TrackViewURL  string `json:"trackViewUrl"`
	CollectionName string `json:"collectionName"`
}

type iTunesResponse struct {
	Results []Track `json:"results"`
}

func searchHandler(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	if query == "" {
		http.Error(w, "missing query param 'q'", http.StatusBadRequest)
		return
	}

	searchURL := fmt.Sprintf("https://itunes.apple.com/search?term=%s&media=music&entity=song&limit=12", url.QueryEscape(query))

	resp, err := http.Get(searchURL)
	if err != nil {
		http.Error(w, "failed to reach iTunes API", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, "failed to read response", http.StatusInternalServerError)
		return
	}

	var data iTunesResponse
	if err := json.Unmarshal(body, &data); err != nil {
		http.Error(w, "failed to parse response", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(data.Results)
}

func main() {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		log.Fatal("unable to get current file path")
	}

	clientDir := filepath.Join(filepath.Dir(currentFile), "..", "client")

	mux := http.NewServeMux()

	mux.HandleFunc("/search", searchHandler)
	mux.Handle("/", http.FileServer(http.Dir(clientDir)))

	log.Println("Server running at http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}