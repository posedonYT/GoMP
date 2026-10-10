// The car dealership (Premium Deluxe Motorsport): the catalog comes from the
// server (gomp:dealer, server-files/packages/freeroam/dealership.js) when the
// character spawns. At the counter "E" opens the window: two sections (custom
// cars of the add-on packs, the game's own cars), each split by vehicle class;
// the chosen car stands on the showroom floor (a local vehicle, nobody else
// sees it) under a slowly circling camera, in the colour picked.
#include <algorithm>
#include <cmath>

#include "game_client.hpp"
#include "natives.hpp"
#include "props.hpp"
#include "ui.hpp"

namespace gompgame {

using namespace gomp;
using namespace ui;

namespace {

constexpr float kMarkerRange = 25.0f;
constexpr int kRowsShown = 11;

float dist(Vector3 a, Vec3 b) { return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) + (a.z - b.z) * (a.z - b.z)); }

Vec3 vec3(const Value* v) {
    if (!v || v->kind != Value::Kind::Array || v->arr.size() < 3) return {};
    return {static_cast<float>(v->arr[0].asNumber()), static_cast<float>(v->arr[1].asNumber()), static_cast<float>(v->arr[2].asNumber())};
}

Rgba hexColor(const std::string& s) {
    if (s.size() != 7 || s[0] != '#') return theme::Muted;
    const long v = std::strtol(s.c_str() + 1, nullptr, 16);
    return {static_cast<int>((v >> 16) & 0xFF), static_cast<int>((v >> 8) & 0xFF), static_cast<int>(v & 0xFF), 255};
}

}  // namespace

// The game's name of a vehicle model in the game's language, else the fallback.
std::string GameClient::vehicleName(Hash model, const std::string& fallback) const {
    const char* label = VEHICLE::GET_DISPLAY_NAME_FROM_VEHICLE_MODEL(model);
    if (!label || !*label || std::string(label) == "CARNOTFOUND") return fallback;
    const char* text = HUD::GET_FILENAME_FOR_AUDIO_CONVERSATION(label);
    if (!text || !*text || std::string(text) == "NULL") return fallback.empty() ? label : fallback;
    return text;
}

bool GameClient::handleDealerEvent(const ScriptEvent& e) {
    const auto& a = e.args;
    if (e.name == "gomp:dealer:bought") {
        if (screen_ == Screen::Dealer) closeScreens();
        if (!a.empty()) HUD::SET_NEW_WAYPOINT(static_cast<float>(props::fieldNum(a[0], "x")), static_cast<float>(props::fieldNum(a[0], "y")));
        return true;
    }
    if (e.name != "gomp:dealer" || a.empty() || a[0].kind != Value::Kind::Map) return false;
    const Value& d = a[0];
    dealerName_ = props::fieldStr(d, "name");
    dealerMarker_ = vec3(props::field(d, "marker"));
    dealerRadius_ = static_cast<float>(props::fieldNum(d, "radius"));
    const Value* pv = props::field(d, "preview");
    dealerPreviewPos_ = vec3(pv);
    dealerPreviewHeading_ = pv && pv->arr.size() > 3 ? static_cast<float>(pv->arr[3].asNumber()) : 0.0f;
    dealerColors_.clear();
    if (const Value* c = props::field(d, "colors"); c && c->kind == Value::Kind::Array)
        for (const auto& x : c->arr)
            dealerColors_.push_back({static_cast<int>(props::fieldInt(x, "id")), props::fieldStr(x, "name"), hexColor(props::fieldStr(x, "rgb"))});
    dealerSections_.clear();
    if (const Value* s = props::field(d, "sections"); s && s->kind == Value::Kind::Array)
        for (const auto& x : s->arr) dealerSections_.emplace_back(props::fieldStr(x, "id"), props::fieldStr(x, "name"));
    dealerClasses_.clear();
    if (const Value* s = props::field(d, "classes"); s && s->kind == Value::Kind::Array)
        for (const auto& x : s->arr) dealerClasses_.emplace_back(static_cast<int>(props::fieldInt(x, "id")), props::fieldStr(x, "name"));
    dealerCars_.clear();
    if (const Value* s = props::field(d, "vehicles"); s && s->kind == Value::Kind::Array) {
        for (const auto& x : s->arr) {
            DealerCar c;
            c.model = props::fieldStr(x, "model");
            c.hash = joaat(c.model);
            c.cls = static_cast<int>(props::fieldInt(x, "cls"));
            c.price = props::fieldInt(x, "price");
            const Value* custom = props::field(x, "custom");
            c.custom = custom && custom->asNumber() != 0;
            c.name = props::fieldStr(x, "name");
            if (c.name.empty()) c.name = vehicleName(c.hash, c.model);
            dealerCars_.push_back(std::move(c));
        }
    }
    dealerLoaded_ = !dealerCars_.empty() && !dealerSections_.empty();
    STREAMING::REQUEST_IPL("shr_int");  // the showroom's interior
    return true;
}

