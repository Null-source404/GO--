package main

import (
	"context"
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
	"strconv"
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
	RecReason        string  `json:"recReason,omitempty"`
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

type RecommendationsResponse struct {
	WeekLabel     string   `json:"weekLabel"`
	ActivityBasis []string `json:"activityBasis"`
	ForYou        []Track  `json:"forYou"`
	WeeklyHits    []Track  `json:"weeklyHits"`
}

type iTunesRSSFeed struct {
	Feed struct {
		Entry []struct {
			ID struct {
				Attributes struct {
					ImID string `json:"im:id"`
				} `json:"attributes"`
			} `json:"id"`
			Name struct {
				Label string `json:"label"`
			} `json:"im:name"`
			Artist struct {
				Label string `json:"label"`
			} `json:"im:artist"`
			Collection struct {
				Name struct {
					Label string `json:"label"`
				} `json:"im:name"`
			} `json:"im:collection"`
			Image []struct {
				Label string `json:"label"`
			} `json:"im:image"`
			Link []struct {
				Attributes struct {
					Rel  string `json:"rel"`
					Type string `json:"type"`
					Href string `json:"href"`
				} `json:"attributes"`
			} `json:"link"`
			Category struct {
				Attributes struct {
					Label string `json:"label"`
				} `json:"attributes"`
			} `json:"category"`
			ReleaseDate struct {
				Label string `json:"label"`
			} `json:"im:releaseDate"`
		} `json:"entry"`
	} `json:"feed"`
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
	UID               string `json:"uid,omitempty"`
	Name              string `json:"name"`
	Email             string `json:"email"`
	PasswordHash      string `json:"passwordHash"`
	EmailVerified     bool   `json:"emailVerified"`
	VerificationToken string `json:"verificationToken,omitempty"`
	CreatedAt         string `json:"createdAt"`
}

type PublicUser struct {
	UID           string `json:"uid,omitempty"`
	Name          string `json:"name"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"emailVerified"`
}

type AuthRequest struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

type FirebaseSyncRequest struct {
	UID           string `json:"uid"`
	Name          string `json:"name"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"emailVerified"`
}

type AuthResponse struct {
	Token            string     `json:"token"`
	User             PublicUser `json:"user"`
	VerificationLink string     `json:"verificationLink,omitempty"`
}

type FullTrackResponse struct {
	TrackName     string `json:"trackName"`
	ArtistName    string `json:"artistName"`
	FullAudioURL  string `json:"fullAudioUrl"`
	YoutubeID     string `json:"youtubeId"`
	Source        string `json:"source"`
	Authenticated bool   `json:"authenticated"`
}

type audiusSearchResponse struct {
	Data []struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	} `json:"data"`
}

var (
	httpClient = &http.Client{
		Timeout: 12 * time.Second,
	}
	streamClient = &http.Client{
		Timeout: 0, // Streaming audio response body
	}
	authMu        sync.RWMutex
	usersByEmail  = make(map[string]UserRecord)
	sessions      = make(map[string]string) // token -> email
	streamCacheMu sync.RWMutex
	streamCache   = make(map[string]string)
	ytCacheMu     sync.RWMutex
	ytCache       = make(map[string]string)
	ytVideoRegex  = regexp.MustCompile(`"videoId":"([a-zA-Z0-9_-]{11})"`)
)

func setCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Range")
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

	verifyTok := generateToken()
	record := UserRecord{
		Name:              name,
		Email:             email,
		PasswordHash:      hashPassword(email, password),
		EmailVerified:     false,
		VerificationToken: verifyTok,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	}
	usersByEmail[email] = record
	saveUsersToDiskLocked()

	token := generateToken()
	sessions[token] = email
	authMu.Unlock()

	verifyLink := fmt.Sprintf("/?verifyToken=%s&email=%s", url.QueryEscape(verifyTok), url.QueryEscape(email))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(AuthResponse{
		Token: token,
		User: PublicUser{
			Name:          record.Name,
			Email:         record.Email,
			EmailVerified: record.EmailVerified,
		},
		VerificationLink: verifyLink,
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

	if record.VerificationToken == "" {
		record.VerificationToken = generateToken()
		usersByEmail[email] = record
		saveUsersToDiskLocked()
	}

	token := generateToken()
	sessions[token] = email
	authMu.Unlock()

	verifyLink := ""
	if !record.EmailVerified && record.VerificationToken != "" {
		verifyLink = fmt.Sprintf("/?verifyToken=%s&email=%s", url.QueryEscape(record.VerificationToken), url.QueryEscape(email))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(AuthResponse{
		Token: token,
		User: PublicUser{
			UID:           record.UID,
			Name:          record.Name,
			Email:         record.Email,
			EmailVerified: record.EmailVerified,
		},
		VerificationLink: verifyLink,
	})
}

// Syncs a Firebase-authenticated user (Email/Password or Google Auth) with the Go server session
func firebaseSyncHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req FirebaseSyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	email := strings.ToLower(strings.TrimSpace(req.Email))
	name := strings.TrimSpace(req.Name)
	if email == "" {
		http.Error(w, "email is required", http.StatusBadRequest)
		return
	}
	if name == "" {
		parts := strings.Split(email, "@")
		name = parts[0]
	}

	authMu.Lock()
	record, exists := usersByEmail[email]
	if !exists {
		record = UserRecord{
			UID:               strings.TrimSpace(req.UID),
			Name:              name,
			Email:             email,
			EmailVerified:     req.EmailVerified,
			VerificationToken: generateToken(),
			CreatedAt:         time.Now().UTC().Format(time.RFC3339),
		}
	} else {
		if req.UID != "" {
			record.UID = strings.TrimSpace(req.UID)
		}
		if name != "" {
			record.Name = name
		}
		if req.EmailVerified {
			record.EmailVerified = true
		}
		if record.VerificationToken == "" {
			record.VerificationToken = generateToken()
		}
	}
	usersByEmail[email] = record
	saveUsersToDiskLocked()

	token := generateToken()
	sessions[token] = email
	authMu.Unlock()

	verifyLink := ""
	if !record.EmailVerified && record.VerificationToken != "" {
		verifyLink = fmt.Sprintf("/?verifyToken=%s&email=%s", url.QueryEscape(record.VerificationToken), url.QueryEscape(email))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(AuthResponse{
		Token: token,
		User: PublicUser{
			UID:           record.UID,
			Name:          record.Name,
			Email:         record.Email,
			EmailVerified: record.EmailVerified,
		},
		VerificationLink: verifyLink,
	})
}

// Verifies an email acknowledgment link (?verifyToken=...&email=...) to confirm account creation
func verifyEmailHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	verifyTok := strings.TrimSpace(r.URL.Query().Get("verifyToken"))
	email := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("email")))

	authMu.Lock()
	record, exists := usersByEmail[email]
	if !exists || (verifyTok != "" && record.VerificationToken != "" && record.VerificationToken != verifyTok) {
		authMu.Unlock()
		http.Error(w, "Invalid or expired verification link", http.StatusBadRequest)
		return
	}

	record.EmailVerified = true
	usersByEmail[email] = record
	saveUsersToDiskLocked()

	token := generateToken()
	sessions[token] = email
	authMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(AuthResponse{
		Token: token,
		User: PublicUser{
			UID:           record.UID,
			Name:          record.Name,
			Email:         record.Email,
			EmailVerified: true,
		},
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
	json.NewEncoder(w).Encode(PublicUser{
		UID:           user.UID,
		Name:          user.Name,
		Email:         user.Email,
		EmailVerified: user.EmailVerified,
	})
}

func isYouTubeEmbeddable(videoID string) bool {
	oembedURL := fmt.Sprintf("https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=%s&format=json", url.QueryEscape(videoID))
	resp, err := httpClient.Get(oembedURL)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func lookupYouTubeVideoID(trackName, artistName string) string {
	cacheKey := strings.ToLower(strings.TrimSpace(trackName) + "::" + strings.TrimSpace(artistName))
	ytCacheMu.RLock()
	if cached, ok := ytCache[cacheKey]; ok && cached != "" {
		ytCacheMu.RUnlock()
		return cached
	}
	ytCacheMu.RUnlock()

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

	allMatches := ytVideoRegex.FindAllStringSubmatch(string(body), 12)
	seen := make(map[string]bool)
	candidates := make([]string, 0, 5)
	for _, m := range allMatches {
		if len(m) > 1 && !seen[m[1]] {
			seen[m[1]] = true
			candidates = append(candidates, m[1])
			if len(candidates) >= 5 {
				break
			}
		}
	}

	if len(candidates) == 0 {
		return ""
	}

	// Verify embeddability of all candidates concurrently using goroutines
	valid := make([]bool, len(candidates))
	var wg sync.WaitGroup
	for i, id := range candidates {
		wg.Add(1)
		go func(idx int, vid string) {
			defer wg.Done()
			valid[idx] = isYouTubeEmbeddable(vid)
		}(i, id)
	}
	wg.Wait()

	chosen := candidates[0]
	for i, ok := range valid {
		if ok {
			chosen = candidates[i]
			break
		}
	}

	ytCacheMu.Lock()
	ytCache[cacheKey] = chosen
	ytCacheMu.Unlock()
	return chosen
}

// Concurrently resolves a direct full-length MP3 stream with a strict 1.2s timeout so playback starts fast
func resolveDirectFullSongURL(trackName, artistName string) string {
	cacheKey := strings.ToLower(strings.TrimSpace(trackName) + "::" + strings.TrimSpace(artistName))
	streamCacheMu.RLock()
	if cached, ok := streamCache[cacheKey]; ok && cached != "" {
		streamCacheMu.RUnlock()
		return cached
	}
	streamCacheMu.RUnlock()

	ctx, cancel := context.WithTimeout(context.Background(), 1200*time.Millisecond)
	defer cancel()

	query := strings.TrimSpace(trackName + " " + artistName)
	audiusURL := fmt.Sprintf("https://api.audius.co/v1/tracks/search?query=%s&app_name=soniccrate", url.QueryEscape(query))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, audiusURL, nil)
	if err == nil {
		if resp, err := httpClient.Do(req); err == nil {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			var audiusData audiusSearchResponse
			if err := json.Unmarshal(body, &audiusData); err == nil && len(audiusData.Data) > 0 {
				firstID := audiusData.Data[0].ID
				if firstID != "" {
					streamEndpoint := fmt.Sprintf("https://api.audius.co/v1/tracks/%s/stream?app_name=soniccrate", url.PathEscape(firstID))
					streamCacheMu.Lock()
					streamCache[cacheKey] = streamEndpoint
					streamCacheMu.Unlock()
					return streamEndpoint
				}
			}
		}
	}

	return ""
}

// Same-origin audio stream proxy (/stream): eliminates CORS & mixed-content blocks and streams the full song
func streamHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	track := strings.TrimSpace(r.URL.Query().Get("track"))
	artist := strings.TrimSpace(r.URL.Query().Get("artist"))
	previewURL := strings.TrimSpace(r.URL.Query().Get("preview"))

	_, isMember := authenticateRequest(r)
	targetURL := ""

	if isMember && track != "" {
		targetURL = resolveDirectFullSongURL(track, artist)
	}
	if targetURL == "" {
		targetURL = previewURL
	}
	if targetURL == "" {
		http.Error(w, "no audio stream available", http.StatusNotFound)
		return
	}

	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		http.Error(w, "invalid upstream audio URL", http.StatusInternalServerError)
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}

	resp, err := streamClient.Do(req)
	if err != nil || (resp.StatusCode >= 400 && previewURL != "" && targetURL != previewURL) {
		if resp != nil {
			resp.Body.Close()
		}
		if previewURL != "" && targetURL != previewURL {
			fallbackReq, _ := http.NewRequest(http.MethodGet, previewURL, nil)
			if rng := r.Header.Get("Range"); rng != "" {
				fallbackReq.Header.Set("Range", rng)
			}
			resp, err = streamClient.Do(fallbackReq)
		}
		if err != nil || resp == nil {
			http.Error(w, "failed to connect to audio stream", http.StatusBadGateway)
			return
		}
	}
	defer resp.Body.Close()

	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	} else {
		w.Header().Set("Content-Type", "audio/mpeg")
	}
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		w.Header().Set("Content-Length", cl)
	}
	if cr := resp.Header.Get("Content-Range"); cr != "" {
		w.Header().Set("Content-Range", cr)
	}
	w.Header().Set("Accept-Ranges", "bytes")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// Protected metadata endpoint: returns full-length stream URL + verified embeddable YouTube ID
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
	preview := strings.TrimSpace(r.URL.Query().Get("preview"))
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))

	if track == "" {
		http.Error(w, "missing 'track' query param", http.StatusBadRequest)
		return
	}

	youtubeID := lookupYouTubeVideoID(track, artist)
	fullAudioURL := fmt.Sprintf(
		"/stream?track=%s&artist=%s&preview=%s&token=%s",
		url.QueryEscape(track),
		url.QueryEscape(artist),
		url.QueryEscape(preview),
		url.QueryEscape(token),
	)

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

