package main

// The server's game resources (client_packages/game_resources: dlcpacks with maps,
// vehicles, clothes...) as RAGE.MP servers ship them: the game mounts packs only
// at start, so the launcher fetches them from the server's fastdl (port+1,
// /resources.json, core/internal/fastdl) before it starts the game, into a cache
// per server; a file already there with the same hash is not downloaded again,
// files the server no longer has are removed. The packs are then installed like
// the local add-ons (tools/addons, several folders at once).

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type resourceFile struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
	Hash string `json:"sha256"`
}

type resourceManifest struct {
	Files []resourceFile `json:"files"`
}

// fastdlBase is the fastdl address of a game server address (host:port -> http://host:port+1).
func fastdlBase(server string) (string, error) {
	host, port, err := net.SplitHostPort(server)
	if err != nil {
		return "", err
	}
	p, err := strconv.Atoi(port)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("http://%s", net.JoinHostPort(host, strconv.Itoa(p+1))), nil
}

// cacheDirFor is the folder of one server's resources under root.
func cacheDirFor(root, server string) string {
	return filepath.Join(root, strings.NewReplacer(":", "_", "/", "_", "\\", "_", "[", "", "]", "").Replace(server))
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// fetchResources brings dir (one server's cache) up to date with the server's
// resources; it returns the folder of the packs (dir/game_resources/dlcpacks), "" when
// the server has none. progress gets the bytes downloaded so far and the total to download.
func fetchResources(client *http.Client, server, dir string, progress func(done, total int64)) (string, error) {
	base, err := fastdlBase(server)
	if err != nil {
		return "", err
	}
	res, err := client.Get(base + "/resources.json")
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return "", nil // an older server: no game resources
	}
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("resources.json: %s", res.Status)
	}
	var m resourceManifest
	if err := json.NewDecoder(res.Body).Decode(&m); err != nil {
		return "", fmt.Errorf("resources.json: %w", err)
	}
	// What is missing or changed.
	wanted := map[string]bool{}
	var todo []resourceFile
	var total int64
	for _, f := range m.Files {
		clean := filepath.FromSlash(f.Path)
		if f.Path == "" || strings.Contains(f.Path, "..") || filepath.IsAbs(clean) || !strings.HasPrefix(f.Path, "game_resources/") {
			return "", fmt.Errorf("resources.json: bad path %q", f.Path)
		}
		wanted[clean] = true
		local := filepath.Join(dir, clean)
		if st, err := os.Stat(local); err == nil && st.Size() == f.Size {
			if h, err := sha256File(local); err == nil && strings.EqualFold(h, f.Hash) {
				continue
			}
		}
		todo = append(todo, f)
		total += f.Size
	}
	var done int64
	for _, f := range todo {
		if err := download(client, base+"/files/"+f.Path, filepath.Join(dir, filepath.FromSlash(f.Path)), f, func(n int64) {
			if progress != nil {
				progress(done+n, total)
			}
		}); err != nil {
			return "", err
		}
		done += f.Size
	}
	// Files the server does not have any more go (a pack removed from the server).
	root := filepath.Join(dir, "game_resources")
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		if !wanted[rel] {
			_ = os.Remove(p)
		}
		return nil
	})
	packs := filepath.Join(root, "dlcpacks")
	if st, err := os.Stat(packs); err == nil && st.IsDir() {
		return packs, nil
	}
	return "", nil
}

// download writes url to path through a temporary file, checking size and hash.
func download(client *http.Client, url, path string, f resourceFile, progress func(int64)) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	res, err := client.Get(url)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", f.Path, res.Status)
	}
	tmp := path + ".part"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	h := sha256.New()
	var n int64
	buf := make([]byte, 256<<10)
	for {
		k, rerr := res.Body.Read(buf)
		if k > 0 {
			if _, err := out.Write(buf[:k]); err != nil {
				out.Close()
				return err
			}
			h.Write(buf[:k])
			n += int64(k)
			progress(n)
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			out.Close()
			os.Remove(tmp)
			return rerr
		}
	}
	out.Close()
	if n != f.Size || !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), f.Hash) {
		os.Remove(tmp)
		return errors.New(f.Path + ": the download does not match the server's hash")
	}
	_ = os.Remove(path)
	return os.Rename(tmp, path)
}

// serverResources fetches the resources of server into the launcher's cache, printing
// progress; "" when there are none or the server cannot be reached (the game still starts).
func serverResources(server string) string {
	root, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	dir := cacheDirFor(filepath.Join(root, "GoMP", "servers"), server)
	client := &http.Client{Timeout: 30 * time.Minute}
	last := time.Time{}
	packs, err := fetchResources(client, server, dir, func(done, total int64) {
		if time.Since(last) > 500*time.Millisecond || done == total {
			last = time.Now()
			fmt.Printf("\rserver resources: %d / %d MB", done>>20, total>>20)
		}
	})
	if err != nil {
		fmt.Println("\nserver resources not downloaded:", err)
		return ""
	}
	if packs != "" {
		fmt.Println("\nserver resources:", packs)
	}
	return packs
}
