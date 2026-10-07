// Client side of the GoMP transport: handshake, encryption and framing.
// Mirrors wire/transport/{packet,conn,client}.go.
#include <cmath>
#include <cstring>

#include "gomp/crypto.hpp"
#include "gomp/transport.hpp"

extern "C" {
#include "monocypher.h"
}

namespace gomp {
namespace {

constexpr uint8_t kHello = 1, kChallenge = 2, kConnect = 3, kAccept = 4, kReject = 5, kData = 6, kDisconnect = 7;
constexpr std::size_t kHelloSize = 96;
constexpr std::size_t kCookieSize = 20;
constexpr std::size_t kKeySize = 32;
constexpr std::size_t kTag = 16;
constexpr uint8_t kFlagEncrypt = 1;
constexpr auto kHandshakeResend = std::chrono::milliseconds(250);
constexpr auto kRestartHandshake = std::chrono::seconds(3);
constexpr auto kKeepalive = std::chrono::milliseconds(250);
constexpr int kMaxPacketsPerFlush = 256;

inline void put64(uint8_t* p, uint64_t v) {
    for (int i = 0; i < 8; ++i) p[i] = static_cast<uint8_t>(v >> (8 * i));
}
inline uint64_t le64(const uint8_t* p) {
    uint64_t v = 0;
    for (int i = 0; i < 8; ++i) v |= static_cast<uint64_t>(p[i]) << (8 * i);
    return v;
}
inline uint32_t le32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}
inline void append32(std::vector<uint8_t>& b, uint32_t v) {
    for (int i = 0; i < 4; ++i) b.push_back(static_cast<uint8_t>(v >> (8 * i)));
}
inline void append16(std::vector<uint8_t>& b, uint16_t v) {
    b.push_back(static_cast<uint8_t>(v));
    b.push_back(static_cast<uint8_t>(v >> 8));
}
inline void append64(std::vector<uint8_t>& b, uint64_t v) {
    for (int i = 0; i < 8; ++i) b.push_back(static_cast<uint8_t>(v >> (8 * i)));
}

}  // namespace

Client::Client() = default;
Client::~Client() { sock_.close(); }

bool Client::connect(const std::string& host, uint16_t port, std::vector<uint8_t> payload, std::string& err) {
    if (payload.size() > 900) {
        err = "connect payload too large";
        return false;
    }
    if (!sock_.open(host, port, err)) return false;
    payload_ = std::move(payload);
    randomBytes(reinterpret_cast<uint8_t*>(&nonce_), sizeof(nonce_));
    started_ = Clock::now();
    state_ = State::Connecting;
    connectPkt_.clear();
    sendHello();
    return true;
}

void Client::sendHello() {
    uint8_t hello[kHelloSize] = {};
    hello[0] = kHello;
    std::memcpy(hello + 1, &kMagic, 4);  // little-endian hosts only
    hello[5] = static_cast<uint8_t>(kProtocolVersion);
    hello[6] = static_cast<uint8_t>(kProtocolVersion >> 8);
    put64(hello + 7, nonce_);
    sock_.send(hello, sizeof(hello));
    lastHandshakeSend_ = Clock::now();
}

void Client::sendConnect() {
    sock_.send(connectPkt_.data(), connectPkt_.size());
    lastHandshakeSend_ = Clock::now();
}

void Client::restartHandshake() {
    connectPkt_.clear();
    encrypted_ = false;
    randomBytes(reinterpret_cast<uint8_t*>(&nonce_), sizeof(nonce_));
    sendHello();
}

void Client::update(TimePoint now) {
    if (state_ != State::Connecting && state_ != State::Connected) return;
    uint8_t buf[2048];
    for (int i = 0; i < 4096; ++i) {
        int n = sock_.recv(buf, sizeof(buf));
        if (n <= 0) break;
        handlePacket(buf, static_cast<std::size_t>(n), now);
        if (state_ != State::Connecting && state_ != State::Connected) return;
    }
    if (state_ == State::Connecting) {
        if (now - started_ > connectTimeout) {
            state_ = State::Disconnected;
            reason_ = "connect timeout";
            return;
        }
        if (!connectPkt_.empty() && now - connectSentAt_ > kRestartHandshake) {
            restartHandshake();  // stale cookie: start over with a fresh challenge
        } else if (now - lastHandshakeSend_ >= kHandshakeResend) {
            if (connectPkt_.empty()) sendHello();
            else sendConnect();
        }
        return;
    }
    if (now - ep_->lastRecv() > timeout) {
        disconnect("timeout");
        reason_ = "timeout";
    }
}

