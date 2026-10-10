package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// A fake fastdl (the real one is core/internal/fastdl): /resources.json and /files/.
func fakeFastdl(t *testing.T, files map[string][]byte) (server string, downloads *atomic.Int32) {
	t.Helper()
	downloads = &atomic.Int32{}
	mux := http.NewServeMux()
	mux.HandleFunc("/resources.json", func(w http.ResponseWriter, _ *http.Request) {
		var m resourceManifest
		for p, b := range files {
			sum := sha256.Sum256(b)
			m.Files = append(m.Files, resourceFile{Path: p, Size: int64(len(b)), Hash: hex.EncodeToString(sum[:])})
		}
		_ = json.NewEncoder(w).Encode(m)
	})
	mux.HandleFunc("/files/", func(w http.ResponseWriter, r *http.Request) {
		b, ok := files[strings.TrimPrefix(r.URL.Path, "/files/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		downloads.Add(1)
		_, _ = w.Write(b)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	// The game server's port is one below fastdl's.
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	p, _ := strconv.Atoi(port)
	return net.JoinHostPort(host, strconv.Itoa(p-1)), downloads
}

func TestServerResourcesAreFetchedOnceAndKeptInStep(t *testing.T) {
	files := map[string][]byte{
		"game_resources/dlcpacks/lspd/dlc.rpf":    []byte(strings.Repeat("lspd", 1000)),
		"game_resources/dlcpacks/clothes/dlc.rpf": []byte("clothes"),
	}
	server, downloads := fakeFastdl(t, files)
	dir := cacheDirFor(t.TempDir(), server)
	var last [2]int64
	packs, err := fetchResources(http.DefaultClient, server, dir, func(d, total int64) { last = [2]int64{d, total} })
	if err != nil {
		t.Fatal(err)
	}
	if packs != filepath.Join(dir, "game_resources", "dlcpacks") || downloads.Load() != 2 || last[0] != last[1] || last[1] != 4007 {
		t.Fatalf("packs %q, downloads %d, progress %v", packs, downloads.Load(), last)
	}
	b, _ := os.ReadFile(filepath.Join(packs, "lspd", "dlc.rpf"))
	if string(b) != string(files["game_resources/dlcpacks/lspd/dlc.rpf"]) {
		t.Fatal("content")
	}
	// Again: nothing to download.
	if _, err := fetchResources(http.DefaultClient, server, dir, nil); err != nil || downloads.Load() != 2 {
		t.Fatalf("second run: %v, downloads %d", err, downloads.Load())
	}
	// The server changed one pack and dropped the other.
	files["game_resources/dlcpacks/lspd/dlc.rpf"] = []byte("lspd v2")
	delete(files, "game_resources/dlcpacks/clothes/dlc.rpf")
	if _, err := fetchResources(http.DefaultClient, server, dir, nil); err != nil {
		t.Fatal(err)
	}
	if downloads.Load() != 3 {
		t.Fatalf("only the changed pack: %d", downloads.Load())
	}
	if b, _ := os.ReadFile(filepath.Join(packs, "lspd", "dlc.rpf")); string(b) != "lspd v2" {
		t.Fatal("not updated")
	}
	if _, err := os.Stat(filepath.Join(packs, "clothes", "dlc.rpf")); !os.IsNotExist(err) {
		t.Fatal("a pack the server dropped stays")
	}
}

func TestServerResourcesRefuseBadPaths(t *testing.T) {
	server, _ := fakeFastdl(t, map[string][]byte{"game_resources/../../evil.dll": []byte("x")})
	if _, err := fetchResources(http.DefaultClient, server, t.TempDir(), nil); err == nil || !strings.Contains(err.Error(), "bad path") {
		t.Fatalf("err %v", err)
	}
	server, _ = fakeFastdl(t, map[string][]byte{"index.js": []byte("x")})
	if _, err := fetchResources(http.DefaultClient, server, t.TempDir(), nil); err == nil {
		t.Fatal("only game_resources/ is fetched by the launcher")
	}
}

func TestFastdlBase(t *testing.T) {
	if b, _ := fastdlBase("127.0.0.1:22005"); b != "http://127.0.0.1:22006" {
		t.Fatal(b)
	}
	if b, _ := fastdlBase("[::1]:22005"); b != "http://[::1]:22006" {
		t.Fatal(b)
	}
	if _, err := fastdlBase("nohost"); err == nil {
		t.Fatal("bad address")
	}
	if d := cacheDirFor("C:/cache", "1.2.3.4:22005"); filepath.Base(d) != "1.2.3.4_22005" {
		t.Fatal(d)
	}
}
