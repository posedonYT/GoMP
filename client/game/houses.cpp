// Houses and garages: map blips and door markers, the "E" hints (the door, the
// garage for the own vehicle, the way out inside), the house window (buying,
// selling, the lock, the garage) and the fade into a house and out of it.
// The server keeps houses, owners and garages (server-files/packages/freeroam/houses.js).
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
constexpr int kFadeMs = 350;
constexpr DWORD kServerTimeoutMs = 2500, kArriveTimeoutMs = 8000;
constexpr DWORD kSellConfirmMs = 4000;
constexpr int kBlipHouse = 40;         // the safehouse icon
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
                const Value* owner = props::field(v, "owner");
                h.owner = owner && !owner->isNil() ? static_cast<int>(owner->asInt()) : -1;
                h.ownerName = props::fieldStr(v, "ownerName");
                const Value* locked = props::field(v, "locked");
                h.locked = locked && locked->asNumber() != 0;
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
        insideHouse_ = in ? static_cast<int>(props::fieldInt(a[0], "id")) : -1;
        if (in) houseExit_ = vec(a[0]);
        // The answer to our own request: wait for the place to load, then fade in.
        if (houseFade_ == 1) {
            houseFade_ = 2;
            houseFadeAt_ = GetTickCount();
            const House* h = in ? nullptr : houseById(houseFadeArg_);
            houseFadeTarget_ = in ? houseExit_ : h ? h->door : houseFadeTarget_;
        }
        return true;
    }
    return false;
}

// Map blips: houses for sale in green, the own house in blue (shown from afar), the others grey.
void GameClient::refreshHouseBlips() {
    const int me = myStatic();
    blipsStatic_ = me;
    for (House& h : houses_) {
        if (h.blip && HUD::DOES_BLIP_EXIST(h.blip)) HUD::REMOVE_BLIP(&h.blip);
        h.blip = HUD::ADD_BLIP_FOR_COORD(h.door.x, h.door.y, h.door.z);
        const bool mine = me >= 0 && h.owner == me;
        HUD::SET_BLIP_SPRITE(h.blip, kBlipHouse);
        HUD::SET_BLIP_COLOUR(h.blip, mine ? kBlipBlue : h.owner < 0 ? kBlipGreen : kBlipGrey);
        HUD::SET_BLIP_SCALE(h.blip, mine ? 0.9f : 0.7f);
        HUD::SET_BLIP_AS_SHORT_RANGE(h.blip, !mine);
        auto cls = houseClasses_.find(h.cls);
        const std::string clsName = cls != houseClasses_.end() ? cls->second.name : h.cls;
        blipName(h.blip, mine ? "Мой дом" : h.owner < 0 ? "Дом на продажу (" + clsName + ")" : "Дом (" + clsName + ")");
    }
}

void GameClient::clearHouseBlips() {
    for (House& h : houses_)
        if (h.blip && HUD::DOES_BLIP_EXIST(h.blip)) HUD::REMOVE_BLIP(&h.blip);
}

// ------------------------------------------------------------------ into a house and out

// The screen goes dark, then the server is asked to move us (gomp:house:enter / exit).
void GameClient::startHouseFade(const std::string& event, int house) {
    if (houseFade_ != 0) return;
    houseFade_ = 1;
    houseFadeAt_ = GetTickCount();
    houseFadeEvent_ = event;
    houseFadeArg_ = house;
    CAMERA::DO_SCREEN_FADE_OUT(kFadeMs);
}

void GameClient::tickHouseFade() {
    if (houseFade_ == 0) return;
    const DWORD now = GetTickCount();
    // 1: once dark, the request goes out (once); the answer is gomp:house:inside.
    if (houseFade_ == 1) {
        if (!houseFadeEvent_.empty() && (CAMERA::IS_SCREEN_FADED_OUT() || now - houseFadeAt_ > 1000)) {
            ScriptEvent ev{houseFadeEvent_, {}};
            if (houseFadeEvent_ != "gomp:house:exit") ev.args.push_back(Value::integer(houseFadeArg_));
            send(ev);
            houseFadeEvent_.clear();
            houseFadeAt_ = now;
        } else if (houseFadeEvent_.empty() && now - houseFadeAt_ > kServerTimeoutMs) {
            houseFade_ = 0;  // refused (a locked door): back to the street
            CAMERA::DO_SCREEN_FADE_IN(kFadeMs);
        }
        return;
    }
    // 2: moved; the interior (or the street) loads around us.
    const Ped me = PLAYER::PLAYER_PED_ID();
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
        ready = ready && ENTITY::HAS_COLLISION_LOADED_AROUND_ENTITY(me);
    }
    if (ready || now - houseFadeAt_ > kArriveTimeoutMs) {
        if (!ready) log("house: the place did not load in time");
        houseFade_ = 0;
        CAMERA::DO_SCREEN_FADE_IN(kFadeMs);
    }
}

