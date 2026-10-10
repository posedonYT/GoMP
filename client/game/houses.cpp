// Houses and garages: map blips and door markers, the "E" hints (the door, the
// garage for the own vehicle, the way out inside), the house window (buying,
// selling, the lock, the garage) and the fade into a house and out of it.
// The server keeps houses, owners and garages (server-files/packages/freeroam/houses.js).
#include <algorithm>
#include <cmath>
#include <cstring>

#include "game_client.hpp"
#include "natives.hpp"
#include "ui.hpp"

namespace gompgame {

using namespace gomp;
using namespace ui;

namespace {

constexpr float kDoorRange = 1.8f;     // the door hint, on foot
constexpr float kGarageRange = 10.0f;  // the garage hint, driving an own vehicle
constexpr float kMarkerRange = 30.0f;
constexpr float kExitRange = 1.6f;
constexpr float kSpotRange = 70.0f;    // a road spot for a vehicle out of the garage
constexpr size_t kMaxHouseProps = 300;
constexpr DWORD kPropLoadMs = 2500;    // all decoration models together
constexpr int kFadeMs = 350;
constexpr DWORD kServerTimeoutMs = 2500, kArriveTimeoutMs = 8000;
constexpr DWORD kSellConfirmMs = 4000;
constexpr int kBlipHouse = 40;         // the safehouse icon
constexpr int kBlipGarage = 357;       // the car icon
constexpr float kGaragePointRange = 4.0f;  // driving in: from the garage point
constexpr int kBlipGreen = 2, kBlipBlue = 3, kBlipGrey = 39;

float dist(Vector3 a, Vec3 b) { return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) + (a.z - b.z) * (a.z - b.z)); }

Vec3 vec(const Value& m) {
    return {static_cast<float>(props::fieldNum(m, "x")), static_cast<float>(props::fieldNum(m, "y")), static_cast<float>(props::fieldNum(m, "z"))};
}

std::string fixed1(double v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.1f", v);
    return buf;
}

// The name of a vehicle model as the game shows it.
std::string modelName(Hash model) {
    const char* label = VEHICLE::GET_DISPLAY_NAME_FROM_VEHICLE_MODEL(model);
    const char* text = label && *label ? HUD::GET_FILENAME_FOR_AUDIO_CONVERSATION(label) : nullptr;
    if (text && *text && std::strcmp(text, "NULL") != 0) return text;
    return label && *label && std::strcmp(label, "CARNOTFOUND") != 0 ? label : "Транспорт";
}

}  // namespace

// ------------------------------------------------------------------ data

int GameClient::myStatic() const {
    const Value* s = props::shared(selfShared_, "static");
    return s ? static_cast<int>(s->asInt()) : -1;
}

const GameClient::House* GameClient::houseById(int id) const {
    for (const House& h : houses_)
        if (h.id == id) return &h;
    return nullptr;
}

const GameClient::House* GameClient::myHouse() const {
    const int me = myStatic();
    for (const House& h : houses_)
        if (me >= 0 && h.owner == me) return &h;
    return nullptr;
}