// Near the counter: the marker and "E".
bool GameClient::tickDealer(bool interact, bool hintTaken) {
    if (!dealerLoaded_ || screen_ != Screen::None || dead_) return false;
    const Ped me = PLAYER::PLAYER_PED_ID();
    const Vector3 here = ENTITY::GET_ENTITY_COORDS(me, true);
    const float d = dist(here, dealerMarker_);
    if (d > kMarkerRange) return false;
    GRAPHICS::DRAW_MARKER(36, dealerMarker_.x, dealerMarker_.y, dealerMarker_.z, 0, 0, 0, 0, 0, 0, 0.8f, 0.8f, 0.8f, theme::Accent.r,
                          theme::Accent.g, theme::Accent.b, 150, true, true, 2, false, nullptr, nullptr, false);
    if (hintTaken || d > dealerRadius_ || PED::IS_PED_IN_ANY_VEHICLE(me, false)) return false;
    drawHint("E", dealerName_.empty() ? "Автосалон" : dealerName_);
    if (interact) openDealer();
    return true;
}

void GameClient::openDealer() {
    dealerSection_ = std::clamp(dealerSection_, 0, static_cast<int>(dealerSections_.size()) - 1);
    dealerPick_ = -1;
    dealerScroll_ = 0;
    dealerOrbit_ = 0;
    openScreen(Screen::Dealer);
    // The camera over the showroom floor (lobby screens make their own; this one is ours).
    if (!uiCam_) {
        const Vec3& p = dealerPreviewPos_;
        uiCam_ = CAMERA::CREATE_CAM_WITH_PARAMS("DEFAULT_SCRIPTED_CAMERA", p.x, p.y - 6, p.z + 2, 0, 0, 0, 45.0f, true, 2);
        CAMERA::RENDER_SCRIPT_CAMS(true, true, 500, true, false, 0);
    }
    CAMERA::SET_CAM_ACTIVE(uiCam_, true);
}

void GameClient::closeDealer() {
    if (dealerPreview_ && ENTITY::DOES_ENTITY_EXIST(dealerPreview_)) {
        ENTITY::SET_ENTITY_AS_MISSION_ENTITY(dealerPreview_, true, true);
        ENTITY::DELETE_ENTITY(&dealerPreview_);
    }
    if (dealerPreviewModel_) STREAMING::SET_MODEL_AS_NO_LONGER_NEEDED(dealerPreviewModel_);
    dealerPreview_ = 0;
    dealerPreviewModel_ = 0;
    dealerPreviewColor_ = -1;
}

// The chosen car on the floor: made once its model has streamed in, recoloured, turned slowly.
void GameClient::updateDealerPreview() {
    const DealerCar* car = dealerPick_ >= 0 && dealerPick_ < static_cast<int>(dealerCars_.size()) ? &dealerCars_[dealerPick_] : nullptr;
    const Hash want = car ? car->hash : 0;
    if (dealerPreviewModel_ != want) {
        closeDealer();
        dealerPreviewModel_ = want;
    }
    const Vec3& p = dealerPreviewPos_;
    dealerOrbit_ += MISC::GET_FRAME_TIME() * 12.0f;  // degrees per second
    if (want && !dealerPreview_ && ensureModel(want)) {
        dealerPreview_ = VEHICLE::CREATE_VEHICLE(want, p.x, p.y, p.z, dealerPreviewHeading_, false, false, false);
        if (dealerPreview_) {
            ENTITY::SET_ENTITY_AS_MISSION_ENTITY(dealerPreview_, true, true);
            VEHICLE::SET_VEHICLE_ON_GROUND_PROPERLY(dealerPreview_, 5.0f);
            ENTITY::FREEZE_ENTITY_POSITION(dealerPreview_, true);
            VEHICLE::SET_VEHICLE_DIRT_LEVEL(dealerPreview_, 0.0f);
            VEHICLE::SET_VEHICLE_DOORS_LOCKED(dealerPreview_, 2);
            dealerPreviewColor_ = -1;
        }
    }
    if (dealerPreview_) {
        const int color = dealerColors_.empty() ? 0 : dealerColors_[std::clamp(dealerColor_, 0, static_cast<int>(dealerColors_.size()) - 1)].id;
        if (color != dealerPreviewColor_) {
            VEHICLE::SET_VEHICLE_COLOURS(dealerPreview_, color, color);
            dealerPreviewColor_ = color;
        }
        ENTITY::SET_ENTITY_HEADING(dealerPreview_, std::fmod(dealerPreviewHeading_ + dealerOrbit_, 360.0f));
    }
    if (uiCam_) {
        // From the front-left, a little above: the car turns in front of it.
        const float a = (dealerPreviewHeading_ + 200.0f) * 3.14159265f / 180.0f;
        CAMERA::SET_CAM_COORD(uiCam_, p.x - std::sin(a) * 6.5f, p.y + std::cos(a) * 6.5f, p.z + 1.6f);
        CAMERA::POINT_CAM_AT_COORD(uiCam_, p.x, p.y, p.z + 0.3f);
    }
}

