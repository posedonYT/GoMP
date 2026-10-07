// Session crypto shared by the transport and its tests (wire/transport/packet.go).
#pragma once

#include <cstddef>
#include <cstdint>

namespace gomp::crypto {

// key = BLAKE2b-256(key=shared, label || nonce(LE) || serverPub || clientPub)
void deriveKey(uint8_t out[32], const uint8_t shared[32], const char* label, uint64_t nonce,
               const uint8_t serverPub[32], const uint8_t clientPub[32]);

// X25519.
void publicKey(uint8_t pub[32], const uint8_t secret[32]);
void sharedSecret(uint8_t shared[32], const uint8_t secret[32], const uint8_t peerPub[32]);

// ChaCha20-Poly1305 (RFC 8439) with nonce = 4 zero bytes || counter (LE).
// seal writes n bytes of ciphertext followed by the 16-byte tag.
void seal(uint8_t* out, const uint8_t key[32], uint64_t counter, const uint8_t* ad, std::size_t adLen,
          const uint8_t* plain, std::size_t n);
// open verifies and decrypts n bytes of ciphertext followed by the tag.
bool open(uint8_t* plain, const uint8_t key[32], uint64_t counter, const uint8_t* ad, std::size_t adLen,
          const uint8_t* cipher, std::size_t n);

}  // namespace gomp::crypto