bool GameClient::handleHousesEvent(const ScriptEvent& e) {
    const auto& a = e.args;
    if (e.name == "gomp:houses") {
        clearHouseBlips();
        houses_.clear();
        if (!a.empty() && a[0].kind == Value::Kind::Array) {
            for (const Value& v : a[0].arr) {
                House h;
                h.id = static_cast<int>(props::fieldInt(v, "id"));
                h.name = props::fieldStr(v, "name");
                h.cls = props::fieldStr(v, "cls");
                h.price = props::fieldInt(v, "price");
                h.door = vec(v);
                h.heading = static_cast<float>(props::fieldNum(v, "heading"));
                h.interiorName = props::fieldStr(v, "interiorName");
                const Value* owner = props::field(v, "owner");
                h.owner = owner && !owner->isNil() ? static_cast<int>(owner->asInt()) : -1;
                h.ownerName = props::fieldStr(v, "ownerName");
                const Value* locked = props::field(v, "locked");
                h.locked = locked && locked->asNumber() != 0;
                const Value* hg = props::field(v, "hasGarage");
                h.hasGarage = hg && hg->asNumber() != 0;
                h.garageName = props::fieldStr(v, "garageName");
                if (const Value* gp = props::field(v, "garagePoint"); gp && gp->kind == Value::Kind::Map) {
                    h.hasGaragePoint = true;
                    h.garagePoint = vec(*gp);
                    h.garageHeading = static_cast<float>(props::fieldNum(*gp, "heading"));
                }
                houses_.push_back(h);
            }
        }
        if (a.size() > 1 && a[1].kind == Value::Kind::Map) {
            houseClasses_.clear();
            for (const auto& [k, c] : a[1].map) {
                const Value* in = props::field(c, "interior");
                houseClasses_[k] = {props::fieldStr(c, "name"), props::fieldStr(c, "interiorName"), static_cast<int>(props::fieldInt(c, "garage")),
                                    in ? Vec3{static_cast<float>(props::at(*in, 0)), static_cast<float>(props::at(*in, 1)), static_cast<float>(props::at(*in, 2))}
                                       : Vec3{}};
            }
        }
        // The interior templates; an old server sends none.
        houseInteriors_.clear();
        if (a.size() > 2 && a[2].kind == Value::Kind::Map) {
            auto point = [](const Value& m, const char* name) {
                const Value* p = props::field(m, name);
                return p ? Vec3{static_cast<float>(props::at(*p, 0)), static_cast<float>(props::at(*p, 1)), static_cast<float>(props::at(*p, 2))} : Vec3{};
            };
            for (const auto& [k, t] : a[2].map)
                houseInteriors_[k] = {props::fieldStr(t, "name"), point(t, "spawn"), point(t, "exit"), static_cast<float>(props::fieldNum(t, "heading"))};
        }
        // The garage templates; an old server sends none.
        garageTemplates_.clear();
        if (a.size() > 3 && a[3].kind == Value::Kind::Map) {
            auto point = [](const Value& m, const char* name) {
                const Value* p = props::field(m, name);
                return p ? Vec3{static_cast<float>(props::at(*p, 0)), static_cast<float>(props::at(*p, 1)), static_cast<float>(props::at(*p, 2))} : Vec3{};
            };
            for (const auto& [k, t] : a[3].map) {
                GarageTemplate g;
                g.name = props::fieldStr(t, "name");
                g.spawn = point(t, "spawn");
                g.exit = point(t, "exit");
                g.heading = static_cast<float>(props::fieldNum(t, "heading"));
                if (const Value* sl = props::field(t, "slots"); sl && sl->kind == Value::Kind::Array)
                    for (const Value& s : sl->arr)
                        g.slots.push_back({{static_cast<float>(props::at(s, 0)), static_cast<float>(props::at(s, 1)), static_cast<float>(props::at(s, 2))},
                                           static_cast<float>(props::at(s, 3))});
                garageTemplates_[k] = std::move(g);
            }
        }
        refreshHouseBlips();
        return true;
    }
    if (e.name == "gomp:house:info") {
        if (a.empty() || a[0].kind != Value::Kind::Map) return true;
        const Value& m = a[0];
        HouseInfo info;
        info.id = static_cast<int>(props::fieldInt(m, "id"));
        info.mine = props::fieldNum(m, "mine") != 0;
        info.sellPrice = props::fieldInt(m, "sellPrice");
        info.cap = static_cast<int>(props::fieldInt(m, "cap"));
        if (const Value* g = props::field(m, "garage"); g && g->kind == Value::Kind::Array)
            for (const Value& c : g->arr)
                info.garage.push_back({static_cast<Hash>(props::fieldInt(c, "model")), static_cast<float>(props::fieldNum(c, "fuel")),
                                       props::fieldStr(c, "plate"), props::fieldNum(c, "out") != 0});
        houseInfo_ = std::move(info);
        return true;
    }
    if (e.name == "gomp:house:inside") {
        const bool in = !a.empty() && a[0].kind == Value::Kind::Map;
        if (!in) {
            clearHouseProps();
            housePropsWanted_.clear();
            insideHouse_ = -1;
        } else {
            const int id = static_cast<int>(props::fieldInt(a[0], "id"));
            const Vec3 spawn = vec(a[0]);
            // The exit marker is by the door of the interior; an old server sends none: the spawn then.
            const Value* ex = props::field(a[0], "exit");
            const Vec3 exit = ex && ex->kind == Value::Kind::Array
                                  ? Vec3{static_cast<float>(props::at(*ex, 0)), static_cast<float>(props::at(*ex, 1)), static_cast<float>(props::at(*ex, 2))}
                                  : spawn;
            const bool refresh = props::fieldNum(a[0], "refresh") != 0 && id == insideHouse_;
            housePropsWanted_.clear();
            if (const Value* ps = props::field(a[0], "props"); ps && ps->kind == Value::Kind::Array) {
                for (const Value& p : ps->arr) {
                    if (housePropsWanted_.size() >= kMaxHouseProps) break;
                    const Value* pos = props::field(p, "pos");
                    const Value* rot = props::field(p, "rot");
                    if (!pos) continue;
                    HouseProp hp;
                    hp.model = static_cast<Hash>(props::fieldInt(p, "model"));
                    hp.pos = {static_cast<float>(props::at(*pos, 0)), static_cast<float>(props::at(*pos, 1)), static_cast<float>(props::at(*pos, 2))};
                    if (rot) hp.rot = {static_cast<float>(props::at(*rot, 0)), static_cast<float>(props::at(*rot, 1)), static_cast<float>(props::at(*rot, 2))};
                    housePropsWanted_.push_back(hp);
                }
            }
            houseExit_ = exit;
            if (refresh) {
                // Already inside (the owner changed the decoration): no teleport, no fade.
                buildHouseProps();
                return true;
            }
            clearHouseProps();
            insideHouse_ = id;
            insideGarage_ = -1;  // a house payload clears the garage
            const float heading = static_cast<float>(props::fieldNum(a[0], "heading"));
            // The answer to our own request: wait for the place to load, then fade in.
            if (houseFade_ == 1) {
                arriveAt(spawn, heading, true);
            } else {
                // Moved by the server on its own: nothing to wait for here.
                ENTITY::SET_ENTITY_HEADING(PLAYER::PLAYER_PED_ID(), heading);
                buildHouseProps();
            }
            return true;
        }
        // The answer to our own request: back to the street.
        if (houseFade_ == 1) {
            const House* h = houseById(houseFadeArg_);
            const Vector3 here = ENTITY::GET_ENTITY_COORDS(PLAYER::PLAYER_PED_ID(), true);
            arriveAt(h ? h->door : Vec3{here.x, here.y, here.z}, 0, false);
        }
        return true;
    }
    if (e.name == "gomp:garage:inside") {
        const bool in = !a.empty() && a[0].kind == Value::Kind::Map;
        auto point = [](const Value& m, const char* name) {
            const Value* p = props::field(m, name);
            return p ? Vec3{static_cast<float>(props::at(*p, 0)), static_cast<float>(props::at(*p, 1)), static_cast<float>(props::at(*p, 2))} : Vec3{};
        };
        if (!in) {
            // Out of the garage: to the street (with `out`), or just the state cleared (death).
            insideGarage_ = -1;
            if (a.size() > 1 && a[1].kind == Value::Kind::Map) {
                const Vec3 to = vec(a[1]);
                const float heading = static_cast<float>(props::fieldNum(a[1], "heading"));
                const bool drive = props::fieldNum(a[1], "drive") != 0;
                if (houseFade_ == 1) {
                    arriveAt(to, heading, drive);
                } else if (drive) {
                    const Ped me = PLAYER::PLAYER_PED_ID();
                    ENTITY::SET_ENTITY_HEADING(PED::IS_PED_IN_ANY_VEHICLE(me, false) ? PED::GET_VEHICLE_PED_IS_IN(me, false) : me, heading);
                }
            }
            return true;
        }
        const int id = static_cast<int>(props::fieldInt(a[0], "id"));
        const Vec3 spawn = vec(a[0]);
        const Value* ex = props::field(a[0], "exit");
        garageExit_ = ex && ex->kind == Value::Kind::Array ? point(a[0], "exit") : spawn;
        if (props::fieldNum(a[0], "refresh") != 0 && id == insideGarage_) return true;  // the template changed: no teleport
        // A garage payload clears the house.
        clearHouseProps();
        housePropsWanted_.clear();
        insideHouse_ = -1;
        insideGarage_ = id;
        const float heading = static_cast<float>(props::fieldNum(a[0], "heading"));
        const bool drive = props::fieldNum(a[0], "drive") != 0;
        if (houseFade_ == 1) {
            // Driving in: the vehicle is held still at once (arriveAt); the SetPosition came just before.
            arriveAt(spawn, heading, true);
        } else {
            const Ped me = PLAYER::PLAYER_PED_ID();
            ENTITY::SET_ENTITY_HEADING(drive && PED::IS_PED_IN_ANY_VEHICLE(me, false) ? PED::GET_VEHICLE_PED_IS_IN(me, false) : me, heading);
            settleGarageVehicles(spawn);
        }
        return true;
    }
    return false;
}

