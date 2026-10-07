// gomp-headless: a console GoMP client built from the same C++ core as the
// game client. It connects, spawns, walks and reports what it sees, so the
// C++ protocol stack can be verified end to end without GTA V.
//
//   gomp-headless --server 127.0.0.1:22005 --name Cpp --seconds 3 [--expect-player Bob] [--vehicle-cmd "/veh sultan"]
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <string>
#include <thread>

#include "gomp/messages.hpp"
#include "gomp/transport.hpp"

using namespace gomp;
using namespace std::chrono;

namespace {

struct Remote {
    std::string name;
    Vec3 pos;
    int syncs = 0;
};

struct Options {
    std::string host = "127.0.0.1";
    uint16_t port = 22005;
    std::string name = "Headless";
    double seconds = 3;
    std::string expectPlayer;
    std::string vehicleCmd;
};

bool parse(int argc, char** argv, Options& o) {
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
        if (a == "--server") {
            std::string s = next();
            auto c = s.rfind(':');
            if (c == std::string::npos) return false;
            o.host = s.substr(0, c);
            o.port = static_cast<uint16_t>(std::stoi(s.substr(c + 1)));
        } else if (a == "--name") {
            o.name = next();
        } else if (a == "--seconds") {
            o.seconds = std::stod(next());
        } else if (a == "--expect-player") {
            o.expectPlayer = next();
        } else if (a == "--vehicle-cmd") {
            o.vehicleCmd = next();
        } else {
            return false;
        }
    }
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    Options opt;
    if (!parse(argc, argv, opt)) {
        std::fprintf(stderr, "usage: gomp-headless --server host:port [--name N] [--seconds S] [--expect-player N] [--vehicle-cmd CMD]\n");
        return 2;
    }
    ConnectInfo info;
    info.name = opt.name;
    info.serial = "headless-" + opt.name;
    info.socialClub = opt.name;
    info.build = 3258;

    Client client;
    std::string err;
    if (!client.connect(opt.host, opt.port, info.marshal(), err)) {
        std::fprintf(stderr, "connect: %s\n", err.c_str());
        return 1;
    }
    auto start = steady_clock::now();
    while (client.state() == Client::State::Connecting) {
        client.update(steady_clock::now());
        std::this_thread::sleep_for(milliseconds(5));
    }
    if (client.state() != Client::State::Connected) {
        std::fprintf(stderr, "handshake failed: %s\n", client.reason().c_str());
        return 1;
    }
    std::printf("OK connected in %lld ms\n",
                static_cast<long long>(duration_cast<milliseconds>(steady_clock::now() - start).count()));

    uint16_t myId = kNoID;
    bool spawned = false, readySent = false, cmdSent = false;
    Vec3 pos;
    uint16_t vehicle = kNoID;
    std::map<uint16_t, Remote> players;
    std::vector<Message> inbox;
    TimePoint walkStart{};
    auto epoch = steady_clock::now();
    auto lastSync = steady_clock::now();

