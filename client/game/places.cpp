// Gas stations, 24/7 shops and items lying on the ground: markers, the "E"
// hint at the bottom of the screen, the shop and gas station windows.
// The server sends the places once a character spawns (gomp:places, see
// server-files/packages/freeroam/places.js) and checks every purchase.
#include <cmath>
#include <cstdio>

#include "game_client.hpp"
#include "natives.hpp"
#include "ui.hpp"

namespace gompgame {

using namespace gomp;
using namespace ui;

namespace {

constexpr float kPickupRange = 1.8f;
constexpr float kDropLabelRange = 7.0f;
constexpr float kShopMarkerRange = 30.0f;
constexpr float kFuelVehicleRange = 4.0f;

float dist(Vector3 a, Vec3 b) { return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) + (a.z - b.z) * (a.z - b.z)); }

std::string fixed1(double v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.1f", v);
    return buf;
}

}  // namespace

bool GameClient::handlePlacesEvent(const ScriptEvent& e) {
    if (e.name != "gomp:places") return false;
    const auto& a = e.args;
    places_.clear();
    if (!a.empty() && a[0].kind == Value::Kind::Array) {
        for (const auto& p : a[0].arr) {
            Place pl;
            const std::string type = props::fieldStr(p, "type");
            pl.kind = type == "fuel" ? PlaceKind::Fuel : type == "tune" ? PlaceKind::Tune : PlaceKind::Shop;
            pl.pos = {static_cast<float>(props::fieldNum(p, "x")), static_cast<float>(props::fieldNum(p, "y")), static_cast<float>(props::fieldNum(p, "z"))};
            pl.radius = static_cast<float>(props::fieldNum(p, "r"));
            if (const Value* bay = props::field(p, "bay"); bay && bay->kind == Value::Kind::Array && bay->arr.size() >= 4) {
                pl.bay = {static_cast<float>(bay->arr[0].asNumber()), static_cast<float>(bay->arr[1].asNumber()),
                          static_cast<float>(bay->arr[2].asNumber())};
                pl.bayHeading = static_cast<float>(bay->arr[3].asNumber());
            }
            places_.push_back(pl);
        }
    }
    if (a.size() > 1 && a[1].kind == Value::Kind::Map) {
        fuelPrice_ = static_cast<int>(props::fieldNum(a[1], "fuelPrice"));
        catalog_.clear();
        if (const Value* c = a[1].get("catalog"); c && c->kind == Value::Kind::Array)
            for (const auto& item : c->arr) catalog_.emplace_back(props::fieldStr(item, "key"), static_cast<int>(props::fieldNum(item, "price")));
        // Tuning prices (tuning.js PRICES): the client shows what the server will charge.
        if (const Value* t = a[1].get("tuning"); t && t->kind == Value::Kind::Map) {
            logic::TunePrices p;
            p.levelStep = props::fieldNum(*t, "levelStep");
            p.otherMod = static_cast<int>(props::fieldNum(*t, "otherMod"));
            auto table = [&](const char* name, std::map<int, int>& out) {
                if (const Value* m = t->get(name); m && m->kind == Value::Kind::Map)
                    for (const auto& [k, v] : m->map) out[props::key(k)] = static_cast<int>(v.asNumber());
            };
            table("mods", p.mods);
            table("toggles", p.toggles);
            for (const char* f : {"primary", "secondary", "pearl", "wheelColor", "wheelType", "windowTint", "neon", "plateType", "livery"})
                p.fields[f] = static_cast<int>(props::fieldNum(*t, f));
            tunePrices_ = p;
        }
    }
    return true;
}

// [E] text, at the bottom centre above the hotbar.
void GameClient::drawHint(const std::string& key, const std::string& text) {
    int sw, sh;
    screenSize(sw, sh);
    const float h = 0.04f, kw = h * sh / sw, scale = 0.36f;
    const float tw = textWidth(text, scale) + 0.02f, w = kw + 0.008f + tw;
    const float x = 0.5f - w / 2, y = 0.84f;
    roundRect(x, y, w, h, theme::Hud, 8);
    roundRect(x + 0.003f, y + 0.005f, kw - 0.006f, h - 0.01f, theme::Accent, 6);
    label(key, x + kw / 2, y, 0.42f, theme::OnAccent, Align::Center, h);
    label(text, x + kw + 0.008f, y, scale, theme::Text, Align::Left, h);
}

// ------------------------------------------------------------------ every frame

