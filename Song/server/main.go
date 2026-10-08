package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/time/rate"
)

// --------------------------
// Models
// --------------------------

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

// --------------------------
// Global state
// --------------------------

var (
	authMu        sync.RWMutex
	usersByEmail  = make(map[string]UserRecord)
	sessions      = make(map[string]string) // retained for compatibility, but JWT is used for auth
	ytCache       = make(map[string]string)
	streamCache   = make(map[string]string)
	authLimiter   = rate.NewLimiter(rate.Every(15*time.Second), 25)
	streamLimiter = rate.NewLimiter(rate.Every(time.Second), 60)
)

const (
	jwtIssuer = "soniccrate"
)

var (
	allowedUpstreamHosts = map[string]struct{}{
		"itunes.apple.com": {},
		"is1-ssl.mzstatic.com": {},
		"is2-ssl.mzstatic.com": {},
		"is3-ssl.mzstatic.com": {},
		"is4-ssl.mzstatic.com": {},
		"audius.co": {},
		"api.audius.co": {},
		"www.youtube.com": {},
		"m.youtube.com": {},
		"i.ytimg.com": {},
	}
)

var ytVideoRegex = regexp.MustCompile(`"videoId":"([a-zA-Z0-9_-]{11})"`)

// --------------------------
// Security helpers
// --------------------------

func getJWTSecret() []byte {
	secret := strings.TrimSpace(os.Getenv("JWT_SECRET"))
	if secret == "" {
		secret = "change-me-in-production"
	}
	return []byte(secret)
}

func issueJWT(user UserRecord) (string, error) {
	claims := jwt.MapClaims{
		"sub":      user.Email,
		"name":     user.Name,
		"verified": user.EmailVerified,
		"iat":      time.Now().Unix(),
		"exp":      time.Now().Add(7 * 24 * time.Hour).Unix(),
		"iss":      jwtIssuer,
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(getJWTSecret())
}

func verifyJWT(tokenString string) jwt.MapClaims {
	token, err := jwt.Parse(tokenString, jwt.SigningMethodHS256, func(token *jwt.Token) (interface{}) {
		return getJWTSecret(), nil
	})
	if err != nil || !token.Valid {
		return nil
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return nil
	}
	if claims["iss"] != jwtIssuer {
		return nil
	}
	return claims
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

	claims := verifyJWT(token)
	if claims == nil {
		return UserRecord{}, false
	}

	email, ok := claims["sub"].(string)
	if !ok || strings.TrimSpace(email) == "" {
		return UserRecord{}, false
	}

	authMu.RLock()
	defer authMu.RUnlock()
	user, exists := usersByEmail[strings.ToLower(email)]
	return user, exists
}

func setCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Range")
}

func authRateLimit(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authLimiter.Allow() {
			http.Error(w, "too many auth attempts", http.StatusTooManyRequests)
			return
		}
		next(w, r)
	}
}

func streamRateLimit(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !streamLimiter.Allow() {
			http.Error(w, "too many stream requests", http.StatusTooManyRequests)
			return
		}
		next(w, r)
	}
}

func isAllowedUpstreamHost(host string) bool {
	host = strings.TrimSpace(strings.ToLower(host))
	_, ok := allowedUpstreamHosts[host]
	return ok
}

func isPrivateOrLocalIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}

func validateUpstreamURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, errors.New("invalid scheme")
	}
	if u.Host == "" {
		return nil, errors.New("missing host")
	}

	host := strings.TrimSpace(strings.ToLower(u.Hostname()))
	if !isAllowedUpstreamHost(host) {
		return nil, fmt.Errorf("disallowed host: %s", host)
	}

	// reject obvious internal/private targets
	addrs, err := net.LookupIP(host)
	if err == nil {
		for _, ip := range addrs {
			if isPrivateOrLocalIP(ip) {
				return nil, fmt.Errorf("blocked private host: %s", host)
			}
		}
	}

	if u.User != nil && (u.User.Username() != "" || u.User.Password() != "") {
		return nil, errors.New("credentials not allowed in upstream url")
	}

	return u, nil
}

func hashPassword(password string) string {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return ""
	}
	return string(hash)
}

func verifyPassword(password, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

func generateToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	return hex.EncodeToString(b)
}