    for (;;) {
        auto now = steady_clock::now();
        client.update(now);
        if (client.state() != Client::State::Connected) {
            std::fprintf(stderr, "disconnected: %s\n", client.reason().c_str());
            return 1;
        }
        inbox.clear();
        client.drain(inbox);
        for (auto& m : inbox) {
            const uint8_t* d = m.data.data();
            std::size_t n = m.data.size();
            MsgID id;
            if (!peekId(d, n, id)) continue;
            switch (id) {
                case MsgID::Welcome: {
                    Welcome w;
                    if (unmarshal(d, n, w)) {
                        myId = w.playerId;
                        std::printf("OK welcome id=%u server=\"%s\" tick=%u\n", myId, w.serverName.c_str(), w.tickRate);
                    }
                    break;
                }
                case MsgID::SetPosition: {
                    SetPosition sp;
                    if (!unmarshal(d, n, sp)) break;
                    pos = sp.pos;
                    client.send(Channel::Reliable, marshal(TeleportAck{sp.seq}));
                    if (sp.reason == PosReason::Spawn && !spawned) {
                        spawned = true;
                        walkStart = now;
                        std::printf("OK spawned at %.2f %.2f %.2f\n", pos.x, pos.y, pos.z);
                    }
                    break;
                }
                case MsgID::EntityCreate: {
                    EntityCreate c;
                    if (unmarshal(d, n, c) && c.type == EntityType::Player && c.id != myId) {
                        Remote& r = players[c.id];
                        r.pos = c.pos;
                        if (auto it = c.props.find(prop::Name); it != c.props.end()) r.name = it->second.s;
                    }
                    break;
                }
                case MsgID::EntityDestroy: {
                    EntityDestroy e;
                    if (unmarshal(d, n, e) && e.type == EntityType::Player) players.erase(e.id);
                    break;
                }
                case MsgID::PlayerSyncOut: {
                    PlayerSyncOut s;
                    if (unmarshal(d, n, s)) {
                        auto it = players.find(s.playerId);
                        if (it != players.end()) {
                            it->second.pos = s.sync.pos;
                            it->second.syncs++;
                        }
                    }
                    break;
                }
                case MsgID::PutIntoVehicle: {
                    PutIntoVehicle p;
                    if (unmarshal(d, n, p)) {
                        vehicle = p.vehicleId;
                        std::printf("OK seated in vehicle %u seat %u\n", p.vehicleId, p.seat);
                    }
                    break;
                }
                case MsgID::Chat: {
                    Chat c;
                    if (unmarshal(d, n, c)) std::printf("CHAT %s\n", c.text.c_str());
                    break;
                }
                default:
                    break;
            }
        }
        if (myId != kNoID && !readySent) {
            client.send(Channel::Reliable, marshal(Ready{}));
            readySent = true;
        }
        if (spawned && !cmdSent && !opt.vehicleCmd.empty()) {
            client.send(Channel::Reliable, marshal(Chat{opt.vehicleCmd}));
            cmdSent = true;
        }
        // Walk east at 3 m/s with 30 Hz on-foot sync.
        if (spawned && vehicle == kNoID && now - lastSync >= milliseconds(33)) {
            double dt = duration<double>(now - lastSync).count();
            lastSync = now;
            pos.x += static_cast<float>(3.0 * std::min(dt, 0.1));
            PedSync ps;
            ps.time = static_cast<uint32_t>(duration_cast<milliseconds>(now - epoch).count());
            ps.pos = pos;
            ps.vel = {3, 0, 0};
            ps.heading = 270;
            ps.move = MoveState::Run;
            ps.weapon = joaat("weapon_unarmed");
            client.send(Channel::Unreliable, marshal(ps));
        }
        client.flush(now);
        if (spawned && now - walkStart >= duration<double>(opt.seconds)) break;
        if (now - start > seconds(30)) {
            std::fprintf(stderr, "timed out waiting for spawn\n");
            return 1;
        }
        std::this_thread::sleep_for(milliseconds(5));
    }

    bool ok = true;
    for (const auto& [id, r] : players)
        std::printf("SEEN %s id=%u at %.2f %.2f %.2f syncs=%d\n", r.name.c_str(), id, r.pos.x, r.pos.y, r.pos.z, r.syncs);
    if (!opt.expectPlayer.empty()) {
        bool found = false;
        for (const auto& [id, r] : players) found = found || (r.name == opt.expectPlayer && r.syncs > 0);
        if (!found) {
            std::fprintf(stderr, "expected to see player %s with sync updates\n", opt.expectPlayer.c_str());
            ok = false;
        }
    }
    auto st = client.stats(steady_clock::now());
    std::printf("STATS rtt=%.1fms loss=%.3f sent=%llu recv=%llu final=%.2f %.2f %.2f\n", st.rttMs, st.packetLoss,
                static_cast<unsigned long long>(st.packetsSent), static_cast<unsigned long long>(st.packetsRecv), pos.x,
                pos.y, pos.z);
    client.disconnect("done");
    return ok ? 0 : 1;
}