// Fetch Weekly Global Hits from Apple's iTunes Top Songs RSS feed (with search fallback)
func fetchWeeklyHits(limit int) []Track {
	if limit <= 0 {
		limit = 12
	}
	rssURL := fmt.Sprintf("https://itunes.apple.com/us/rss/topsongs/limit=%d/json", limit)
	resp, err := httpClient.Get(rssURL)
	if err == nil {
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err == nil {
			var rss iTunesRSSFeed
			if err := json.Unmarshal(body, &rss); err == nil && len(rss.Feed.Entry) > 0 {
				hits := make([]Track, 0, len(rss.Feed.Entry))
				for idx, entry := range rss.Feed.Entry {
					trackID, _ := strconv.ParseInt(entry.ID.Attributes.ImID, 10, 64)
					art100 := ""
					if len(entry.Image) > 0 {
						art100 = entry.Image[len(entry.Image)-1].Label
					}
					art600 := art100
					if art100 != "" {
						art600 = strings.Replace(art100, "170x170bb", "600x600bb", 1)
					}
					previewURL := ""
					viewURL := ""
					for _, l := range entry.Link {
						if strings.Contains(l.Attributes.Type, "audio") || l.Attributes.Rel == "enclosure" {
							previewURL = l.Attributes.Href
						} else if l.Attributes.Rel == "alternate" && viewURL == "" {
							viewURL = l.Attributes.Href
						}
					}
					if previewURL != "" && entry.Name.Label != "" {
						hits = append(hits, Track{
							TrackID:          trackID,
							TrackName:        strings.TrimSpace(entry.Name.Label),
							ArtistName:       strings.TrimSpace(entry.Artist.Label),
							CollectionName:   strings.TrimSpace(entry.Collection.Name.Label),
							PreviewURL:       previewURL,
							ArtworkURL100:    art100,
							ArtworkURL600:    art600,
							TrackViewURL:     viewURL,
							PrimaryGenreName: entry.Category.Attributes.Label,
							ReleaseDate:      entry.ReleaseDate.Label,
							TrackTimeMillis:  210000,
							RecReason:        fmt.Sprintf("Weekly Global Chart #%d", idx+1),
						})
					}
				}
				if len(hits) > 0 {
					return hits
				}
			}
		}
	}

	// Fallback to iTunes Search if RSS feed is unreachable
	fallback, err := fetchTracks("top hits 2025", limit)
	if err == nil {
		for i := range fallback {
			fallback[i].RecReason = fmt.Sprintf("Weekly Hit #%d", i+1)
		}
		return fallback
	}
	return []Track{}
}