// interact: E was pressed; hintTaken: a house hint is shown (houses.cpp), so no other.
void GameClient::tickPlaces(bool interact, bool hintTaken) {
    if (screen_ != Screen::None || dead_ || tuneStage_ != 0) return;
    Ped me = PLAYER::PLAYER_PED_ID();
    const Vector3 here = ENTITY::GET_ENTITY_COORDS(me, true);
    const bool inVeh = PED::IS_PED_IN_ANY_VEHICLE(me, false);

    // Items on the ground: names nearby, the closest one can be picked up.
    uint16_t dropId = kNoID;
    std::string dropText;
    float dropBest = kPickupRange;
    for (auto& [key, e] : world_) {
        if (e.type != EntityType::Object || !e.handle) continue;
        const Value* d = props::shared(e.shared, "drop");
        if (!d || d->kind != Value::Kind::Map) continue;
        const Vector3 op = ENTITY::GET_ENTITY_COORDS(e.handle, true);
        const float dd = dist(here, {op.x, op.y, op.z});
        if (dd > kDropLabelRange) continue;
        const int count = static_cast<int>(props::fieldNum(*d, "count"));
        const std::string text = props::fieldStr(*d, "label") + (count > 1 ? " x" + std::to_string(count) : "");
        drawText3d(text, {op.x, op.y, op.z + 0.25f}, 0.3f, theme::Font, theme::Text);
        if (!inVeh && dd < dropBest) {
            dropBest = dd;
            dropId = e.id;
            dropText = text;
        }
    }

    // Shops: a marker at the till.
    int shop = -1, shopIndex = 0;
    for (const Place& pl : places_) {
        if (pl.kind != PlaceKind::Shop) continue;
        const float d = dist(here, pl.pos);
        if (d < kShopMarkerRange)
            GRAPHICS::DRAW_MARKER(1, pl.pos.x, pl.pos.y, pl.pos.z - 0.98f, 0, 0, 0, 0, 0, 0, 0.9f, 0.9f, 0.35f, theme::Accent.r,
                                  theme::Accent.g, theme::Accent.b, 120, false, false, 2, false, nullptr, nullptr, false);
        if (!inVeh && d <= pl.radius) shop = shopIndex;
        ++shopIndex;
    }

    // Gas stations: the vehicle being driven, or one standing next to the player.
    uint16_t fuelVeh = kNoID;
    const bool driver = inVeh && myVehicle_ != kNoID &&
                        VEHICLE::GET_PED_IN_VEHICLE_SEAT(PED::GET_VEHICLE_PED_IS_IN(me, false), -1, false) == me;
    const uint16_t candidate = driver ? myVehicle_ : inVeh ? kNoID : nearestVehicle(kFuelVehicleRange);
    if (auto vit = vehicles_.find(candidate); vit != vehicles_.end() && vit->second.handle) {
        const Vector3 vp = ENTITY::GET_ENTITY_COORDS(vit->second.handle, true);
        float tank = 0;
        vehicleFuel(vit->second, &tank);
        for (const Place& pl : places_)
            if (pl.kind == PlaceKind::Fuel && tank > 0 && dist(vp, pl.pos) <= pl.radius) fuelVeh = candidate;
    }

    // Tuning shops: the driver of an own vehicle that stands in the workshop.
    bool tuneHere = false, tuneOwn = false;
    const Place* tuneShop = nullptr;
    if (driver) {
        const Vehicle veh = vehicleHandle(myVehicle_);
        const Vector3 vp = ENTITY::GET_ENTITY_COORDS(veh, true);
        for (const Place& pl : places_)
            if (pl.kind == PlaceKind::Tune && dist(vp, pl.pos) <= pl.radius) tuneShop = &pl;
        tuneHere = tuneShop != nullptr;
        if (auto vit = vehicles_.find(myVehicle_); tuneHere && vit != vehicles_.end()) {
            const Value* owner = props::shared(vit->second.shared, "owner");
            const Value* statik = props::shared(selfShared_, "static");
            tuneOwn = owner && statik && owner->asInt() == statik->asInt();
        }
        tuneHere = tuneHere && ENTITY::GET_ENTITY_SPEED(veh) < 3.0f;
    }

    if (hintTaken) return;
    if (tuneHere) {
        PAD::DISABLE_CONTROL_ACTION(0, 86, true);  // E is the horn in vehicles
        if (!tuneOwn) {
            drawHint("!", "Тюнинг доступен только для личного транспорта");
        } else {
            drawHint("E", "Los Santos Customs — тюнинг");
            if (interact) enterTuning(myVehicle_, *tuneShop);
        }
    } else if (dropId != kNoID) {
        drawHint("E", "Подобрать: " + dropText);
        if (interact) send(ScriptEvent{"gomp:drop:pickup", {Value::integer(dropId)}});
    } else if (shop >= 0) {
        drawHint("E", "Магазин 24/7");
        if (interact) {
            shopIndex_ = shop;
            openScreen(Screen::Shop);
        }
    } else if (fuelVeh != kNoID) {
        if (inVeh) PAD::DISABLE_CONTROL_ACTION(0, 86, true);  // E is the horn in vehicles
        drawHint("E", "Заправить транспорт");
        if (interact) {
            const Vehicle veh = vehicleHandle(fuelVeh);
            if (VEHICLE::GET_IS_VEHICLE_ENGINE_RUNNING(veh)) {
                notify("~r~Сначала заглушите двигатель~s~ (G → Двигатель)");
            } else {
                float tank = 0;
                const float fuel = vehicleFuel(vehicles_.at(fuelVeh), &tank);
                fuelVehicle_ = fuelVeh;
                fuelLitres_ = std::max(0.0f, std::floor(tank - fuel));
                openScreen(Screen::Fuel);
            }
        }
    }
}

