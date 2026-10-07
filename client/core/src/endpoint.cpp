// Port of wire/transport/endpoint.go. Keep both files in sync.
#include <algorithm>
#include <cstring>

#include "gomp/transport.hpp"

namespace gomp {
namespace {

constexpr int kMaxAckBits = 32;
constexpr uint8_t kChunkUnrel = 0, kChunkRel = 1, kChunkMore = 0x80;
constexpr std::size_t kMaxUnrelQ = 8192;
constexpr std::size_t kMaxRelBacklog = 64u << 20;
constexpr auto kMinRTO = std::chrono::milliseconds(40);
constexpr auto kMaxRTO = std::chrono::seconds(1);
constexpr auto kInitialRTT = std::chrono::milliseconds(100);

inline bool seqGreater(uint16_t a, uint16_t b) { return static_cast<int16_t>(static_cast<uint16_t>(a - b)) > 0; }

inline uint16_t le16(const uint8_t* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }
inline uint32_t le32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}
inline void put16(uint8_t* p, uint16_t v) { p[0] = static_cast<uint8_t>(v); p[1] = static_cast<uint8_t>(v >> 8); }
inline void put32(uint8_t* p, uint32_t v) {
    for (int i = 0; i < 4; ++i) p[i] = static_cast<uint8_t>(v >> (8 * i));
}
inline void appendUvarint(std::vector<uint8_t>& b, uint64_t v) {
    while (v >= 0x80) {
        b.push_back(static_cast<uint8_t>(v) | 0x80);
        v >>= 7;
    }
    b.push_back(static_cast<uint8_t>(v));
}
inline std::size_t uvarintLen(std::size_t n) {
    std::size_t l = 1;
    while (n >= 0x80) {
        n >>= 7;
        ++l;
    }
    return l;
}
// Returns bytes consumed (0 on error).
inline std::size_t readUvarint(const uint8_t* p, std::size_t n, uint64_t& v) {
    v = 0;
    for (std::size_t i = 0; i < n && i < 10; ++i) {
        v |= static_cast<uint64_t>(p[i] & 0x7f) << (7 * i);
        if (!(p[i] & 0x80)) return i + 1;
    }
    return 0;
}

}  // namespace

Endpoint::Endpoint(TimePoint now)
    : srtt_(kInitialRTT), rttvar_(kInitialRTT / 2), rto_(3 * kInitialRTT), lastRecv_(now) {
    scratch_.reserve(kMaxPacketSize);
}

bool Endpoint::queue(Channel ch, const uint8_t* data, std::size_t n) {
    if (ch == Channel::Unreliable) {
        if (n > kMaxFragmentPayload) return queue(Channel::Reliable, data, n);
        if (unrelMsgs_.size() >= kMaxUnrelQ) return true;  // drop state updates nobody drains
        auto start = static_cast<uint32_t>(unrelBuf_.size());
        unrelBuf_.insert(unrelBuf_.end(), data, data + n);
        unrelMsgs_.emplace_back(start, static_cast<uint32_t>(unrelBuf_.size()));
        return true;
    }
    if (n > maxMsgSize_ || relBytes_ + n > kMaxRelBacklog) return false;
    relBytes_ += n;
    do {
        std::size_t k = std::min(n, kMaxFragmentPayload);
        RelOut m;
        m.data.assign(data, data + k);
        m.more = k < n;
        m.present = true;
        pushReliable(std::move(m));
        data += k;
        n -= k;
    } while (n > 0);
    return true;
}

void Endpoint::pushReliable(RelOut&& m) {
    if (relQueue_.empty() && static_cast<uint16_t>(relNext_ - relOldest_) < kWindow) {
        relBuf_[relNext_ % kWindow] = std::move(m);
        ++relNext_;
        return;
    }
    relQueue_.push_back(std::move(m));
}

void Endpoint::fillWindow() {
    while (!relQueue_.empty() && static_cast<uint16_t>(relNext_ - relOldest_) < kWindow) {
        relBuf_[relNext_ % kWindow] = std::move(relQueue_.front());
        relQueue_.pop_front();
        ++relNext_;
    }
}