// Weekly Recommendations Endpoint (/recommendations):
// Concurrently combines personalized picks from user activity (artists, genres, searches) with Weekly Global Hits
func recommendationsHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	rawArtists := strings.TrimSpace(r.URL.Query().Get("artists"))
	rawGenres := strings.TrimSpace(r.URL.Query().Get("genres"))
	rawExclude := strings.TrimSpace(r.URL.Query().Get("exclude"))

	excludeIDs := make(map[string]bool)
	if rawExclude != "" {
		for _, id := range strings.Split(rawExclude, ",") {
			trimmed := strings.TrimSpace(id)
			if trimmed != "" {
				excludeIDs[trimmed] = true
			}
		}
	}

	type seedQuery struct {
		term   string
		reason string
	}

	var seeds []seedQuery
	var basis []string

	if rawArtists != "" {
		for _, a := range strings.Split(rawArtists, ",") {
			artist := strings.TrimSpace(a)
			if artist != "" && len(seeds) < 3 {
				seeds = append(seeds, seedQuery{
					term:   artist,
					reason: fmt.Sprintf("Based on your activity with %s", artist),
				})
				basis = append(basis, artist)
			}
		}
	}

	if rawGenres != "" {
		for _, g := range strings.Split(rawGenres, ",") {
			genre := strings.TrimSpace(g)
			if genre != "" && len(seeds) < 4 {
				seeds = append(seeds, seedQuery{
					term:   genre + " hits",
					reason: fmt.Sprintf("Matched to your %s listening sessions", genre),
				})
				basis = append(basis, genre)
			}
		}
	}

	if len(seeds) == 0 {
		seeds = []seedQuery{
			{term: "Daft Punk", reason: "Studio Discovery · Electronic Essentials"},
			{term: "The Weeknd", reason: "Studio Discovery · Synthwave & Pop"},
			{term: "Tame Impala", reason: "Studio Discovery · Modern Psychedelia"},
		}
		basis = []string{"Electronic Essentials", "Synthwave & Pop", "Modern Psychedelia"}
	}

	var (
		wg         sync.WaitGroup
		mu         sync.Mutex
		forYouPool = make([][]Track, len(seeds))
		weeklyHits []Track
	)

	wg.Add(1)
	go func() {
		defer wg.Done()
		weeklyHits = fetchWeeklyHits(12)
	}()

	for i, s := range seeds {
		wg.Add(1)
		go func(idx int, sq seedQuery) {
			defer wg.Done()
			tracks, err := fetchTracks(sq.term, 8)
			if err != nil {
				return
			}
			for j := range tracks {
				tracks[j].RecReason = sq.reason
			}
			mu.Lock()
			forYouPool[idx] = tracks
			mu.Unlock()
		}(i, s)
	}

	wg.Wait()

	seen := make(map[int64]bool)
	forYou := make([]Track, 0, 12)
	// Interleave tracks across activity seeds so recommendations are diverse
	for round := 0; round < 8 && len(forYou) < 12; round++ {
		for sIdx := range forYouPool {
			if round < len(forYouPool[sIdx]) {
				t := forYouPool[sIdx][round]
				idStr := strconv.FormatInt(t.TrackID, 10)
				if t.TrackID != 0 && !seen[t.TrackID] && !excludeIDs[idStr] && t.PreviewURL != "" {
					seen[t.TrackID] = true
					forYou = append(forYou, t)
					if len(forYou) >= 12 {
						break
					}
				}
			}
		}
	}

	_, isoWeek := time.Now().ISOWeek()
	weekLabel := fmt.Sprintf("Week %d · %s", isoWeek, time.Now().Format("Jan 2, 2006"))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(RecommendationsResponse{
		WeekLabel:     weekLabel,
		ActivityBasis: basis,
		ForYou:        forYou,
		WeeklyHits:    weeklyHits,
	})
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
	mux.HandleFunc("/recommendations", recommendationsHandler)
	mux.HandleFunc("/artist", artistHandler)
	mux.HandleFunc("/lyrics", lyricsHandler)
	mux.HandleFunc("/auth/register", registerHandler)
	mux.HandleFunc("/auth/login", loginHandler)
	mux.HandleFunc("/auth/firebase-sync", firebaseSyncHandler)
	mux.HandleFunc("/auth/verify", verifyEmailHandler)
	mux.HandleFunc("/auth/logout", logoutHandler)
	mux.HandleFunc("/auth/me", meHandler)
	mux.HandleFunc("/fulltrack", fullTrackHandler)
	mux.HandleFunc("/stream", streamHandler)
	mux.Handle("/", http.FileServer(http.Dir(clientDir)))

	log.Printf("Serving client from: %s", clientDir)
	log.Printf("Server running at http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
