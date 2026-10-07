package transport

import (
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"net"
	"net/netip"
	"time"

	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/chacha20poly1305"
)

// Packet kinds (first byte of every datagram).
const (
	kindHello      = 1
	kindChallenge  = 2
	kindConnect    = 3
	kindAccept     = 4
	kindReject     = 5
	kindData       = 6
	kindDisconnect = 7
)

const (
	// Magic identifies GoMP datagrams ("GOMP" little-endian).
	Magic uint32 = 0x504D4F47
	// ProtocolVersion is bumped on incompatible wire changes.
	ProtocolVersion uint16 = 1

	// helloSize pads HELLO so that a CHALLENGE is never larger than the
	// request that triggered it (no reflection amplification).
	helloSize   = 96
	cookieSize  = 20
	keySize     = 32
	tagSize     = chacha20poly1305.Overhead
	cookieTTL   = 10 * time.Second
	flagEncrypt = 1

	// MaxConnectPayload bounds the application data in CONNECT.
	MaxConnectPayload = 900
)

// PacketConn is the datagram socket used by the transport. *net.UDPConn
// implements it; tests wrap it with faultnet.
type PacketConn interface {
	ReadFromUDPAddrPort(b []byte) (int, netip.AddrPort, error)
	WriteToUDPAddrPort(b []byte, addr netip.AddrPort) (int, error)
	LocalAddr() net.Addr
	Close() error
}

// makeCookie returns ts || HMAC(secret, addr || nonce || ts)[:16].
func makeCookie(secret []byte, addr netip.AddrPort, nonce uint64, ts uint32) [cookieSize]byte {
	var c [cookieSize]byte
	binary.LittleEndian.PutUint32(c[:4], ts)
	mac := hmac.New(sha256.New, secret)
	ab, _ := addr.MarshalBinary()
	mac.Write(ab)
	var nb [12]byte
	binary.LittleEndian.PutUint64(nb[:8], nonce)
	binary.LittleEndian.PutUint32(nb[8:], ts)
	mac.Write(nb[:])
	copy(c[4:], mac.Sum(nil)[:cookieSize-4])
	return c
}

func checkCookie(secret []byte, addr netip.AddrPort, nonce uint64, c []byte, now time.Time) bool {
	if len(c) != cookieSize {
		return false
	}
	ts := binary.LittleEndian.Uint32(c[:4])
	age := now.Unix() - int64(ts)
	if age < -1 || age > int64(cookieTTL/time.Second) {
		return false
	}
	want := makeCookie(secret, addr, nonce, ts)
	return hmac.Equal(want[:], c)
}

// sessionKeys derives directional ChaCha20-Poly1305 keys from an X25519 secret:
// key = BLAKE2b-256(key=shared, label || nonce || serverPub || clientPub).
func sessionKeys(shared []byte, nonce uint64, serverPub, clientPub []byte) (c2s, s2c cipher.AEAD, err error) {
	derive := func(label string) (cipher.AEAD, error) {
		h, err := blake2b.New256(shared)
		if err != nil {
			return nil, err
		}
		h.Write([]byte(label))
		var nb [8]byte
		binary.LittleEndian.PutUint64(nb[:], nonce)
		h.Write(nb[:])
		h.Write(serverPub)
		h.Write(clientPub)
		return chacha20poly1305.New(h.Sum(nil))
	}
	if c2s, err = derive("gomp-c2s"); err != nil {
		return nil, nil, err
	}
	s2c, err = derive("gomp-s2c")
	return c2s, s2c, err
}

func newKeyPair() (*ecdh.PrivateKey, error) {
	return ecdh.X25519().GenerateKey(rand.Reader)
}

func randUint64() uint64 {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return binary.LittleEndian.Uint64(b[:])
}

// randSessionID returns a random non-zero session identifier.
func randSessionID() uint32 {
	var b [4]byte
	for {
		_, _ = rand.Read(b[:])
		if id := binary.LittleEndian.Uint32(b[:]); id != 0 {
			return id
		}
	}
}

func unmap(ap netip.AddrPort) netip.AddrPort {
	return netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())
}