// Map blips: houses for sale in green, the own house in blue (shown from afar), the others grey;
// the garage entrance of the own house gets a car blip.
void GameClient::refreshHouseBlips() {
    const int me = myStatic();
    blipsStatic_ = me;
    for (House& h : houses_) {
        if (h.blip && HUD::DOES_BLIP_EXIST(h.blip)) HUD::REMOVE_BLIP(&h.blip);
        if (h.garageBlip && HUD::DOES_BLIP_EXIST(h.garageBlip)) HUD::REMOVE_BLIP(&h.garageBlip);
        h.garageBlip = 0;
        h.blip = HUD::ADD_BLIP_FOR_COORD(h.door.x, h.door.y, h.door.z);
        const bool mine = me >= 0 && h.owner == me;
        HUD::SET_BLIP_SPRITE(h.blip, kBlipHouse);
        HUD::SET_BLIP_COLOUR(h.blip, mine ? kBlipBlue : h.owner < 0 ? kBlipGreen : kBlipGrey);
        HUD::SET_BLIP_SCALE(h.blip, mine ? 0.9f : 0.7f);
        HUD::SET_BLIP_AS_SHORT_RANGE(h.blip, !mine);
        auto cls = houseClasses_.find(h.cls);
        const std::string clsName = cls != houseClasses_.end() ? cls->second.name : h.cls;
        blipName(h.blip, mine ? "Мой дом" : h.owner < 0 ? "Дом на продажу (" + clsName + ")" : "Дом (" + clsName + ")");
        if (mine && h.hasGarage && h.hasGaragePoint) {
            h.garageBlip = HUD::ADD_BLIP_FOR_COORD(h.garagePoint.x, h.garagePoint.y, h.garagePoint.z);
            HUD::SET_BLIP_SPRITE(h.garageBlip, kBlipGarage);
            HUD::SET_BLIP_COLOUR(h.garageBlip, kBlipBlue);
            HUD::SET_BLIP_SCALE(h.garageBlip, 0.8f);
            HUD::SET_BLIP_AS_SHORT_RANGE(h.garageBlip, true);
            blipName(h.garageBlip, "Мой гараж");
        }
    }
}

void GameClient::clearHouseBlips() {
    for (House& h : houses_) {
        if (h.blip && HUD::DOES_BLIP_EXIST(h.blip)) HUD::REMOVE_BLIP(&h.blip);
        if (h.garageBlip && HUD::DOES_BLIP_EXIST(h.garageBlip)) HUD::REMOVE_BLIP(&h.garageBlip);
        h.garageBlip = 0;
    }
}

// ------------------------------------------------------------------ into a house or a garage and out

// The screen goes dark, then the server is asked to move us: `request` is
// gomp:house:enter / exit, gomp:garage:enter / exit or gomp:spawn:choose.
void GameClient::startHouseFade(ScriptEvent request, int house) {
    if (houseFade_ != 0) return;
    houseFade_ = 1;
    houseFadeAt_ = GetTickCount();
    houseFadeRequest_ = std::move(request);
    houseFadeArg_ = house;
    houseFadeVehicle_ = 0;
    houseFadeHasHeading_ = false;
    CAMERA::DO_SCREEN_FADE_OUT(kFadeMs);
}

