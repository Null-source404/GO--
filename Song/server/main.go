package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
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

// Authentication & Full-Track Models
type UserRecord struct {
	Name         string `json:"name"`
	Email        string `json:"email"`
	PasswordHash string `json:"passwordHash"`
	CreatedAt    string `json:"createdAt"`
}

type PublicUser struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

type AuthRequest struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

type AuthResponse struct {
	Token string     `json:"token"`
	User  PublicUser `json:"user"`
}

type FullTrackResponse struct {
	TrackName     string `json:"trackName"`
	ArtistName    string `json:"artistName"`
	FullAudioURL  string `json:"fullAudioUrl"`
	YoutubeID     string `json:"youtubeId"`
	Source        string `json:"source"`
	Authenticated bool   `json:"authenticated"`
}

var (
	httpClient = &http.Client{
		Timeout: 10 * time.Second,
	}
	authMu       sync.RWMutex
	usersByEmail = make(map[string]UserRecord)
	sessions     = make(map[string]string) // token -> email
	ytVideoRegex = regexp.MustCompile(`"videoId":"([a-zA-Z0-9_-]{11})"`)

	// Full-length (3 to 6+ minute) studio MP3 streams for uninterrupted native Web Audio deck playback
	fullLengthStudioStreams = []string{
		"https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
		"https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
		"https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",
		"https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3",
		"https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3",
		"https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3",
		"https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3",
		"https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3",
	}
)

func setCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

func usersFilePath() string {
	if _, currentFile, _, ok := runtime.Caller(0); ok {
		return filepath.Join(filepath.Dir(currentFile), "users.json")
	}
	return "users.json"
}

func loadUsersFromDisk() {
	authMu.Lock()
	defer authMu.Unlock()

	data, err := os.ReadFile(usersFilePath())
	if err != nil {
		return
	}
	var list []UserRecord
	if err := json.Unmarshal(data, &list); err == nil {
		for _, u := range list {
			usersByEmail[strings.ToLower(u.Email)] = u
		}
	}
}

func saveUsersToDiskLocked() {
	list := make([]UserRecord, 0, len(usersByEmail))
	for _, u := range usersByEmail {
		list = append(list, u)
	}
	data, err := json.MarshalIndent(list, "", "  ")
	if err == nil {
		_ = os.WriteFile(usersFilePath(), data, 0600)
	}
}

func hashPassword(email, password string) string {
	h := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email)) + ":soniccrate:" + password))
	return hex.EncodeToString(h[:])
}

func generateToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func authenticateRequest(r *http.Request) (UserRecord, bool) {
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	token := strings.TrimPrefix(authHeader, "Bearer ")
	token = strings.TrimSpace(token)
	if token == "" {
		token = strings.TrimSpace(r.URL.Query().Get("token"))
	}
	if token == "" {
		return UserRecord{}, false
	}

	authMu.RLock()
	defer authMu.RUnlock()
	email, ok := sessions[token]
	if !ok {
		return UserRecord{}, false
	}
	user, exists := usersByEmail[email]
	return user, exists
}

func registerHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req AuthRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	name := strings.TrimSpace(req.Name)
	email := strings.ToLower(strings.TrimSpace(req.Email))
	password := req.Password

	if name == "" || email == "" || len(password) < 4 {
		http.Error(w, "Name, valid email, and password (min 4 chars) are required", http.StatusBadRequest)
		return
	}

	authMu.Lock()
	if _, exists := usersByEmail[email]; exists {
		authMu.Unlock()
		http.Error(w, "An account with that email already exists. Please sign in.", http.StatusConflict)
		return
	}

	record := UserRecord{
		Name:         name,
		Email:        email,
		PasswordHash: hashPassword(email, password),
		CreatedAt:    time.Now().UTC().Format(time.RFC3339),
	}
	usersByEmail[email] = record
	saveUsersToDiskLocked()

	token := generateToken()
	sessions[token] = email
	authMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(AuthResponse{
		Token: token,
		User:  PublicUser{Name: record.Name, Email: record.Email},
	})
}

func loginHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req AuthRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	email := strings.ToLower(strings.TrimSpace(req.Email))
	expectedHash := hashPassword(email, req.Password)

	authMu.Lock()
	record, exists := usersByEmail[email]
	if !exists || record.PasswordHash != expectedHash {
		authMu.Unlock()
		http.Error(w, "Invalid email or password", http.StatusUnauthorized)
		return
	}

	token := generateToken()
	sessions[token] = email
	authMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(AuthResponse{
		Token: token,
		User:  PublicUser{Name: record.Name, Email: record.Email},
	})
}

func logoutHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	if token != "" {
		authMu.Lock()
		delete(sessions, token)
		authMu.Unlock()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func meHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	user, ok := authenticateRequest(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(PublicUser{Name: user.Name, Email: user.Email})
}

func lookupYouTubeVideoID(trackName, artistName string) string {
	query := fmt.Sprintf("%s %s official audio", trackName, artistName)
	searchURL := fmt.Sprintf("https://www.youtube.com/results?search_query=%s", url.QueryEscape(query))

	req, err := http.NewRequest(http.MethodGet, searchURL, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")

	resp, err := httpClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		return ""
	}

	matches := ytVideoRegex.FindStringSubmatch(string(body))
	if len(matches) > 1 {
		return matches[1]
	}
	return ""
}

func selectFullLengthStream(trackName, artistName string) string {
	h := sha256.Sum256([]byte(strings.ToLower(trackName + "::" + artistName)))
	idx := int(h[0]) % len(fullLengthStudioStreams)
	return fullLengthStudioStreams[idx]
}

// Protected endpoint: returns full-length audio stream + official YouTube match only for registered/logged-in users
func fullTrackHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	_, ok := authenticateRequest(r)
	if !ok {
		http.Error(w, "Sign in required to unlock full-length songs", http.StatusUnauthorized)
		return
	}

	track := strings.TrimSpace(r.URL.Query().Get("track"))
	artist := strings.TrimSpace(r.URL.Query().Get("artist"))
	if track == "" {
		http.Error(w, "missing 'track' query param", http.StatusBadRequest)
		return
	}

	var (
		youtubeID    string
		fullAudioURL string
		wg           sync.WaitGroup
	)

	wg.Add(2)
	go func() {
		defer wg.Done()
		youtubeID = lookupYouTubeVideoID(track, artist)
	}()
	go func() {
		defer wg.Done()
		fullAudioURL = selectFullLengthStream(track, artist)
	}()
	wg.Wait()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(FullTrackResponse{
		TrackName:     track,
		ArtistName:    artist,
		FullAudioURL:  fullAudioURL,
		YoutubeID:     youtubeID,
		Source:        "Full-Length Member Stream",
		Authenticated: true,
	})
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

	go func() {
		defer wg.Done()
		tracks, err := fetchTracks(artistName, 10)
		if err == nil {
			topTracks = tracks
		}
	}()

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

	loadUsersFromDisk()

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
	mux.HandleFunc("/auth/register", registerHandler)
	mux.HandleFunc("/auth/login", loginHandler)
	mux.HandleFunc("/auth/logout", logoutHandler)
	mux.HandleFunc("/auth/me", meHandler)
	mux.HandleFunc("/fulltrack", fullTrackHandler)
	mux.Handle("/", http.FileServer(http.Dir(clientDir)))

	log.Printf("Serving client from: %s", clientDir)
	log.Printf("Server running at http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
