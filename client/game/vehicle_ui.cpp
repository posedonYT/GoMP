// Vehicles on the client: fuel and the engine, the seat belt (J), locks (L),
// doors and the vehicle menu (G, a Majestic-style radial menu).
//
// Fuel, owner and open doors are shared variables of the vehicle set by the
// server (server-files/packages/freeroam/vehicles.js). The driver's client
// keeps the engine off while the tank is empty; the engine state reaches the
// server with the driver's sync like any other engine change.
#include <cmath>
#include <cstring>

#include "game_client.hpp"
#include "natives.hpp"
#include "ui.hpp"

namespace gompgame {

using namespace gomp;
using namespace ui;

namespace {

constexpr int kFlagFlyThroughWindscreen = 32;  // CPED_CONFIG_FLAG_WillFlyThroughWindscreen
constexpr int kDoorCount = 6;                  // 0-3 doors, 4 bonnet, 5 boot
constexpr float kMenuRange = 5.0f;
constexpr DWORD kBlinkMs = 700;
constexpr DWORD kFobWaitMs = 2000;
const char* const kFobDict = "anim@mp_player_intmenu@key_fob@";

std::string fixed1(double v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.1f", v);
    return buf;
}

}  // namespace

// ------------------------------------------------------------------ helpers

RemoteVehicle* GameClient::myRemoteVehicle() {
    auto it = vehicles_.find(myVehicle_);
    return it == vehicles_.end() ? nullptr : &it->second;
}

// The closest spawned vehicle within range of the player (kNoID if none).
uint16_t GameClient::nearestVehicle(float range) const {
    Vector3 p = ENTITY::GET_ENTITY_COORDS(PLAYER::PLAYER_PED_ID(), true);
    uint16_t best = kNoID;
    float bestD = range * range;
    for (const auto& [id, v] : vehicles_) {
        if (!v.handle) continue;
        Vector3 vp = ENTITY::GET_ENTITY_COORDS(v.handle, true);
        const float dx = vp.x - p.x, dy = vp.y - p.y, dz = vp.z - p.z, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) {
            bestD = d2;
            best = id;
        }
    }
    return best;
}

// Litres in the tank (the server's shared "fuel"); tank receives the tank size, 0 for bicycles.
float GameClient::vehicleFuel(const RemoteVehicle& v, float* tank) const {
    const Value* f = props::shared(v.shared, "fuel");
    const Value* m = props::shared(v.shared, "fuelMax");
    if (tank) *tank = m ? static_cast<float>(m->asNumber()) : 60.0f;
    return f ? static_cast<float>(f->asNumber()) : 60.0f;
}

std::string GameClient::vehicleName(Vehicle veh) const {
    const char* label = VEHICLE::GET_DISPLAY_NAME_FROM_VEHICLE_MODEL(ENTITY::GET_ENTITY_MODEL(veh));
    const char* text = label ? HUD::GET_FILENAME_FOR_AUDIO_CONVERSATION(label) : nullptr;
    if (text && *text && std::strcmp(text, "NULL") != 0) return text;
    return label && *label ? label : "Транспорт";
}

int GameClient::itemCount(const std::string& key) const {
    int n = 0;
    for (const auto& s : pockets_)
        if (s.key == key) n += s.count;
    for (const auto& s : hotbar_)
        if (s.key == key) n += s.count;
    return n;
}

void GameClient::setBelt(bool on) {
    if (belted_ == on) return;
    belted_ = on;
    AUDIO::PLAY_SOUND_FRONTEND(-1, on ? "NAV_UP_DOWN" : "BACK", "HUD_FRONTEND_DEFAULT_SOUNDSET", true);
    notify(on ? "Вы ~g~пристегнулись" : "Вы ~r~отстегнулись");
}

void GameClient::toggleEngine(Vehicle veh) {
    RemoteVehicle* rv = myRemoteVehicle();
    float tank = 0;
    const float fuel = rv ? vehicleFuel(*rv, &tank) : 1.0f;
    if (VEHICLE::GET_IS_VEHICLE_ENGINE_RUNNING(veh)) {
        // disableAutoStart: the ped does not start it again on the throttle.
        VEHICLE::SET_VEHICLE_ENGINE_ON(veh, false, false, true);
        notify("Двигатель ~r~заглушен");
    } else if (tank > 0 && fuel <= 0) {
        notify("~r~Бак пуст~s~ — заправьтесь на АЗС");
    } else {
        VEHICLE::SET_VEHICLE_ENGINE_ON(veh, true, false, true);
        notify("Двигатель ~g~заведён");
    }
}

// ------------------------------------------------------------------ every frame