// --------------------------
// File persistence
// --------------------------

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
		for _, user := range list {
			usersByEmail[strings.ToLower(user.Email)] = user
		}
	}
}

func saveUsersToDiskLocked() {
	list := make([]UserRecord, 0, len(usersByEmail))
	for _, user := range usersByEmail {
		list = append(list, user)
	}
	data, err := json.MarshalIndent(list, "", "  ")
	if err == nil {
		_ = os.WriteFile(usersFilePath(), data, 0600)
	}
}

// --------------------------
// Utility functions
// --------------------------

func normalizeTrack(item map[string]interface{}, recReason string) Track {
	artwork100 := ""
	if v, ok := item["artworkUrl100"].(string); ok {
		artwork100 = v
	}
	trackName := ""
	if v, ok := item["trackName"].(string); ok {
		trackName = v
	}
	artistName := ""
	if v, ok := item["artistName"].(string); ok {
		artistName = v
	}

	obj := Track{
		TrackID:          int64(item["trackId"].(float64)),
		ArtistID:         int64(item["artistId"].(float64)),
		CollectionID:     int64(item["collectionId"].(float64)),
		TrackName:        strings.TrimSpace(trackName),
		ArtistName:       strings.TrimSpace(artistName),
		PreviewURL:       item["previewUrl"].(string),
		ArtworkURL100:    artwork100,
		ArtworkURL600:    artwork100,
		TrackViewURL:     item["trackViewUrl"].(string),
		CollectionName:   strings.TrimSpace(item["collectionName"].(string)),
		PrimaryGenreName: item["primaryGenreName"].(string),
		TrackTimeMillis:  int64(item["trackTimeMillis"].(float64)),
		ReleaseDate:      item["releaseDate"].(string),
		TrackPrice:       item["trackPrice"].(float64),
		Currency:         item["currency"].(string),
	}
	if recReason != "" {
		obj.RecReason = recReason
	}
	if obj.ArtworkURL100 != "" {
		obj.ArtworkURL600 = strings.ReplaceAll(obj.ArtworkURL100, "100x100bb", "600x600bb")
	}
	return obj
}

func fetchTracks(query string, limit int) ([]Track, error) {
	if strings.TrimSpace(query) == "" {
		return nil, errors.New("missing query")
	}
	u := fmt.Sprintf("https://itunes.apple.com/search?term=%s&media=music&entity=song&limit=%d", url.QueryEscape(query), limit)
	resp, err := http.Get(u)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("itunes api status: %d", resp.StatusCode)
	}

	var payload iTunesResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return payload.Results, nil
}

func fetchWeeklyHits(limit int) []Track {
	const rssURL = "https://itunes.apple.com/us/rss/topsongs/limit=12/json"
	resp, err := http.Get(rssURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return []Track{}
	}

	var feed iTunesRSSFeed
	if err := json.NewDecoder(resp.Body).Decode(&feed); err != nil {
		return []Track{}
	}

	hits := make([]Track, 0, limit)
	for idx, entry := range feed.Feed.Entry {
		if len(entry.Link) == 0 {
			continue
		}
		trackName := strings.TrimSpace(entry.Name.Label)
		artistName := strings.TrimSpace(entry.Artist.Label)
		if trackName == "" || artistName == "" {
			continue
		}

		var previewURL string
		var trackViewURL string
		for _, link := range entry.Link {
			attrs := link.Attributes
			if (attrs.Type != "" && strings.Contains(attrs.Type, "audio")) || attrs.Rel == "enclosure" {
				previewURL = attrs.Href
			} else if attrs.Rel == "alternate" && trackViewURL == "" {
				trackViewURL = attrs.Href
			}
		}

		if previewURL == "" || trackName == "" {
			continue
		}

		hit := Track{
			TrackID:          int64(entry.ID.Attributes.ImID),
			ArtistID:         0,
			CollectionID:     0,
			TrackName:        trackName,
			ArtistName:       artistName,
			PreviewURL:       previewURL,
			ArtworkURL100:    "",
			ArtworkURL600:    "",
			TrackViewURL:     trackViewURL,
			CollectionName:   strings.TrimSpace(entry.Collection.Name.Label),
			PrimaryGenreName: entry.Category.Attributes.Label,
			ReleaseDate:      entry.ReleaseDate.Label,
			TrackTimeMillis:  210000,
			RecReason:        fmt.Sprintf("Weekly Global Chart #%d", idx+1),
		}
		if len(entry.Image) > 0 {
			hit.ArtworkURL100 = entry.Image[len(entry.Image)-1].Label
			if hit.ArtworkURL100 != "" {
				hit.ArtworkURL600 = strings.ReplaceAll(hit.ArtworkURL100, "170x170bb", "600x600bb")
			}
		}
		hits = append(hits, hit)
		if len(hits) >= limit {
			break
		}
	}
	return hits
}

