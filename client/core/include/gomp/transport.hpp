// GoMP reliable UDP transport, client side. A single-threaded port of
// wire/transport (endpoint.go, conn.go, client.go): call Client::update()
// every frame, read delivered messages, queue messages, call flush().
#pragma once

#include <array>
#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace gomp {

using Clock = std::chrono::steady_clock;
using TimePoint = Clock::time_point;
using Duration = Clock::duration;

enum class Channel : uint8_t { Unreliable = 0, Reliable = 1 };

struct Message {
    Channel channel = Channel::Reliable;
    std::vector<uint8_t> data;
};

struct TransportStats {
    double rttMs = 0;
    double packetLoss = 0;
    uint64_t bytesSent = 0, bytesRecv = 0, packetsSent = 0, packetsRecv = 0, resends = 0;
    std::size_t relBacklog = 0;
};

constexpr std::size_t kMaxPacketSize = 1200;
constexpr std::size_t kMaxBodySize = kMaxPacketSize - 1 - 4 - 8 - 16;
constexpr std::size_t kInnerHeaderSize = 8;
constexpr std::size_t kMaxFragmentPayload = 1100;
constexpr std::size_t kDefaultMaxMessageSize = 1 << 20;
constexpr uint32_t kMagic = 0x504D4F47;
constexpr uint16_t kProtocolVersion = 1;

// Endpoint is the I/O-free reliability state machine (see endpoint.go).
class Endpoint {
public:
    explicit Endpoint(TimePoint now);

    // Queues data; false when the reliable backlog overflowed or the message is too large.
    bool queue(Channel ch, const uint8_t* data, std::size_t n);
    // Processes an inner packet body; false on a protocol error.
    bool receive(const uint8_t* body, std::size_t n, TimePoint now);
    // Builds packet bodies for everything due and passes each to emit.
    void build(TimePoint now, bool keepalive, int maxPackets, const std::function<void(const uint8_t*, std::size_t)>& emit);
    bool needsEarlyAck() const { return recvSince_ >= 16; }
    void drain(std::vector<Message>& out);
    TransportStats stats(TimePoint now) const;

    TimePoint lastSend() const { return lastSend_; }
    TimePoint lastRecv() const { return lastRecv_; }
    void setLastRecv(TimePoint t) { lastRecv_ = t; }

private:
    static constexpr uint16_t kWindow = 1024;
    struct SentPacket {
        uint16_t seq = 0;
        bool valid = false, acked = false;
        TimePoint sentAt;
        std::vector<uint16_t> relSeqs;
    };
    struct RelOut {
        std::vector<uint8_t> data;
        bool more = false, present = false, acked = false;
        TimePoint lastSent{};
        bool everSent = false;
    };
    struct RelIn {
        std::vector<uint8_t> data;
        bool more = false, present = false;
    };
    struct RecvSeq {
        uint16_t seq = 0;
        bool valid = false;
    };

    void pushReliable(RelOut&& m);
    void fillWindow();
    void processAcks(uint16_t ack, uint32_t bits, TimePoint now);
    void ackPacket(uint16_t seq, TimePoint now);
    void sampleRTT(Duration s);
    void receiveReliable(uint16_t seq, const uint8_t* data, std::size_t n, bool more);

    uint16_t seq_ = 0;
    std::array<SentPacket, kWindow> sent_;
    uint16_t relNext_ = 0, relOldest_ = 0;
    std::array<RelOut, kWindow> relBuf_;
    std::deque<RelOut> relQueue_;
    std::size_t relBytes_ = 0;
    std::vector<uint8_t> unrelBuf_;
    std::vector<std::pair<uint32_t, uint32_t>> unrelMsgs_;

    bool haveRemote_ = false;
    uint16_t remoteSeq_ = 0xFFFF;
    uint32_t recvBits_ = 0;
    std::array<RecvSeq, kWindow> recvHist_;
    int recvSince_ = 0;
    bool ackPending_ = false;
    uint16_t relRecvNext_ = 0;
    std::array<RelIn, kWindow> relRecv_;
    std::vector<uint8_t> fragAcc_;
    std::vector<Message> inbox_;

    Duration srtt_, rttvar_, rto_;
    TimePoint lastSend_{}, lastRecv_;
    TransportStats stats_;
    std::size_t maxMsgSize_ = kDefaultMaxMessageSize;
    std::vector<uint8_t> scratch_;
};

// Platform UDP socket (non-blocking).
class UdpSocket {
public:
    UdpSocket();
    ~UdpSocket();
    UdpSocket(const UdpSocket&) = delete;
    UdpSocket& operator=(const UdpSocket&) = delete;

    // Resolves host:port and opens a socket of the right family.
    bool open(const std::string& host, uint16_t port, std::string& err);
    bool send(const uint8_t* data, std::size_t n);
    // Returns bytes received from the server address, 0 when nothing is pending, -1 on error.
    int recv(uint8_t* buf, std::size_t cap);
    void close();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// Client is a connection to a GoMP server.
class Client {
public:
    enum class State { Idle, Connecting, Connected, Rejected, Disconnected };

    Client();
    ~Client();

    // Starts connecting; progress happens in update().
    bool connect(const std::string& host, uint16_t port, std::vector<uint8_t> payload, std::string& err);
    // Receives datagrams (at most kMaxDatagramsPerUpdate), advances the handshake, detects timeouts.
    static constexpr int kMaxDatagramsPerUpdate = 512;
    void update(TimePoint now);
    // Queues a message (copied).
    bool send(Channel ch, const std::vector<uint8_t>& data) { return send(ch, data.data(), data.size()); }
    bool send(Channel ch, const uint8_t* data, std::size_t n);
    // Transmits everything due.
    void flush(TimePoint now);
    // Moves delivered messages into out.
    void drain(std::vector<Message>& out);
    void disconnect(const std::string& reason);

    State state() const { return state_; }
    const std::string& reason() const { return reason_; }
    TransportStats stats(TimePoint now) const;

    Duration connectTimeout = std::chrono::seconds(10);
    Duration timeout = std::chrono::seconds(10);

private:
    void sendHello();
    void sendConnect();
    void handlePacket(const uint8_t* p, std::size_t n, TimePoint now);
    void writeFramed(uint8_t kind, const uint8_t* body, std::size_t n);
    bool openFramed(const uint8_t* p, std::size_t n, std::vector<uint8_t>& body);
    void restartHandshake();

    UdpSocket sock_;
    State state_ = State::Idle;
    std::string reason_;
    std::vector<uint8_t> payload_;
    uint64_t nonce_ = 0;
    uint32_t session_ = 0;
    std::unique_ptr<Endpoint> ep_;
    TimePoint started_, lastHandshakeSend_, connectSentAt_;
    std::vector<uint8_t> connectPkt_;

    bool encrypted_ = false;
    std::array<uint8_t, 32> sendKey_{}, recvKey_{};
    uint64_t sendCtr_ = 0, recvCtr_ = 0;
    std::vector<uint8_t> out_, body_;
};

// Fills buf with cryptographically secure random bytes.
void randomBytes(uint8_t* buf, std::size_t n);

}  // namespace gomp