void GameClient::tickVehicles() {
    Ped me = PLAYER::PLAYER_PED_ID();
    const bool inVeh = PED::IS_PED_IN_ANY_VEHICLE(me, false);
    const Vehicle veh = inVeh ? PED::GET_VEHICLE_PED_IS_IN(me, false) : 0;
    const bool driver = inVeh && VEHICLE::GET_PED_IN_VEHICLE_SEAT(veh, -1, false) == me;

    // Keys from the keyboard thread (only while no screen is open).
    const bool wantMenu = vehMenuRequested_.exchange(false), wantLock = lockRequested_.exchange(false),
               wantBelt = beltRequested_.exchange(false);
    if (screen_ == Screen::None && !dead_) {
        if (wantLock) send(ScriptEvent{"gomp:veh:lock", {}});
        if (wantBelt) {
            if (inVeh) setBelt(!belted_);
            else notify("Ремень пристёгивается в транспорте");
        }
        if (wantMenu) openVehicleMenu();
    }
    // G also throws/detonates in the game: ours near vehicles.
    if (inVeh || nearestVehicle(kMenuRange) != kNoID) {
        PAD::DISABLE_CONTROL_ACTION(0, 47, true);  // INPUT_DETONATE
        PAD::DISABLE_CONTROL_ACTION(0, 58, true);  // INPUT_THROW_GRENADE
    }

    // Seat belt: a belted ped stays in the seat, an unbelted one flies through the windscreen.
    if (!inVeh) belted_ = false;
    PED::SET_PED_CONFIG_FLAG(me, kFlagFlyThroughWindscreen, inVeh && !belted_);

    // The driver: tank size for the server once, and no engine without fuel.
    if (driver && myVehicle_ != kNoID) {
        if (classSentFor_ != myVehicle_) {
            classSentFor_ = myVehicle_;
            send(ScriptEvent{"gomp:veh:class", {Value::integer(myVehicle_), Value::integer(VEHICLE::GET_VEHICLE_CLASS(veh))}});
        }
        if (RemoteVehicle* rv = myRemoteVehicle()) {
            float tank = 0;
            const float fuel = vehicleFuel(*rv, &tank);
            if (tank > 0 && fuel <= 0) {
                if (VEHICLE::GET_IS_VEHICLE_ENGINE_RUNNING(veh)) VEHICLE::SET_VEHICLE_ENGINE_ON(veh, false, true, true);
                if (fuelEmptyFor_ != myVehicle_) notify("~r~Бак пуст~s~ — заправьтесь на АЗС или канистрой");
                fuelEmptyFor_ = myVehicle_;
            } else if (fuelEmptyFor_ == myVehicle_) {
                // Refuelled: the ped may start the engine on the throttle again.
                VEHICLE::SET_VEHICLE_ENGINE_ON(veh, false, true, false);
                fuelEmptyFor_ = kNoID;
            }
        }
    }

    // Open doors (shared "doors" mask): applied when the mask changes.
    for (auto& [id, v] : vehicles_) {
        if (!v.handle) continue;
        const Value* d = props::shared(v.shared, "doors");
        const int mask = d ? static_cast<int>(d->asInt()) : 0;
        if (mask == v.appliedDoors) continue;
        const int before = v.appliedDoors < 0 ? 0 : v.appliedDoors;
        const bool instant = v.appliedDoors < 0;
        for (int i = 0; i < kDoorCount; ++i) {
            const bool open = mask & (1 << i);
            if (open == static_cast<bool>(before & (1 << i)) && !(instant && open)) continue;
            if (open) VEHICLE::SET_VEHICLE_DOOR_OPEN(v.handle, i, false, instant);
            else VEHICLE::SET_VEHICLE_DOOR_SHUT(v.handle, i, instant);
        }
        v.appliedDoors = mask;
    }

    // The key fob click, once its animation dictionary has streamed in.
    const DWORD now = GetTickCount();
    if (fobRequestedAt_ && now - fobRequestedAt_ < kFobWaitMs) {
        if (STREAMING::HAS_ANIM_DICT_LOADED(kFobDict)) {
            if (!inVeh) TASK::TASK_PLAY_ANIM(me, kFobDict, "fob_click", 8.0f, -8.0f, -1, 48, 0, false, false, false);
            fobRequestedAt_ = 0;
        }
    } else {
        fobRequestedAt_ = 0;
    }

    tickTuningTransition();
    tickTuningResync();

    // Indicators flashing after a lock change.
    std::erase_if(lockBlinks_, [&](const auto& b) {
        if (now - b.second < kBlinkMs) return false;
        if (ENTITY::DOES_ENTITY_EXIST(b.first)) {
            VEHICLE::SET_VEHICLE_INDICATOR_LIGHTS(b.first, 0, false);
            VEHICLE::SET_VEHICLE_INDICATOR_LIGHTS(b.first, 1, false);
        }
        return true;
    });
}

// ------------------------------------------------------------------ server events

