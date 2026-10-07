#include "gomp/crypto.hpp"

#include <cstring>

extern "C" {
#include "monocypher.h"
}

namespace gomp::crypto {
namespace {
void nonceFor(uint8_t nonce[12], uint64_t counter) {
    std::memset(nonce, 0, 12);
    for (int i = 0; i < 8; ++i) nonce[4 + i] = static_cast<uint8_t>(counter >> (8 * i));
}
}  // namespace

void deriveKey(uint8_t out[32], const uint8_t shared[32], const char* label, uint64_t nonce,
               const uint8_t serverPub[32], const uint8_t clientPub[32]) {
    crypto_blake2b_ctx ctx;
    crypto_blake2b_keyed_init(&ctx, 32, shared, 32);
    crypto_blake2b_update(&ctx, reinterpret_cast<const uint8_t*>(label), std::strlen(label));
    uint8_t nb[8];
    for (int i = 0; i < 8; ++i) nb[i] = static_cast<uint8_t>(nonce >> (8 * i));
    crypto_blake2b_update(&ctx, nb, 8);
    crypto_blake2b_update(&ctx, serverPub, 32);
    crypto_blake2b_update(&ctx, clientPub, 32);
    crypto_blake2b_final(&ctx, out);
}

void publicKey(uint8_t pub[32], const uint8_t secret[32]) { crypto_x25519_public_key(pub, secret); }

void sharedSecret(uint8_t shared[32], const uint8_t secret[32], const uint8_t peerPub[32]) {
    crypto_x25519(shared, secret, peerPub);
}

void seal(uint8_t* out, const uint8_t key[32], uint64_t counter, const uint8_t* ad, std::size_t adLen,
          const uint8_t* plain, std::size_t n) {
    uint8_t nonce[12];
    nonceFor(nonce, counter);
    crypto_aead_ctx ctx;
    crypto_aead_init_ietf(&ctx, key, nonce);
    crypto_aead_write(&ctx, out, out + n, ad, adLen, plain, n);
    crypto_wipe(&ctx, sizeof(ctx));
}

bool open(uint8_t* plain, const uint8_t key[32], uint64_t counter, const uint8_t* ad, std::size_t adLen,
          const uint8_t* cipher, std::size_t n) {
    uint8_t nonce[12];
    nonceFor(nonce, counter);
    crypto_aead_ctx ctx;
    crypto_aead_init_ietf(&ctx, key, nonce);
    int bad = crypto_aead_read(&ctx, plain, cipher + n, ad, adLen, cipher, n);
    crypto_wipe(&ctx, sizeof(ctx));
    return bad == 0;
}

}  // namespace gomp::crypto