// The answer came: from now on wait for the place around `target` to load. A vehicle we
// drive is held still at once (and turned), so that it does not fall through an unloaded floor.
void GameClient::arriveAt(Vec3 target, float heading, bool hasHeading) {
    houseFade_ = 2;
    houseFadeAt_ = GetTickCount();
    houseFadeTarget_ = target;
    houseFadeHeading_ = heading;
    houseFadeHasHeading_ = hasHeading;
    houseFadeVehicle_ = 0;
    const Ped me = PLAYER::PLAYER_PED_ID();
    if (PED::IS_PED_IN_ANY_VEHICLE(me, false)) {
        const Vehicle veh = PED::GET_VEHICLE_PED_IS_IN(me, false);
        if (veh && VEHICLE::GET_PED_IN_VEHICLE_SEAT(veh, -1, false) == me) {
            houseFadeVehicle_ = veh;
            ENTITY::FREEZE_ENTITY_POSITION(veh, true);
            if (hasHeading) ENTITY::SET_ENTITY_HEADING(veh, heading);
        }
    }
}

// The parked cars of a garage are frozen; one that was created before its floor loaded has
// to be put on its wheels again.
void GameClient::settleGarageVehicles(Vec3 around) {
    for (auto& [id, v] : vehicles_) {
        if (!v.handle || id == myVehicle_ || !ENTITY::DOES_ENTITY_EXIST(v.handle)) continue;
        const Value* movable = props::find(v.props, prop::Movable);
        if (!movable || movable->asNumber() != 0) continue;
        if (dist(ENTITY::GET_ENTITY_COORDS(v.handle, true), around) > 40.0f) continue;
        ENTITY::FREEZE_ENTITY_POSITION(v.handle, false);
        VEHICLE::SET_VEHICLE_ON_GROUND_PROPERLY(v.handle, 5.0f);
        ENTITY::FREEZE_ENTITY_POSITION(v.handle, true);
    }
}

void GameClient::tickHouseFade() {
    tickHouseProps();
    if (houseFade_ == 0) return;
    PAD::DISABLE_ALL_CONTROL_ACTIONS(0);  // nothing while the screen is dark
    const DWORD now = GetTickCount();
    // 3: arrived; the screen stays dark until the decoration is in place.
    if (houseFade_ == 3) {
        if (housePropsBuilding_) return;
        houseFade_ = 0;
        CAMERA::DO_SCREEN_FADE_IN(kFadeMs);
        return;
    }
    const Ped me = PLAYER::PLAYER_PED_ID();
    // 1: once dark, the request goes out (once); the answer is gomp:house:inside or gomp:garage:inside.
    if (houseFade_ == 1) {
        if (!houseFadeRequest_.name.empty() && (CAMERA::IS_SCREEN_FADED_OUT() || now - houseFadeAt_ > 1000)) {
            if (PED::IS_PED_IN_ANY_VEHICLE(me, false)) {
                const Vehicle veh = PED::GET_VEHICLE_PED_IS_IN(me, false);
                if (veh) ENTITY::SET_ENTITY_VELOCITY(veh, 0, 0, 0);
            }
            send(houseFadeRequest_);
            houseFadeRequest_ = ScriptEvent{};
            houseFadeAt_ = now;
        } else if (houseFadeRequest_.name.empty() && now - houseFadeAt_ > kServerTimeoutMs) {
            houseFade_ = 0;  // refused (a locked door): back to the street
            CAMERA::DO_SCREEN_FADE_IN(kFadeMs);
        }
        return;
    }
    // 2: moved; the interior (or the street) loads around us. Held still until it has.
    const bool holdVehicle = houseFadeVehicle_ && ENTITY::DOES_ENTITY_EXIST(houseFadeVehicle_);
    ENTITY::FREEZE_ENTITY_POSITION(holdVehicle ? houseFadeVehicle_ : me, true);
    const Vector3 p = ENTITY::GET_ENTITY_COORDS(me, true);
    bool ready = dist(p, houseFadeTarget_) < 5.0f;
    if (ready) {
        STREAMING::REQUEST_COLLISION_AT_COORD(p.x, p.y, p.z);
        const Interior interior = INTERIOR::GET_INTERIOR_AT_COORDS(houseFadeTarget_.x, houseFadeTarget_.y, houseFadeTarget_.z);
        if (interior) {
            // Some GTA Online interiors are switched off in story mode.
            if (INTERIOR::IS_INTERIOR_DISABLED(interior)) INTERIOR::DISABLE_INTERIOR(interior, false);
            if (INTERIOR::IS_INTERIOR_CAPPED(interior)) INTERIOR::CAP_INTERIOR(interior, false);
            INTERIOR::PIN_INTERIOR_IN_MEMORY(interior);
            ready = INTERIOR::IS_INTERIOR_READY(interior);
        }
        ready = ready && ENTITY::HAS_COLLISION_LOADED_AROUND_ENTITY(holdVehicle ? houseFadeVehicle_ : me);
    }
    if (ready || now - houseFadeAt_ > kArriveTimeoutMs) {
        if (!ready) log("house: the place did not load in time");
        // Arrived: let go, face the right way and set the decoration (the screen is still dark).
        if (holdVehicle) {
            ENTITY::FREEZE_ENTITY_POSITION(houseFadeVehicle_, false);
            if (houseFadeHasHeading_) ENTITY::SET_ENTITY_HEADING(houseFadeVehicle_, houseFadeHeading_);
            VEHICLE::SET_VEHICLE_ON_GROUND_PROPERLY(houseFadeVehicle_, 5.0f);
        } else {
            ENTITY::FREEZE_ENTITY_POSITION(me, false);
            if (houseFadeHasHeading_) ENTITY::SET_ENTITY_HEADING(me, houseFadeHeading_);
        }
        if (insideHouse_ >= 0) buildHouseProps();
        if (insideGarage_ >= 0) settleGarageVehicles(houseFadeTarget_);
        houseFadeVehicle_ = 0;
        houseFadeHasHeading_ = false;
        houseFade_ = housePropsBuilding_ ? 3 : 0;
        if (houseFade_ == 0) CAMERA::DO_SCREEN_FADE_IN(kFadeMs);
    }
}

