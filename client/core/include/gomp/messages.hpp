// GoMP application messages, mirroring wire/proto/messages.go field by field.
#pragma once

#include <cmath>
#include <cstdint>
#include <limits>
#include <map>
#include <string>
#include <vector>

#include "gomp/buffer.hpp"
#include "gomp/quant.hpp"
#include "gomp/value.hpp"

namespace gomp {

enum class MsgID : uint8_t {
    PedSync = 0x10, VehicleSync = 0x11, PassengerSync = 0x12, UnoccupiedSync = 0x13, WeaponShot = 0x14,
    WeaponHit = 0x15, SelfDamage = 0x16, EnterVehicleRequest = 0x17, EnterVehicleComplete = 0x18,
    ExitVehicleRequest = 0x19, ExitVehicleComplete = 0x1A, TeleportAck = 0x1B, Ready = 0x1C,
    Chat = 0x20, ScriptEvent = 0x21, ProcCall = 0x22, ProcResult = 0x23,
    Welcome = 0x80, EntityCreate = 0x81, EntityDestroy = 0x82, EntitySetProps = 0x83, PlayerSyncOut = 0x84,
    VehicleSyncOut = 0x85, PassengerSyncOut = 0x86, WeaponShotOut = 0x87, SharedData = 0x88, SetPosition = 0x89,
    Loadout = 0x8A, PutIntoVehicle = 0x8B, EnterVehicleResponse = 0x8C, VehicleTask = 0x8D,
    ControllerAssign = 0x8E, World = 0x8F, Ipl = 0x90, Notify = 0x91, Invoke = 0x92, PlayAnim = 0x93,
    VehicleExplode = 0x94,
};

constexpr uint16_t kNoID = 0xFFFF;
constexpr uint8_t kSeatDriver = 0;
constexpr uint8_t kSeatAny = 0xFF;
constexpr uint32_t kGlobalDimension = 0xFFFFFFFF;
constexpr uint16_t kClientVersion = 1;

enum class MoveState : uint8_t { Idle = 0, Walk = 1, Run = 2, Sprint = 3 };

namespace ped {
constexpr uint16_t Aiming = 1 << 0, Reloading = 1 << 1, InMelee = 1 << 2, Jumping = 1 << 3, Climbing = 1 << 4,
                   OnLadder = 1 << 5, InCover = 1 << 6, Crouching = 1 << 7, Ragdoll = 1 << 8, Falling = 1 << 9,
                   Parachuting = 1 << 10, Swimming = 1 << 11, EnteringVehicle = 1 << 12, LeavingVehicle = 1 << 13;
}
namespace veh {
constexpr uint16_t EngineOn = 1 << 0, LightsOn = 1 << 1, HighBeams = 1 << 2, Horn = 1 << 3, Siren = 1 << 4,
                   Handbrake = 1 << 5, DriverAiming = 1 << 6, Destroyed = 1 << 7;
}

// Property ids (wire/proto/types.go).
namespace prop {
constexpr uint8_t Model = 1, Position = 2, Rotation = 3, Alpha = 5, Frozen = 6, Name = 10, Health = 11, Armour = 12,
                  Weapon = 13, Heading = 14, Clothes = 15, Accessories = 16, HeadBlend = 17, FaceFeatures = 18,
                  HeadOverlays = 19, Decorations = 20, HairColor = 21, EyeColor = 22, Dead = 23, Vehicle = 24,
                  Invincible = 25, Dynamic = 26, Colors = 30, ColorRGB = 31, NumberPlate = 32, Engine = 33,
                  Locked = 34, BodyHealth = 35, EngineHealth = 36, Livery = 38, Mods = 39, Neon = 40,
                  WindowTint = 41, WheelType = 42, WheelColor = 43, PearlColor = 44, Extras = 45, Siren = 46,
                  TaxiLights = 47, Movable = 48, NumberPlateType = 51, BlipSprite = 60, BlipColor = 61,
                  BlipName = 62, BlipScale = 63, BlipShortRange = 64, BlipRotation = 66, MarkerType = 70,
                  MarkerScale = 71, MarkerColor = 72, MarkerDirection = 73, Visible = 74, CheckpointType = 80,
                  CheckpointRadius = 81, CheckpointColor = 82, Destination = 83, LabelText = 90,
                  LabelColor = 91, LabelDrawDistance = 92, LabelLOS = 93, LabelFont = 94;
}

using Props = std::map<uint8_t, Value>;
using KV = std::vector<std::pair<std::string, Value>>;

enum class PosReason : uint8_t { Teleport = 0, Correction = 1, Spawn = 2 };
enum class TaskKind : uint8_t { EnterStart = 1, EnterWarp = 2, ExitStart = 3, ExitWarp = 4 };
enum class DamageCause : uint8_t { Other = 0, Fall = 1, Fire = 2, Drown = 3, Vehicle = 4, Explosion = 5 };
enum class EnterResult : uint8_t { Allowed = 0, NoVehicle = 1, TooFar = 2, Locked = 3, SeatTaken = 4, InvalidSeat = 5, Busy = 6 };

#define GOMP_MSG(Name)                         \
    static constexpr MsgID kId = MsgID::Name;  \
    void encode(Writer& w) const;              \
    void decode(Reader& r);

struct PedSync {
    GOMP_MSG(PedSync)
    uint32_t time = 0;
    Vec3 pos, vel;
    float heading = 0;
    MoveState move = MoveState::Idle;
    uint16_t flags = 0;
    uint32_t weapon = 0;
    Vec3 aimPos;
};
struct PlayerSyncOut {
    GOMP_MSG(PlayerSyncOut)
    uint16_t playerId = 0;
    PedSync sync;
};
struct VehicleSync {
    GOMP_MSG(VehicleSync)
    uint16_t vehicleId = 0;
    uint32_t time = 0;
    Vec3 pos;
    Quat rot;
    Vec3 vel, angVel;
    float steer = 0, gas = 0, brake = 0;
    uint16_t flags = 0;
    float bodyHealth = 1000, engineHealth = 1000;
    uint32_t weapon = 0;
    Vec3 aimPos;
};
struct VehicleSyncOut {
    GOMP_MSG(VehicleSyncOut)
    VehicleSync sync;
};
struct PassengerSync {
    GOMP_MSG(PassengerSync)
    uint16_t vehicleId = 0;
    uint8_t seat = 0;
    uint32_t time = 0;
    uint16_t flags = 0;
    uint32_t weapon = 0;
    Vec3 aimPos;
};
struct PassengerSyncOut {
    GOMP_MSG(PassengerSyncOut)
    uint16_t playerId = 0;
    PassengerSync sync;
};
struct UnoccupiedSync {
    GOMP_MSG(UnoccupiedSync)
    uint16_t vehicleId = 0;
    uint32_t time = 0;
    Vec3 pos;
    Quat rot;
    Vec3 vel, angVel;
};
struct WeaponShot {
    GOMP_MSG(WeaponShot)
    uint16_t seq = 0;
    uint32_t time = 0;
    uint32_t weapon = 0;
    Vec3 origin, target;
};
struct WeaponShotOut {
    GOMP_MSG(WeaponShotOut)
    uint16_t playerId = 0;
    WeaponShot shot;
};
struct WeaponHit {
    GOMP_MSG(WeaponHit)
    uint16_t shotSeq = 0;
    uint32_t weapon = 0;
    uint8_t flags = 0;  // 1 = melee
    EntityType targetType = EntityType::None;
    uint16_t targetId = 0;
    uint16_t bone = 0;
    Vec3 hitPos;
};
struct SelfDamage {
    GOMP_MSG(SelfDamage)
    DamageCause cause = DamageCause::Other;
    uint8_t health = 0, armour = 0;
};
struct EnterVehicleRequest {
    GOMP_MSG(EnterVehicleRequest)
    uint16_t vehicleId = 0;
    uint8_t seat = 0;
};
struct EnterVehicleResponse {
    GOMP_MSG(EnterVehicleResponse)
    uint16_t vehicleId = 0;
    uint8_t seat = 0;
    EnterResult result = EnterResult::Allowed;
};
struct EnterVehicleComplete {
    GOMP_MSG(EnterVehicleComplete)
    uint16_t vehicleId = 0;
    uint8_t seat = 0;
    bool aborted = false;
};
struct ExitVehicleRequest { GOMP_MSG(ExitVehicleRequest) };
struct ExitVehicleComplete { GOMP_MSG(ExitVehicleComplete) };
struct PutIntoVehicle {
    GOMP_MSG(PutIntoVehicle)
    uint16_t vehicleId = kNoID;
    uint8_t seat = 0;
};
struct VehicleTask {
    GOMP_MSG(VehicleTask)
    uint16_t playerId = 0;
    TaskKind task = TaskKind::EnterStart;
    uint16_t vehicleId = 0;
    uint8_t seat = 0;
};
struct ControllerAssign {
    GOMP_MSG(ControllerAssign)
    uint16_t vehicleId = 0;
    bool controlled = false;
};
struct VehicleExplode {
    GOMP_MSG(VehicleExplode)
    uint16_t vehicleId = 0;
};
struct TeleportAck {
    GOMP_MSG(TeleportAck)
    uint16_t seq = 0;
};
struct Ready { GOMP_MSG(Ready) };
struct Welcome {
    GOMP_MSG(Welcome)
    uint16_t playerId = 0;
    std::string serverName, gameMode;
    uint8_t tickRate = 30;
    float streamDistance = 0;
    uint8_t hour = 12, minute = 0, second = 0;
    std::string weather;
};
struct SetPosition {
    GOMP_MSG(SetPosition)
    uint16_t seq = 0;
    PosReason reason = PosReason::Teleport;
    Vec3 pos;
    float heading = std::numeric_limits<float>::quiet_NaN();
};
struct WeaponAmmo {
    uint32_t hash = 0;
    uint16_t ammo = 0;
};
struct Loadout {
    GOMP_MSG(Loadout)
    uint32_t current = 0;
    std::vector<WeaponAmmo> weapons;
};
struct EntityCreate {
    GOMP_MSG(EntityCreate)
    EntityType type = EntityType::None;
    uint16_t id = 0;
    uint32_t model = 0;
    Vec3 pos, rot;
    Props props;
    KV shared;
};
struct EntityDestroy {
    GOMP_MSG(EntityDestroy)
    EntityType type = EntityType::None;
    uint16_t id = 0;
};
struct EntitySetProps {
    GOMP_MSG(EntitySetProps)
    EntityType type = EntityType::None;
    uint16_t id = 0;
    Props props;
};
struct SharedData {
    GOMP_MSG(SharedData)
    EntityType type = EntityType::None;
    uint16_t id = 0;
    bool own = false;
    KV values;
};
struct Chat {
    GOMP_MSG(Chat)
    std::string text;
};
struct ScriptEvent {
    GOMP_MSG(ScriptEvent)
    std::string name;
    std::vector<Value> args;
};
struct ProcCall {
    GOMP_MSG(ProcCall)
    uint32_t callId = 0;
    std::string name;
    std::vector<Value> args;
};
struct ProcResult {
    GOMP_MSG(ProcResult)
    uint32_t callId = 0;
    bool ok = false;
    Value result;
    std::string error;
};
struct World {
    GOMP_MSG(World)
    uint8_t hour = 12, minute = 0, second = 0;
    std::string weather;
    uint32_t transitionMs = 0;
};
struct Ipl {
    GOMP_MSG(Ipl)
    std::string name;
    bool load = false;
};
struct Notify {
    GOMP_MSG(Notify)
    std::string text;
};
struct Invoke {
    GOMP_MSG(Invoke)
    uint64_t hash = 0;
    std::vector<Value> args;
};
struct PlayAnim {
    GOMP_MSG(PlayAnim)
    uint16_t playerId = 0;
    std::string dict, name;
    float speed = 8;
    int32_t flag = 0;
    bool stop = false;
};

#undef GOMP_MSG

// Connect payload of the transport handshake (wire/proto/connect.go).
struct ConnectInfo {
    uint16_t version = kClientVersion;
    std::string name, serial, socialClub, rgscId, gameType = "gta5";
    uint32_t build = 0;
    std::vector<uint8_t> marshal() const;
};

template <typename M> std::vector<uint8_t> marshal(const M& m) {
    Writer w;
    w.u8(static_cast<uint8_t>(M::kId));
    m.encode(w);
    return std::move(w.bytes());
}

// Decodes a full message (id byte + body); trailing bytes are an error.
template <typename M> bool unmarshal(const uint8_t* data, std::size_t size, M& m) {
    Reader r(data, size);
    if (r.u8() != static_cast<uint8_t>(M::kId)) return false;
    m.decode(r);
    return r.ok() && r.remaining() == 0;
}

inline bool peekId(const uint8_t* data, std::size_t size, MsgID& id) {
    if (size == 0) return false;
    id = static_cast<MsgID>(data[0]);
    return true;
}

// Decodes any known message and re-encodes it (cross-language tests).
bool reencode(const uint8_t* data, std::size_t size, std::vector<uint8_t>& out);

}  // namespace gomp