func isYouTubeEmbeddable(videoID string) bool {
	if strings.TrimSpace(videoID) == "" {
		return false
	}

	urlStr := fmt.Sprintf("https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=%s&format=json", url.QueryEscape(videoID))
	resp, err := http.Get(urlStr)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func lookupYouTubeVideoID(trackName, artistName string) string {
	cacheKey := strings.ToLower(strings.TrimSpace(trackName) + "::" + strings.TrimSpace(artistName))
	if id, ok := ytCache[cacheKey]; ok {
		return id
	}

	query := fmt.Sprintf("%s %s official audio", strings.TrimSpace(trackName), strings.TrimSpace(artistName))
	searchURL := fmt.Sprintf("https://www.youtube.com/results?search_query=%s", url.QueryEscape(query))
	resp, err := http.Get(searchURL)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}

	html, err := io.ReadAll(resp.Body)
	if err != nil {
		return ""
	}

	matches := ytVideoRegex.FindAllStringSubmatch(string(html), -1)
	ids := make([]string, 0, len(matches))
	for _, match := range matches {
		ids = append(ids, match[1])
	}
	seen := make(map[string]bool)
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
		}
	}
	candidates := make([]string, 0, len(seen))
	for id := range seen {
		candidates = append(candidates, id)
	}

	for _, id := range candidates {
		if isYouTubeEmbeddable(id) {
			ytCache[cacheKey] = id
			return id
		}
	}
	if len(candidates) > 0 {
		ytCache[cacheKey] = candidates[0]
		return candidates[0]
	}
	return ""
}

func resolveDirectFullSongURL(trackName, artistName string) string {
	cacheKey := strings.ToLower(strings.TrimSpace(trackName) + "::" + strings.TrimSpace(artistName))
	if value, ok := streamCache[cacheKey]; ok {
		return value
	}

	query := strings.TrimSpace(trackName + " " + artistName)
	if query == "" {
		return ""
	}

	client := &http.Client{
		Timeout: 1200 * time.Millisecond,
	}

	resp, err := client.Get(fmt.Sprintf("https://api.audius.co/v1/tracks/search?query=%s&app_name=soniccrate", url.QueryEscape(query)))
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ""
	}

	var payload audiusSearchResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return ""
	}
	if len(payload.Data) == 0 {
		return ""
	}

	first := payload.Data[0]
	streamURL := fmt.Sprintf("https://api.audius.co/v1/tracks/%s/stream?app_name=soniccrate", url.QueryEscape(first.ID))
	streamCache[cacheKey] = streamURL
	return streamURL
}

