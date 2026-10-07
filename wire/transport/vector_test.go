package transport

import (
	"bytes"
	"crypto/ecdh"
	"encoding/binary"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var updateVector = flag.Bool("update", false, "rewrite testdata/crypto_vector.txt")

// TestCryptoVector produces a fixed handshake + packet vector that the C++
// client tests verify, proving both implementations derive the same keys and
// interoperate on ChaCha20-Poly1305.
func TestCryptoVector(t *testing.T) {
	serverPriv := bytes.Repeat([]byte{0x11}, 32)
	clientPriv := bytes.Repeat([]byte{0x22}, 32)
	sk, err := ecdh.X25519().NewPrivateKey(serverPriv)
	if err != nil {
		t.Fatal(err)
	}
	ck, err := ecdh.X25519().NewPrivateKey(clientPriv)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := ck.ECDH(sk.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	const nonce = uint64(0x0102030405060708)
	c2s, s2c, err := sessionKeys(shared, nonce, sk.PublicKey().Bytes(), ck.PublicKey().Bytes())
	if err != nil {
		t.Fatal(err)
	}
	// A server → client DATA packet: header(kind, session, counter) || seal(body).
	body := []byte{1, 0, 0xFF, 0xFF, 0, 0, 0, 0, chunkUnrel, 3, 'g', 'o', '!'}
	const session, counter = uint32(0xCAFEBABE), uint64(7)
	hdr := []byte{kindData}
	hdr = binary.LittleEndian.AppendUint32(hdr, session)
	hdr = binary.LittleEndian.AppendUint64(hdr, counter)
	var n [12]byte
	binary.LittleEndian.PutUint64(n[4:], counter)
	packet := s2c.Seal(append([]byte(nil), hdr...), n[:], body, hdr)
	// And a client → server packet sealed with the c2s key.
	clientPacket := c2s.Seal(append([]byte(nil), hdr...), n[:], body, hdr)

	lines := []string{
		"server_priv=" + hex.EncodeToString(serverPriv),
		"client_priv=" + hex.EncodeToString(clientPriv),
		"server_pub=" + hex.EncodeToString(sk.PublicKey().Bytes()),
		"client_pub=" + hex.EncodeToString(ck.PublicKey().Bytes()),
		"shared=" + hex.EncodeToString(shared),
		fmt.Sprintf("nonce=%d", nonce),
		"body=" + hex.EncodeToString(body),
		"s2c_packet=" + hex.EncodeToString(packet),
		"c2s_packet=" + hex.EncodeToString(clientPacket),
	}
	content := strings.Join(lines, "\n") + "\n"
	path := filepath.Join("testdata", "crypto_vector.txt")
	if *updateVector {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing %s (run go test ./wire/transport -run TestCryptoVector -update): %v", path, err)
	}
	if string(want) != content {
		t.Fatal("crypto vector changed; rerun with -update if intended")
	}
}