bool Endpoint::receive(const uint8_t* body, std::size_t n, TimePoint now) {
    if (n < kInnerHeaderSize) return false;
    uint16_t seq = le16(body);
    uint16_t ack = le16(body + 2);
    uint32_t ackBits = le32(body + 4);

    if (haveRemote_ && seqGreater(remoteSeq_, seq) && static_cast<uint16_t>(remoteSeq_ - seq) >= kWindow / 2) return true;
    RecvSeq& h = recvHist_[seq % kWindow];
    if (h.valid && h.seq == seq) return true;  // duplicate
    h.seq = seq;
    h.valid = true;

    if (!haveRemote_) {
        haveRemote_ = true;
        remoteSeq_ = seq;
        recvBits_ = 0;
    } else if (seqGreater(seq, remoteSeq_)) {
        uint16_t shift = static_cast<uint16_t>(seq - remoteSeq_);
        if (shift > kMaxAckBits) recvBits_ = 0;
        else if (shift == kMaxAckBits) recvBits_ = 1u << 31;  // shifting a uint32 by 32 is undefined in C++
        else recvBits_ = (recvBits_ << shift) | (1u << (shift - 1));
        remoteSeq_ = seq;
    } else {
        uint16_t diff = static_cast<uint16_t>(remoteSeq_ - seq);
        if (diff <= kMaxAckBits) recvBits_ |= 1u << (diff - 1);
    }
    ackPending_ = true;
    ++recvSince_;
    lastRecv_ = now;
    stats_.packetsRecv++;
    stats_.bytesRecv += n;

    processAcks(ack, ackBits, now);

    const uint8_t* p = body + kInnerHeaderSize;
    std::size_t left = n - kInnerHeaderSize;
    while (left > 0) {
        uint8_t hdr = *p++;
        --left;
        uint8_t kind = hdr & static_cast<uint8_t>(~kChunkMore);
        uint16_t relSeq = 0;
        if (kind == kChunkRel) {
            if (left < 2) return false;
            relSeq = le16(p);
            p += 2;
            left -= 2;
        } else if (kind != kChunkUnrel) {
            return false;
        }
        uint64_t len = 0;
        std::size_t k = readUvarint(p, left, len);
        if (k == 0 || len > left - k || len > kMaxFragmentPayload) return false;
        const uint8_t* data = p + k;
        p += k + len;
        left -= k + len;
        if (kind == kChunkUnrel) {
            if (hdr & kChunkMore) return false;
            inbox_.push_back(Message{Channel::Unreliable, std::vector<uint8_t>(data, data + len)});
            continue;
        }
        receiveReliable(relSeq, data, static_cast<std::size_t>(len), (hdr & kChunkMore) != 0);
        if (fragAcc_.size() > maxMsgSize_) return false;
    }
    return true;
}

void Endpoint::receiveReliable(uint16_t seq, const uint8_t* data, std::size_t n, bool more) {
    if (seqGreater(relRecvNext_, seq)) return;
    if (static_cast<uint16_t>(seq - relRecvNext_) >= kWindow) return;
    RelIn& slot = relRecv_[seq % kWindow];
    if (slot.present) return;
    slot.data.assign(data, data + n);
    slot.more = more;
    slot.present = true;
    for (;;) {
        RelIn& s = relRecv_[relRecvNext_ % kWindow];
        if (!s.present) return;
        if (s.more) {
            fragAcc_.insert(fragAcc_.end(), s.data.begin(), s.data.end());
        } else if (!fragAcc_.empty()) {
            fragAcc_.insert(fragAcc_.end(), s.data.begin(), s.data.end());
            inbox_.push_back(Message{Channel::Reliable, std::move(fragAcc_)});
            fragAcc_.clear();
        } else {
            inbox_.push_back(Message{Channel::Reliable, std::move(s.data)});
        }
        s = RelIn{};
        ++relRecvNext_;
    }
}

void Endpoint::processAcks(uint16_t ack, uint32_t bits, TimePoint now) {
    ackPacket(ack, now);
    for (uint16_t i = 0; i < kMaxAckBits; ++i)
        if (bits & (1u << i)) ackPacket(static_cast<uint16_t>(ack - 1 - i), now);
    while (relOldest_ != relNext_) {
        RelOut& m = relBuf_[relOldest_ % kWindow];
        if (!m.acked) break;
        relBytes_ -= m.data.size();
        m = RelOut{};
        ++relOldest_;
    }
    fillWindow();
}

void Endpoint::ackPacket(uint16_t seq, TimePoint now) {
    SentPacket& sp = sent_[seq % kWindow];
    if (!sp.valid || sp.seq != seq || sp.acked) return;
    sp.acked = true;
    sampleRTT(now - sp.sentAt);
    for (uint16_t rs : sp.relSeqs) {
        if (static_cast<uint16_t>(rs - relOldest_) >= static_cast<uint16_t>(relNext_ - relOldest_)) continue;
        RelOut& m = relBuf_[rs % kWindow];
        if (m.present) m.acked = true;
    }
}