// Decoration objects of the interior are local only (not networked): the server just
// lists them. Made once the interior is ready, so they do not fall or stream wrong.
void GameClient::clearHouseProps() {
    for (Object& o : houseProps_)
        if (o && ENTITY::DOES_ENTITY_EXIST(o)) OBJECT::DELETE_OBJECT(&o);
    houseProps_.clear();
    if (housePropsBuilding_) {
        for (const HouseProp& p : housePropsWanted_)
            if (p.model) STREAMING::SET_MODEL_AS_NO_LONGER_NEEDED(p.model);
        housePropsBuilding_ = false;
    }
}

// Every model is requested at once and the objects are made by tickHouseProps() once
// they have all loaded (or after kPropLoadMs), a few per frame: waiting here stopped
// the whole client for up to the load time.
void GameClient::buildHouseProps() {
    clearHouseProps();
    for (const HouseProp& p : housePropsWanted_)
        if (p.model && STREAMING::IS_MODEL_IN_CDIMAGE(p.model)) STREAMING::REQUEST_MODEL(p.model);
    housePropsBuilding_ = !housePropsWanted_.empty();
    housePropsAskedAt_ = GetTickCount();
    housePropsNext_ = 0;
    housePropsSkipped_ = 0;
    tickHouseProps();
}

void GameClient::tickHouseProps() {
    constexpr std::size_t kPropsPerFrame = 48;
    if (!housePropsBuilding_) return;
    if (housePropsNext_ == 0 && GetTickCount() - housePropsAskedAt_ <= kPropLoadMs) {
        for (const HouseProp& p : housePropsWanted_)
            if (p.model && STREAMING::IS_MODEL_IN_CDIMAGE(p.model) && !STREAMING::HAS_MODEL_LOADED(p.model)) return;
    }
    const std::size_t end = std::min(housePropsWanted_.size(), housePropsNext_ + kPropsPerFrame);
    for (; housePropsNext_ < end; ++housePropsNext_) {
        const HouseProp& p = housePropsWanted_[housePropsNext_];
        if (!p.model || !STREAMING::IS_MODEL_IN_CDIMAGE(p.model) || !STREAMING::HAS_MODEL_LOADED(p.model)) {
            ++housePropsSkipped_;
            continue;
        }
        Object obj = OBJECT::CREATE_OBJECT_NO_OFFSET(p.model, p.pos.x, p.pos.y, p.pos.z, false, false, false, 0);
        if (!obj) {
            ++housePropsSkipped_;
            continue;
        }
        ENTITY::SET_ENTITY_ROTATION(obj, p.rot.x, p.rot.y, p.rot.z, 2, true);
        ENTITY::FREEZE_ENTITY_POSITION(obj, true);
        houseProps_.push_back(obj);
    }
    if (housePropsNext_ < housePropsWanted_.size()) return;
    for (const HouseProp& p : housePropsWanted_)
        if (p.model) STREAMING::SET_MODEL_AS_NO_LONGER_NEEDED(p.model);
    housePropsBuilding_ = false;
    if (housePropsSkipped_)
        log("house: " + std::to_string(housePropsSkipped_) + " of " + std::to_string(housePropsWanted_.size()) +
            " props skipped (model missing or not loaded)");
}

// ------------------------------------------------------------------ every frame

