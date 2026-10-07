// Local player: outgoing sync, shooting, hit detection, vehicles, self damage.
#include <cmath>

#include "game_client.hpp"
#include "natives.hpp"

namespace gompgame {

using namespace gomp;

namespace {
constexpr int kInputEnter = 23;           // INPUT_ENTER (F)
constexpr int kInputVehExit = 75;         // INPUT_VEH_EXIT (F in vehicles)
constexpr int kInputVehAccelerate = 71;   // INPUT_VEH_ACCELERATE
constexpr int kInputVehBrake = 72;        // INPUT_VEH_BRAKE
constexpr int kInputVehMoveLR = 59;       // INPUT_VEH_MOVE_LR
constexpr int kSkelRightHand = 57005;

Vec3 toVec(const Vector3& v) { return {v.x, v.y, v.z}; }

uint16_t pedFlags(Ped p) {
    uint16_t f = 0;
    Player me = PLAYER::PLAYER_ID();
    if (PLAYER::IS_PLAYER_FREE_AIMING(me)) f |= ped::Aiming;
    if (PED::IS_PED_RELOADING(p)) f |= ped::Reloading;
    if (PED::IS_PED_IN_MELEE_COMBAT(p)) f |= ped::InMelee;
    if (PED::IS_PED_JUMPING(p)) f |= ped::Jumping;
    if (PED::IS_PED_CLIMBING(p)) f |= ped::Climbing;
    if (PED::IS_PED_IN_COVER(p, false)) f |= ped::InCover;
    if (PED::IS_PED_DUCKING(p)) f |= ped::Crouching;
    if (PED::IS_PED_RAGDOLL(p)) f |= ped::Ragdoll;
    if (PED::IS_PED_FALLING(p)) f |= ped::Falling;
    if (PED::IS_PED_SWIMMING(p)) f |= ped::Swimming;
    if (PED::IS_PED_IN_PARACHUTE_FREE_FALL(p)) f |= ped::Parachuting;
    if (TASK::GET_IS_TASK_ACTIVE(p, 160)) f |= ped::EnteringVehicle;  // CTaskEnterVehicle
    if (TASK::GET_IS_TASK_ACTIVE(p, 2)) f |= ped::LeavingVehicle;     // CTaskExitVehicle
    return f;
}

// Where the player aims: the camera ray hit point, or 100 m along the camera.
Vec3 aimPoint() {
    Vector3 cam = CAMERA::GET_GAMEPLAY_CAM_COORD();
    Vector3 rot = CAMERA::GET_GAMEPLAY_CAM_ROT(2);
    double rx = rot.x * 3.14159265358979 / 180, rz = rot.z * 3.14159265358979 / 180;
    double cx = std::cos(rx);
    Vec3 dir{static_cast<float>(-std::sin(rz) * cx), static_cast<float>(std::cos(rz) * cx), static_cast<float>(std::sin(rx))};
    return {cam.x + dir.x * 100, cam.y + dir.y * 100, cam.z + dir.z * 100};
}

}  // namespace

void GameClient::syncLocal() {
    Ped me = PLAYER::PLAYER_PED_ID();
    if (teleportPending_) return;
    if (PED::IS_PED_IN_ANY_VEHICLE(me, false)) {
        Vehicle veh = PED::GET_VEHICLE_PED_IS_IN(me, false);
        if (myVehicle_ == kNoID) return;  // entered without the server's permission
        if (mySeat_ == kSeatDriver && VEHICLE::GET_PED_IN_VEHICLE_SEAT(veh, -1, false) == me) {
            sendVehicleSync(veh);
        } else {
            PassengerSync ps;
            ps.vehicleId = myVehicle_;
            ps.seat = mySeat_;
            ps.time = clock();
            ps.flags = pedFlags(me) & (ped::Aiming | ped::Reloading);
            Hash w = 0;
            WEAPON::GET_CURRENT_PED_WEAPON(me, &w, true);
            ps.weapon = w;
            if (ps.flags & ped::Aiming) ps.aimPos = aimPoint();
            send(ps, Channel::Unreliable);
        }
        return;
    }
    PedSync ps;
    ps.time = clock();
    ps.pos = toVec(ENTITY::GET_ENTITY_COORDS(me, true));
    ps.vel = toVec(ENTITY::GET_ENTITY_VELOCITY(me));
    ps.heading = ENTITY::GET_ENTITY_HEADING(me);
    float speed = std::sqrt(ps.vel.x * ps.vel.x + ps.vel.y * ps.vel.y);
    ps.move = speed < 0.3f ? MoveState::Idle : speed < 2.5f ? MoveState::Walk : speed < 5.5f ? MoveState::Run : MoveState::Sprint;
    ps.flags = pedFlags(me);
    Hash w = 0;
    WEAPON::GET_CURRENT_PED_WEAPON(me, &w, true);
    ps.weapon = w;
    if (ps.flags & ped::Aiming) ps.aimPos = aimPoint();
    send(ps, Channel::Unreliable);
}

void GameClient::sendVehicleSync(Vehicle veh) {
    Ped me = PLAYER::PLAYER_PED_ID();
    VehicleSync vs;
    vs.vehicleId = myVehicle_;
    vs.time = clock();
    vs.pos = toVec(ENTITY::GET_ENTITY_COORDS(veh, true));
    ENTITY::GET_ENTITY_QUATERNION(veh, &vs.rot.x, &vs.rot.y, &vs.rot.z, &vs.rot.w);
    vs.vel = toVec(ENTITY::GET_ENTITY_VELOCITY(veh));
    vs.angVel = toVec(ENTITY::GET_ENTITY_ROTATION_VELOCITY(veh));
    vs.steer = PAD::GET_CONTROL_NORMAL(0, kInputVehMoveLR);
    vs.gas = PAD::GET_CONTROL_NORMAL(0, kInputVehAccelerate) - PAD::GET_CONTROL_NORMAL(0, kInputVehBrake);
    vs.brake = 0;
    BOOL lights = FALSE, high = FALSE;
    VEHICLE::GET_VEHICLE_LIGHTS_STATE(veh, &lights, &high);
    if (VEHICLE::GET_IS_VEHICLE_ENGINE_RUNNING(veh)) vs.flags |= veh::EngineOn;
    if (lights) vs.flags |= veh::LightsOn;
    if (high) vs.flags |= veh::HighBeams;
    if (AUDIO::IS_HORN_ACTIVE(veh)) vs.flags |= veh::Horn;
    if (VEHICLE::IS_VEHICLE_SIREN_ON(veh)) vs.flags |= veh::Siren;
    if (ENTITY::IS_ENTITY_DEAD(veh, false)) vs.flags |= veh::Destroyed;
    vs.bodyHealth = VEHICLE::GET_VEHICLE_BODY_HEALTH(veh);
    vs.engineHealth = VEHICLE::GET_VEHICLE_ENGINE_HEALTH(veh);
    if (PLAYER::IS_PLAYER_FREE_AIMING(PLAYER::PLAYER_ID())) {
        vs.flags |= veh::DriverAiming;
        Hash w = 0;
        WEAPON::GET_CURRENT_PED_WEAPON(me, &w, true);
        vs.weapon = w;
        vs.aimPos = aimPoint();
    }
    send(vs, Channel::Unreliable);
}

void GameClient::sendControlledVehicles() {
    for (auto& [id, v] : vehicles_) {
        if (!v.controlled || !v.handle || v.id == myVehicle_) continue;
        Vector3 vel = ENTITY::GET_ENTITY_VELOCITY(v.handle);
        // Parked vehicles only need an occasional update.
        bool moving = std::fabs(vel.x) + std::fabs(vel.y) + std::fabs(vel.z) > 0.05f;
        if (!moving && (clock() / 33) % 30 != 0) continue;
        UnoccupiedSync us;
        us.vehicleId = id;
        us.time = clock();
        us.pos = toVec(ENTITY::GET_ENTITY_COORDS(v.handle, true));
        ENTITY::GET_ENTITY_QUATERNION(v.handle, &us.rot.x, &us.rot.y, &us.rot.z, &us.rot.w);
        us.vel = toVec(vel);
        us.angVel = toVec(ENTITY::GET_ENTITY_ROTATION_VELOCITY(v.handle));
        send(us, Channel::Unreliable);
    }
}

void GameClient::detectShots() {
    Ped me = PLAYER::PLAYER_PED_ID();
    if (!PED::IS_PED_SHOOTING(me)) return;
    Hash weapon = 0;
    WEAPON::GET_CURRENT_PED_WEAPON(me, &weapon, true);
    WeaponShot shot;
    shot.seq = ++shotSeq_;
    shot.time = clock();
    shot.weapon = weapon;
    shot.origin = toVec(PED::GET_PED_BONE_COORDS(me, kSkelRightHand, 0, 0, 0));
    Vector3 impact{};
    shot.target = WEAPON::GET_PED_LAST_WEAPON_IMPACT_COORD(me, &impact) ? toVec(impact) : aimPoint();
    lastShotAt_ = Clock::now();
    // Shots and hits share the reliable channel so a hit never overtakes its shot.
    send(shot, Channel::Reliable);
}

void GameClient::detectHits() {
    Ped me = PLAYER::PLAYER_PED_ID();
    Hash weapon = 0;
    WEAPON::GET_CURRENT_PED_WEAPON(me, &weapon, true);
    bool melee = PED::IS_PED_IN_MELEE_COMBAT(me);
    bool recentShot = Clock::now() - lastShotAt_ < std::chrono::milliseconds(500);
    for (auto& [id, r] : players_) {
        if (!r.ped || !ENTITY::HAS_ENTITY_BEEN_DAMAGED_BY_ENTITY(r.ped, me, true)) continue;
        int bone = 0;
        PED::GET_PED_LAST_DAMAGE_BONE(r.ped, &bone);
        ENTITY::CLEAR_ENTITY_LAST_DAMAGE_ENTITY(r.ped);
        // Undo the local damage: the server decides health and death.
        if (!r.dead) ENTITY::SET_ENTITY_HEALTH(r.ped, 1000, 0, 0);
        if (!recentShot && !melee) continue;
        WeaponHit hit;
        hit.shotSeq = shotSeq_;
        hit.weapon = weapon;
        hit.flags = recentShot ? 0 : 1;
        hit.targetType = EntityType::Player;
        hit.targetId = id;
        hit.bone = static_cast<uint16_t>(bone);
        hit.hitPos = toVec(ENTITY::GET_ENTITY_COORDS(r.ped, true));
        send(hit, Channel::Reliable);
    }
    for (auto& [id, v] : vehicles_) {
        if (!v.handle || !ENTITY::HAS_ENTITY_BEEN_DAMAGED_BY_ENTITY(v.handle, me, true)) continue;
        ENTITY::CLEAR_ENTITY_LAST_DAMAGE_ENTITY(v.handle);
        if (!recentShot) continue;
        WeaponHit hit;
        hit.shotSeq = shotSeq_;
        hit.weapon = weapon;
        hit.targetType = EntityType::Vehicle;
        hit.targetId = id;
        hit.hitPos = toVec(ENTITY::GET_ENTITY_COORDS(v.handle, true));
        send(hit, Channel::Reliable);
    }
}

void GameClient::detectSelfDamage() {
    Ped me = PLAYER::PLAYER_PED_ID();
    if (dead_) return;
    int hp = ENTITY::GET_ENTITY_HEALTH(me);
    int armour = PED::GET_PED_ARMOUR(me);
    if (lastLocalHealth_ < 0) lastLocalHealth_ = hp;
    int healthLoss = std::max(0, lastLocalHealth_ - hp);
    int armourLoss = std::max(0, serverArmour_ - armour);
    if (healthLoss > 0 || armourLoss > 0) {
        SelfDamage d;
        if (FIRE::IS_ENTITY_ON_FIRE(me)) d.cause = DamageCause::Fire;
        else if (ENTITY::IS_ENTITY_IN_WATER(me) && PED::IS_PED_SWIMMING_UNDER_WATER(me)) d.cause = DamageCause::Drown;
        else if (PED::IS_PED_IN_ANY_VEHICLE(me, false) || ENTITY::HAS_ENTITY_BEEN_DAMAGED_BY_ANY_VEHICLE(me)) d.cause = DamageCause::Vehicle;
        else if (PED::IS_PED_FALLING(me) || PED::IS_PED_RAGDOLL(me)) d.cause = DamageCause::Fall;
        else d.cause = DamageCause::Explosion;
        d.health = static_cast<uint8_t>(std::min(255, healthLoss));
        d.armour = static_cast<uint8_t>(std::min(255, armourLoss));
        send(d, Channel::Reliable);
        // Keep the server's values until it confirms the new ones.
        ENTITY::SET_ENTITY_HEALTH(me, 100 + serverHealth_, 0, 0);
        PED::SET_PED_ARMOUR(me, serverArmour_);
        ENTITY::CLEAR_ENTITY_LAST_DAMAGE_ENTITY(me);
        hp = ENTITY::GET_ENTITY_HEALTH(me);
    }
    lastLocalHealth_ = hp;
}

Vehicle GameClient::vehicleHandle(uint16_t id) const {
    auto it = vehicles_.find(id);
    return it == vehicles_.end() ? 0 : it->second.handle;
}

void GameClient::handleVehicleKeys() {
    Ped me = PLAYER::PLAYER_PED_ID();
    bool inVeh = PED::IS_PED_IN_ANY_VEHICLE(me, false);
    // The server decides who may enter: the game's own F handling is disabled.
    PAD::DISABLE_CONTROL_ACTION(0, kInputEnter, true);
    if (!inVeh && enteringVehicle_ == kNoID && PAD::IS_DISABLED_CONTROL_JUST_PRESSED(0, kInputEnter)) {
        Vector3 pos = ENTITY::GET_ENTITY_COORDS(me, true);
        uint16_t best = kNoID;
        float bestD = 8.0f * 8.0f;
        for (auto& [id, v] : vehicles_) {
            if (!v.handle) continue;
            Vector3 vp = ENTITY::GET_ENTITY_COORDS(v.handle, true);
            float dx = vp.x - pos.x, dy = vp.y - pos.y, dz = vp.z - pos.z;
            float d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < bestD) {
                bestD = d2;
                best = id;
            }
        }
        if (best != kNoID) send(EnterVehicleRequest{best, kSeatAny});
    }
    // Progress of a running enter task.
    if (enteringVehicle_ != kNoID) {
        Vehicle veh = vehicleHandle(enteringVehicle_);
        if (veh && PED::IS_PED_IN_VEHICLE(me, veh, false)) {
            send(EnterVehicleComplete{enteringVehicle_, enteringSeat_, false});
            myVehicle_ = enteringVehicle_;
            mySeat_ = enteringSeat_;
            enteringVehicle_ = kNoID;
        } else if (!veh || Clock::now() - enterStarted_ > std::chrono::seconds(8) ||
                   (Clock::now() - enterStarted_ > std::chrono::milliseconds(500) && !TASK::GET_IS_TASK_ACTIVE(me, 160))) {
            send(EnterVehicleComplete{enteringVehicle_, enteringSeat_, true});
            enteringVehicle_ = kNoID;
        }
    }
    // Leaving: F inside a vehicle.
    if (inVeh) {
        PAD::DISABLE_CONTROL_ACTION(0, kInputVehExit, true);
        if (!exiting_ && PAD::IS_DISABLED_CONTROL_JUST_PRESSED(0, kInputVehExit)) {
            exiting_ = true;
            send(ExitVehicleRequest{});
            TASK::TASK_LEAVE_VEHICLE(me, PED::GET_VEHICLE_PED_IS_IN(me, false), 0);
        }
    } else if (exiting_ || myVehicle_ != kNoID) {
        // Out of the vehicle (task finished, thrown out or warped).
        exiting_ = false;
        if (myVehicle_ != kNoID) send(ExitVehicleComplete{});
        myVehicle_ = kNoID;
    }
    // A putIntoVehicle that arrived before the vehicle was spawned.
    if (pendingPutVehicle_ != kNoID) {
        if (Vehicle veh = vehicleHandle(pendingPutVehicle_)) {
            PED::SET_PED_INTO_VEHICLE(me, veh, gtaSeat(pendingPutSeat_));
            myVehicle_ = pendingPutVehicle_;
            mySeat_ = pendingPutSeat_;
            pendingPutVehicle_ = kNoID;
        }
    }
}

}  // namespace gompgame