bool GameClient::handleVehicleEvent(const ScriptEvent& e) {
    const auto& a = e.args;
    auto vehicleArg = [&]() -> Vehicle {
        if (a.empty()) return 0;
        if (a[0].kind == Value::Kind::Entity) return vehicleHandle(a[0].e.id);
        return vehicleHandle(static_cast<uint16_t>(a[0].asInt()));
    };
    if (e.name == "gomp:veh:lockfx") {
        Vehicle veh = vehicleArg();
        const bool locked = a.size() > 1 && a[1].asNumber() != 0;
        if (veh) {
            VEHICLE::SET_VEHICLE_INDICATOR_LIGHTS(veh, 0, true);
            VEHICLE::SET_VEHICLE_INDICATOR_LIGHTS(veh, 1, true);
            VEHICLE::START_VEHICLE_HORN(veh, locked ? 120 : 60, joaat("HELDDOWN"), false);
            lockBlinks_.emplace_back(veh, GetTickCount());
        }
        // The owner on foot clicks the key fob.
        const Value* statik = props::shared(selfShared_, "static");
        Ped me = PLAYER::PLAYER_PED_ID();
        if (a.size() > 2 && statik && a[2].asInt() == statik->asInt() && !PED::IS_PED_IN_ANY_VEHICLE(me, false)) {
            STREAMING::REQUEST_ANIM_DICT(kFobDict);  // played by tickVehicles: no waiting inside the frame
            fobRequestedAt_ = GetTickCount();
        }
        return true;
    }
    if (e.name == "gomp:veh:fixed") {
        if (Vehicle veh = vehicleArg()) {
            VEHICLE::SET_VEHICLE_FIXED(veh);
            VEHICLE::SET_VEHICLE_DEFORMATION_FIXED(veh);
            VEHICLE::SET_VEHICLE_ENGINE_HEALTH(veh, 1000.0f);
            VEHICLE::SET_VEHICLE_BODY_HEALTH(veh, 1000.0f);
        }
        return true;
    }
    return false;
}

// ------------------------------------------------------------------ G menu

void GameClient::openVehicleMenu() {
    Ped me = PLAYER::PLAYER_PED_ID();
    const bool inVeh = PED::IS_PED_IN_ANY_VEHICLE(me, false) && myVehicle_ != kNoID;
    const uint16_t id = inVeh ? myVehicle_ : nearestVehicle(kMenuRange);
    if (id == kNoID) return;  // G stays the game's key away from vehicles
    menuVehicle_ = id;
    openScreen(Screen::VehMenu);
}

