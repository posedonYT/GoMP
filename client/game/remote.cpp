// Remote players and vehicles: spawning, interpolation, appearance, removal.
#include <algorithm>
#include <cmath>

#include "game_client.hpp"
#include "natives.hpp"
#include "props.hpp"

namespace gompgame {

using namespace gomp;

namespace {

constexpr int kPedTypeMission = 26;
constexpr int kRagdollBlockAll = 1 | 2 | 16 | 32 | 64 | 128 | 256;  // bullets, vehicles, players, explosions, objects, melee, rubber bullets
constexpr int kRemotePedHealth = 1000;  // local hits never kill: death comes from the server
constexpr auto kSampleTtl = std::chrono::seconds(1);
constexpr auto kPedMaxExtrapolation = std::chrono::milliseconds(250);
constexpr auto kVehMaxExtrapolation = std::chrono::milliseconds(300);
constexpr auto kTaskRefresh = std::chrono::milliseconds(500);
constexpr auto kAimRefresh = std::chrono::milliseconds(300);
constexpr float kTeleportDistance = 10.0f;
constexpr float kCorrectDistance = 1.5f;
constexpr float kTaskRetarget = 1.0f;
constexpr float kVehicleCorrection = 5.0f;   // velocity gain per metre of error
constexpr float kMaxCorrectionSpeed = 20.0f;
constexpr float kRotationBlend = 0.3f;       // slerp factor per frame
constexpr int kSeatDriverGta = -1;

Vec3 toVec(const Vector3& v) { return {v.x, v.y, v.z}; }
Vec3 add(Vec3 a, Vec3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
Vec3 sub(Vec3 a, Vec3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
Vec3 scale(Vec3 a, float s) { return {a.x * s, a.y * s, a.z * s}; }
Vec3 lerp(Vec3 a, Vec3 b, float t) { return add(a, scale(sub(b, a), t)); }
float length(Vec3 a) { return std::sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }
float dist(Vec3 a, Vec3 b) { return length(sub(a, b)); }
float seconds(Clock::duration d) { return std::chrono::duration<float>(d).count(); }

float lerpAngle(float a, float b, float t) {
    float d = std::fmod(b - a + 540.0f, 360.0f) - 180.0f;
    return a + d * t;
}

Quat slerp(Quat a, Quat b, float t) {
    float dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    if (dot < 0) {  // shortest path
        b = {-b.x, -b.y, -b.z, -b.w};
        dot = -dot;
    }
    if (dot > 0.9995f) {
        return normalize({a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t, a.w + (b.w - a.w) * t});
    }
    float theta = std::acos(dot), s = std::sin(theta);
    float wa = std::sin((1 - t) * theta) / s, wb = std::sin(t * theta) / s;
    return {a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb, a.w * wa + b.w * wb};
}

// Drops samples older than the TTL but always keeps the newest one.
void pruneSamples(std::deque<Sample>& s, Clock::time_point now) {
    while (s.size() > 1 && now - s.front().at > kSampleTtl) s.pop_front();
}

void setBlipName(Blip blip, const std::string& name) {
    HUD::BEGIN_TEXT_COMMAND_SET_BLIP_NAME("STRING");
    HUD::ADD_TEXT_COMPONENT_SUBSTRING_PLAYER_NAME(name.c_str());
    HUD::END_TEXT_COMMAND_SET_BLIP_NAME(blip);
}

float moveSpeed(MoveState m) {
    switch (m) {
        case MoveState::Sprint: return 3.0f;
        case MoveState::Run: return 2.0f;
        default: return 1.0f;
    }
}

// True when nothing (map geometry or objects) lies on the straight line from the ped
// to the target, as far as the last raycast knows. A new raycast is requested (made
// by runLosRequests() after the peds are updated, kLosPerFrame per frame): one for
// every lagging ped in every frame was a raycast per ped per frame.
bool pathClear(budget::Los& los, std::vector<budget::LosRequest>& reqs, uint16_t id, Vec3 from, Vec3 to, int64_t nowMs) {
    if (los.shouldAsk(nowMs)) reqs.push_back({id, los.askedAt, {from.x, from.y, from.z}, {to.x, to.y, to.z}});
    return los.clearFor(to.x, to.y, nowMs);
}

int64_t millis(Clock::time_point t) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(t.time_since_epoch()).count();
}

float distSq(Vec3 a, Vec3 b) {
    const Vec3 d = sub(a, b);
    return d.x * d.x + d.y * d.y + d.z * d.z;
}

// Where an entity is (or will appear) by its latest sample.
Vec3 lastPos(const std::deque<Sample>& samples, Vec3 spawn) { return samples.empty() ? spawn : samples.back().pos; }

void deleteEntity(Entity& e) {
    if (e && ENTITY::DOES_ENTITY_EXIST(e)) {
        ENTITY::SET_ENTITY_AS_MISSION_ENTITY(e, true, true);
        ENTITY::DELETE_ENTITY(&e);
    }
    e = 0;
}

}  // namespace

// ------------------------------------------------------------------ frame update

void GameClient::updateRemotes() {
    ++frameNo_;
    const Vec3 here = toVec(ENTITY::GET_ENTITY_COORDS(PLAYER::PLAYER_PED_ID(), true));
    // Spawning is spread over frames, the nearest first: a crowd streaming in at once
    // (joining next to a hub of players) froze the game for a moment. Models that are
    // not loaded yet do not use up the budget; a few more candidates are tried for that.
    constexpr std::size_t kSpawnTries = 4;
    std::vector<std::pair<float, uint16_t>> missing;
    // Vehicles first so that peds spawned this frame can be seated.
    for (auto& [id, v] : vehicles_) {
        if (v.handle && !ENTITY::DOES_ENTITY_EXIST(v.handle)) v.handle = 0;  // removed by the game
        if (!v.handle) missing.emplace_back(distSq(here, lastPos(v.samples, v.spawnPos)), id);
    }
    std::size_t spawned = 0;
    for (uint16_t id : budget::nearestFirst(missing, budget::kVehicleSpawnsPerFrame * kSpawnTries)) {
        if (spawned == budget::kVehicleSpawnsPerFrame) break;
        RemoteVehicle& v = vehicles_[id];
        if ((v.handle = spawnRemoteVehicle(v))) ++spawned;
    }
    missing.clear();
    std::vector<std::pair<float, uint16_t>> present;
    for (auto& [id, r] : players_) {
        if (r.ped && !ENTITY::DOES_ENTITY_EXIST(r.ped)) {
            r.ped = 0;
            r.blip = 0;
        }
        Vec3 pos = lastPos(r.samples, r.spawnPos);
        if (r.vehicle != kNoID)
            if (auto it = vehicles_.find(r.vehicle); it != vehicles_.end()) pos = lastPos(it->second.samples, it->second.spawnPos);
        (r.ped ? present : missing).emplace_back(distSq(here, pos), id);
    }
    // At most kMaxRemotePeds peds: a farther one makes room for a nearer one (one per frame).
    if (!missing.empty() && present.size() >= budget::kMaxRemotePeds) {
        const float nearest = std::min_element(missing.begin(), missing.end())->first;
        if (int out = budget::swapOut(present, nearest, budget::kMaxRemotePeds); out >= 0) despawnPlayer(players_[static_cast<uint16_t>(out)]);
    }
    const std::size_t room = present.size() < budget::kMaxRemotePeds ? budget::kMaxRemotePeds - present.size() : 0;
    spawned = 0;
    for (uint16_t id : budget::nearestFirst(std::move(missing), budget::kPedSpawnsPerFrame * kSpawnTries)) {
        if (spawned == std::min(budget::kPedSpawnsPerFrame, room)) break;
        RemotePlayer& r = players_[id];
        if ((r.ped = spawnRemotePed(r))) ++spawned;
    }
    // Far entities (150 m+) are moved every third frame, taking turns by id.
    for (auto& [id, v] : vehicles_)
        if (v.handle && budget::updateNow(distSq(here, lastPos(v.samples, v.spawnPos)), frameNo_, id)) updateRemoteVehicle(v);
    for (auto& [id, r] : players_)
        if (r.ped && budget::updateNow(distSq(here, lastPos(r.samples, r.spawnPos)), frameNo_, id)) updateRemotePlayer(r);
    runLosRequests();
}

void GameClient::runLosRequests() {
    constexpr int kWorld = 1, kObjects = 16;
    if (losRequests_.empty()) return;
    budget::oldestFirst(losRequests_, budget::kLosPerFrame);
    const int64_t now = millis(Clock::now());
    for (const budget::LosRequest& q : losRequests_) {
        auto it = players_.find(q.id);
        if (it == players_.end() || !it->second.ped) continue;
        int probe = SHAPETEST::START_EXPENSIVE_SYNCHRONOUS_SHAPE_TEST_LOS_PROBE(q.from[0], q.from[1], q.from[2], q.to[0], q.to[1], q.to[2],
                                                                            kWorld | kObjects, it->second.ped, 7);
        BOOL hit = FALSE;
        Vector3 end{}, normal{};
        Entity entity = 0;
        SHAPETEST::GET_SHAPE_TEST_RESULT(probe, &hit, &end, &normal, &entity);
        it->second.los.answered(now, q.to[0], q.to[1], !hit);
    }
    losRequests_.clear();
}

bool GameClient::ensureModel(Hash model) {
    if (!model || !STREAMING::IS_MODEL_IN_CDIMAGE(model)) return false;
    if (STREAMING::HAS_MODEL_LOADED(model)) return true;
    STREAMING::REQUEST_MODEL(model);  // try again next frame; never block the frame
    return false;
}

// ------------------------------------------------------------------ players

Ped GameClient::spawnRemotePed(RemotePlayer& r) {
    Hash model = r.model;
    if (!model || !STREAMING::IS_MODEL_IN_CDIMAGE(model)) model = joaat("mp_m_freemode_01");
    if (!ensureModel(model)) return 0;
    Vec3 pos = r.samples.empty() ? r.spawnPos : r.samples.back().pos;
    float heading = r.samples.empty() ? r.spawnHeading : r.samples.back().heading;
    Ped ped = PED::CREATE_PED(kPedTypeMission, model, pos.x, pos.y, pos.z, heading, false, true);
    STREAMING::SET_MODEL_AS_NO_LONGER_NEEDED(model);
    if (!ped) return 0;
    ENTITY::SET_ENTITY_AS_MISSION_ENTITY(ped, true, true);
    ENTITY::SET_ENTITY_COORDS_NO_OFFSET(ped, pos.x, pos.y, pos.z, false, false, false);
    PED::SET_BLOCKING_OF_NON_TEMPORARY_EVENTS(ped, true);
    PED::SET_PED_FLEE_ATTRIBUTES(ped, 0, false);
    PED::SET_PED_COMBAT_ATTRIBUTES(ped, 17, true);  // as specified in GOMP_TODO; events are blocked anyway
    PED::SET_PED_CAN_RAGDOLL_FROM_PLAYER_IMPACT(ped, false);
    // Hits must not knock remote players over: their pose comes from their own client.
    PED::SET_PED_CAN_RAGDOLL(ped, false);
    PED::SET_RAGDOLL_BLOCKING_FLAGS(ped, kRagdollBlockAll);
    PED::SET_PED_SUFFERS_CRITICAL_HITS(ped, false);
    PED::SET_PED_CAN_EVASIVE_DIVE(ped, false);
    PED::SET_PED_CAN_PLAY_AMBIENT_ANIMS(ped, false);
    PED::SET_PED_CAN_BE_DRAGGED_OUT(ped, false);
    PED::SET_PED_DIES_WHEN_INJURED(ped, false);
    PED::SET_PED_KEEP_TASK(ped, true);
    WEAPON::SET_PED_DROPS_WEAPONS_WHEN_DEAD(ped, false);
    PED::SET_PED_MAX_HEALTH(ped, kRemotePedHealth);
    ENTITY::SET_ENTITY_HEALTH(ped, kRemotePedHealth, 0, 0);
    PED::SET_PED_DEFAULT_COMPONENT_VARIATION(ped);
    applyAppearance(ped, r.props);
    PED::SET_PED_ARMOUR(ped, r.armour);

    r.moveTask = r.aimTask = false;
    r.pedWeapon = 0;
    r.lastTaskAt = r.lastAimAt = {};
    r.los = {};
    if (r.weapon) {
        WEAPON::GIVE_WEAPON_TO_PED(ped, r.weapon, 9999, false, true);
        WEAPON::SET_CURRENT_PED_WEAPON(ped, r.weapon, true);
        r.pedWeapon = r.weapon;
    }
    if (r.vehicle != kNoID) {
        if (Vehicle veh = vehicleHandle(r.vehicle)) PED::SET_PED_INTO_VEHICLE(ped, veh, gtaSeat(r.seat));
    }
    if (r.dead) ENTITY::SET_ENTITY_HEALTH(ped, 0, 0, 0);

    r.blip = HUD::ADD_BLIP_FOR_ENTITY(ped);
    r.blipHidden = false;  // a new blip is shown; tickAdmin hides it again for an invisible admin
    HUD::SET_BLIP_CATEGORY(r.blip, 7);  // "other players" in the map legend
    setBlipName(r.blip, r.name.empty() ? "Player" : r.name);
    return ped;
}

void GameClient::updateRemotePlayer(RemotePlayer& r) {
    if (!r.ped) return;
    const auto now = Clock::now();
    pruneSamples(r.samples, now);
    if (r.dead) return;
    Ped ped = r.ped;
    // Keep the ped alive locally whatever hits it.
    if (ENTITY::GET_ENTITY_HEALTH(ped) < kRemotePedHealth / 2) ENTITY::SET_ENTITY_HEALTH(ped, kRemotePedHealth, 0, 0);

    // Weapon in hand.
    if (r.weapon && r.weapon != r.pedWeapon) {
        WEAPON::GIVE_WEAPON_TO_PED(ped, r.weapon, 9999, false, true);
        WEAPON::SET_CURRENT_PED_WEAPON(ped, r.weapon, true);
        r.pedWeapon = r.weapon;
    }

    // In a vehicle: the vehicle sync moves the ped; only keep it seated.
    if (r.vehicle != kNoID) {
        Vehicle veh = vehicleHandle(r.vehicle);
        if (veh && now - r.lastVehicleCheck > std::chrono::milliseconds(250)) {
            r.lastVehicleCheck = now;
            if (!PED::IS_PED_IN_VEHICLE(ped, veh, false) && !TASK::GET_IS_TASK_ACTIVE(ped, 160))
                PED::SET_PED_INTO_VEHICLE(ped, veh, gtaSeat(r.seat));
        }
        bool aiming = (r.lastFlags & ped::Aiming) != 0;
        if (veh && aiming && (!r.aimTask || now - r.lastAimAt > kAimRefresh)) {
            TASK::TASK_DRIVE_BY(ped, 0, 0, r.aimPos.x, r.aimPos.y, r.aimPos.z, 100.0f, 100, false, joaat("FIRING_PATTERN_SINGLE_SHOT"));
            r.aimTask = true;
            r.lastAimAt = now;
        } else if (!aiming && r.aimTask) {
            TASK::CLEAR_PED_SECONDARY_TASK(ped);
            r.aimTask = false;
        }
        return;
    }
    if (r.samples.empty()) return;

    // Render slightly in the past and interpolate between the two samples around it.
    const auto renderAt = now - std::chrono::milliseconds(cfg_.interpolationDelayMs);
    Sample cur = r.samples.back();
    if (renderAt <= r.samples.front().at) {
        cur = r.samples.front();
    } else if (renderAt >= r.samples.back().at) {
        auto dt = std::min<Clock::duration>(renderAt - r.samples.back().at, kPedMaxExtrapolation);
        cur.pos = add(cur.pos, scale(cur.vel, seconds(dt)));
    } else {
        for (std::size_t i = 1; i < r.samples.size(); ++i) {
            const Sample& a = r.samples[i - 1];
            const Sample& b = r.samples[i];
            if (renderAt > b.at) continue;
            float span = seconds(b.at - a.at);
            float t = span > 0 ? seconds(renderAt - a.at) / span : 1.0f;
            cur = a;
            cur.pos = lerp(a.pos, b.pos, t);
            cur.vel = lerp(a.vel, b.vel, t);
            cur.heading = lerpAngle(a.heading, b.heading, t);
            break;
        }
    }

    Vec3 here = toVec(ENTITY::GET_ENTITY_COORDS(ped, true));
    float err = dist(here, cur.pos);
    const uint16_t flags = r.samples.back().flags;
    const MoveState move = r.samples.back().move;
    const bool aiming = (flags & ped::Aiming) != 0;

    if (err > kTeleportDistance) {
        ENTITY::SET_ENTITY_COORDS_NO_OFFSET(ped, cur.pos.x, cur.pos.y, cur.pos.z, false, false, false);
        ENTITY::SET_ENTITY_HEADING(ped, cur.heading);
        r.moveTask = r.aimTask = false;
        r.lastTaskAt = {};
    } else if (err > kCorrectDistance && pathClear(r.los, losRequests_, r.id, here, {cur.pos.x, cur.pos.y, here.z}, millis(now))) {
        // Soft correction in the plane; the ped keeps its own ground height. Never through
        // walls or props: a blocked ped keeps walking and is teleported only past 10 m.
        ENTITY::SET_ENTITY_COORDS_NO_OFFSET(ped, cur.pos.x, cur.pos.y, here.z, false, false, false);
    }

    const bool moving = move != MoveState::Idle;
    if (moving) {
        Vec3 goal = add(cur.pos, scale(cur.vel, 0.3f));
        if (!r.moveTask || dist(goal, r.lastTaskTarget) > kTaskRetarget || now - r.lastTaskAt > kTaskRefresh ||
            aiming != r.aimTask) {
            if (aiming) {
                TASK::TASK_GO_TO_COORD_WHILE_AIMING_AT_COORD(ped, goal.x, goal.y, goal.z, r.aimPos.x, r.aimPos.y,
                                                             r.aimPos.z, moveSpeed(move), false, 0.5f, 0.0f, false, 0,
                                                             false, joaat("FIRING_PATTERN_SINGLE_SHOT"));
            } else {
                TASK::TASK_GO_STRAIGHT_TO_COORD(ped, goal.x, goal.y, goal.z, moveSpeed(move), -1, cur.heading, 0.0f);
            }
            r.lastTaskTarget = goal;
            r.lastTaskAt = now;
            r.moveTask = true;
            r.aimTask = aiming;
            r.lastAimAt = now;
        }
    } else {
        if (r.moveTask) {
            TASK::CLEAR_PED_TASKS(ped);
            r.moveTask = false;
            r.aimTask = false;
        }
        if (aiming) {
            if (!r.aimTask || (now - r.lastAimAt > kAimRefresh && dist(r.aimPos, r.lastAimTarget) > 0.5f)) {
                TASK::TASK_AIM_GUN_AT_COORD(ped, r.aimPos.x, r.aimPos.y, r.aimPos.z, -1, !r.aimTask, false);
                r.aimTask = true;
                r.lastAimAt = now;
                r.lastAimTarget = r.aimPos;
            }
        } else {
            if (r.aimTask) {
                TASK::CLEAR_PED_TASKS(ped);
                r.aimTask = false;
            }
            ENTITY::SET_ENTITY_HEADING(ped, cur.heading);
        }
    }

    if ((flags & ped::Jumping) && !(r.lastFlags & ped::Jumping)) TASK::TASK_JUMP(ped, false, false, false);
    r.lastFlags = flags;
}

void GameClient::despawnPlayer(RemotePlayer& r) {
    if (r.blip && HUD::DOES_BLIP_EXIST(r.blip)) HUD::REMOVE_BLIP(&r.blip);
    r.blip = 0;
    if (r.ped && ENTITY::DOES_ENTITY_EXIST(r.ped)) {
        ENTITY::SET_ENTITY_AS_MISSION_ENTITY(r.ped, true, true);
        PED::DELETE_PED(&r.ped);
    }
    r.ped = 0;
    r.moveTask = r.aimTask = false;
    r.pedWeapon = 0;
}

void GameClient::applyAppearance(Ped ped, const Props& p) {
    using Kind = Value::Kind;
    if (const Value* v = props::find(p, prop::Clothes); v && v->kind == Kind::Map) {
        for (const auto& [k, c] : v->map)
            PED::SET_PED_COMPONENT_VARIATION(ped, props::key(k), static_cast<int>(props::at(c, 0)),
                                             static_cast<int>(props::at(c, 1)), static_cast<int>(props::at(c, 2)));
    }
    if (const Value* v = props::find(p, prop::Accessories); v && v->kind == Kind::Map) {
        for (const auto& [k, a] : v->map) {
            int drawable = static_cast<int>(props::at(a, 0, -1));
            if (drawable < 0) PED::CLEAR_PED_PROP(ped, props::key(k), 0);
            else PED::SET_PED_PROP_INDEX(ped, props::key(k), drawable, static_cast<int>(props::at(a, 1)), true, 0);
        }
    }
    if (const Value* v = props::find(p, prop::HeadBlend); v && v->kind == Kind::Array && v->arr.size() >= 9) {
        auto i = [&](std::size_t n) { return static_cast<int>(props::at(*v, n)); };
        auto f = [&](std::size_t n) { return static_cast<float>(props::at(*v, n)); };
        PED::SET_PED_HEAD_BLEND_DATA(ped, i(0), i(1), i(2), i(3), i(4), i(5), f(6), f(7), f(8), false);
    }
    if (const Value* v = props::find(p, prop::FaceFeatures); v && v->kind == Kind::Map) {
        for (const auto& [k, s] : v->map) PED::SET_PED_MICRO_MORPH(ped, props::key(k), static_cast<float>(s.asNumber()));
    }
    if (const Value* v = props::find(p, prop::HeadOverlays); v && v->kind == Kind::Map) {
        for (const auto& [k, o] : v->map) {
            int overlay = props::key(k);
            PED::SET_PED_HEAD_OVERLAY(ped, overlay, static_cast<int>(props::at(o, 0, 255)), static_cast<float>(props::at(o, 1, 1)));
            // Colour type: 1 = hair colours (beard, eyebrows, chest hair), 2 = make-up colours.
            int colorType = (overlay == 1 || overlay == 2 || overlay == 10) ? 1 : (overlay == 5 || overlay == 8) ? 2 : 0;
            if (colorType)
                PED::SET_PED_HEAD_OVERLAY_TINT(ped, overlay, colorType, static_cast<int>(props::at(o, 2)),
                                               static_cast<int>(props::at(o, 3)));
        }
    }
    if (auto it = p.find(prop::Decorations); it != p.end()) {
        PED::CLEAR_PED_DECORATIONS(ped);
        if (it->second.kind == Kind::Map) {
            for (const auto& [k, o] : it->second.map) {  // "<collection hash>:<overlay hash>"
                auto colon = k.find(':');
                auto collection = static_cast<Hash>(std::strtoul(k.substr(0, colon).c_str(), nullptr, 10));
                PED::ADD_PED_DECORATION_FROM_HASHES(ped, collection, static_cast<Hash>(o.asInt()));
            }
        }
    }
    if (const Value* v = props::find(p, prop::HairColor); v && v->kind == Kind::Array) {
        PED::SET_PED_HAIR_TINT(ped, static_cast<int>(props::at(*v, 0)), static_cast<int>(props::at(*v, 1)));
    }
    if (const Value* v = props::find(p, prop::EyeColor)) PED::SET_HEAD_BLEND_EYE_COLOR(ped, static_cast<int>(v->asInt()));
    if (const Value* v = props::find(p, prop::Alpha)) {
        int alpha = static_cast<int>(v->asInt());
        if (alpha >= 255) ENTITY::RESET_ENTITY_ALPHA(ped);
        else ENTITY::SET_ENTITY_ALPHA(ped, alpha, false);
    }
}

// ------------------------------------------------------------------ vehicles

Vehicle GameClient::spawnRemoteVehicle(RemoteVehicle& v) {
    if (!ensureModel(v.model)) return 0;
    const bool synced = !v.samples.empty();
    Vec3 pos = synced ? v.samples.back().pos : v.spawnPos;
    Vehicle veh = VEHICLE::CREATE_VEHICLE(v.model, pos.x, pos.y, pos.z, v.spawnRot.z, false, false, false);
    STREAMING::SET_MODEL_AS_NO_LONGER_NEEDED(v.model);
    if (!veh) return 0;
    ENTITY::SET_ENTITY_AS_MISSION_ENTITY(veh, true, true);
    if (synced) {
        const Quat& q = v.samples.back().rot;
        ENTITY::SET_ENTITY_QUATERNION(veh, q.x, q.y, q.z, q.w);
    } else {
        ENTITY::SET_ENTITY_ROTATION(veh, v.spawnRot.x, v.spawnRot.y, v.spawnRot.z, 2, true);
    }
    VEHICLE::SET_VEHICLE_HAS_BEEN_OWNED_BY_PLAYER(veh, true);
    VEHICLE::SET_VEHICLE_NEEDS_TO_BE_HOTWIRED(veh, false);
    VEHICLE::SET_VEHICLE_IS_STOLEN(veh, false);
    VEHICLE::SET_VEHICLE_DOORS_LOCKED(veh, 1);
    v.appliedFlags = 0xFFFF;
    v.appliedDoors = -1;
    applyVehicleProps(veh, v.props, &v);
    // A freshly created vehicle (nobody has synced it yet) is placed on its wheels.
    if (!synced && !props::find(v.props, prop::Rotation)) {
        // A frozen (non-movable) vehicle, such as a car parked in a garage, is let go for a moment to settle.
        const Value* movable = props::find(v.props, prop::Movable);
        const bool frozen = movable && movable->asNumber() == 0;
        if (frozen) ENTITY::FREEZE_ENTITY_POSITION(veh, false);
        VEHICLE::SET_VEHICLE_ON_GROUND_PROPERLY(veh, 5.0f);
        if (frozen) ENTITY::FREEZE_ENTITY_POSITION(veh, true);
    }

    for (auto& [pid, r] : players_)
        if (r.ped && r.vehicle == v.id) PED::SET_PED_INTO_VEHICLE(r.ped, veh, gtaSeat(r.seat));
    return veh;
}

void GameClient::updateRemoteVehicle(RemoteVehicle& v) {
    if (!v.handle) return;
    if (v.controlled || (myVehicle_ == v.id && mySeat_ == kSeatDriver)) return;  // simulated here
    const auto now = Clock::now();
    pruneSamples(v.samples, now);
    if (v.samples.empty()) return;
    Vehicle veh = v.handle;
    const Sample& s = v.samples.back();

    // Projective velocity blending: aim at where the vehicle is now.
    auto dt = std::min<Clock::duration>(now - s.at, kVehMaxExtrapolation);
    Vec3 target = add(s.pos, scale(s.vel, seconds(dt)));
    Vec3 here = toVec(ENTITY::GET_ENTITY_COORDS(veh, true));
    Vec3 err = sub(target, here);
    if (length(err) > kTeleportDistance) {
        ENTITY::SET_ENTITY_COORDS_NO_OFFSET(veh, target.x, target.y, target.z, false, false, false);
        ENTITY::SET_ENTITY_QUATERNION(veh, s.rot.x, s.rot.y, s.rot.z, s.rot.w);
        ENTITY::SET_ENTITY_VELOCITY(veh, s.vel.x, s.vel.y, s.vel.z);
    } else {
        Vec3 corr = scale(err, kVehicleCorrection);
        if (float l = length(corr); l > kMaxCorrectionSpeed) corr = scale(corr, kMaxCorrectionSpeed / l);
        Vec3 vel = add(s.vel, corr);
        ENTITY::SET_ENTITY_VELOCITY(veh, vel.x, vel.y, vel.z);
        Quat q;
        ENTITY::GET_ENTITY_QUATERNION(veh, &q.x, &q.y, &q.z, &q.w);
        q = slerp(normalize(q), normalize(s.rot), kRotationBlend);
        ENTITY::SET_ENTITY_QUATERNION(veh, q.x, q.y, q.z, q.w);
    }

    const uint16_t f = v.flags, changed = f ^ v.appliedFlags;
    if (changed & veh::EngineOn) VEHICLE::SET_VEHICLE_ENGINE_ON(veh, (f & veh::EngineOn) != 0, true, true);
    if (changed & veh::LightsOn) VEHICLE::SET_VEHICLE_LIGHTS(veh, (f & veh::LightsOn) ? 2 : 1);
    if (changed & veh::HighBeams) VEHICLE::SET_VEHICLE_FULLBEAM(veh, (f & veh::HighBeams) != 0);
    if (changed & veh::Siren) VEHICLE::SET_VEHICLE_SIREN(veh, (f & veh::Siren) != 0);
    if ((f & veh::Horn) && !AUDIO::IS_HORN_ACTIVE(veh)) VEHICLE::START_VEHICLE_HORN(veh, 250, joaat("HELDDOWN"), false);
    v.appliedFlags = f;
    // Steering input is -1 (left) .. 1 (right); a positive steer bias turns left.
    VEHICLE::SET_VEHICLE_STEER_BIAS(veh, -v.steer);
    if (v.bodyHealth < VEHICLE::GET_VEHICLE_BODY_HEALTH(veh)) VEHICLE::SET_VEHICLE_BODY_HEALTH(veh, v.bodyHealth);
    if (v.engineHealth < VEHICLE::GET_VEHICLE_ENGINE_HEALTH(veh)) VEHICLE::SET_VEHICLE_ENGINE_HEALTH(veh, v.engineHealth);
}

void GameClient::applyVehicleProps(Vehicle veh, const Props& p, RemoteVehicle* rv) {
    using Kind = Value::Kind;
    if (rv) {
        if (const Value* m = props::find(p, prop::Model); m && static_cast<Hash>(m->asInt()) != rv->model) {
            rv->model = static_cast<Hash>(m->asInt());
            despawnVehicle(*rv);  // recreated with the new model next frame
            return;
        }
    }
    if (const Value* v = props::find(p, prop::Colors); v && v->kind == Kind::Array) {
        VEHICLE::SET_VEHICLE_COLOURS(veh, static_cast<int>(props::at(*v, 0)), static_cast<int>(props::at(*v, 1)));
    }
    if (auto it = p.find(prop::ColorRGB); it != p.end()) {
        const Value& v = it->second;
        if (v.kind == Kind::Array && v.arr.size() >= 6) {
            auto c = [&](std::size_t i) { return static_cast<int>(props::at(v, i)); };
            VEHICLE::SET_VEHICLE_CUSTOM_PRIMARY_COLOUR(veh, c(0), c(1), c(2));
            VEHICLE::SET_VEHICLE_CUSTOM_SECONDARY_COLOUR(veh, c(3), c(4), c(5));
        } else {
            VEHICLE::CLEAR_VEHICLE_CUSTOM_PRIMARY_COLOUR(veh);
            VEHICLE::CLEAR_VEHICLE_CUSTOM_SECONDARY_COLOUR(veh);
        }
    }
    if (const Value* v = props::find(p, prop::Paint); v && v->kind == Kind::Array && v->arr.size() >= 4) {
        auto c = [&](std::size_t i) { return static_cast<int>(props::at(*v, i)); };
        VEHICLE::SET_VEHICLE_MOD_COLOR_1(veh, c(0), c(1), 0);
        VEHICLE::SET_VEHICLE_MOD_COLOR_2(veh, c(2), c(3));
    }
    if (props::find(p, prop::PearlColor) || props::find(p, prop::WheelColor)) {
        int pearl = 0, wheel = 0;
        VEHICLE::GET_VEHICLE_EXTRA_COLOURS(veh, &pearl, &wheel);
        VEHICLE::SET_VEHICLE_EXTRA_COLOURS(veh, props::integer(p, prop::PearlColor, pearl), props::integer(p, prop::WheelColor, wheel));
    }
    if (const Value* v = props::find(p, prop::TrimColor)) VEHICLE::SET_VEHICLE_EXTRA_COLOUR_5(veh, static_cast<int>(v->asInt()));
    if (const Value* v = props::find(p, prop::DashboardColor)) VEHICLE::SET_VEHICLE_EXTRA_COLOUR_6(veh, static_cast<int>(v->asInt()));
    if (const Value* v = props::find(p, prop::NumberPlate); v && v->kind == Kind::String)
        VEHICLE::SET_VEHICLE_NUMBER_PLATE_TEXT(veh, v->s.c_str());
    if (const Value* v = props::find(p, prop::NumberPlateType)) VEHICLE::SET_VEHICLE_NUMBER_PLATE_TEXT_INDEX(veh, static_cast<int>(v->asInt()));
    if (const Value* v = props::find(p, prop::Engine)) {
        bool on = v->asNumber() != 0;
        VEHICLE::SET_VEHICLE_ENGINE_ON(veh, on, true, true);
        if (rv) rv->flags = on ? (rv->flags | veh::EngineOn) : (rv->flags & ~veh::EngineOn);
    }
    if (const Value* v = props::find(p, prop::Locked)) VEHICLE::SET_VEHICLE_DOORS_LOCKED(veh, v->asNumber() != 0 ? 2 : 1);
    if (const Value* v = props::find(p, prop::BodyHealth)) {
        VEHICLE::SET_VEHICLE_BODY_HEALTH(veh, static_cast<float>(v->asNumber()));
        if (rv) rv->bodyHealth = static_cast<float>(v->asNumber());
    }
    if (const Value* v = props::find(p, prop::EngineHealth)) {
        VEHICLE::SET_VEHICLE_ENGINE_HEALTH(veh, static_cast<float>(v->asNumber()));
        if (rv) rv->engineHealth = static_cast<float>(v->asNumber());
    }
    if (const Value* v = props::find(p, prop::WheelType)) VEHICLE::SET_VEHICLE_WHEEL_TYPE(veh, static_cast<int>(v->asInt()));
    if (const Value* v = props::find(p, prop::Mods); v && v->kind == Kind::Map) {
        VEHICLE::SET_VEHICLE_MOD_KIT(veh, 0);
        for (const auto& [k, idx] : v->map) {
            int type = props::key(k), index = static_cast<int>(idx.asInt());
            if (type == 18 || type == 20 || type == 22) {
                VEHICLE::TOGGLE_VEHICLE_MOD(veh, type, index >= 0);  // toggles: turbo, tyre smoke, xenon
            } else {
                VEHICLE::SET_VEHICLE_MOD(veh, type, index, props::flag(p, prop::CustomTires, false));
            }
        }
    }
    if (const Value* v = props::find(p, prop::Extras); v && v->kind == Kind::Map) {
        for (const auto& [k, on] : v->map) VEHICLE::SET_VEHICLE_EXTRA(veh, props::key(k), on.asNumber() == 0);
    }
    if (const Value* v = props::find(p, prop::Livery)) VEHICLE::SET_VEHICLE_LIVERY(veh, static_cast<int>(v->asInt()));
    if (const Value* v = props::find(p, prop::WindowTint)) VEHICLE::SET_VEHICLE_WINDOW_TINT(veh, static_cast<int>(v->asInt()));
    if (const Value* v = props::find(p, prop::Neon); v && v->kind == Kind::Array && v->arr.size() >= 4) {
        bool on = props::at(*v, 0) != 0;
        for (int i = 0; i < 4; ++i) VEHICLE::SET_VEHICLE_NEON_ENABLED(veh, i, on);
        VEHICLE::SET_VEHICLE_NEON_COLOUR(veh, static_cast<int>(props::at(*v, 1)), static_cast<int>(props::at(*v, 2)),
                                         static_cast<int>(props::at(*v, 3)));
    }
    if (const Value* v = props::find(p, prop::Siren)) VEHICLE::SET_VEHICLE_SIREN(veh, v->asNumber() != 0);
    if (const Value* v = props::find(p, prop::TaxiLights)) VEHICLE::SET_TAXI_LIGHTS(veh, v->asNumber() != 0);
    if (const Value* v = props::find(p, prop::Movable)) ENTITY::FREEZE_ENTITY_POSITION(veh, v->asNumber() == 0);
    if (const Value* v = props::find(p, prop::Alpha)) {
        int alpha = static_cast<int>(v->asInt());
        if (alpha >= 255) ENTITY::RESET_ENTITY_ALPHA(veh);
        else ENTITY::SET_ENTITY_ALPHA(veh, alpha, false);
    }
    // Script teleports apply when nobody drives the vehicle (a driver syncs it).
    const bool driverless = VEHICLE::GET_PED_IN_VEHICLE_SEAT(veh, kSeatDriverGta, false) == 0;
    if (driverless) {
        if (const Value* v = props::find(p, prop::Position); v && v->kind == Kind::Vec3) {
            ENTITY::SET_ENTITY_COORDS_NO_OFFSET(veh, v->v.x, v->v.y, v->v.z, false, false, false);
            ENTITY::SET_ENTITY_VELOCITY(veh, 0, 0, 0);
            if (rv) {
                rv->samples.clear();
                rv->spawnPos = v->v;
            }
        }
        if (const Value* v = props::find(p, prop::Rotation); v && v->kind == Kind::Vec3) {
            ENTITY::SET_ENTITY_ROTATION(veh, v->v.x, v->v.y, v->v.z, 2, true);
            if (rv) rv->spawnRot = v->v;
        }
    }
    if (const Value* v = props::find(p, prop::Dead); v && v->asNumber() != 0 && !ENTITY::IS_ENTITY_DEAD(veh, false)) {
        VEHICLE::EXPLODE_VEHICLE(veh, false, true);
    }
}

void GameClient::despawnVehicle(RemoteVehicle& v) {
    if (!v.handle) return;
    Vehicle veh = v.handle;
    if (ENTITY::DOES_ENTITY_EXIST(veh)) {
        // Get everyone out first so they are not deleted with the vehicle.
        Ped me = PLAYER::PLAYER_PED_ID();
        if (PED::IS_PED_IN_VEHICLE(me, veh, false)) {
            TASK::CLEAR_PED_TASKS_IMMEDIATELY(me);
            if (myVehicle_ == v.id) myVehicle_ = kNoID;
        }
        for (auto& [pid, r] : players_)
            if (r.ped && PED::IS_PED_IN_VEHICLE(r.ped, veh, false)) TASK::CLEAR_PED_TASKS_IMMEDIATELY(r.ped);
    }
    deleteEntity(veh);
    v.handle = 0;
    v.appliedFlags = 0xFFFF;
    v.appliedDoors = -1;
}

}  // namespace gompgame