void GameClient::drawDealer() {
    updateDealerPreview();
    const float X = 0.03f, Y = 0.08f, W = 0.3f, H = 0.84f;
    panel(X, Y, W, H);
    label(dealerName_.empty() ? "АВТОСАЛОН" : dealerName_, X + 0.016f, Y + 0.014f, 0.46f, theme::Text);
    label("Esc — выйти", X + W - 0.016f, Y + 0.022f, 0.28f, theme::Muted, Align::Right);

    // Sections: custom / the game's cars.
    float y = Y + 0.06f;
    const int sections = static_cast<int>(dealerSections_.size());
    const float sw = (W - 0.032f - (sections - 1) * 0.006f) / std::max(1, sections);
    for (int i = 0; i < sections; ++i) {
        if (uiButton(X + 0.016f + i * (sw + 0.006f), y, sw, 0.04f, dealerSections_[i].second, i == dealerSection_)) {
            dealerSection_ = i;
            dealerClass_ = 0;
            dealerScroll_ = 0;
            dealerPick_ = -1;
        }
    }
    y += 0.052f;
    const bool custom = sections > 0 && dealerSections_[dealerSection_].first == "custom";

    // Subsections: the classes that have cars in this section.
    std::vector<int> order;
    for (const auto& [cls, name] : dealerClasses_) order.push_back(cls);
    const std::vector<int> classes = logic::dealerClasses(dealerCars_, custom, order);
    dealerClass_ = std::clamp(dealerClass_, 0, std::max(0, static_cast<int>(classes.size()) - 1));
    {
        float cx = X + 0.016f;
        const float ch = 0.03f;
        for (int i = 0; i < static_cast<int>(classes.size()); ++i) {
            auto it = std::find_if(dealerClasses_.begin(), dealerClasses_.end(), [&](const auto& c) { return c.first == classes[i]; });
            const std::string& name = it->second;
            const float cw = textWidth(name, 0.3f) + 0.016f;
            if (cx + cw > X + W - 0.016f) {
                cx = X + 0.016f;
                y += ch + 0.006f;
            }
            const bool on = i == dealerClass_;
            const bool hover = mouseX_ >= cx && mouseX_ <= cx + cw && mouseY_ >= y && mouseY_ <= y + ch;
            roundRect(cx, y, cw, ch, on ? theme::AccentSoft : hover ? theme::SurfaceHi : theme::Surface, 6);
            label(name, cx + cw / 2, y, 0.3f, on ? theme::Accent : theme::Text, Align::Center, ch);
            if (hover && mouseClick_) {
                dealerClass_ = i;
                dealerScroll_ = 0;
                dealerPick_ = -1;
            }
            cx += cw + 0.006f;
        }
        y += ch + 0.014f;
    }

    // The cars of the class, cheapest first; the wheel scrolls.
    const std::vector<int> list = classes.empty() ? std::vector<int>{} : logic::dealerList(dealerCars_, custom, classes[dealerClass_]);
    const float rowH = 0.04f, listTop = y, listH = kRowsShown * (rowH + 0.004f);
    const int maxScroll = std::max(0, static_cast<int>(list.size()) - kRowsShown);
    if (mouseX_ >= X && mouseX_ <= X + W && mouseY_ >= listTop && mouseY_ <= listTop + listH) {
        if (PAD::IS_DISABLED_CONTROL_JUST_PRESSED(2, 241)) --dealerScroll_;
        if (PAD::IS_DISABLED_CONTROL_JUST_PRESSED(2, 242)) ++dealerScroll_;
    }
    dealerScroll_ = std::clamp(dealerScroll_, 0, maxScroll);
    if (dealerPick_ < 0 && !list.empty()) dealerPick_ = list[0];
    for (int r = 0; r < kRowsShown && dealerScroll_ + r < static_cast<int>(list.size()); ++r) {
        const int i = list[dealerScroll_ + r];
        const DealerCar& c = dealerCars_[i];
        const float ry = listTop + r * (rowH + 0.004f);
        const bool on = i == dealerPick_;
        const bool hover = mouseX_ >= X + 0.016f && mouseX_ <= X + W - 0.016f && mouseY_ >= ry && mouseY_ <= ry + rowH;
        roundRect(X + 0.016f, ry, W - 0.032f, rowH, on ? theme::AccentSoft : hover ? theme::SurfaceHi : theme::Surface, 7);
        if (on) rect(X + 0.016f, ry + 0.008f, 0.003f, rowH - 0.016f, theme::Accent);
        label(c.name, X + 0.028f, ry, 0.34f, on ? theme::Accent : theme::Text, Align::Left, rowH);
        label(money(c.price), X + W - 0.028f, ry, 0.32f, theme::Positive, Align::Right, rowH);
        if (hover && mouseClick_) dealerPick_ = i;
    }
    if (list.size() > static_cast<std::size_t>(kRowsShown))
        label(std::to_string(dealerScroll_ + 1) + "–" + std::to_string(std::min<int>(dealerScroll_ + kRowsShown, static_cast<int>(list.size()))) + " из " +
                  std::to_string(list.size()) + "  ·  колесо мыши — прокрутка",
              X + W / 2, listTop + listH + 0.004f, 0.26f, theme::Muted, Align::Center);

    // The chosen car: details, colour, purchase (bottom right).
    if (dealerPick_ < 0 || dealerPick_ >= static_cast<int>(dealerCars_.size())) return;
    const DealerCar& c = dealerCars_[dealerPick_];
    const float PW = 0.34f, PH = 0.27f, PX = 1.0f - PW - 0.03f, PY = 1.0f - PH - 0.06f;
    panel(PX, PY, PW, PH);
    label(c.name, PX + 0.016f, PY + 0.012f, 0.5f, theme::Text);
    std::string make;
    if (const char* m = VEHICLE::GET_MAKE_NAME_FROM_VEHICLE_MODEL(c.hash); m && *m) {
        const char* t = HUD::GET_FILENAME_FOR_AUDIO_CONVERSATION(m);
        make = t && *t && std::string(t) != "NULL" ? t : "";
    }
    auto cls = std::find_if(dealerClasses_.begin(), dealerClasses_.end(), [&](const auto& x) { return x.first == c.cls; });
    label((make.empty() ? "" : make + "  ·  ") + (cls != dealerClasses_.end() ? cls->second : ""), PX + 0.016f, PY + 0.05f, 0.3f, theme::Muted);
    const int kmh = static_cast<int>(std::lround(VEHICLE::GET_VEHICLE_MODEL_ESTIMATED_MAX_SPEED(c.hash) * 3.6f));
    const int seats = VEHICLE::GET_VEHICLE_MODEL_NUMBER_OF_SEATS(c.hash);
    pill(money(c.price), PX + PW - 0.016f, PY + 0.016f, 0.034f, 0.36f, theme::AccentSoft, theme::Accent, Align::Right);
    label("Макс. скорость: " + std::to_string(kmh) + " км/ч    Мест: " + std::to_string(seats), PX + 0.016f, PY + 0.08f, 0.3f, theme::Text);

    // Colours.
    float cx = PX + 0.016f;
    const float sy = PY + 0.115f;
    int sw2, sh2;
    screenSize(sw2, sh2);
    const float dh = 0.03f, dw = dh * sh2 / sw2;
    for (int i = 0; i < static_cast<int>(dealerColors_.size()); ++i) {
        const bool on = i == dealerColor_;
        if (on) roundRect(cx - 0.002f, sy - 0.002f * sw2 / sh2, dw + 0.004f, dh + 0.004f * sw2 / sh2, theme::Accent, 6);
        roundRect(cx, sy, dw, dh, dealerColors_[i].rgb, 5);
        if (mouseX_ >= cx && mouseX_ <= cx + dw && mouseY_ >= sy && mouseY_ <= sy + dh && mouseClick_) dealerColor_ = i;
        cx += dw + 0.006f;
    }
    if (!dealerColors_.empty())
        label("Цвет: " + dealerColors_[std::clamp(dealerColor_, 0, static_cast<int>(dealerColors_.size()) - 1)].name, PX + 0.016f, sy + dh + 0.008f, 0.28f, theme::Muted);

    const Value* cash = props::shared(selfShared_, "cash");
    const Value* bank = props::shared(selfShared_, "bank");
    const int colorId = dealerColors_.empty() ? 0 : dealerColors_[std::clamp(dealerColor_, 0, static_cast<int>(dealerColors_.size()) - 1)].id;
    const float by = PY + PH - 0.058f, bw = (PW - 0.04f) / 2;
    auto buy = [&](const char* method) {
        send(ScriptEvent{"gomp:dealer:buy", {Value::string(c.model), Value::integer(colorId), Value::string(method)}});
    };
    if (uiButton(PX + 0.016f, by, bw, 0.042f, "Наличными (" + money(cash ? cash->asInt() : 0) + ")", true, cash && cash->asInt() >= c.price)) buy("cash");
    if (uiButton(PX + 0.024f + bw, by, bw, 0.042f, "Картой (" + money(bank ? bank->asInt() : 0) + ")", true, bank && bank->asInt() >= c.price)) buy("bank");
}

}  // namespace gompgame