void GameClient::drawVehicleMenu() {
    auto it = vehicles_.find(menuVehicle_);
    Ped me = PLAYER::PLAYER_PED_ID();
    if (it == vehicles_.end() || !it->second.handle) {
        closeScreens();
        menuVehicle_ = kNoID;
        return;
    }
    RemoteVehicle& rv = it->second;
    const Vehicle veh = rv.handle;
    const uint16_t id = rv.id;
    const bool inside = PED::IS_PED_IN_VEHICLE(me, veh, false);
    const bool driver = inside && VEHICLE::GET_PED_IN_VEHICLE_SEAT(veh, -1, false) == me;
    const Value* owner = props::shared(rv.shared, "owner");
    const Value* statik = props::shared(selfShared_, "static");
    const bool mine = owner && statik && owner->asInt() == statik->asInt();
    // Who may lock it (vehicles.js canLock): its owner; anyone when it is nobody's (/veh);
    // members of the organization a work vehicle belongs to.
    const Value* vorg = props::shared(rv.shared, "org");
    const Value* myOrg = props::shared(selfShared_, "org");
    const bool nobodys = (!owner || owner->isNil()) && (!vorg || vorg->isNil());
    const bool ourOrg = vorg && myOrg && vorg->kind == Value::Kind::String && myOrg->kind == Value::Kind::String && vorg->s == myOrg->s;
    const bool canLock = mine || nobodys || ourOrg;
    const bool locked = VEHICLE::GET_VEHICLE_DOOR_LOCK_STATUS(veh) >= 2;
    const Value* doorsV = props::shared(rv.shared, "doors");
    const int doors = doorsV ? static_cast<int>(doorsV->asInt()) : 0;
    const bool engine = VEHICLE::GET_IS_VEHICLE_ENGINE_RUNNING(veh);

    // The items, rebuilt every frame from the current state.
    radial_.clear();
    auto door = [this, id](int d) { return [this, id, d] { send(ScriptEvent{"gomp:veh:door", {Value::integer(id), Value::integer(d)}}); }; };
    if (driver)
        radial_.push_back({"Двигатель", engine ? "заглушить" : "завести", true, [this, veh] { toggleEngine(veh); }});
    radial_.push_back({"Замок", locked ? "открыть" : "закрыть", canLock, [this, id] { send(ScriptEvent{"gomp:veh:lock", {Value::integer(id)}}); }});
    if (inside) radial_.push_back({"Ремень", belted_ ? "отстегнуть" : "пристегнуть", true, [this] { setBelt(!belted_); }});
    radial_.push_back({"Капот", doors & (1 << 4) ? "закрыть" : "открыть", driver || !inside, door(4)});
    radial_.push_back({"Багажник", doors & (1 << 5) ? "закрыть" : "открыть", driver || !inside, door(5)});
    radial_.push_back({"Двери", doors & 0xF ? "закрыть" : "открыть", true, [this, id, doors] {
                           // All doors follow the first one: open what is shut, or shut what is open.
                           const bool open = !(doors & 0xF);
                           for (int d = 0; d < 4; ++d)
                               if (static_cast<bool>(doors & (1 << d)) != open)
                                   send(ScriptEvent{"gomp:veh:door", {Value::integer(id), Value::integer(d)}});
                       }});
    if (!inside) {
        const int kits = itemCount("repairkit"), cans = itemCount("jerrycan");
        radial_.push_back({"Ремонт", kits ? "ремкомплект x" + std::to_string(kits) : "нет ремкомплекта", kits > 0,
                           [this] { send(ScriptEvent{"gomp:inv:usekey", {Value::string("repairkit")}}); }});
        radial_.push_back({"Канистра", cans ? "+20 л" : "нет канистры", cans > 0,
                           [this] { send(ScriptEvent{"gomp:inv:usekey", {Value::string("jerrycan")}}); }});
    }

    // Layout: a ring of translucent round buttons around an information disc (Majestic style).
    int sw, sh;
    screenSize(sw, sh);
    const float aspect = static_cast<float>(sw) / sh;
    const float cx = 0.5f, cy = 0.5f, ring = 0.2f;  // ring radius (screen height units)
    const float bh = 0.115f;                         // button diameter
    const float ch = 0.19f;                          // centre disc diameter
    rect(0, 0, 1, 1, {0, 0, 0, 70});

    // Centre: name, plate, fuel and condition.
    circle(cx, cy, ch + 0.004f, withAlpha(theme::Accent, 90));
    circle(cx, cy, ch, withAlpha(theme::Bg, 215));
    float tank = 0;
    const float fuel = vehicleFuel(rv, &tank);
    const char* plate = VEHICLE::GET_VEHICLE_NUMBER_PLATE_TEXT(veh);
    label(vehicleName(veh), cx, cy - 0.062f, 0.42f, theme::Text, Align::Center);
    label(plate ? plate : "", cx, cy - 0.032f, 0.3f, theme::Accent, Align::Center);
    label(tank > 0 ? "Топливо " + fixed1(fuel) + " / " + fixed1(tank) + " л" : "Без топлива", cx, cy - 0.006f, 0.28f,
          theme::Muted, Align::Center);
    const int condition = std::clamp(static_cast<int>(VEHICLE::GET_VEHICLE_ENGINE_HEALTH(veh) / 10), 0, 100);
    label("Состояние " + std::to_string(condition) + "%", cx, cy + 0.016f, 0.28f,
          condition > 50 ? theme::Positive : theme::Negative, Align::Center);
    label(locked ? "закрыт" : "открыт", cx, cy + 0.038f, 0.26f, locked ? theme::Negative : theme::Muted, Align::Center);

    // Hover by angle: the item whose direction is closest to the cursor.
    const int n = static_cast<int>(radial_.size());
    const int hover = logic::radialHover((mouseX_ - cx) * aspect, mouseY_ - cy, n, ch / 2);
    for (int i = 0; i < n; ++i) {
        const RadialItem& item = radial_[i];
        const float ang = i * 6.2831853f / n;
        const float x = cx + std::sin(ang) * ring / aspect, y = cy - std::cos(ang) * ring;
        const bool hot = i == hover && item.enabled;
        // A thin ring around the selected button, translucent fills everywhere.
        if (hot) circle(x, y, bh + 0.008f, withAlpha(theme::Accent, 230));
        circle(x, y, bh, hot ? withAlpha(theme::AccentDeep, 235) : item.enabled ? withAlpha(theme::Bg, 190) : withAlpha(theme::Bg, 120));
        label(item.title, x, y - 0.024f, 0.36f, item.enabled ? theme::Text : theme::Muted, Align::Center);
        label(item.sub, x, y + 0.004f, 0.25f, hot ? theme::Text : theme::Muted, Align::Center);
    }
    label("G / Esc — закрыть", cx, cy + ring + bh / 2 + 0.016f, 0.27f, theme::Muted, Align::Center);

    if (mouseClick_ && hover >= 0 && radial_[hover].enabled) {
        auto action = radial_[hover].action;
        closeScreens();
        menuVehicle_ = kNoID;
        action();
    }
}

}  // namespace gompgame
