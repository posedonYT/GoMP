#include "gomp/messages.hpp"

namespace gomp {
namespace {

void writeVel(Writer& w, Vec3 v) {
    w.i16(quantizeSigned(v.x, kVelocityScale));
    w.i16(quantizeSigned(v.y, kVelocityScale));
    w.i16(quantizeSigned(v.z, kVelocityScale));
}
Vec3 readVel(Reader& r) {
    Vec3 v;
    v.x = dequantizeSigned(r.i16(), kVelocityScale);
    v.y = dequantizeSigned(r.i16(), kVelocityScale);
    v.z = dequantizeSigned(r.i16(), kVelocityScale);
    return v;
}
void writeAngVel(Writer& w, Vec3 v) {
    w.i16(quantizeSigned(v.x, kAngVelocityScale));
    w.i16(quantizeSigned(v.y, kAngVelocityScale));
    w.i16(quantizeSigned(v.z, kAngVelocityScale));
}
Vec3 readAngVel(Reader& r) {
    Vec3 v;
    v.x = dequantizeSigned(r.i16(), kAngVelocityScale);
    v.y = dequantizeSigned(r.i16(), kAngVelocityScale);
    v.z = dequantizeSigned(r.i16(), kAngVelocityScale);
    return v;
}
void writeProps(Writer& w, const Props& p) {
    w.uvarint(p.size());
    for (const auto& [id, v] : p) {  // std::map iterates in id order, like Go
        w.u8(id);
        writeValue(w, v);
    }
}
Props readProps(Reader& r) {
    Props p;
    std::size_t n = r.len(r.remaining() / 2);
    for (std::size_t i = 0; i < n && r.ok(); ++i) {
        uint8_t id = r.u8();
        p[id] = readValue(r);
    }
    return p;
}
void writeKV(Writer& w, const KV& kv) {
    w.uvarint(kv.size());
    for (const auto& [k, v] : kv) {
        w.string(k);
        writeValue(w, v);
    }
}
KV readKV(Reader& r) {
    KV kv;
    std::size_t n = r.len(r.remaining() / 2);
    kv.reserve(n);
    for (std::size_t i = 0; i < n && r.ok(); ++i) {
        std::string k = r.string();
        kv.emplace_back(std::move(k), readValue(r));
    }
    return kv;
}

}  // namespace

void PedSync::encode(Writer& w) const {
    w.u32(time);
    w.vec3(pos);
    writeVel(w, vel);
    w.u16(quantizeHeading(heading));
    w.u8(static_cast<uint8_t>(move));
    w.u16(flags);
    w.u32(weapon);
    if (flags & ped::Aiming) w.vec3(aimPos);
}
void PedSync::decode(Reader& r) {
    time = r.u32();
    pos = r.vec3();
    vel = readVel(r);
    heading = dequantizeHeading(r.u16());
    move = static_cast<MoveState>(r.u8());
    flags = r.u16();
    weapon = r.u32();
    aimPos = (flags & ped::Aiming) ? r.vec3() : Vec3{};
}

void PlayerSyncOut::encode(Writer& w) const { w.u16(playerId); sync.encode(w); }
void PlayerSyncOut::decode(Reader& r) { playerId = r.u16(); sync.decode(r); }

void VehicleSync::encode(Writer& w) const {
    w.u16(vehicleId);
    w.u32(time);
    w.vec3(pos);
    w.u32(packQuat(rot));
    writeVel(w, vel);
    writeAngVel(w, angVel);
    w.i8(quantizeUnitS8(steer));
    w.i8(quantizeUnitS8(gas));
    w.u8(quantizeUnitU8(brake));
    w.u16(flags);
    w.i16(quantizeHealth(bodyHealth));
    w.i16(quantizeHealth(engineHealth));
    if (flags & veh::DriverAiming) {
        w.u32(weapon);
        w.vec3(aimPos);
    }
}
void VehicleSync::decode(Reader& r) {
    vehicleId = r.u16();
    time = r.u32();
    pos = r.vec3();
    rot = unpackQuat(r.u32());
    vel = readVel(r);
    angVel = readAngVel(r);
    steer = dequantizeUnitS8(r.i8());
    gas = dequantizeUnitS8(r.i8());
    brake = dequantizeUnitU8(r.u8());
    flags = r.u16();
    bodyHealth = static_cast<float>(r.i16());
    engineHealth = static_cast<float>(r.i16());
    if (flags & veh::DriverAiming) {
        weapon = r.u32();
        aimPos = r.vec3();
    } else {
        weapon = 0;
        aimPos = {};
    }
}

void VehicleSyncOut::encode(Writer& w) const { sync.encode(w); }
void VehicleSyncOut::decode(Reader& r) { sync.decode(r); }

void PassengerSync::encode(Writer& w) const {
    w.u16(vehicleId);
    w.u8(seat);
    w.u32(time);
    w.u16(flags);
    w.u32(weapon);
    if (flags & ped::Aiming) w.vec3(aimPos);
}
void PassengerSync::decode(Reader& r) {
    vehicleId = r.u16();
    seat = r.u8();
    time = r.u32();
    flags = r.u16();
    weapon = r.u32();
    aimPos = (flags & ped::Aiming) ? r.vec3() : Vec3{};
}

void PassengerSyncOut::encode(Writer& w) const { w.u16(playerId); sync.encode(w); }
void PassengerSyncOut::decode(Reader& r) { playerId = r.u16(); sync.decode(r); }

void UnoccupiedSync::encode(Writer& w) const {
    w.u16(vehicleId);
    w.u32(time);
    w.vec3(pos);
    w.u32(packQuat(rot));
    writeVel(w, vel);
    writeAngVel(w, angVel);
}
void UnoccupiedSync::decode(Reader& r) {
    vehicleId = r.u16();
    time = r.u32();
    pos = r.vec3();
    rot = unpackQuat(r.u32());
    vel = readVel(r);
    angVel = readAngVel(r);
}

void WeaponShot::encode(Writer& w) const {
    w.u16(seq);
    w.u32(time);
    w.u32(weapon);
    w.vec3(origin);
    w.vec3(target);
}
void WeaponShot::decode(Reader& r) {
    seq = r.u16();
    time = r.u32();
    weapon = r.u32();
    origin = r.vec3();
    target = r.vec3();
}

void WeaponShotOut::encode(Writer& w) const { w.u16(playerId); shot.encode(w); }
void WeaponShotOut::decode(Reader& r) { playerId = r.u16(); shot.decode(r); }

void WeaponHit::encode(Writer& w) const {
    w.u16(shotSeq);
    w.u32(weapon);
    w.u8(flags);
    w.u8(static_cast<uint8_t>(targetType));
    w.u16(targetId);
    w.u16(bone);
    w.vec3(hitPos);
}
void WeaponHit::decode(Reader& r) {
    shotSeq = r.u16();
    weapon = r.u32();
    flags = r.u8();
    targetType = static_cast<EntityType>(r.u8());
    targetId = r.u16();
    bone = r.u16();
    hitPos = r.vec3();
}

void SelfDamage::encode(Writer& w) const {
    w.u8(static_cast<uint8_t>(cause));
    w.u8(health);
    w.u8(armour);
}
void SelfDamage::decode(Reader& r) {
    cause = static_cast<DamageCause>(r.u8());
    health = r.u8();
    armour = r.u8();
}

void EnterVehicleRequest::encode(Writer& w) const { w.u16(vehicleId); w.u8(seat); }
void EnterVehicleRequest::decode(Reader& r) { vehicleId = r.u16(); seat = r.u8(); }

void EnterVehicleResponse::encode(Writer& w) const {
    w.u16(vehicleId);
    w.u8(seat);
    w.u8(static_cast<uint8_t>(result));
}
void EnterVehicleResponse::decode(Reader& r) {
    vehicleId = r.u16();
    seat = r.u8();
    result = static_cast<EnterResult>(r.u8());
}

void EnterVehicleComplete::encode(Writer& w) const { w.u16(vehicleId); w.u8(seat); w.boolean(aborted); }
void EnterVehicleComplete::decode(Reader& r) { vehicleId = r.u16(); seat = r.u8(); aborted = r.boolean(); }

void ExitVehicleRequest::encode(Writer&) const {}
void ExitVehicleRequest::decode(Reader&) {}
void ExitVehicleComplete::encode(Writer&) const {}
void ExitVehicleComplete::decode(Reader&) {}

void PutIntoVehicle::encode(Writer& w) const { w.u16(vehicleId); w.u8(seat); }
void PutIntoVehicle::decode(Reader& r) { vehicleId = r.u16(); seat = r.u8(); }

void VehicleTask::encode(Writer& w) const {
    w.u16(playerId);
    w.u8(static_cast<uint8_t>(task));
    w.u16(vehicleId);
    w.u8(seat);
}
void VehicleTask::decode(Reader& r) {
    playerId = r.u16();
    task = static_cast<TaskKind>(r.u8());
    vehicleId = r.u16();
    seat = r.u8();
}

void ControllerAssign::encode(Writer& w) const { w.u16(vehicleId); w.boolean(controlled); }
void ControllerAssign::decode(Reader& r) { vehicleId = r.u16(); controlled = r.boolean(); }

void VehicleExplode::encode(Writer& w) const { w.u16(vehicleId); }
void VehicleExplode::decode(Reader& r) { vehicleId = r.u16(); }

void TeleportAck::encode(Writer& w) const { w.u16(seq); }
void TeleportAck::decode(Reader& r) { seq = r.u16(); }

void Ready::encode(Writer&) const {}
void Ready::decode(Reader&) {}

void Welcome::encode(Writer& w) const {
    w.u16(playerId);
    w.string(serverName);
    w.string(gameMode);
    w.u8(tickRate);
    w.f32(streamDistance);
    w.u8(hour);
    w.u8(minute);
    w.u8(second);
    w.string(weather);
}
void Welcome::decode(Reader& r) {
    playerId = r.u16();
    serverName = r.string();
    gameMode = r.string();
    tickRate = r.u8();
    streamDistance = r.f32();
    hour = r.u8();
    minute = r.u8();
    second = r.u8();
    weather = r.string();
}

void SetPosition::encode(Writer& w) const {
    w.u16(seq);
    w.u8(static_cast<uint8_t>(reason));
    w.vec3(pos);
    w.f32(heading);
}
void SetPosition::decode(Reader& r) {
    seq = r.u16();
    reason = static_cast<PosReason>(r.u8());
    pos = r.vec3();
    heading = r.f32();
}

void Loadout::encode(Writer& w) const {
    w.u32(current);
    w.uvarint(weapons.size());
    for (const auto& wa : weapons) {
        w.u32(wa.hash);
        w.u16(wa.ammo);
    }
}
void Loadout::decode(Reader& r) {
    current = r.u32();
    std::size_t n = r.len(r.remaining() / 6);
    weapons.clear();
    for (std::size_t i = 0; i < n && r.ok(); ++i) {
        WeaponAmmo wa;
        wa.hash = r.u32();
        wa.ammo = r.u16();
        weapons.push_back(wa);
    }
}

void EntityCreate::encode(Writer& w) const {
    w.u8(static_cast<uint8_t>(type));
    w.u16(id);
    w.u32(model);
    w.vec3(pos);
    w.vec3(rot);
    writeProps(w, props);
    writeKV(w, shared);
}
void EntityCreate::decode(Reader& r) {
    type = static_cast<EntityType>(r.u8());
    id = r.u16();
    model = r.u32();
    pos = r.vec3();
    rot = r.vec3();
    props = readProps(r);
    shared = readKV(r);
}

void EntityDestroy::encode(Writer& w) const { w.u8(static_cast<uint8_t>(type)); w.u16(id); }
void EntityDestroy::decode(Reader& r) { type = static_cast<EntityType>(r.u8()); id = r.u16(); }

void EntitySetProps::encode(Writer& w) const {
    w.u8(static_cast<uint8_t>(type));
    w.u16(id);
    writeProps(w, props);
}
void EntitySetProps::decode(Reader& r) {
    type = static_cast<EntityType>(r.u8());
    id = r.u16();
    props = readProps(r);
}

void SharedData::encode(Writer& w) const {
    w.u8(static_cast<uint8_t>(type));
    w.u16(id);
    w.boolean(own);
    writeKV(w, values);
}
void SharedData::decode(Reader& r) {
    type = static_cast<EntityType>(r.u8());
    id = r.u16();
    own = r.boolean();
    values = readKV(r);
}

void Chat::encode(Writer& w) const { w.string(text); }
void Chat::decode(Reader& r) { text = r.string(); }

void ScriptEvent::encode(Writer& w) const { w.string(name); writeValues(w, args); }
void ScriptEvent::decode(Reader& r) { name = r.string(); args = readValues(r); }

void ProcCall::encode(Writer& w) const {
    w.u32(callId);
    w.string(name);
    writeValues(w, args);
}
void ProcCall::decode(Reader& r) {
    callId = r.u32();
    name = r.string();
    args = readValues(r);
}

void ProcResult::encode(Writer& w) const {
    w.u32(callId);
    w.boolean(ok);
    if (ok) writeValue(w, result);
    else w.string(error);
}
void ProcResult::decode(Reader& r) {
    callId = r.u32();
    ok = r.boolean();
    if (ok) {
        result = readValue(r);
        error.clear();
    } else {
        result = {};
        error = r.string();
    }
}

void World::encode(Writer& w) const {
    w.u8(hour);
    w.u8(minute);
    w.u8(second);
    w.string(weather);
    w.u32(transitionMs);
}
void World::decode(Reader& r) {
    hour = r.u8();
    minute = r.u8();
    second = r.u8();
    weather = r.string();
    transitionMs = r.u32();
}

void Ipl::encode(Writer& w) const { w.string(name); w.boolean(load); }
void Ipl::decode(Reader& r) { name = r.string(); load = r.boolean(); }

void Notify::encode(Writer& w) const { w.string(text); }
void Notify::decode(Reader& r) { text = r.string(); }

void Invoke::encode(Writer& w) const { w.u64(hash); writeValues(w, args); }
void Invoke::decode(Reader& r) { hash = r.u64(); args = readValues(r); }

void PlayAnim::encode(Writer& w) const {
    w.u16(playerId);
    w.string(dict);
    w.string(name);
    w.f32(speed);
    w.i32(flag);
    w.boolean(stop);
}
void PlayAnim::decode(Reader& r) {
    playerId = r.u16();
    dict = r.string();
    name = r.string();
    speed = r.f32();
    flag = r.i32();
    stop = r.boolean();
}

std::vector<uint8_t> ConnectInfo::marshal() const {
    Writer w;
    w.u16(version);
    w.string(name);
    w.string(serial);
    w.string(socialClub);
    w.string(rgscId);
    w.string(gameType);
    w.u32(build);
    return std::move(w.bytes());
}

namespace {
template <typename M> bool rt(const uint8_t* d, std::size_t n, std::vector<uint8_t>& out) {
    M m;
    if (!unmarshal(d, n, m)) return false;
    out = marshal(m);
    return true;
}
}  // namespace

bool reencode(const uint8_t* d, std::size_t n, std::vector<uint8_t>& out) {
    MsgID id;
    if (!peekId(d, n, id)) return false;
    switch (id) {
        case MsgID::PedSync: return rt<PedSync>(d, n, out);
        case MsgID::VehicleSync: return rt<VehicleSync>(d, n, out);
        case MsgID::PassengerSync: return rt<PassengerSync>(d, n, out);
        case MsgID::UnoccupiedSync: return rt<UnoccupiedSync>(d, n, out);
        case MsgID::WeaponShot: return rt<WeaponShot>(d, n, out);
        case MsgID::WeaponHit: return rt<WeaponHit>(d, n, out);
        case MsgID::SelfDamage: return rt<SelfDamage>(d, n, out);
        case MsgID::EnterVehicleRequest: return rt<EnterVehicleRequest>(d, n, out);
        case MsgID::EnterVehicleComplete: return rt<EnterVehicleComplete>(d, n, out);
        case MsgID::ExitVehicleRequest: return rt<ExitVehicleRequest>(d, n, out);
        case MsgID::ExitVehicleComplete: return rt<ExitVehicleComplete>(d, n, out);
        case MsgID::TeleportAck: return rt<TeleportAck>(d, n, out);
        case MsgID::Ready: return rt<Ready>(d, n, out);
        case MsgID::Chat: return rt<Chat>(d, n, out);
        case MsgID::ScriptEvent: return rt<ScriptEvent>(d, n, out);
        case MsgID::ProcCall: return rt<ProcCall>(d, n, out);
        case MsgID::ProcResult: return rt<ProcResult>(d, n, out);
        case MsgID::Welcome: return rt<Welcome>(d, n, out);
        case MsgID::EntityCreate: return rt<EntityCreate>(d, n, out);
        case MsgID::EntityDestroy: return rt<EntityDestroy>(d, n, out);
        case MsgID::EntitySetProps: return rt<EntitySetProps>(d, n, out);
        case MsgID::PlayerSyncOut: return rt<PlayerSyncOut>(d, n, out);
        case MsgID::VehicleSyncOut: return rt<VehicleSyncOut>(d, n, out);
        case MsgID::PassengerSyncOut: return rt<PassengerSyncOut>(d, n, out);
        case MsgID::WeaponShotOut: return rt<WeaponShotOut>(d, n, out);
        case MsgID::SharedData: return rt<SharedData>(d, n, out);
        case MsgID::SetPosition: return rt<SetPosition>(d, n, out);
        case MsgID::Loadout: return rt<Loadout>(d, n, out);
        case MsgID::PutIntoVehicle: return rt<PutIntoVehicle>(d, n, out);
        case MsgID::EnterVehicleResponse: return rt<EnterVehicleResponse>(d, n, out);
        case MsgID::VehicleTask: return rt<VehicleTask>(d, n, out);
        case MsgID::ControllerAssign: return rt<ControllerAssign>(d, n, out);
        case MsgID::World: return rt<World>(d, n, out);
        case MsgID::Ipl: return rt<Ipl>(d, n, out);
        case MsgID::Notify: return rt<Notify>(d, n, out);
        case MsgID::Invoke: return rt<Invoke>(d, n, out);
        case MsgID::PlayAnim: return rt<PlayAnim>(d, n, out);
        case MsgID::VehicleExplode: return rt<VehicleExplode>(d, n, out);
    }
    return false;
}

}  // namespace gomp
