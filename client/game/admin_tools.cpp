// Admin tools on the client (server side: admin.js):
//   /fly   — the shared variable "fly": the ped flies through walls where the camera
//            looks (W/S/A/D, Space up, Ctrl down, Shift faster); the server turns its
//            movement checks off meanwhile.
//   /invis — "invisible": others see nothing (alpha 0 from the server), no name tag and
//            no map blip; the admin sees himself faded.
//   /tpm   — gomp:admin:tpm: the waypoint of the map. The server first moves the admin
//            high above it; once the ground there has streamed in, the client asks for
//            the spot on it (gomp:admin:tpm:go).
#include <cmath>

#include "game_client.hpp"
#include "natives.hpp"
#include "props.hpp"

namespace gompgame {

using namespace gomp;

namespace {

constexpr int kWaypointSprite = 8;
constexpr float kProbeHeight = 800.0f;   // where the admin waits for the ground to stream in
constexpr DWORD kGroundTimeoutMs = 6000;
constexpr float kFlySpeed = 14.0f, kFlyFast = 4.0f;
constexpr int kSelfFadedAlpha = 110;
constexpr int kInputMoveLR = 30, kInputMoveUD = 31, kInputSprint = 21, kInputJump = 22, kInputDuck = 36;

bool flag(const KV& kv, const char* key) {
    const Value* v = props::shared(kv, key);
    return v && v->kind == Value::Kind::Bool && v->b;
}

}  // namespace

bool GameClient::handleAdminEvent(const ScriptEvent& e) {
    if (e.name != "gomp:admin:tpm") return false;
    if (!HUD::IS_WAYPOINT_ACTIVE()) {
        send(ScriptEvent{"gomp:admin:tpm:none", {}});
        return true;
    }
    const Vector3 w = HUD::GET_BLIP_INFO_ID_COORD(HUD::GET_FIRST_BLIP_INFO_ID(kWaypointSprite));
    tpmX_ = w.x;
    tpmY_ = w.y;
    tpmPending_ = true;
    tpmAt_ = GetTickCount();
    send(ScriptEvent{"gomp:admin:tpm:go", {Value::number(tpmX_), Value::number(tpmY_), Value::number(kProbeHeight)}});
    return true;
}

void GameClient::tickAdmin() {
    const Ped me = PLAYER::PLAYER_PED_ID();

    // Teleport to the waypoint: wait high above it until the ground is known.
    if (tpmPending_) {
        STREAMING::REQUEST_COLLISION_AT_COORD(tpmX_, tpmY_, 100.0f);
        ENTITY::FREEZE_ENTITY_POSITION(me, true);
        float gz = 0;
        const bool found = MISC::GET_GROUND_Z_FOR_3D_COORD(tpmX_, tpmY_, kProbeHeight, &gz, false, false);
        const bool late = GetTickCount() - tpmAt_ > kGroundTimeoutMs;
        if (found || late) {
            tpmPending_ = false;
            ENTITY::FREEZE_ENTITY_POSITION(me, false);
            // Not found in time (water, the sea): a little above sea level.
            send(ScriptEvent{"gomp:admin:tpm:go", {Value::number(tpmX_), Value::number(tpmY_), Value::number(found ? gz + 1.0f : 2.0f)}});
        }
    }

    // Invisible: others see nothing; the admin sees himself faded.
    static bool fadedSelf = false;
    if (flag(selfShared_, "invisible")) {
        ENTITY::SET_ENTITY_ALPHA(me, kSelfFadedAlpha, false);
        fadedSelf = true;
    } else if (fadedSelf) {
        ENTITY::RESET_ENTITY_ALPHA(me);
        fadedSelf = false;
    }
    // Invisible players have no blip on the map.
    for (auto& [id, r] : players_) {
        if (!r.blip) continue;
        const bool hide = flag(r.shared, "invisible");
        if (hide != r.blipHidden) {
            HUD::SET_BLIP_DISPLAY(r.blip, hide ? 0 : 2);
            r.blipHidden = hide;
        }
    }

    // Flight.
    const bool fly = flag(selfShared_, "fly") && !dead_;
    if (fly != flying_) {
        flying_ = fly;
        ENTITY::SET_ENTITY_COLLISION(me, !fly, !fly);
        ENTITY::SET_ENTITY_INVINCIBLE(me, fly, false);
        if (!fly) ENTITY::FREEZE_ENTITY_POSITION(me, false);
    }
    if (!flying_ || PED::IS_PED_IN_ANY_VEHICLE(me, false)) return;
    for (int c : {kInputMoveLR, kInputMoveUD, kInputSprint, kInputJump, kInputDuck}) PAD::DISABLE_CONTROL_ACTION(0, c, true);
    const bool typing = uiBlocksPause();  // a window, the chat or the console is open
    const Vector3 rot = CAMERA::GET_GAMEPLAY_CAM_ROT(2);
    const float pitch = rot.x * 3.14159265f / 180.0f, yaw = rot.z * 3.14159265f / 180.0f;
    const float fwd = typing ? 0.0f : -PAD::GET_DISABLED_CONTROL_NORMAL(0, kInputMoveUD);
    const float side = typing ? 0.0f : PAD::GET_DISABLED_CONTROL_NORMAL(0, kInputMoveLR);
    float up = 0;
    if (!typing && PAD::IS_DISABLED_CONTROL_PRESSED(0, kInputJump)) up += 1;
    if (!typing && PAD::IS_DISABLED_CONTROL_PRESSED(0, kInputDuck)) up -= 1;
    const float speed = kFlySpeed * (!typing && PAD::IS_DISABLED_CONTROL_PRESSED(0, kInputSprint) ? kFlyFast : 1.0f) * MISC::GET_FRAME_TIME();
    const float fx = -std::sin(yaw) * std::cos(pitch), fy = std::cos(yaw) * std::cos(pitch), fz = std::sin(pitch);
    const float rx = std::cos(yaw), ry = std::sin(yaw);
    Vector3 p = ENTITY::GET_ENTITY_COORDS(me, true);
    p.x += (fx * fwd + rx * side) * speed;
    p.y += (fy * fwd + ry * side) * speed;
    p.z += (fz * fwd + up) * speed;
    ENTITY::SET_ENTITY_VELOCITY(me, 0, 0, 0);
    ENTITY::SET_ENTITY_COORDS_NO_OFFSET(me, p.x, p.y, p.z, false, false, false);
    ENTITY::SET_ENTITY_HEADING(me, rot.z);
}

}  // namespace gompgame
