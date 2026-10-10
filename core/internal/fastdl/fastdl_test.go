package fastdl

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManifestAndFiles(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "ui"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "index.js"), []byte("require('./ui/app.js')"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "ui", "app.js"), []byte("mp.gui.chat.push('hi')"), 0o644)
	srv := httptest.NewServer(Handler(dir))
	defer srv.Close()

	res, err := srv.Client().Get(srv.URL + "/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var m Manifest
	if err := json.NewDecoder(res.Body).Decode(&m); err != nil {
		t.Fatal(err)
	}
	if len(m.Files) != 2 || m.Files[0].Path != "index.js" || m.Files[1].Path != "ui/app.js" || len(m.Files[0].Hash) != 64 {
		t.Fatalf("manifest %+v", m)
	}
	res, err = srv.Client().Get(srv.URL + "/files/ui/app.js")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	if string(body) != "mp.gui.chat.push('hi')" {
		t.Fatalf("file body %q", body)
	}
	res, _ = srv.Client().Get(srv.URL + "/files/../secret")
	if res.StatusCode == 200 {
		t.Fatal("path traversal served")
	}
}

func TestMissingDir(t *testing.T) {
	m, err := Build(filepath.Join(t.TempDir(), "nope"))
	if err != nil || len(m.Files) != 0 {
		t.Fatalf("%v %+v", err, m)
	}
}

// game_resources (dlcpacks) have a manifest of their own and stay out of the scripts';
// ranges resume a download; text comes gzip-compressed to a client that takes it.
func TestResourcesRangesAndGzip(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "game_resources", "dlcpacks", "lspd"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "index.js"), []byte(strings.Repeat("mp.events.add('x', () => {});\n", 200)), 0o644)
	pack := make([]byte, 100000)
	for i := range pack {
		pack[i] = byte(i * 7)
	}
	_ = os.WriteFile(filepath.Join(dir, "game_resources", "dlcpacks", "lspd", "dlc.rpf"), pack, 0o644)
	srv := httptest.NewServer(Handler(dir))
	defer srv.Close()
	get := func(path string, m *Manifest) {
		res, err := srv.Client().Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if err := json.NewDecoder(res.Body).Decode(m); err != nil {
			t.Fatal(err)
		}
	}
	var scripts, res Manifest
	get("/manifest.json", &scripts)
	get("/resources.json", &res)
	if len(scripts.Files) != 1 || scripts.Files[0].Path != "index.js" {
		t.Fatalf("scripts %+v", scripts)
	}
	if len(res.Files) != 1 || res.Files[0].Path != "game_resources/dlcpacks/lspd/dlc.rpf" || res.Files[0].Size != 100000 {
		t.Fatalf("resources %+v", res)
	}
	// A range: the rest of a broken download.
	req, _ := http.NewRequest("GET", srv.URL+"/files/game_resources/dlcpacks/lspd/dlc.rpf", nil)
	req.Header.Set("Range", "bytes=99990-")
	r, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != http.StatusPartialContent || !bytes.Equal(body, pack[99990:]) {
		t.Fatalf("range: %d, %d bytes", r.StatusCode, len(body))
	}
	// gzip for scripts (the transport decompresses it), not for archives.
	tr := &http.Transport{DisableCompression: true}
	cl := &http.Client{Transport: tr}
	req, _ = http.NewRequest("GET", srv.URL+"/files/index.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	r, err = cl.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if r.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("no gzip: %v", r.Header)
	}
	zr, err := gzip.NewReader(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	text, _ := io.ReadAll(zr)
	r.Body.Close()
	if !strings.HasPrefix(string(text), "mp.events.add") || len(text) != 200*len("mp.events.add('x', () => {});\n") {
		t.Fatalf("gzip body %d bytes", len(text))
	}
	req, _ = http.NewRequest("GET", srv.URL+"/files/game_resources/dlcpacks/lspd/dlc.rpf", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	r, _ = cl.Do(req)
	r.Body.Close()
	if r.Header.Get("Content-Encoding") != "" {
		t.Fatal("an archive is not compressed")
	}
}

// A file's hash is computed once and again only when the file changes.
func TestHashesAreCached(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.js")
	_ = os.WriteFile(p, []byte("one"), 0o644)
	h := NewHasher()
	m1, _ := h.Build(dir, false)
	// Same size and time: the cached hash (the content is not read again).
	old := m1.Files[0].Hash
	info, _ := os.Stat(p)
	_ = os.WriteFile(p, []byte("two"), 0o644)
	_ = os.Chtimes(p, info.ModTime(), info.ModTime())
	m2, _ := h.Build(dir, false)
	if m2.Files[0].Hash != old {
		t.Fatal("re-hashed an unchanged file")
	}
	// Changed: hashed again.
	_ = os.WriteFile(p, []byte("three"), 0o644)
	m3, _ := h.Build(dir, false)
	if m3.Files[0].Hash == old || m3.Files[0].Size != 5 {
		t.Fatalf("changed file: %+v", m3.Files[0])
	}
}
