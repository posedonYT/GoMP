package fastdl

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
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