void Endpoint::sampleRTT(Duration s) {
    if (s < Duration::zero()) return;
    Duration diff = srtt_ > s ? srtt_ - s : s - srtt_;
    rttvar_ = (3 * rttvar_ + diff) / 4;
    srtt_ = (7 * srtt_ + s) / 8;
    rto_ = std::clamp<Duration>(srtt_ + 4 * rttvar_, kMinRTO, kMaxRTO);
}

void Endpoint::build(TimePoint now, bool keepalive, int maxPackets,
                     const std::function<void(const uint8_t*, std::size_t)>& emit) {
    bool sentAny = false;
    uint16_t relCursor = relOldest_;
    std::size_t unrelIdx = 0;
    for (int pk = 0; pk < maxPackets; ++pk) {
        auto& body = scratch_;
        body.assign(kInnerHeaderSize, 0);
        std::vector<uint16_t> relSeqs;
        while (relCursor != relNext_) {
            RelOut& m = relBuf_[relCursor % kWindow];
            if (!m.present || m.acked || (m.everSent && now - m.lastSent < rto_)) {
                ++relCursor;
                continue;
            }
            std::size_t need = 1 + 2 + uvarintLen(m.data.size()) + m.data.size();
            if (body.size() + need > kMaxBodySize) break;
            body.push_back(m.more ? (kChunkRel | kChunkMore) : kChunkRel);
            body.push_back(static_cast<uint8_t>(relCursor));
            body.push_back(static_cast<uint8_t>(relCursor >> 8));
            appendUvarint(body, m.data.size());
            body.insert(body.end(), m.data.begin(), m.data.end());
            if (m.everSent) stats_.resends++;
            m.lastSent = now;
            m.everSent = true;
            relSeqs.push_back(relCursor);
            ++relCursor;
        }
        while (unrelIdx < unrelMsgs_.size()) {
            auto [start, end] = unrelMsgs_[unrelIdx];
            std::size_t len = end - start;
            std::size_t need = 1 + uvarintLen(len) + len;
            if (body.size() + need > kMaxBodySize) break;
            body.push_back(kChunkUnrel);
            appendUvarint(body, len);
            body.insert(body.end(), unrelBuf_.begin() + start, unrelBuf_.begin() + end);
            ++unrelIdx;
        }
        bool hasChunks = body.size() > kInnerHeaderSize;
        if (!hasChunks && (sentAny || !(ackPending_ || keepalive))) break;

        uint16_t seq = seq_++;
        put16(body.data(), seq);
        put16(body.data() + 2, remoteSeq_);
        put32(body.data() + 4, recvBits_);
        SentPacket& sp = sent_[seq % kWindow];
        sp.seq = seq;
        sp.valid = true;
        sp.acked = false;
        sp.sentAt = now;
        sp.relSeqs = std::move(relSeqs);
        ackPending_ = false;
        recvSince_ = 0;
        lastSend_ = now;
        stats_.packetsSent++;
        stats_.bytesSent += body.size();
        emit(body.data(), body.size());
        sentAny = true;
        if (relCursor == relNext_ && unrelIdx >= unrelMsgs_.size()) break;
    }
    if (unrelIdx >= unrelMsgs_.size()) {
        unrelBuf_.clear();
        unrelMsgs_.clear();
    } else if (unrelIdx > 0) {
        uint32_t base = unrelMsgs_[unrelIdx].first;
        unrelBuf_.erase(unrelBuf_.begin(), unrelBuf_.begin() + base);
        unrelMsgs_.erase(unrelMsgs_.begin(), unrelMsgs_.begin() + static_cast<std::ptrdiff_t>(unrelIdx));
        for (auto& m : unrelMsgs_) {
            m.first -= base;
            m.second -= base;
        }
    }
}

void Endpoint::drain(std::vector<Message>& out) {
    for (auto& m : inbox_) out.push_back(std::move(m));
    inbox_.clear();
}

TransportStats Endpoint::stats(TimePoint now) const {
    TransportStats s = stats_;
    s.rttMs = std::chrono::duration<double, std::milli>(srtt_).count();
    s.relBacklog = static_cast<uint16_t>(relNext_ - relOldest_) + relQueue_.size();
    TimePoint cutoff = now - 2 * srtt_ - std::chrono::milliseconds(50);
    TimePoint horizon = now - std::chrono::seconds(5);
    int total = 0, lost = 0;
    for (const auto& sp : sent_) {
        if (!sp.valid || sp.sentAt > cutoff || sp.sentAt < horizon) continue;
        ++total;
        if (!sp.acked) ++lost;
    }
    if (total > 0) s.packetLoss = static_cast<double>(lost) / total;
    return s;
}

}  // namespace gomp
