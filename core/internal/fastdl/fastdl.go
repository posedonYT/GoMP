// Package fastdl serves client_packages over HTTP like RAGE.MP does on
// port+1: a manifest with SHA-256 hashes and the files themselves. The game
// client downloads changed files before running client scripts (phase 2).
package fastdl

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// File is one manifest entry.
type File struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
	Hash string `json:"sha256"`
}

// Manifest lists every client package file.
type Manifest struct {
	Files []File `json:"files"`
}

// Build hashes every regular file under dir.
func Build(dir string) (Manifest, error) {
	var m Manifest
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		sum := sha256.Sum256(data)
		m.Files = append(m.Files, File{Path: filepath.ToSlash(rel), Size: int64(len(data)), Hash: hex.EncodeToString(sum[:])})
		return nil
	})
	if os.IsNotExist(err) {
		return Manifest{}, nil
	}
	sort.Slice(m.Files, func(i, j int) bool { return m.Files[i].Path < m.Files[j].Path })
	return m, err
}

// Handler serves /manifest.json and /files/<path> from dir. The manifest is
// rebuilt at most once per second so edits are picked up without restarts.
func Handler(dir string) http.Handler {
	var mu sync.Mutex
	var cached []byte
	var at time.Time
	mux := http.NewServeMux()
	mux.HandleFunc("/manifest.json", func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		if cached == nil || time.Since(at) > time.Second {
			m, err := Build(dir)
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
		_, _ = w.Write(body)
	})
	files := http.StripPrefix("/files/", http.FileServer(http.Dir(dir)))
	mux.HandleFunc("/files/", func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "..") {
			http.Error(w, "bad path", http.StatusBadRequest)
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