// --------------------------
// HTTP handlers
// --------------------------

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

	passwordHash := hashPassword(password)
	if passwordHash == "" {
		authMu.Unlock()
		http.Error(w, "failed to hash password", http.StatusInternalServerError)
		return
	}

	verifyTok := generateToken()
	record := UserRecord{
		Name:              name,
		Email:             email,
		PasswordHash:      passwordHash,
		EmailVerified:     false,
		VerificationToken: verifyTok,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	}
	usersByEmail[email] = record
	saveUsersToDiskLocked()
	authMu.Unlock()

	token, err := issueJWT(record)
	if err != nil {
		http.Error(w, "failed to issue token", http.StatusInternalServerError)
		return
	}

	verifyLink := fmt.Sprintf("/?verifyToken=%s&email=%s", url.QueryEscape(verifyTok), url.QueryEscape(email))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(AuthResponse{
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
	if email == "" || strings.TrimSpace(req.Password) == "" {
		http.Error(w, "email and password are required", http.StatusBadRequest)
		return
	}

	authMu.RLock()
	record, exists := usersByEmail[email]
	authMu.RUnlock()

	if !exists || !verifyPassword(req.Password, record.PasswordHash) {
		http.Error(w, "invalid email or password", http.StatusUnauthorized)
		return
	}

	token, err := issueJWT(record)
	if err != nil {
		http.Error(w, "failed to issue token", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(AuthResponse{
		Token: token,
		User: PublicUser{
			UID:           record.UID,
			Name:          record.Name,
			Email:         record.Email,
			EmailVerified: record.EmailVerified,
		},
	})
}

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
	authMu.Unlock()

	token, err := issueJWT(record)
	if err != nil {
		http.Error(w, "failed to issue token", http.StatusInternalServerError)
		return
	}

	verifyLink := ""
	if !record.EmailVerified && record.VerificationToken != "" {
		verifyLink = fmt.Sprintf("/?verifyToken=%s&email=%s", url.QueryEscape(record.VerificationToken), url.QueryEscape(email))
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(AuthResponse{
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

func verifyEmailHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	verifyTok := strings.TrimSpace(r.URL.Query().Get("verifyToken"))
	email := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("email")))
	if verifyTok == "" || email == "" {
		http.Error(w, "invalid or expired verification link", http.StatusBadRequest)
		return
	}

	authMu.Lock()
	defer authMu.Unlock()

	record, exists := usersByEmail[email]
	if !exists {
		http.Error(w, "invalid or expired verification link", http.StatusBadRequest)
		return
	}
	if verifyTok != "" && record.VerificationToken != "" && verifyTok != record.VerificationToken {
		http.Error(w, "invalid or expired verification link", http.StatusBadRequest)
		return
	}

	record.EmailVerified = true
	usersByEmail[email] = record
	saveUsersToDiskLocked()

	token, err := issueJWT(record)
	if err != nil {
		http.Error(w, "failed to issue token", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"token": token,
		"user": PublicUser{
			UID:           record.UID,
			Name:          record.Name,
			Email:         record.Email,
			EmailVerified: record.EmailVerified,
		},
	})
}

func logoutHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	token := strings.TrimPrefix(authHeader, "Bearer ")
	token = strings.TrimSpace(token)
	if token != "" {
		delete(sessions, token)
	}
	res.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func meHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	user, ok := authenticateRequest(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"uid":            user.UID,
		"name":           user.Name,
		"email":          user.Email,
		"emailVerified":  user.EmailVerified,
	})
}

func streamHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	track := strings.TrimSpace(r.URL.Query().Get("track"))
	artist := strings.TrimSpace(r.URL.Query().Get("artist"))
	previewURL := strings.TrimSpace(r.URL.Query().Get("preview"))
	if track == "" && previewURL == "" {
		http.Error(w, "missing track or preview", http.StatusBadRequest)
		return
	}

	targetURL := previewURL
	if track != "" {
		if user, ok := authenticateRequest(r); ok && user.Email != "" {
			targetURL = resolveDirectFullSongURL(track, artist)
		}
	}
	if targetURL == "" {
		http.Error(w, "no audio stream available", http.StatusNotFound)
		return
	}

	parsedURL, err := validateUpstreamURL(targetURL)
	if err != nil {
		http.Error(w, "invalid upstream audio source", http.StatusBadRequest)
		return
	}

	client := &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout: 5 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			ForceAttemptHTTP2: true,
		},
	}
	resp, err := client.Get(parsedURL.String())
	if err != nil || resp == nil {
		http.Error(w, "failed to fetch upstream audio", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	if contentLength := resp.Header.Get("Content-Length"); contentLength != "" {
		w.Header().Set("Content-Length", contentLength)
	}
	if resp.Header.Get("Accept-Ranges") != "" {
		w.Header().Set("Accept-Ranges", resp.Header.Get("Accept-Ranges"))
	}
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = io.Copy(w, resp.Body)
}

func fullTrackHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	user, ok := authenticateRequest(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	track := strings.TrimSpace(r.URL.Query().Get("track"))
	artist := strings.TrimSpace(r.URL.Query().Get("artist"))
	preview := strings.TrimSpace(r.URL.Query().Get("preview"))
	if track == "" {
		http.Error(w, "missing 'track' query param", http.StatusBadRequest)
		return
	}

	youtubeID := lookupYouTubeVideoID(track, artist)
	token, err := issueJWT(user)
	if err != nil {
		http.Error(w, "failed to issue token", http.StatusInternalServerError)
		return
	}
	fullAudioURL := fmt.Sprintf("/stream?track=%s&artist=%s&preview=%s&token=%s", url.QueryEscape(track), url.QueryEscape(artist), url.QueryEscape(preview), url.QueryEscape(token))

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(FullTrackResponse{
		TrackName:     track,
		ArtistName:    artist,
		FullAudioURL:  fullAudioURL,
		YoutubeID:     youtubeID,
		Source:        "Full-Length Member Stream",
		Authenticated: true,
	})
}

func searchHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		http.Error(w, "missing query param 'q'", http.StatusBadRequest)
		return
	}

	results, err := fetchTracks(query, 20)
	if err != nil {
		http.Error(w, "failed to reach iTunes API", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(results)
}

func artistHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	artistName := strings.TrimSpace(r.URL.Query().Get("name"))
	if artistName == "" {
		http.Error(w, "missing query param 'name'", http.StatusBadRequest)
		return
	}

	u := fmt.Sprintf("https://itunes.apple.com/search?term=%s&media=music&entity=song&limit=10", url.QueryEscape(artistName))
	resp, err := http.Get(u)
	if err != nil {
		http.Error(w, "failed to fetch artist profile", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	var songsPayload iTunesResponse
	if err := json.NewDecoder(resp.Body).Decode(&songsPayload); err != nil {
		http.Error(w, "failed to parse artist profile", http.StatusBadGateway)
		return
	}

	var topTracks []Track
	if len(songsPayload.Results) > 0 {
		topTracks = songsPayload.Results
	}

	var albums []Album
	albumURL := fmt.Sprintf("https://itunes.apple.com/search?term=%s&media=music&entity=album&limit=8", url.QueryEscape(artistName))
	albumResp, err := http.Get(albumURL)
	if err != nil {
		// keep partial results
		albums = nil
	} else {
		defer albumResp.Body.Close()
		var albumsPayload iTunesAlbumResponse
		if err := json.NewDecoder(albumResp.Body).Decode(&albumsPayload); err != nil {
			albums = nil
		} else {
			albums = albumsPayload.Results
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(ArtistProfileResponse{
		ArtistName: artistName,
		TopTracks:  topTracks,
		Albums:     albums,
	})
}

func recommendationsHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rawArtists := strings.TrimSpace(r.URL.Query().Get("artists"))
	rawGenres := strings.TrimSpace(r.URL.Query().Get("genres"))
	rawExclude := strings.TrimSpace(r.URL.Query().Get("exclude"))

	excludeSet := make(map[string]struct{})
	for _, part := range strings.Split(rawExclude, ",") {
		value := strings.TrimSpace(part)
		if value != "" {
			excludeSet[value] = struct{}{}
		}
	}

	seeds := []struct {
		term   string
		reason string
	}{}

	if rawArtists != "" {
		for _, artist := range strings.Split(rawArtists, ",") {
			name := strings.TrimSpace(artist)
			if name == "" {
				continue
			}
			seeds = append(seeds, struct {
				term   string
				reason string
			}{term: name, reason: "Based on your activity with " + name})
		}
	}

	if rawGenres != "" {
		for _, genre := range strings.Split(rawGenres, ",") {
			name := strings.TrimSpace(genre)
			if name == "" {
				continue
			}
			if len(seeds) < 4 {
				seeds = append(seeds, struct {
					term   string
					reason string
				}{term: fmt.Sprintf("%s hits", name), reason: "Matched to your " + name + " listening sessions"})
			}
		}
	}

	if len(seeds) == 0 {
		seeds = append(seeds, struct {
			term   string
			reason string
		}{term: "Daft Punk", reason: "Studio Discovery · Electronic Essentials"})
		seeds = append(seeds, struct {
			term   string
			reason string
		}{term: "The Weeknd", reason: "Studio Discovery · Synthwave & Pop"})
		seeds = append(seeds, struct {
			term   string
			reason string
		}{term: "Tame Impala", reason: "Studio Discovery · Modern Psychedelia"})
	}

	var forYouPools [][]Track
	for _, seed := range seeds {
		tracks, err := fetchTracks(seed.term, 8)
		if err != nil {
			continue
		}
		forYouPools = append(forYouPools, tracks)
	}

	weeklyHits := fetchWeeklyHits(12)
	seen := make(map[int64]bool)
	forYou := make([]Track, 0, 12)
	for round := 0; round < 8 && len(forYou) < 12; round++ {
		for _, pool := range forYouPools {
			if round >= len(pool) {
				continue
			}
			track := pool[round]
			if track.TrackID == 0 {
				continue
			}
			if seen[track.TrackID] {
				continue
			}
			if _, ok := excludeSet[fmt.Sprintf("%d", track.TrackID)]; ok {
				continue
			}
			if track.PreviewURL == "" {
				continue
			}
			seen[track.TrackID] = true
			forYou = append(forYou, track)
		}
	}

	basis := make([]string, 0, len(seeds))
	for _, seed := range seeds {
		basis = append(basis, seed.term)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(RecommendationsResponse{
		WeekLabel:     fmt.Sprintf("Week %d", time.Now().Weekday()),
		ActivityBasis: basis,
		ForYou:        forYou,
		WeeklyHits:    weeklyHits,
	})
}

func lyricsHandler(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	track := strings.TrimSpace(r.URL.Query().Get("track"))
	artist := strings.TrimSpace(r.URL.Query().Get("artist"))
	if track == "" || artist == "" {
		http.Error(w, "missing 'track' or 'artist' query param", http.StatusBadRequest)
		return
	}

	searchURL := fmt.Sprintf("https://lrclib.net/api/search?track_name=%s&artist_name=%s", url.QueryEscape(track), url.QueryEscape(artist))
	resp, err := http.Get(searchURL)
	if err != nil {
		http.Error(w, "failed to fetch lyrics", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	var items []LrcLibItem
	if err := json.NewDecoder(resp.Body).Decode(&items); err != nil {
		http.Error(w, "failed to parse lyrics response", http.StatusBadGateway)
		return
	}

	match := LrcLibItem{}
	if len(items) > 0 {
		// use the first available result
		for _, item := range items {
			if item.PlainLyrics != "" || item.SyncedLyrics != "" {
				match = item
				break
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(LyricsResponse{
		TrackName:    match.TrackName,
		ArtistName:   match.ArtistName,
		PlainLyrics:  match.PlainLyrics,
		SyncedLyrics: match.SyncedLyrics,
		Found:        match.TrackName != "" || match.PlainLyrics != "" || match.SyncedLyrics != "",
	})
}

// --------------------------
// Static files / router setup
// --------------------------

func resolveClientDir() string {
	if _, currentFile, _, ok := runtime.Caller(0); ok {
		return filepath.Join(filepath.Dir(currentFile), "..", "client")
	}
	return filepath.Join(".", "Song", "client")
}

func main() {
	loadUsersFromDisk()

	router := http.NewServeMux()

	router.HandleFunc("/auth/register", authRateLimit(registerHandler))
	router.HandleFunc("/auth/login", authRateLimit(loginHandler))
	router.HandleFunc("/auth/firebase-sync", authRateLimit(firebaseSyncHandler))
	router.HandleFunc("/auth/verify", verifyEmailHandler)
	router.HandleFunc("/auth/logout", logoutHandler)
	router.HandleFunc("/auth/me", meHandler)

	router.HandleFunc("/stream", streamRateLimit(streamHandler))
	router.HandleFunc("/fulltrack", fullTrackHandler)
	router.HandleFunc("/recommendations", recommendationsHandler)
	router.HandleFunc("/search", searchHandler)
	router.HandleFunc("/artist", artistHandler)
	router.HandleFunc("/lyrics", lyricsHandler)

	router.HandleFunc("/api/firebase-config", func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w)
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"configured": false,
		})
	})

	clientDir := resolveClientDir()
	router.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir(clientDir)))
	router.Handle("/", http.FileServer(http.Dir(clientDir)))

	log.Println("Server starting on :8080")
	log.Fatal(http.ListenAndServe(":8080", envPort("PORT", "8080")))
}

func envPort(key string, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