// ------------------------------------------------------------------ shop

void GameClient::drawShop() {
    const float W = 0.6f, rowH = 0.062f, gap = 0.008f;
    const int rows = (static_cast<int>(catalog_.size()) + 1) / 2;
    const float H = 0.1f + rows * (rowH + gap) + 0.075f;
    const float X = 0.5f - W / 2, Y = 0.5f - H / 2;
    const float aspect = GRAPHICS::GET_ASPECT_RATIO(false);
    panel(X, Y, W, H);
    label("МАГАЗИН 24/7", X + 0.018f, Y + 0.014f, 0.5f, theme::Text);
    label("Еда, медикаменты и всё для машины", X + 0.018f, Y + 0.052f, 0.3f, theme::Muted);
    label("Esc — закрыть", X + W - 0.018f, Y + 0.024f, 0.28f, theme::Muted, Align::Right);

    // A cheap button: a one-pixel frame and a label.
    auto button = [&](float x, float y, float w, float h, const std::string& text, bool primary) {
        const bool hover = mouseX_ >= x && mouseX_ <= x + w && mouseY_ >= y && mouseY_ <= y + h;
        frame(x, y, w, h, primary ? (hover ? theme::AccentHi : theme::Accent) : (hover ? theme::SurfaceHi : theme::Surface),
              primary ? theme::Accent : theme::SlotBorder);
        label(text, x + w / 2, y, 0.32f, primary ? theme::OnAccent : theme::Text, Align::Center, h);
        return hover && mouseClick_;
    };

    const float colW = (W - 0.036f - gap) / 2;
    for (int i = 0; i < static_cast<int>(catalog_.size()); ++i) {
        const auto& [key, price] = catalog_[i];
        const float x = X + 0.018f + (i % 2) * (colW + gap), y = Y + 0.09f + (i / 2) * (rowH + gap);
        frame(x, y, colW, rowH, theme::Slot, theme::SlotBorder);
        auto def = itemDefs_.find(key);
        const std::string name = def != itemDefs_.end() ? def->second.name : key;
        const float iw = 0.03f, ih = iw * aspect;
        if (def != itemDefs_.end()) drawIcon(def->second.icon, x + 0.006f, y + (rowH - ih) / 2, iw, ih, theme::Text);
        label(name, x + iw + 0.014f, y + 0.007f, 0.34f, theme::Text);
        label(money(price), x + iw + 0.014f, y + 0.034f, 0.3f, theme::Positive);
        // Quantity: - n +
        int& qty = shopQty_[key];
        qty = std::clamp(qty, 1, 50);
        const float bh = 0.03f, by = y + (rowH - bh) / 2, sbw = 0.018f;
        const float buyW = 0.07f, buyX = x + colW - buyW - 0.006f;
        const float qx = buyX - 0.008f - (sbw * 2 + 0.03f);
        if (button(qx, by, sbw, bh, "-", false)) qty = std::max(1, qty - 1);
        label(std::to_string(qty), qx + sbw + 0.015f, by, 0.34f, theme::Text, Align::Center, bh);
        if (button(qx + sbw + 0.03f, by, sbw, bh, "+", false)) qty = std::min(50, qty + 1);
        if (button(buyX, by, buyW, bh, "Купить " + money(static_cast<long long>(price) * qty), true))
            send(ScriptEvent{"gomp:shop:buy", {Value::integer(shopIndex_), Value::string(key), Value::integer(qty),
                                               Value::string(payByCard_ ? "bank" : "cash")}});
    }

    // Payment method.
    const Value* cash = props::shared(selfShared_, "cash");
    const Value* bank = props::shared(selfShared_, "bank");
    const float fy = Y + H - 0.058f, fh = 0.038f, fw = 0.17f;
    label("Оплата:", X + 0.018f, fy, 0.34f, theme::Muted, Align::Left, fh);
    if (button(X + 0.09f, fy, fw, fh, "Наличные " + money(cash ? cash->asInt() : 0), !payByCard_)) payByCard_ = false;
    if (button(X + 0.1f + fw, fy, fw, fh, "Карта " + money(bank ? bank->asInt() : 0), payByCard_)) payByCard_ = true;
}

