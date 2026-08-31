package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
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
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/majd/ipatool/v2/internal/sap"
)

const (
	defaultAddress = "127.0.0.1:54726"
	maxJSONBody    = 128 << 10
	maxActionBody  = 64 << 10
	sessionTTL     = 15 * time.Minute
	maxSessions    = 4
)

type signRequest struct {
	GUID           string `json:"guid"`
	SetupURL       string `json:"setupURL"`
	CertificateURL string `json:"certificateURL"`
	Version        uint32 `json:"version"`
	Body           string `json:"body"`
}

type signResponse struct {
	Signature string `json:"signature"`
}

type signerFactory func(context.Context, sap.Config) (sap.ActionSigner, error)

type signerEntry struct {
	mu       sync.Mutex
	signer   sap.ActionSigner
	lastUsed time.Time
}

type signerManager struct {
	mu       sync.Mutex
	sessions map[[32]byte]*signerEntry
	factory  signerFactory
}

func newSignerManager(factory signerFactory) *signerManager {
	return &signerManager{
		sessions: make(map[[32]byte]*signerEntry),
		factory:  factory,
	}
}

func (m *signerManager) sign(ctx context.Context, input signRequest) ([]byte, error) {
	config, body, key, err := validatedSignInput(input)
	if err != nil {
		return nil, err
	}

	entry, err := m.session(ctx, key, config)
	if err != nil {
		return nil, err
	}

	entry.mu.Lock()
	defer entry.mu.Unlock()

	signature, err := entry.signer.Sign(body)
	if err != nil {
		m.remove(key, entry)
		_ = entry.signer.Close()
		return nil, fmt.Errorf("sign Apple action: %w", err)
	}

	m.mu.Lock()
	if current := m.sessions[key]; current == entry {
		entry.lastUsed = time.Now()
	}
	m.mu.Unlock()

	return signature, nil
}

func (m *signerManager) session(
	ctx context.Context,
	key [32]byte,
	config sap.Config,
) (*signerEntry, error) {
	now := time.Now()
	m.mu.Lock()
	expired := m.takeExpiredLocked(now)
	if entry := m.sessions[key]; entry != nil {
		entry.lastUsed = now
		m.mu.Unlock()
		closeEntries(expired)
		return entry, nil
	}
	m.mu.Unlock()
	closeEntries(expired)

	signer, err := m.factory(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("initialize Apple SAP signer: %w", err)
	}
	created := &signerEntry{signer: signer, lastUsed: now}

	m.mu.Lock()
	if existing := m.sessions[key]; existing != nil {
		existing.lastUsed = now
		m.mu.Unlock()
		_ = signer.Close()
		return existing, nil
	}

	var evicted []*signerEntry
	for len(m.sessions) >= maxSessions {
		evicted = append(evicted, m.takeOldestLocked())
	}
	m.sessions[key] = created
	m.mu.Unlock()
	closeEntries(evicted)

	return created, nil
}

func (m *signerManager) takeExpiredLocked(now time.Time) []*signerEntry {
	var expired []*signerEntry
	for key, entry := range m.sessions {
		if now.Sub(entry.lastUsed) >= sessionTTL {
			delete(m.sessions, key)
			expired = append(expired, entry)
		}
	}
	return expired
}

func (m *signerManager) takeOldestLocked() *signerEntry {
	var oldestKey [32]byte
	var oldest *signerEntry
	for key, entry := range m.sessions {
		if oldest == nil || entry.lastUsed.Before(oldest.lastUsed) {
			oldestKey = key
			oldest = entry
		}
	}
	if oldest != nil {
		delete(m.sessions, oldestKey)
	}
	return oldest
}

func (m *signerManager) remove(key [32]byte, entry *signerEntry) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sessions[key] == entry {
		delete(m.sessions, key)
	}
}

func (m *signerManager) close() {
	m.mu.Lock()
	entries := make([]*signerEntry, 0, len(m.sessions))
	for key, entry := range m.sessions {
		delete(m.sessions, key)
		entries = append(entries, entry)
	}
	m.mu.Unlock()
	closeEntries(entries)
}

func closeEntries(entries []*signerEntry) {
	for _, entry := range entries {
		if entry == nil {
			continue
		}
		entry.mu.Lock()
		_ = entry.signer.Close()
		entry.mu.Unlock()
	}
}