bool GameClient::tickHouses(bool interact) {
    // Our static may arrive after the houses: the own house changes colour then.
    if (!houses_.empty() && myStatic() != blipsStatic_) refreshHouseBlips();
    if (screen_ != Screen::None || dead_ || tuneStage_ != 0 || houseFade_ != 0) return false;
    const Ped me = PLAYER::PLAYER_PED_ID();
    const Vector3 here = ENTITY::GET_ENTITY_COORDS(me, true);
    const bool inVeh = PED::IS_PED_IN_ANY_VEHICLE(me, false);

    if (insideGarage_ >= 0) return tickGarage(interact, inVeh);

    // Inside: the way out.
    if (insideHouse_ >= 0) {
        GRAPHICS::DRAW_MARKER(1, houseExit_.x, houseExit_.y, houseExit_.z - 0.98f, 0, 0, 0, 0, 0, 0, 0.8f, 0.8f, 0.3f, theme::Accent.r,
                              theme::Accent.g, theme::Accent.b, 110, false, false, 2, false, nullptr, nullptr, false);
        if (dist(here, houseExit_) > kExitRange) return false;
        const House* in = houseById(insideHouse_);
        const int mine = myStatic();
        if (in && in->hasGarage && mine >= 0 && in->owner == mine) {
            // The owner of a house with a garage chooses: the street or the garage.
            drawHint("E", "Выйти");
            if (interact) {
                const int id = insideHouse_;
                openChoice("Куда выйти?",
                           {{"На улицу", [this, id] { startHouseFade(ScriptEvent{"gomp:house:exit", {}}, id); }},
                            {"В гараж", [this, id] {
                                 startHouseFade(ScriptEvent{"gomp:garage:enter", {Value::integer(id), Value::string("foot")}}, id);
                             }}});
            }
            return true;
        }
        drawHint("E", "Выйти на улицу");
        if (interact) startHouseFade(ScriptEvent{"gomp:house:exit", {}}, insideHouse_);
        return true;
    }

    const int mine = myStatic();
    const House* door = nullptr;
    const House* garage = nullptr;    // no garage interior: the old "put it in the garage"
    const House* garageIn = nullptr;  // a garage interior: drive in
    float best = kDoorRange;
    for (House& h : houses_) {
        const float d = dist(here, h.door);
        if (d < kMarkerRange) {
            if (!h.grounded) {
                float gz = 0;
                if (MISC::GET_GROUND_Z_FOR_3D_COORD(h.door.x, h.door.y, h.door.z + 1.0f, &gz, false, false)) {
                    h.ground = gz;
                    h.grounded = true;
                }
            }
            const Rgba c = h.owner < 0 ? theme::Positive : h.owner == mine ? theme::Accent : theme::Muted;
            const float z = h.grounded && std::fabs(h.ground - (h.door.z - 1.0f)) < 2.5f ? h.ground + 0.02f : h.door.z - 0.98f;
            GRAPHICS::DRAW_MARKER(1, h.door.x, h.door.y, z, 0, 0, 0, 0, 0, 0, 0.8f, 0.8f, 0.3f, c.r, c.g, c.b, 110, false, false, 2, false,
                                  nullptr, nullptr, false);
        }
        const bool own = mine >= 0 && h.owner == mine;
        if (own && h.hasGarage && h.hasGaragePoint && dist(here, h.garagePoint) < kMarkerRange) {
            // The garage entrance: a circle on the ground and the car symbol over it.
            const Vec3& g = h.garagePoint;
            GRAPHICS::DRAW_MARKER(1, g.x, g.y, g.z - 0.98f, 0, 0, 0, 0, 0, 0, 3.0f, 3.0f, 0.3f, theme::Accent.r, theme::Accent.g, theme::Accent.b, 110,
                                  false, false, 2, false, nullptr, nullptr, false);
            GRAPHICS::DRAW_MARKER(36, g.x, g.y, g.z - 0.98f + 0.4f + 0.6f, 0, 0, 0, 0, 0, 0, 1.0f, 1.0f, 1.0f, theme::Accent.r, theme::Accent.g,
                                  theme::Accent.b, 200, false, false, 2, false, nullptr, nullptr, false);
        }
        if (!inVeh && d < best) {
            best = d;
            door = &h;
        }
        if (inVeh && own) {
            if (h.hasGarage) {
                if (h.hasGaragePoint ? dist(here, h.garagePoint) < kGaragePointRange : d < kGarageRange) garageIn = &h;
            } else if (d < kGarageRange) {
                garage = &h;
            }
        }
    }

    if (garage || garageIn) {
        // The driver of an own vehicle that has stopped at the house.
        const Vehicle veh = PED::GET_VEHICLE_PED_IS_IN(me, false);
        auto vit = vehicles_.find(myVehicle_);
        const Value* owner = vit != vehicles_.end() ? props::shared(vit->second.shared, "owner") : nullptr;
        const bool own = owner && !owner->isNil() && owner->asInt() == mine;
        if (!own || VEHICLE::GET_PED_IN_VEHICLE_SEAT(veh, -1, false) != me || ENTITY::GET_ENTITY_SPEED(veh) > 3.0f) return false;
        PAD::DISABLE_CONTROL_ACTION(0, 86, true);  // E is the horn in vehicles
        if (garageIn) {
            drawHint("E", "Заехать в гараж");
            if (interact)
                startHouseFade(ScriptEvent{"gomp:garage:enter", {Value::integer(garageIn->id), Value::string("drive")}}, garageIn->id);
            return true;
        }
        drawHint("E", "Поставить в гараж");
        if (interact) send(ScriptEvent{"gomp:garage:store", {Value::integer(garage->id)}});
        return true;
    }
    if (!door) return false;
    drawHint("E", door->owner < 0 ? door->name + " — продаётся" : door->name);
    if (interact) {
        houseMenu_ = door->id;
        houseInfo_ = {};
        houseSellConfirmAt_ = 0;
        send(ScriptEvent{"gomp:house:info", {Value::integer(door->id)}});
        openScreen(Screen::House);
    }
    return true;
}

