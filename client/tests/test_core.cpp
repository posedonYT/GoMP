// Unit and cross-language tests for the C++ client core.
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include <filesystem>
#include <fstream>
#include <map>
#include <random>
#include <sstream>

#include "gomp/crypto.hpp"
#include "gomp/messages.hpp"
#include "gomp/transport.hpp"

#ifndef GOMP_REPO_ROOT
#define GOMP_REPO_ROOT "../.."
#endif

namespace fs = std::filesystem;
using namespace gomp;

static std::vector<uint8_t> readFile(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    return {std::istreambuf_iterator<char>(f), {}};
}

static fs::path goldenDir() { return fs::path(GOMP_REPO_ROOT) / "wire" / "proto" / "testdata" / "golden"; }

TEST_CASE("joaat matches GTA hashes") {
    CHECK(joaat("adder") == 0xB779A091u);
    CHECK(joaat("WEAPON_PISTOL") == 0x1B06D571u);
    CHECK(joaat("mp_m_freemode_01") == 0x705E61F2u);
}

TEST_CASE("varints and values round trip") {
    Writer w;
    w.varint(-1);
    w.varint(INT64_MIN);
    w.uvarint(UINT64_MAX);
    Value m;
    m.kind = Value::Kind::Map;
    m.map.emplace_back("pos", Value::vec3({1, 2, 3}));
    m.map.emplace_back("who", Value::entity({EntityType::Player, 7}));
    m.map.emplace_back("list", Value::array({Value::integer(1), Value::string("x"), Value::nil(), Value::number(2.5)}));
    writeValue(w, m);
    Reader r(w.bytes());
    CHECK(r.varint() == -1);
    CHECK(r.varint() == INT64_MIN);
    CHECK(r.uvarint() == UINT64_MAX);
    Value back = readValue(r);
    REQUIRE(r.ok());
    CHECK(r.remaining() == 0);
    REQUIRE(back.kind == Value::Kind::Map);
    CHECK(back.get("pos")->v == Vec3{1, 2, 3});
    CHECK(back.get("who")->e == EntityRef{EntityType::Player, 7});
    CHECK(back.get("list")->arr[1].s == "x");
    CHECK(back.get("list")->arr[3].f == 2.5);
}

TEST_CASE("malformed input is rejected") {
    const uint8_t deepArrays[] = {6, 1, 6, 1, 6, 1};
    Reader r1(deepArrays, sizeof(deepArrays));
    readValue(r1);
    CHECK_FALSE(r1.ok());  // truncated
    const uint8_t hugeArray[] = {6, 0xff, 0xff, 0xff, 0xff, 0x0f};
    Reader r2(hugeArray, sizeof(hugeArray));
    readValue(r2);
    CHECK_FALSE(r2.ok());
    const uint8_t badTag[] = {42};
    Reader r3(badTag, 1);
    readValue(r3);
    CHECK_FALSE(r3.ok());
    std::vector<uint8_t> out;
    const uint8_t unknown[] = {0x01};
    CHECK_FALSE(reencode(unknown, 1, out));
}

TEST_CASE("every Go golden fixture decodes and re-encodes byte-identically") {
    REQUIRE(fs::exists(goldenDir()));
    int count = 0;
    for (const auto& e : fs::directory_iterator(goldenDir())) {
        if (e.path().extension() != ".bin") continue;
        auto bytes = readFile(e.path());
        std::vector<uint8_t> out;
        INFO("fixture: " << e.path().filename().string());
        REQUIRE(reencode(bytes.data(), bytes.size(), out));
        CHECK(out == bytes);
        // Truncations must fail cleanly.
        for (std::size_t n = 1; n < bytes.size(); ++n) {
            std::vector<uint8_t> tmp;
            CHECK_FALSE(reencode(bytes.data(), n, tmp));
        }
        ++count;
    }
    CHECK(count >= 40);
}