func validatedSignInput(input signRequest) (sap.Config, []byte, [32]byte, error) {
	normalizedGUID, hardwareID, err := parseGUID(input.GUID)
	if err != nil {
		return sap.Config{}, nil, [32]byte{}, err
	}
	if err := validateAppleURL(input.SetupURL, "fpinit.itunes.apple.com", "/v1/signSapSetup/"); err != nil {
		return sap.Config{}, nil, [32]byte{}, fmt.Errorf("invalid SAP setup URL: %w", err)
	}
	if err := validateAppleURL(input.CertificateURL, "s.mzstatic.com", "/sap/setupCert.plist"); err != nil {
		return sap.Config{}, nil, [32]byte{}, fmt.Errorf("invalid SAP certificate URL: %w", err)
	}
	if input.Version != 200 {
		return sap.Config{}, nil, [32]byte{}, fmt.Errorf("unsupported SAP version %d", input.Version)
	}

	body, err := base64.StdEncoding.DecodeString(input.Body)
	if err != nil {
		return sap.Config{}, nil, [32]byte{}, errors.New("request body is not valid base64")
	}
	if len(body) == 0 || len(body) > maxActionBody {
		return sap.Config{}, nil, [32]byte{}, fmt.Errorf(
			"request body must contain between 1 and %d bytes",
			maxActionBody,
		)
	}

	config := sap.Config{
		SetupURL:       input.SetupURL,
		CertificateURL: input.CertificateURL,
		Version:        input.Version,
		HardwareID:     hardwareID,
	}
	keyMaterial := fmt.Sprintf(
		"%s\x00%s\x00%s\x00%d",
		normalizedGUID,
		input.SetupURL,
		input.CertificateURL,
		input.Version,
	)
	return config, body, sha256.Sum256([]byte(keyMaterial)), nil
}

func parseGUID(value string) (string, []byte, error) {
	normalized := strings.ToUpper(strings.Map(func(r rune) rune {
		switch r {
		case ' ', '\t', '\r', '\n', ':', '-':
			return -1
		default:
			return r
		}
	}, value))
	if len(normalized) == 0 || len(normalized)%2 != 0 || len(normalized) > 40 {
		return "", nil, errors.New("GUID must contain 1 to 20 bytes of hexadecimal data")
	}
	hardwareID, err := hex.DecodeString(normalized)
	if err != nil {
		return "", nil, errors.New("GUID must contain only hexadecimal data")
	}
	return normalized, hardwareID, nil
}

func validateAppleURL(rawURL, expectedHost, expectedPath string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil {
		return errors.New("endpoint must be an absolute HTTPS URL without credentials")
	}
	if !strings.EqualFold(parsed.Hostname(), expectedHost) {
		return fmt.Errorf("endpoint host must be %s", expectedHost)
	}
	if strings.HasSuffix(expectedPath, "/") {
		if !strings.HasPrefix(parsed.EscapedPath(), expectedPath) {
			return fmt.Errorf("endpoint path must start with %s", expectedPath)
		}
	} else if parsed.EscapedPath() != expectedPath {
		return fmt.Errorf("endpoint path must be %s", expectedPath)
	}
	return nil
}

func handler(manager *signerManager, token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/v1/sign", func(w http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if !authorized(request.Header.Get("Authorization"), token) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}

		request.Body = http.MaxBytesReader(w, request.Body, maxJSONBody)
		decoder := json.NewDecoder(request.Body)
		decoder.DisallowUnknownFields()
		var input signRequest
		if err := decoder.Decode(&input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sign request"})
			return
		}
		if err := ensureJSONEnd(decoder); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sign request"})
			return
		}

		signature, err := manager.sign(request.Context(), input)
		if err != nil {
			log.Printf("SAP signing failed: %v", err)
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "SAP signing failed"})
			return
		}
		writeJSON(w, http.StatusOK, signResponse{
			Signature: base64.StdEncoding.EncodeToString(signature),
		})
	})
	return mux
}

func authorized(header, token string) bool {
	const prefix = "Bearer "
	if token == "" || !strings.HasPrefix(header, prefix) {
		return false
	}
	actual := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	if len(actual) != len(token) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(actual), []byte(token)) == 1
}

func ensureJSONEnd(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("request contains trailing JSON")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func loopbackAddress(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		value = defaultAddress
	}
	host, _, err := net.SplitHostPort(value)
	if err != nil {
		return "", fmt.Errorf("invalid ASSPSAP_ADDR: %w", err)
	}
	host = strings.Trim(host, "[]")
	if host == "localhost" {
		return value, nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return "", errors.New("ASSPSAP_ADDR must use a loopback address")
	}
	return value, nil
}

func main() {
	token := strings.TrimSpace(os.Getenv("ASSPSAP_TOKEN"))
	if len(token) < 32 {
		log.Fatal("ASSPSAP_TOKEN must contain at least 32 characters")
	}
	address, err := loopbackAddress(os.Getenv("ASSPSAP_ADDR"))
	if err != nil {
		log.Fatal(err)
	}

	manager := newSignerManager(func(ctx context.Context, config sap.Config) (sap.ActionSigner, error) {
		return sap.NewSigner(ctx, config)
	})
	defer manager.close()

	server := &http.Server{
		Addr:              address,
		Handler:           handler(manager, token),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      10 * time.Minute,
		IdleTimeout:       30 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()

	log.Printf("AssppWeb SAP signer listening on %s", address)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