// Inside a garage: the exit marker, the way out on foot (a menu) and by car.
bool GameClient::tickGarage(bool interact, bool inVeh) {
    const Ped me = PLAYER::PLAYER_PED_ID();
    const Vector3 here = ENTITY::GET_ENTITY_COORDS(me, true);
    GRAPHICS::DRAW_MARKER(1, garageExit_.x, garageExit_.y, garageExit_.z - 0.98f, 0, 0, 0, 0, 0, 0, 0.8f, 0.8f, 0.3f, 240, 170, 40, 120, false,
                          false, 2, false, nullptr, nullptr, false);
    const int id = insideGarage_;
    if (inVeh) {
        const Vehicle veh = PED::GET_VEHICLE_PED_IS_IN(me, false);
        if (!veh || VEHICLE::GET_PED_IN_VEHICLE_SEAT(veh, -1, false) != me) return false;
        PAD::DISABLE_CONTROL_ACTION(0, 86, true);  // E is the horn in vehicles
        drawHint("E", "Выехать из гаража");
        if (interact) {
            // Without a garage point outside the server uses a road spot near the door.
            const House* h = houseById(id);
            Vec3 spot{};
            float heading = 0;
            if (!h || h->hasGaragePoint || !roadSpot(h->door, spot, heading)) spot = {0, 0, 0};
            startHouseFade(ScriptEvent{"gomp:garage:exit", {Value::string("drive"), Value::number(spot.x), Value::number(spot.y),
                                                            Value::number(spot.z), Value::number(heading)}}, id);
        }
        return true;
    }
    if (dist(here, garageExit_) > kExitRange) return false;
    drawHint("E", "Выйти из гаража");
    if (interact) {
        auto leave = [this, id](const char* how) {
            startHouseFade(ScriptEvent{"gomp:garage:exit", {Value::string(how), Value::number(0), Value::number(0), Value::number(0),
                                                            Value::number(0)}}, id);
        };
        openChoice("Куда выйти?", {{"На улицу", [leave] { leave("street"); }}, {"В дом", [leave] { leave("house"); }}});
    }
    return true;
}

// ------------------------------------------------------------------ garage

// A free spot on the road nearest to the house, facing along it.
bool GameClient::roadSpot(Vec3 around, Vec3& spot, float& heading) const {
    for (int n = 1; n <= 10; ++n) {
        Vector3 p{};
        float h = 0;
        int lanes = 0;
        if (!PATH::GET_NTH_CLOSEST_VEHICLE_NODE_WITH_HEADING(around.x, around.y, around.z, n, &p, &h, &lanes, 0, 3.0f, 0.0f)) continue;
        if (dist(p, around) > kSpotRange) break;
        if (MISC::IS_POSITION_OCCUPIED(p.x, p.y, p.z, 3.0f, false, true, true, false, false, 0, false)) continue;
        spot = {p.x, p.y, p.z};
        heading = h;
        return true;
    }
    return false;
}

void GameClient::garageTake(int house, int slot, bool release) {
    const House* h = houseById(house);
    if (!h) return;
    Vec3 spot{};
    float heading = 0;
    if (h->hasGarage && h->hasGaragePoint) {
        spot = h->garagePoint;  // the garage entrance (the server uses it anyway)
        heading = h->garageHeading;
    } else if (!roadSpot(h->door, spot, heading)) {
        spot = {0, 0, 0};  // the server puts it next to the door
    }
    send(ScriptEvent{release ? "gomp:garage:release" : "gomp:garage:take",
                     {Value::integer(house), Value::integer(slot), Value::number(spot.x), Value::number(spot.y), Value::number(spot.z),
                      Value::number(heading)}});
}

// ------------------------------------------------------------------ window