TEST_CASE("golden fixtures carry the expected field values") {
    auto ped = readFile(goldenDir() / "ped_sync.bin");
    PedSync ps;
    REQUIRE(unmarshal(ped.data(), ped.size(), ps));
    CHECK(ps.time == 123456u);
    CHECK(ps.pos == Vec3{-1037.5f, -2737.25f, 20.125f});
    CHECK(ps.weapon == joaat("weapon_pistol"));
    CHECK(ps.move == MoveState::Run);
    CHECK((ps.flags & ped::Aiming) != 0);
    CHECK(ps.aimPos == Vec3{-1030, -2730, 21});
    CHECK(ps.heading == doctest::Approx(271.5).epsilon(0.001));

    auto ec = readFile(goldenDir() / "entity_create.bin");
    EntityCreate c;
    REQUIRE(unmarshal(ec.data(), ec.size(), c));
    CHECK(c.type == EntityType::Vehicle);
    CHECK(c.id == 17);
    CHECK(c.model == joaat("adder"));
    CHECK(c.props.at(prop::NumberPlate).s == "GOMP");
    CHECK(c.props.at(prop::Engine).b);
    CHECK(c.props.at(prop::Colors).arr[1].i == 12);

    auto vs = readFile(goldenDir() / "vehicle_sync.bin");
    VehicleSync v;
    REQUIRE(unmarshal(vs.data(), vs.size(), v));
    CHECK(v.vehicleId == 42);
    CHECK(v.engineHealth == -120);
    CHECK((v.flags & veh::DriverAiming) != 0);
    Vec3 e = eulerFromQuat(v.rot);
    CHECK(e.z == doctest::Approx(120).epsilon(0.01));
}

TEST_CASE("quaternion packing precision") {
    std::mt19937 rng(7);
    std::normal_distribution<float> nd;
    double worst = 0;
    for (int i = 0; i < 20000; ++i) {
        Quat q = normalize({nd(rng), nd(rng), nd(rng), nd(rng)});
        Quat u = unpackQuat(packQuat(q));
        double d = std::fabs(static_cast<double>(q.x) * u.x + static_cast<double>(q.y) * u.y +
                             static_cast<double>(q.z) * u.z + static_cast<double>(q.w) * u.w);
        worst = std::max(worst, 2 * std::acos(std::min(1.0, d)) * 180 / kPi);
    }
    CHECK(worst < 0.35);
}

TEST_CASE("crypto interoperates with the Go transport") {
    std::ifstream f(fs::path(GOMP_REPO_ROOT) / "wire" / "transport" / "testdata" / "crypto_vector.txt");
    REQUIRE(f.good());
    std::map<std::string, std::string> kv;
    std::string line;
    while (std::getline(f, line)) {
        auto eq = line.find('=');
        if (eq != std::string::npos) kv[line.substr(0, eq)] = line.substr(eq + 1);
    }
    auto hex = [](const std::string& s) {
        std::vector<uint8_t> out;
        for (std::size_t i = 0; i + 1 < s.size(); i += 2) out.push_back(static_cast<uint8_t>(std::stoi(s.substr(i, 2), nullptr, 16)));
        return out;
    };
    auto clientPriv = hex(kv["client_priv"]);
    auto serverPub = hex(kv["server_pub"]);
    uint8_t clientPub[32], shared[32];
    crypto::publicKey(clientPub, clientPriv.data());
    CHECK(std::vector<uint8_t>(clientPub, clientPub + 32) == hex(kv["client_pub"]));
    crypto::sharedSecret(shared, clientPriv.data(), serverPub.data());
    CHECK(std::vector<uint8_t>(shared, shared + 32) == hex(kv["shared"]));
    uint64_t nonce = std::stoull(kv["nonce"]);
    uint8_t c2s[32], s2c[32];
    crypto::deriveKey(c2s, shared, "gomp-c2s", nonce, serverPub.data(), clientPub);
    crypto::deriveKey(s2c, shared, "gomp-s2c", nonce, serverPub.data(), clientPub);

    auto body = hex(kv["body"]);
    auto pkt = hex(kv["s2c_packet"]);
    const std::size_t hdr = 13;
    std::vector<uint8_t> plain(pkt.size() - hdr - 16);
    REQUIRE(crypto::open(plain.data(), s2c, 7, pkt.data(), hdr, pkt.data() + hdr, plain.size()));
    CHECK(plain == body);
    // Tampering is detected.
    pkt[pkt.size() - 1] ^= 1;
    CHECK_FALSE(crypto::open(plain.data(), s2c, 7, pkt.data(), hdr, pkt.data() + hdr, plain.size()));
    // Our sealing reproduces Go's client → server packet exactly.
    auto want = hex(kv["c2s_packet"]);
    std::vector<uint8_t> sealed(hdr + body.size() + 16);
    std::copy(want.begin(), want.begin() + hdr, sealed.begin());
    crypto::seal(sealed.data() + hdr, c2s, 7, sealed.data(), hdr, body.data(), body.size());
    CHECK(sealed == want);
}