// ------------------------------------------------------------------ every frame

bool GameClient::tickHouses(bool interact) {
    tickHouseFade();
    // Our static may arrive after the houses: the own house changes colour then.
    if (!houses_.empty() && myStatic() != blipsStatic_) refreshHouseBlips();
    if (screen_ != Screen::None || dead_ || tuneStage_ != 0 || houseFade_ != 0) return false;
    const Ped me = PLAYER::PLAYER_PED_ID();
    const Vector3 here = ENTITY::GET_ENTITY_COORDS(me, true);
    const bool inVeh = PED::IS_PED_IN_ANY_VEHICLE(me, false);

    // Inside: the way out.
    if (insideHouse_ >= 0) {
        GRAPHICS::DRAW_MARKER(1, houseExit_.x, houseExit_.y, houseExit_.z - 0.98f, 0, 0, 0, 0, 0, 0, 0.8f, 0.8f, 0.3f, theme::Accent.r,
                              theme::Accent.g, theme::Accent.b, 110, false, false, 2, false, nullptr, nullptr, false);
        if (dist(here, houseExit_) > kExitRange) return false;
        drawHint("E", "Выйти на улицу");
        if (interact) startHouseFade("gomp:house:exit", insideHouse_);
        return true;
    }

    const int mine = myStatic();
    const House* door = nullptr;
    const House* garage = nullptr;
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
        if (!inVeh && d < best) {
            best = d;
            door = &h;
        }
        if (inVeh && mine >= 0 && h.owner == mine && d < kGarageRange) garage = &h;
    }

    if (garage) {
        // The driver of an own vehicle that has stopped at the house.
        const Vehicle veh = PED::GET_VEHICLE_PED_IS_IN(me, false);
        auto vit = vehicles_.find(myVehicle_);
        const Value* owner = vit != vehicles_.end() ? props::shared(vit->second.shared, "owner") : nullptr;
        const bool own = owner && !owner->isNil() && owner->asInt() == mine;
        if (!own || VEHICLE::GET_PED_IN_VEHICLE_SEAT(veh, -1, false) != me || ENTITY::GET_ENTITY_SPEED(veh) > 3.0f) return false;
        PAD::DISABLE_CONTROL_ACTION(0, 86, true);  // E is the horn in vehicles
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
    if (!roadSpot(h->door, spot, heading)) spot = {0, 0, 0};  // the server puts it next to the door
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
    const float H = forSale ? (myHouse() ? 0.37f : 0.345f) : mine ? 0.355f + std::max(1, cars) * (carH + 0.006f) : 0.31f;
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
    row("Интерьер", hc.interiorName);
    row("Гараж", std::to_string(hc.garage) + (hc.garage == 2 ? " места" : hc.garage == 1 ? " место" : " мест"));
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
            startHouseFade("gomp:house:enter", id);
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
            startHouseFade("gomp:house:enter", id);
        }
        return;
    }

    // The own house.
    const float third = (bw - 2 * gap) / 3;
    if (uiButton(bx, y, third, bh, "Войти", true)) {
        const int id = h->id;
        closeScreens();
        startHouseFade("gomp:house:enter", id);
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
    y += bh + 0.016f;

    // The garage.
    rect(bx, y + 0.004f, 0.003f, 0.016f, theme::Accent);
    label("ГАРАЖ  " + std::to_string(cars) + " / " + std::to_string(hc.garage), bx + 0.008f, y, 0.3f, theme::Muted);
    if (cars) label("«Насовсем» — забрать из гаража, чтобы продать дом", bx + bw, y, 0.24f, theme::Muted, Align::Right);
    y += 0.03f;
    if (!loaded) {
        label("Загрузка...", bx, y, 0.3f, theme::Muted, Align::Left, carH);
        return;
    }
    if (!cars) {
        label("Пусто. Подъедьте к дому на своём транспорте и нажмите E", bx, y, 0.28f, theme::Muted, Align::Left, carH);
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