void Client::handlePacket(const uint8_t* p, std::size_t n, TimePoint now) {
    if (n == 0) return;
    switch (p[0]) {
        case kChallenge: {
            // nonce(8) cookie(20) flags(1) [serverPub(32)]
            if (state_ != State::Connecting || !connectPkt_.empty() || n < 1 + 8 + kCookieSize + 1) return;
            if (le64(p + 1) != nonce_) return;
            const uint8_t* cookie = p + 9;
            uint8_t flags = p[9 + kCookieSize];
            std::vector<uint8_t>& c = connectPkt_;
            c.push_back(kConnect);
            append32(c, kMagic);
            append16(c, kProtocolVersion);
            append64(c, nonce_);
            c.insert(c.end(), cookie, cookie + kCookieSize);
            if (flags & kFlagEncrypt) {
                if (n < 1 + 8 + kCookieSize + 1 + kKeySize) {
                    connectPkt_.clear();
                    return;
                }
                const uint8_t* serverPub = p + 10 + kCookieSize;
                uint8_t secret[32], clientPub[32], shared[32];
                randomBytes(secret, 32);
                crypto::publicKey(clientPub, secret);
                crypto::sharedSecret(shared, secret, serverPub);
                crypto::deriveKey(sendKey_.data(), shared, "gomp-c2s", nonce_, serverPub, clientPub);
                crypto::deriveKey(recvKey_.data(), shared, "gomp-s2c", nonce_, serverPub, clientPub);
                crypto_wipe(secret, 32);
                crypto_wipe(shared, 32);
                encrypted_ = true;
                c.insert(c.end(), clientPub, clientPub + 32);
            }
            append16(c, static_cast<uint16_t>(payload_.size()));
            c.insert(c.end(), payload_.begin(), payload_.end());
            connectSentAt_ = now;
            sendConnect();
            return;
        }
        case kAccept: {
            if (state_ != State::Connecting || connectPkt_.empty() || n < 13 || le64(p + 1) != nonce_) return;
            session_ = le32(p + 9);
            ep_ = std::make_unique<Endpoint>(now);
            state_ = State::Connected;
            return;
        }
        case kReject: {
            if (state_ != State::Connecting || n < 10 || le64(p + 1) != nonce_) return;
            std::size_t l = std::min<std::size_t>(p[9], n - 10);
            reason_.assign(reinterpret_cast<const char*>(p + 10), l);
            state_ = State::Rejected;
            return;
        }
        case kData:
        case kDisconnect: {
            if (state_ != State::Connected) return;
            if (!openFramed(p, n, body_)) return;
            if (p[0] == kDisconnect) {
                reason_.assign(body_.begin(), body_.end());
                state_ = State::Disconnected;
                return;
            }
            if (!ep_->receive(body_.data(), body_.size(), now)) {
                disconnect("protocol error");
                return;
            }
            if (ep_->needsEarlyAck())
                ep_->build(now, false, kMaxPacketsPerFlush,
                           [this](const uint8_t* b, std::size_t len) { writeFramed(kData, b, len); });
            return;
        }
        default:
            return;
    }
}

void Client::writeFramed(uint8_t kind, const uint8_t* body, std::size_t n) {
    out_.clear();
    out_.push_back(kind);
    append32(out_, session_);
    if (encrypted_) {
        ++sendCtr_;
        append64(out_, sendCtr_);
        std::size_t hdr = out_.size();
        out_.resize(hdr + n + kTag);
        crypto::seal(out_.data() + hdr, sendKey_.data(), sendCtr_, out_.data(), hdr, body, n);
    } else {
        out_.insert(out_.end(), body, body + n);
    }
    sock_.send(out_.data(), out_.size());
}

bool Client::openFramed(const uint8_t* p, std::size_t n, std::vector<uint8_t>& body) {
    if (n < 5 || le32(p + 1) != session_) return false;
    if (!encrypted_) {
        body.assign(p + 5, p + n);
        return true;
    }
    if (n < 5 + 8 + kTag) return false;
    uint64_t ctr = le64(p + 5);
    if (recvCtr_ > 1024 && ctr < recvCtr_ - 1024) return false;
    std::size_t clen = n - 13 - kTag;
    body.resize(clen);
    if (!crypto::open(body.data(), recvKey_.data(), ctr, p, 13, p + 13, clen)) return false;
    if (ctr > recvCtr_) recvCtr_ = ctr;
    return true;
}

bool Client::send(Channel ch, const uint8_t* data, std::size_t n) {
    if (state_ != State::Connected) return false;
    if (!ep_->queue(ch, data, n)) {
        disconnect("send backlog overflow");
        return false;
    }
    return true;
}

void Client::flush(TimePoint now) {
    if (state_ != State::Connected) return;
    bool keepalive = now - ep_->lastSend() >= kKeepalive;
    ep_->build(now, keepalive, kMaxPacketsPerFlush,
               [this](const uint8_t* b, std::size_t len) { writeFramed(kData, b, len); });
}

void Client::drain(std::vector<Message>& out) {
    if (ep_) ep_->drain(out);
}

void Client::disconnect(const std::string& reason) {
    if (state_ == State::Connected) {
        auto r = reason.substr(0, 200);
        for (int i = 0; i < 3; ++i) writeFramed(kDisconnect, reinterpret_cast<const uint8_t*>(r.data()), r.size());
    }
    if (state_ == State::Connected || state_ == State::Connecting) {
        state_ = State::Disconnected;
        reason_ = reason;
    }
}

TransportStats Client::stats(TimePoint now) const { return ep_ ? ep_->stats(now) : TransportStats{}; }

}  // namespace gomp