// Two endpoints over a lossy, reordering, duplicating simulated link.
struct SimLink {
    std::mt19937 rng{42};
    double loss, dup;
    TimePoint now = Clock::now();
    Endpoint a{now}, b{now};
    struct Flight {
        TimePoint at;
        bool toB;
        std::vector<uint8_t> body;
    };
    std::vector<Flight> inFly;

    SimLink(double l, double d) : loss(l), dup(d) {}

    void send(bool toB, const uint8_t* p, std::size_t n) {
        std::uniform_real_distribution<double> u(0, 1);
        if (u(rng) < loss) return;
        int copies = u(rng) < dup ? 2 : 1;
        std::uniform_int_distribution<int> jitter(0, 40);
        for (int i = 0; i < copies; ++i)
            inFly.push_back({now + std::chrono::milliseconds(30 + jitter(rng)), toB, std::vector<uint8_t>(p, p + n)});
    }
    void flush(Endpoint& e, bool toB, bool keepalive) {
        e.build(now, keepalive, 256, [&](const uint8_t* p, std::size_t n) { send(toB, p, n); });
    }
    bool step(std::chrono::milliseconds dt, bool doFlush) {
        now += dt;
        std::stable_sort(inFly.begin(), inFly.end(), [](const Flight& x, const Flight& y) { return x.at < y.at; });
        std::vector<Flight> due, keep;
        for (auto& f : inFly) (f.at <= now ? due : keep).push_back(std::move(f));
        inFly = std::move(keep);
        for (auto& f : due) {
            Endpoint& dst = f.toB ? b : a;
            if (!dst.receive(f.body.data(), f.body.size(), now)) return false;
            if (dst.needsEarlyAck()) flush(dst, !f.toB, false);
        }
        if (doFlush) {
            flush(a, true, now - a.lastSend() >= std::chrono::milliseconds(250));
            flush(b, false, now - b.lastSend() >= std::chrono::milliseconds(250));
        }
        return true;
    }
};

TEST_CASE("reliable ordered delivery with fragmentation under 30% loss") {
    SimLink l(0.3, 0.1);
    const std::size_t sizes[] = {1, 16, 200, 1100, 5000, 70000};
    const int total = 600;
    auto payload = [&](int i) {
        std::vector<uint8_t> p(sizes[i % 6]);
        for (std::size_t j = 0; j < p.size(); ++j) p[j] = static_cast<uint8_t>(i * 31 + j);
        return p;
    };
    for (int i = 0; i < total; ++i) {
        auto p = payload(i);
        REQUIRE(l.a.queue(Channel::Reliable, p.data(), p.size()));
    }
    std::vector<Message> got;
    for (int s = 0; static_cast<int>(got.size()) < total; ++s) {
        REQUIRE(s < 200000);
        REQUIRE(l.step(std::chrono::milliseconds(5), s % 6 == 0));
        l.b.drain(got);
    }
    for (int i = 0; i < total; ++i) {
        INFO("message " << i);
        CHECK(got[i].channel == Channel::Reliable);
        CHECK(got[i].data == payload(i));
    }
    CHECK(l.a.stats(l.now).resends > 0);
}

TEST_CASE("unreliable messages are not duplicated") {
    SimLink l(0.2, 0.5);
    std::map<uint32_t, int> seen;
    for (int i = 0; i < 1500; ++i) {
        uint8_t m[4];
        std::memcpy(m, &i, 4);
        l.a.queue(Channel::Unreliable, m, 4);
        REQUIRE(l.step(std::chrono::milliseconds(10), true));
        std::vector<Message> out;
        l.b.drain(out);
        for (auto& msg : out) {
            uint32_t v;
            std::memcpy(&v, msg.data.data(), 4);
            seen[v]++;
        }
    }
    for (auto& [k, c] : seen) CHECK(c == 1);
    CHECK(seen.size() > 1000);
}