// ------------------------------------------------------------------ gas station

void GameClient::drawFuel() {
    auto it = vehicles_.find(fuelVehicle_);
    if (it == vehicles_.end() || !it->second.handle) {
        closeScreens();
        return;
    }
    const Vehicle veh = it->second.handle;
    float tank = 0;
    const float fuel = vehicleFuel(it->second, &tank);
    const float space = std::max(0.0f, tank - fuel);
    fuelLitres_ = std::clamp(fuelLitres_, 0.0f, space);

    const float W = 0.32f, H = 0.4f, X = 0.5f - W / 2, Y = 0.5f - H / 2;
    panel(X, Y, W, H);
    label("АЗС", X + 0.018f, Y + 0.014f, 0.5f, theme::Text);
    label(vehicleName(veh), X + W - 0.018f, Y + 0.024f, 0.32f, theme::Accent, Align::Right);

    // The tank: what is in it and what will be added.
    const float bx = X + 0.018f, bw = W - 0.036f;
    float y = Y + 0.07f;
    label("В баке " + fixed1(fuel) + " из " + fixed1(tank) + " л", bx, y, 0.32f, theme::Muted);
    y += 0.03f;
    rect(bx, y, bw, 0.014f, theme::SurfaceHi);
    rect(bx, y, bw * std::clamp(fuel / std::max(1.0f, tank), 0.0f, 1.0f), 0.014f, theme::Positive);
    rect(bx + bw * fuel / std::max(1.0f, tank), y, bw * fuelLitres_ / std::max(1.0f, tank), 0.014f, theme::Accent);
    y += 0.03f;

    // Litres.
    label("Литров", bx, y, 0.34f, theme::Muted, Align::Left, 0.036f);
    label(fixed1(fuelLitres_) + " л", bx + bw, y, 0.42f, theme::Text, Align::Right, 0.036f);
    y += 0.044f;
    const float sw = (bw - 0.024f) / 5;
    const std::pair<const char*, float> steps[] = {{"-10", -10}, {"-1", -1}, {"+1", 1}, {"+10", 10}, {"Полный", 1000}};
    for (int i = 0; i < 5; ++i)
        if (uiButton(bx + i * (sw + 0.006f), y, sw, 0.034f, steps[i].first)) fuelLitres_ = std::clamp(fuelLitres_ + steps[i].second, 0.0f, space);
    y += 0.05f;

    const long long total = static_cast<long long>(std::ceil(fuelLitres_ * fuelPrice_));
    label("Цена за литр", bx, y, 0.32f, theme::Muted);
    label(money(fuelPrice_), bx + bw, y, 0.32f, theme::Text, Align::Right);
    y += 0.028f;
    label("Итого", bx, y, 0.38f, theme::Text);
    label(money(total), bx + bw, y, 0.42f, theme::Positive, Align::Right);
    y += 0.042f;

    const Value* cash = props::shared(selfShared_, "cash");
    const Value* bank = props::shared(selfShared_, "bank");
    const float pw = (bw - 0.008f) / 2;
    if (uiButton(bx, y, pw, 0.036f, "Наличные " + money(cash ? cash->asInt() : 0), !payByCard_)) payByCard_ = false;
    if (uiButton(bx + pw + 0.008f, y, pw, 0.036f, "Карта " + money(bank ? bank->asInt() : 0), payByCard_)) payByCard_ = true;
    y += 0.05f;

    if (uiButton(bx, y, pw, 0.042f, "Заправить", true, fuelLitres_ >= 0.1f)) {
        send(ScriptEvent{"gomp:fuel:buy", {Value::integer(fuelVehicle_), Value::number(fuelLitres_),
                                           Value::string(payByCard_ ? "bank" : "cash")}});
        closeScreens();
        return;
    }
    if (uiButton(bx + pw + 0.008f, y, pw, 0.042f, "Отмена")) closeScreens();
}

}  // namespace gompgame
