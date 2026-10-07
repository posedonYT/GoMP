// GoMP game client: bridges the GoMP protocol and GTA V through ScriptHookV.
// Everything runs on the ScriptHookV script fiber (one call to tick() per frame).
#pragma once

#include <chrono>
#include <deque>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

#include "gomp/messages.hpp"
#include "gomp/transport.hpp"
#include "shv.hpp"

namespace gompgame {

using gomp::Vec3;

struct Config {
    std::string host = "127.0.0.1";
    uint16_t port = 22005;
    std::string name = "Player";
    std::string serial;
    int interpolationDelayMs = 100;
};
Config loadConfig(const std::string& path);

// A sync sample of a remote entity, stamped with the local receive time.
struct Sample {
    gomp::TimePoint at;
    Vec3 pos, vel;
    gomp::Quat rot;
    float heading = 0;
    uint16_t flags = 0;
    gomp::MoveState move = gomp::MoveState::Idle;
};

struct RemotePlayer {
    uint16_t id = 0;
    std::string name;
    Hash model = 0;
    Ped ped = 0;
    Blip blip = 0;
    std::deque<Sample> samples;
    Vec3 aimPos;
    uint32_t weapon = 0;
    int health = 100, armour = 0;
    bool dead = false;
    uint16_t vehicle = gomp::kNoID;
    uint8_t seat = 0;
    uint16_t lastFlags = 0;
    Vec3 lastTaskTarget;
    gomp::TimePoint lastTaskAt;
    gomp::Props props;
    gomp::KV shared;
    Vec3 spawnPos;
    float spawnHeading = 0;
};

struct RemoteVehicle {
    uint16_t id = 0;
    Hash model = 0;
    Vehicle handle = 0;
    std::deque<Sample> samples;
    Vec3 spawnPos, spawnRot;
    gomp::Props props;
    gomp::KV shared;
    bool controlled = false;  // we send UnoccupiedSync for it
    uint16_t flags = 0;
    float steer = 0;
    float bodyHealth = 1000, engineHealth = 1000;
};

// Static world entities (objects, peds, blips, markers, checkpoints, labels).
struct WorldEntity {
    gomp::EntityType type = gomp::EntityType::None;
    uint16_t id = 0;
    Hash model = 0;
    Vec3 pos, rot;
    gomp::Props props;
    gomp::KV shared;
    int handle = 0;  // game handle for objects, peds and blips
};

class GameClient {
public:
    explicit GameClient(Config cfg);
    void tick();                                  // once per frame
    void onKey(DWORD key, bool down, bool alt);   // keyboard handler (any thread)

private:
    using Clock = std::chrono::steady_clock;

    // network
    void connect();
    void pump();
    void handle(const uint8_t* d, std::size_t n);
    template <typename M> void send(const M& m, gomp::Channel ch = gomp::Channel::Reliable) {
        net_.send(ch, gomp::marshal(m));
    }
    uint32_t clock() const;

    // entity messages
    void onCreate(const gomp::EntityCreate& c);
    void onDestroy(gomp::EntityType t, uint16_t id);
    void onProps(gomp::EntityType t, uint16_t id, const gomp::Props& p);
    void applySelfProps(const gomp::Props& p);
    void onSetPosition(const gomp::SetPosition& sp);
    void onLoadout(const gomp::Loadout& l);
    void onPutIntoVehicle(const gomp::PutIntoVehicle& p);
    void onVehicleTask(const gomp::VehicleTask& t);
    void onShot(const gomp::WeaponShotOut& s);
    void onInvoke(const gomp::Invoke& inv);
    void onAnim(const gomp::PlayAnim& a);
    void onScriptEvent(const gomp::ScriptEvent& e);
    void onProcCall(const gomp::ProcCall& c);

    // local player
    void syncLocal();
    void detectShots();
    void detectHits();
    void detectSelfDamage();
    void handleVehicleKeys();
    void sendVehicleSync(Vehicle veh);

    // remote entities
    void updateRemotes();
    void updateRemotePlayer(RemotePlayer& r);
    void updateRemoteVehicle(RemoteVehicle& v);
    void sendControlledVehicles();
    bool ensureModel(Hash model);
    Ped spawnRemotePed(RemotePlayer& r);
    Vehicle spawnRemoteVehicle(RemoteVehicle& v);
    void applyAppearance(Ped ped, const gomp::Props& p);
    void applyVehicleProps(Vehicle veh, const gomp::Props& p, RemoteVehicle* rv);
    void despawnPlayer(RemotePlayer& r);
    void despawnVehicle(RemoteVehicle& v);
    Vehicle vehicleHandle(uint16_t id) const;

    // world entities & UI
    void spawnWorldEntity(WorldEntity& e);
    void despawnWorldEntity(WorldEntity& e);
    void drawWorld();
    void drawUi();
    void notify(const std::string& text);
    void suppressPopulation();
    void clearAmbient();

    Config cfg_;
    gomp::Client net_;
    std::vector<gomp::Message> inbox_;
    Clock::time_point epoch_ = Clock::now();
    Clock::time_point lastSync_{}, lastAmbientSweep_{}, lastConnectTry_{};
    std::string status_ = "connecting";

    // own state
    uint16_t myId_ = gomp::kNoID;
    bool readySent_ = false, spawned_ = false, dead_ = false;
    int serverHealth_ = 100, serverArmour_ = 0;
    uint32_t serverWeapon_ = 0;
    std::map<uint32_t, uint16_t> weapons_;
    uint16_t pendingTeleportSeq_ = 0;
    bool teleportPending_ = false;
    uint16_t myVehicle_ = gomp::kNoID;
    uint8_t mySeat_ = 0;
    uint16_t enteringVehicle_ = gomp::kNoID;
    uint8_t enteringSeat_ = 0;
    Clock::time_point enterStarted_{};
    bool exiting_ = false;
    uint16_t pendingPutVehicle_ = gomp::kNoID;
    uint8_t pendingPutSeat_ = 0;
    uint16_t shotSeq_ = 0;
    Clock::time_point lastShotAt_{};
    int lastLocalHealth_ = -1;

    std::unordered_map<uint16_t, RemotePlayer> players_;
    std::unordered_map<uint16_t, RemoteVehicle> vehicles_;
    std::map<std::pair<uint8_t, uint16_t>, WorldEntity> world_;

    // chat
    std::deque<std::string> chatLines_;
    bool chatOpen_ = false;
    std::string chatInput_;
    std::vector<std::string> pendingChat_;  // filled by the keyboard thread
    CRITICAL_SECTION chatLock_;
};

// Seat mapping: GoMP/RAGE seat 0 is the driver, GTA's driver seat index is -1.
inline int gtaSeat(uint8_t seat) { return static_cast<int>(seat) - 1; }

}  // namespace gompgame
