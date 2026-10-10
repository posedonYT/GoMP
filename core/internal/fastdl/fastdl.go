// Package fastdl serves client_packages over HTTP like RAGE.MP does on
// port+1: manifests with SHA-256 hashes and the files themselves.
//
//	/manifest.json   the client scripts: every file except game_resources/ (the game
//	                 client downloads changed ones before running client scripts)
//	/resources.json  game_resources/ (dlcpacks...): the launcher fetches them before
//	                 the game starts, they cannot be mounted later
//	/files/<path>    a file; ranges are served (a broken download resumes), text
//	                 files gzip-compressed when the client accepts it
//
// Hashes are kept per file and recomputed only when its size or time changes:
// dlcpacks of hundreds of megabytes are not hashed again for every manifest.
package fastdl

import (
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ResourcesDir is the folder of client_packages that holds game resources.
const ResourcesDir = "game_resources"

// File is one manifest entry.
type File struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
	Hash string `json:"sha256"`
}

// Manifest lists files of client_packages.
type Manifest struct {
	Files []File `json:"files"`
}

type hashEntry struct {
	size int64
	mod  time.Time
	hash string
}

// Hasher remembers the hash of each file by its size and modification time.
type Hasher struct {
	mu    sync.Mutex
	known map[string]hashEntry
}

func NewHasher() *Hasher { return &Hasher{known: map[string]hashEntry{}} }

func (h *Hasher) hash(p string, info fs.FileInfo) (string, error) {
	h.mu.Lock()
	e, ok := h.known[p]
	h.mu.Unlock()
	if ok && e.size == info.Size() && e.mod.Equal(info.ModTime()) {
		return e.hash, nil
	}
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	sum := sha256.New()
	if _, err := io.Copy(sum, f); err != nil {
		return "", err
	}
	hs := hex.EncodeToString(sum.Sum(nil))
	h.mu.Lock()
	h.known[p] = hashEntry{info.Size(), info.ModTime(), hs}
	h.mu.Unlock()
	return hs, nil
}

// Build hashes the files under dir; resources selects game_resources/ (true) or
// everything else (false).
func (h *Hasher) Build(dir string, resources bool) (Manifest, error) {
	var m Manifest
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		rel = filepath.ToSlash(rel)
		inResources := rel == ResourcesDir || strings.HasPrefix(rel, ResourcesDir+"/")
		if d.IsDir() {
			if !resources && inResources {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || inResources != resources {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		hs, err := h.hash(p, info)
		if err != nil {
			return err
		}
		m.Files = append(m.Files, File{Path: rel, Size: info.Size(), Hash: hs})
		return nil
	})
	if os.IsNotExist(err) {
		return Manifest{}, nil
	}
	sort.Slice(m.Files, func(i, j int) bool { return m.Files[i].Path < m.Files[j].Path })
	return m, err
}

// Build hashes the client scripts under dir (everything but game_resources/).
func Build(dir string) (Manifest, error) { return NewHasher().Build(dir, false) }

// manifestHandler serves a manifest, rebuilt at most once per second so edits
// are picked up without restarts.
func manifestHandler(h *Hasher, dir string, resources bool) http.HandlerFunc {
	var mu sync.Mutex
	var cached []byte
	var at time.Time
	return func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		if cached == nil || time.Since(at) > time.Second {
			m, err := h.Build(dir, resources)
			if err != nil {
				mu.Unlock()
				http.Error(w, "manifest unavailable", http.StatusInternalServerError)
				return
			}
			cached, _ = json.Marshal(m)
			at = time.Now()
		}
		body := cached
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(body)
	}
}

// Text files are worth compressing; archives (dlc.rpf), images and fonts are not.
var textTypes = map[string]bool{".js": true, ".mjs": true, ".json": true, ".html": true, ".htm": true, ".css": true, ".svg": true, ".txt": true, ".xml": true, ".map": true}

type gzipWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (g gzipWriter) Write(b []byte) (int, error) { return g.gz.Write(b) }

// The length the file server sets is the uncompressed one.
func (g gzipWriter) WriteHeader(code int) {
	g.ResponseWriter.Header().Del("Content-Length")
	g.ResponseWriter.WriteHeader(code)
}

// Handler serves the manifests and the files of dir (client_packages).
func Handler(dir string) http.Handler {
	h := NewHasher()
	mux := http.NewServeMux()
	mux.HandleFunc("/manifest.json", manifestHandler(h, dir, false))
	mux.HandleFunc("/resources.json", manifestHandler(h, dir, true))
	files := http.StripPrefix("/files/", http.FileServer(http.Dir(dir)))
	mux.HandleFunc("/files/", func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "..") {
			http.Error(w, "bad path", http.StatusBadRequest)
			return
		}
		// A whole text file to a client that takes gzip: compressed (ranges are served as they are).
		if textTypes[strings.ToLower(path.Ext(r.URL.Path))] && r.Header.Get("Range") == "" && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Add("Vary", "Accept-Encoding")
			gz := gzip.NewWriter(w)
			defer gz.Close()
			r.Header.Del("Accept-Encoding")
			files.ServeHTTP(gzipWriter{w, gz}, r)
			return
		}
		files.ServeHTTP(w, r)
	})
	return mux
}

// Serve starts the HTTP server on addr.
func Serve(addr, dir string) (net.Addr, func() error, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, nil, err
	}
	srv := &http.Server{Handler: Handler(dir), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	return ln.Addr(), srv.Close, nil
}