void GameClient::drawHouse() {
    const House* h = houseById(houseMenu_);
    if (!h) {
        closeScreens();
        return;
    }
    const int me = myStatic();
    const bool mine = me >= 0 && h->owner == me;
    const bool forSale = h->owner < 0;
    const bool loaded = houseInfo_.id == h->id;
    auto cls = houseClasses_.find(h->cls);
    const HouseClass hc = cls != houseClasses_.end() ? cls->second : HouseClass{h->cls, "", 0, {}};
    const int cars = mine && loaded ? static_cast<int>(houseInfo_.garage.size()) : 0;

    const float W = 0.32f, rowH = 0.03f, carH = 0.04f;
    // Header and rows 0.25; then the buttons: for sale two rows and a note, the own house
    // its buttons and the garage list.
    const float H = forSale ? (myHouse() ? 0.37f : 0.345f)
                              : mine ? 0.355f + (h->hasGarage ? 0.048f : 0.0f) + std::max(1, cars) * (carH + 0.006f)
                                     : 0.31f;
    const float X = 0.5f - W / 2, Y = 0.5f - H / 2, bx = X + 0.018f, bw = W - 0.036f;
    panel(X, Y, W, H);
    label(h->name, bx, Y + 0.014f, 0.46f, theme::Text);
    label("Esc — закрыть", X + W - 0.018f, Y + 0.022f, 0.26f, theme::Muted, Align::Right);
    float y = Y + 0.052f;
    float px = bx + pill(hc.name, bx, y, 0.026f, 0.28f, theme::AccentSoft, theme::Accent) + 0.006f;
    pill(forSale ? "Продаётся" : mine ? "Ваш дом" : "Занят", px, y, 0.026f, 0.28f, forSale ? withAlpha(theme::Positive, 60) : theme::Surface,
         forSale ? theme::Positive : mine ? theme::Accent : theme::Muted);
    y += 0.04f;

    auto row = [&](const std::string& k, const std::string& v, Rgba c = theme::Text) {
        label(k, bx, y, 0.32f, theme::Muted, Align::Left, rowH);
        label(v, bx + bw, y, 0.32f, c, Align::Right, rowH);
        y += rowH;
    };
    row("Интерьер", h->interiorName.empty() ? hc.interiorName : h->interiorName);
    const int capacity = h->hasGarage && loaded && houseInfo_.cap > 0 ? houseInfo_.cap : hc.garage;
    const std::string capText = std::to_string(capacity) + (capacity == 2 ? " места" : capacity == 1 ? " место" : " мест");
    row("Гараж", h->hasGarage && !h->garageName.empty() ? h->garageName + "  ·  " + capText : capText);
    row("Цена", money(h->price), theme::Positive);
    row("Владелец", forSale ? "государство" : h->ownerName);
    if (!forSale) row("Дверь", h->locked ? "закрыта" : "открыта", h->locked ? theme::Negative : theme::Positive);
    y += 0.012f;

    const float gap = 0.008f, half = (bw - gap) / 2, bh = 0.04f;
    if (forSale) {
        const Value* cash = props::shared(selfShared_, "cash");
        const Value* bank = props::shared(selfShared_, "bank");
        if (uiButton(bx, y, half, 0.034f, "Наличные " + money(cash ? cash->asInt() : 0), !housePayByCard_)) housePayByCard_ = false;
        if (uiButton(bx + half + gap, y, half, 0.034f, "Карта " + money(bank ? bank->asInt() : 0), housePayByCard_)) housePayByCard_ = true;
        y += 0.034f + gap;
        if (uiButton(bx, y, half, bh, "Купить за " + money(h->price), true, !myHouse()))
            send(ScriptEvent{"gomp:house:buy", {Value::integer(h->id), Value::string(housePayByCard_ ? "bank" : "cash")}});
        if (uiButton(bx + half + gap, y, half, bh, "Осмотреть")) {
            const int id = h->id;
            closeScreens();
            startHouseFade(ScriptEvent{"gomp:house:enter", {Value::integer(id)}}, id);
            return;
        }
        y += bh + 0.008f;
        if (myHouse()) label("У вас уже есть дом: сначала продайте его", bx, y, 0.27f, theme::Muted);
        return;
    }
    if (!mine) {
        if (uiButton(bx, y, bw, bh, h->locked ? "Дверь закрыта" : "Войти", true, !h->locked)) {
            const int id = h->id;
            closeScreens();
            startHouseFade(ScriptEvent{"gomp:house:enter", {Value::integer(id)}}, id);
        }
        return;
    }

    // The own house.
    const float third = (bw - 2 * gap) / 3;
    if (uiButton(bx, y, third, bh, "Войти", true)) {
        const int id = h->id;
        closeScreens();
        startHouseFade(ScriptEvent{"gomp:house:enter", {Value::integer(id)}}, id);
        return;
    }
    if (uiButton(bx + third + gap, y, third, bh, h->locked ? "Открыть дверь" : "Закрыть дверь"))
        send(ScriptEvent{"gomp:house:lock", {Value::integer(h->id)}});
    const bool confirming = houseSellConfirmAt_ && GetTickCount() - houseSellConfirmAt_ < kSellConfirmMs;
    const long long sell = loaded ? houseInfo_.sellPrice : h->price / 2;
    if (uiButton(bx + 2 * (third + gap), y, third, bh, confirming ? "Точно продать?" : "Продать " + money(sell), false, !cars)) {
        if (confirming) {
            send(ScriptEvent{"gomp:house:sell", {Value::integer(h->id)}});
            houseSellConfirmAt_ = 0;
        } else {
            houseSellConfirmAt_ = GetTickCount();
        }
    }
    y += bh + (h->hasGarage ? 0.008f : 0.016f);
    if (h->hasGarage) {
        if (uiButton(bx, y, bw, bh, "В гараж", true)) {
            const int id = h->id;
            closeScreens();
            startHouseFade(ScriptEvent{"gomp:garage:enter", {Value::integer(id), Value::string("foot")}}, id);
            return;
        }
        y += bh + 0.008f;
    }

    // The garage.
    rect(bx, y + 0.004f, 0.003f, 0.016f, theme::Accent);
    label("ГАРАЖ  " + std::to_string(cars) + " / " + std::to_string(capacity), bx + 0.008f, y, 0.3f, theme::Muted);
    if (cars) label("«Насовсем» — забрать из гаража, чтобы продать дом", bx + bw, y, 0.24f, theme::Muted, Align::Right);
    y += 0.03f;
    if (!loaded) {
        label("Загрузка...", bx, y, 0.3f, theme::Muted, Align::Left, carH);
        return;
    }
    if (!cars) {
        label(h->hasGarage ? "Пусто. Заедьте в гараж через въезд у дома" : "Пусто. Подъедьте к дому на своём транспорте и нажмите E", bx, y,
              0.28f, theme::Muted, Align::Left, carH);
        return;
    }
    for (int i = 0; i < cars; ++i) {
        const GarageCar& c = houseInfo_.garage[i];
        roundRect(bx, y, bw, carH, theme::Surface, 6);
        label(modelName(c.model), bx + 0.008f, y + 0.003f, 0.32f, theme::Text);
        label((c.plate.empty() ? "" : c.plate + "  ·  ") + fixed1(c.fuel) + " л  ·  " + (c.out ? "на улице" : "в гараже"), bx + 0.008f,
              y + 0.021f, 0.24f, c.out ? theme::Accent : theme::Muted);
        const float b2 = 0.052f, b1 = 0.06f, by = y + 0.006f, bbh = carH - 0.012f;
        // Out of the garage for good: the vehicle stays outside and does not come back.
        const bool sure = releaseConfirmSlot_ == i && GetTickCount() - releaseConfirmAt_ < kSellConfirmMs;
        if (uiButton(bx + bw - b2 - 0.006f, by, b2, bbh, sure ? "Точно?" : "Насовсем")) {
            if (sure) {
                garageTake(h->id, i, true);
                releaseConfirmSlot_ = -1;
            } else {
                releaseConfirmSlot_ = i;
                releaseConfirmAt_ = GetTickCount();
            }
        }
        if (uiButton(bx + bw - b2 - b1 - 0.012f, by, b1, bbh, "Выгнать", true, !c.out)) garageTake(h->id, i, false);
        y += carH + 0.006f;
    }
}

}  // namespace gompgame
