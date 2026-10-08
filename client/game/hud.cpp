// GoMP HUD: location and money next to the minimap, online/name, ammo,
// speedometer and crosshair; the F2 menu (character, animations, crosshair,
// settings), the layout editor and the movable minimap. Settings live in
// %APPDATA%\GoMP\settings.ini so they survive the launcher's cleanup.
//
// The speedometer follows Yet Another Speedometer Mod by rikkamus
// (https://github.com/rikkamus/yasm, MIT): speed of the vehicle the player is
// using, km/h = m/s * 3.6, fading in and out at 765 alpha per second.
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <functional>
#include <sstream>
#include <thread>

#include "game_client.hpp"
#include "natives.hpp"
#include "props.hpp"
#include "ui.hpp"

namespace gompgame {

using namespace gomp;
using namespace ui;

namespace {

// Animations of the F2 menu; the same order as ANIMATIONS in server-files/packages/freeroam/roleplay.js.
const char* const kAnimations[] = {
    "Помахать",  "Руки вверх", "Скрестить руки", "Фейспалм",    "Сесть",          "Лечь",          "Танец",
    "Курить",    "Облокотиться", "Кофе",         "Фото на телефон", "Отжимания",  "Аплодировать", "Гитара",
};

struct NamedColor {
    const char* name;
    Rgba color;
};
const NamedColor kCrossColors[] = {
    {"Бирюзовый", {32, 184, 205, 255}}, {"Белый", {255, 255, 255, 255}}, {"Зелёный", {80, 230, 120, 255}},
    {"Красный", {240, 70, 80, 255}},    {"Жёлтый", {250, 220, 60, 255}}, {"Розовый", {255, 100, 200, 255}},
    {"Голубой", {90, 170, 255, 255}},
};
const char* const kCrossStyles[] = {"Крест", "T-образный", "Точка", "Круг"};

constexpr Hash kUnarmed = 0xA2719263;      // WEAPON_UNARMED
constexpr Hash kGroupSniper = 3082541095;  // GROUP_SNIPER
constexpr DWORD kCrossHoldMs = 2000;       // the crosshair stays this long after aiming/shooting

std::string settingsPath() {
    const char* appData = std::getenv("APPDATA");
    std::string dir = std::string(appData ? appData : ".") + "\\GoMP";
    CreateDirectoryA(dir.c_str(), nullptr);
    return dir + "\\settings.ini";
}

// Frontend (frontend.xml) defaults of the minimap parts: posX, posY, sizeX, sizeY.
constexpr float kMinimapDefaults[3][4] = {
    {-0.0045f, 0.002f, 0.150f, 0.188888f},  // minimap
    {0.020f, 0.032f, 0.111f, 0.159f},       // minimap_mask
    {-0.03f, 0.022f, 0.266f, 0.237f},       // minimap_blur
};

// Scans committed read-write memory of the game for the minimap layout data.
// Runs on its own thread; memory is read with ReadProcessMemory so a region
// released meanwhile cannot crash the game.
void scanMinimap(float** out, std::atomic<int>* state) {
    HANDLE self = GetCurrentProcess();
    std::vector<uint8_t> buf(1 << 20);
    uint8_t* addr = nullptr;
    MEMORY_BASIC_INFORMATION mbi{};
    int found = 0;
    while (found < 3 && VirtualQuery(addr, &mbi, sizeof(mbi))) {
        uint8_t* base = static_cast<uint8_t*>(mbi.BaseAddress);
        const bool rw = mbi.State == MEM_COMMIT && (mbi.Protect & (PAGE_READWRITE | PAGE_EXECUTE_READWRITE)) &&
                        !(mbi.Protect & PAGE_GUARD);
        if (rw) {
            for (std::size_t off = 0; off < mbi.RegionSize; off += buf.size() - 16) {
                SIZE_T want = std::min(buf.size(), mbi.RegionSize - off), got = 0;
                if (!ReadProcessMemory(self, base + off, buf.data(), want, &got) || got < 16) break;
                for (std::size_t i = 0; i + 16 <= got; i += 4)
                    for (int part = 0; part < 3; ++part)
                        if (!out[part] && std::memcmp(buf.data() + i, kMinimapDefaults[part], 16) == 0) {
                            out[part] = reinterpret_cast<float*>(base + off + i);
                            ++found;
                        }
                if (want < buf.size()) break;
            }
        }
        addr = base + mbi.RegionSize;
    }
    *state = out[0] ? 2 : 3;
}

}  // namespace

// ------------------------------------------------------------------ settings

// Every persisted setting, by name: one table for loading and saving.
namespace {
struct SettingRef {
    const char* name;
    float* f = nullptr;
    bool* b = nullptr;
    int* i = nullptr;
};
}  // namespace

static std::vector<SettingRef> settingRefs(GameClient::Settings& s);

void GameClient::loadSettings() {
    auto refs = settingRefs(settings_);
    std::ifstream f(settingsPath());
    std::string line;
    while (std::getline(f, line)) {
        auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        const std::string k = line.substr(0, eq);
        const float v = std::strtof(line.c_str() + eq + 1, nullptr);
        if (k == "lang") lang_ = v != 0 ? Lang::Ru : Lang::En;
        for (auto& r : refs)
            if (k == r.name) {
                if (r.f) *r.f = v;
                if (r.b) *r.b = v != 0;
                if (r.i) *r.i = static_cast<int>(v);
            }
    }
}

void GameClient::saveSettings() {
    std::ofstream f(settingsPath(), std::ios::trunc);
    for (auto& r : settingRefs(settings_)) {
        f << r.name << '=';
        if (r.f) f << *r.f;
        if (r.b) f << (*r.b ? 1 : 0);
        if (r.i) f << *r.i;
        f << '\n';
    }
    f << "lang=" << (lang_.load() == Lang::Ru ? 1 : 0) << '\n';
}

static std::vector<SettingRef> settingRefs(GameClient::Settings& s) {
    auto F = [](const char* n, float& v) { return SettingRef{n, &v, nullptr, nullptr}; };
    auto B = [](const char* n, bool& v) { return SettingRef{n, nullptr, &v, nullptr}; };
    auto I = [](const char* n, int& v) { return SettingRef{n, nullptr, nullptr, &v}; };
    return {
        F("mapDX", s.mapDX),         F("mapDY", s.mapDY),          B("infoAttached", s.infoAttached),
        F("infoX", s.infoX),         F("infoY", s.infoY),          F("topX", s.topX),
        F("topY", s.topY),           F("hotbarX", s.hotbarX),      F("hotbarY", s.hotbarY),
        B("hotbarVertical", s.hotbarVertical), F("ammoX", s.ammoX), F("ammoY", s.ammoY),
        F("speedoX", s.speedoX),     F("speedoY", s.speedoY),      B("nametags", s.nametags),
        B("hud", s.hud),             B("perf", s.perf),            B("crossOn", s.crossOn),
        B("crossOutline", s.crossOutline), B("crossDot", s.crossDot), B("crossDynamic", s.crossDynamic),
        I("crossStyle", s.crossStyle), I("crossColor", s.crossColor), I("crossAlpha", s.crossAlpha),
        I("crossLen", s.crossLen),   I("crossThick", s.crossThick), I("crossGap", s.crossGap),
    };
}

// ------------------------------------------------------------------ layout

// Where the game draws the minimap (with its health/armour bars), in screen
// fractions: the widely used GetMinimapAnchor formula plus our offset.
GameClient::Rect GameClient::minimapRect() const {
    const float aspect = GRAPHICS::GET_ASPECT_RATIO(false);
    const float margin = 0.5f * (1.0f - GRAPHICS::GET_SAFE_ZONE_SIZE());
    Rect r;
    r.w = 1.0f / (4.0f * aspect);
    r.h = 1.0f / 5.674f;
    r.x = margin + settings_.mapDX;
    r.y = 1.0f - margin - r.h + settings_.mapDY;
    return r;
}

GameClient::Rect GameClient::infoRect() const {
    Rect r;
    r.w = 0.22f;
    r.h = 0.088f;
    if (settings_.infoAttached) {
        Rect m = minimapRect();
        r.x = m.x + m.w + 0.008f;
        r.y = m.y + m.h - r.h;  // bottom-aligned with the minimap
    } else {
        r.x = settings_.infoX;
        r.y = settings_.infoY;
    }
    return r;
}

GameClient::Rect GameClient::topRect() const {
    Rect r;
    r.w = 0.2f;
    r.h = 0.11f;
    r.x = settings_.topX - r.w;
    r.y = settings_.topY;
    return r;
}

GameClient::Rect GameClient::hotbarRect() const {
    const float aspect = GRAPHICS::GET_ASPECT_RATIO(false);
    const float cw = 0.03f, ch = cw * aspect, gap = 0.004f;
    Rect r;
    if (settings_.hotbarVertical) {
        r.w = cw;
        r.h = 9 * ch + 8 * gap * aspect;
    } else {
        r.w = 9 * cw + 8 * gap;
        r.h = ch;
    }
    r.x = settings_.hotbarX - r.w / 2;  // anchored at the bottom centre
    r.y = settings_.hotbarY - r.h;
    return r;
}

GameClient::Rect GameClient::ammoRect() const {
    Rect r;
    r.w = 0.16f;
    r.h = 0.064f;
    r.x = settings_.ammoX - r.w;  // top-right anchor
    r.y = settings_.ammoY;
    return r;
}

GameClient::Rect GameClient::speedoRect() const {
    Rect r;
    r.w = 0.15f;
    r.h = 0.152f;
    r.x = settings_.speedoX - r.w;  // bottom-right anchor
    r.y = settings_.speedoY - r.h;
    return r;
}

void GameClient::startMinimapSearch() {
    int idle = 0;
    if (!minimapSearch_.compare_exchange_strong(idle, 1)) return;
    std::thread(scanMinimap, minimapParts_, &minimapSearch_).detach();
}

// Moves the minimap parts by the configured offset; the game picks the new
// layout up when the big map state is toggled.
void GameClient::applyMinimapPosition() {
    if (minimapSearch_ != 2) return;
    const float toFrontend = GRAPHICS::GET_ASPECT_RATIO(false) / (16.0f / 9.0f);
    for (int part = 0; part < 3; ++part) {
        if (!minimapParts_[part]) continue;
        float xy[2] = {kMinimapDefaults[part][0] + settings_.mapDX * toFrontend, kMinimapDefaults[part][1] + settings_.mapDY};
        WriteProcessMemory(GetCurrentProcess(), minimapParts_[part], xy, sizeof(xy), nullptr);
    }
    bigmapRefresh_ = 2;
}

void GameClient::tickMinimap() {
    if (minimapSearch_ == 0) startMinimapSearch();
    static bool applied = false;
    if (!applied && minimapSearch_ == 2) {
        applied = true;
        log("minimap layout data found; the minimap can be moved");
        if (settings_.mapDX != 0 || settings_.mapDY != 0) applyMinimapPosition();
    } else if (!applied && minimapSearch_ == 3) {
        applied = true;
        log("minimap layout data not found; the minimap stays in place");
    }
    if (bigmapRefresh_ == 2) {
        HUD::SET_BIGMAP_ACTIVE(true, false);
        bigmapRefresh_ = 1;
    } else if (bigmapRefresh_ == 1) {
        HUD::SET_BIGMAP_ACTIVE(false, false);
        bigmapRefresh_ = 0;
    }
}

// ------------------------------------------------------------------ crosshair

// Draws the configured crosshair centred at (cx, cy); outside the preview it
// shows only while aiming or shooting and for two seconds afterwards.
void GameClient::drawCrosshair(bool preview, float cx, float cy) {
    const Settings& s = settings_;
    Ped me = PLAYER::PLAYER_PED_ID();
    float spread = 0;
    if (!preview) {
        if (!s.crossOn) return;
        const Hash weapon = WEAPON::GET_SELECTED_PED_WEAPON(me);
        const bool scoped = CAMERA::IS_FIRST_PERSON_AIM_CAM_ACTIVE() && WEAPON::GET_WEAPONTYPE_GROUP(weapon) == kGroupSniper;
        if (scoped) return;  // the scope has its own reticle
        HUD::HIDE_HUD_COMPONENT_THIS_FRAME(14);  // the game's reticle
        if (weapon == kUnarmed) return;
        const DWORD now = GetTickCount();
        const bool shooting = PED::IS_PED_SHOOTING(me);
        if (shooting) lastShotSeenAt_ = now;
        if (PLAYER::IS_PLAYER_FREE_AIMING(PLAYER::PLAYER_ID()) || shooting) crossActiveAt_ = now;
        if (!crossActiveAt_ || now - crossActiveAt_ > kCrossHoldMs) return;
        if (s.crossDynamic) {
            if (now - lastShotSeenAt_ < 180) spread += 6;
            if (ENTITY::GET_ENTITY_SPEED(me) > 1.5f) spread += 3;
        }
    }
    int sw, sh;
    screenSize(sw, sh);
    const float k = sh / 1080.0f;  // sizes are given for 1080p
    const float px = k / sw, py = k / sh;
    const float len = static_cast<float>(s.crossLen), th = static_cast<float>(s.crossThick), gap = s.crossGap + spread;
    Rgba c = kCrossColors[std::clamp(s.crossColor, 0, static_cast<int>(std::size(kCrossColors)) - 1)].color;
    c.a = std::clamp(s.crossAlpha, 10, 100) * 255 / 100;
    const Rgba outline{0, 0, 0, c.a * 3 / 4};

    // Each piece is a rectangle in pixels relative to the centre: x, y, w, h.
    std::vector<std::array<float, 4>> pieces;
    const int style = std::clamp(s.crossStyle, 0, 3);
    if (style == 0 || style == 1) {
        pieces.push_back({-gap - len, -th / 2, len, th});  // left
        pieces.push_back({gap, -th / 2, len, th});          // right
        pieces.push_back({-th / 2, gap, th, len});          // bottom
        if (style == 0) pieces.push_back({-th / 2, -gap - len, th, len});  // top
    } else if (style == 3) {
        const float r = gap + len / 2;
        for (int i = 0; i < 24; ++i) {
            const float a = i * 6.2831853f / 24;
            pieces.push_back({std::cos(a) * r - th / 2, std::sin(a) * r - th / 2, th, th});
        }
    }
    if (style == 2 || s.crossDot) pieces.push_back({-th / 2 - (style == 2 ? 1 : 0), -th / 2 - (style == 2 ? 1 : 0),
                                                    th + (style == 2 ? 2 : 0), th + (style == 2 ? 2 : 0)});
    if (s.crossOutline)
        for (const auto& p : pieces) rect(cx + (p[0] - 1) * px, cy + (p[1] - 1) * py, (p[2] + 2) * px, (p[3] + 2) * py, outline);
    for (const auto& p : pieces) rect(cx + p[0] * px, cy + p[1] * py, p[2] * px, p[3] * py, c);
}

// ------------------------------------------------------------------ ammo

void GameClient::drawAmmo() {
    Ped me = PLAYER::PLAYER_PED_ID();
    const Hash weapon = WEAPON::GET_SELECTED_PED_WEAPON(me);
    if (weapon == kUnarmed && screen_ != Screen::Layout) return;
    const Rect r = ammoRect();
    panel(r.x, r.y, r.w, r.h, theme::Hud, theme::Border, 8);

    // Name and icon of the weapon in hand (from the hotbar slot it was taken from).
    std::string name = "Оружие", icon;
    if (heldSlot_ >= 0 && heldSlot_ < 9 && !hotbar_[heldSlot_].empty()) {
        if (auto d = itemDefs_.find(hotbar_[heldSlot_].key); d != itemDefs_.end()) {
            name = d->second.name;
            icon = d->second.icon;
        }
    }
    const float aspect = GRAPHICS::GET_ASPECT_RATIO(false);
    const float iw = 0.036f, ih = iw * aspect;
    if (!icon.empty()) drawIcon(icon, r.x + 0.008f, r.y + (r.h - ih) / 2, iw, ih, theme::Text);
    const float tx = r.x + iw + 0.016f;
    label(name, tx, r.y + 0.006f, 0.28f, theme::Muted);

    int clip = 0;
    const bool hasClip = weapon != kUnarmed && WEAPON::GET_MAX_AMMO_IN_CLIP(me, weapon, true) > 0 &&
                         WEAPON::GET_AMMO_IN_CLIP(me, weapon, &clip);
    if (hasClip || screen_ == Screen::Layout) {
        const int total = weapon != kUnarmed ? WEAPON::GET_AMMO_IN_PED_WEAPON(me, weapon) : 0;
        const std::string inClip = std::to_string(clip);
        label(inClip, tx, r.y + 0.022f, 0.62f, clip > 0 ? theme::Text : theme::Negative);
        label("/ " + std::to_string(std::max(0, total - clip)), tx + textWidth(inClip, 0.62f) + 0.005f, r.y + 0.034f,
              0.4f, theme::Accent);
    } else {
        label("Холодное оружие", tx, r.y + 0.028f, 0.36f, theme::Text);
    }
}

// ------------------------------------------------------------------ speedometer

void GameClient::drawSpeedometer() {
    Ped me = PLAYER::PLAYER_PED_ID();
    const bool inVehicle = PED::IS_PED_IN_ANY_VEHICLE(me, false) || screen_ == Screen::Layout;
    const float frame = MISC::GET_FRAME_TIME();
    speedoAlpha_ = std::clamp(speedoAlpha_ + (inVehicle ? 765.0f : -765.0f) * frame, 0.0f, 255.0f);
    if (speedoAlpha_ <= 0) return;
    const int a = static_cast<int>(speedoAlpha_);
    const Vehicle veh = PED::GET_VEHICLE_PED_IS_USING(me);
    const float mps = veh ? ENTITY::GET_ENTITY_SPEED(veh) : 0.0f;
    const int kph = static_cast<int>(mps * 3.6f);

    const Rect r = speedoRect();
    panel(r.x, r.y, r.w, r.h, withAlpha(theme::Hud, a * 200 / 255), withAlpha(theme::Border, a), 10);
    // Vehicle name.
    std::string model = "-";
    if (veh) {
        const char* label0 = VEHICLE::GET_DISPLAY_NAME_FROM_VEHICLE_MODEL(ENTITY::GET_ENTITY_MODEL(veh));
        const char* text = label0 ? HUD::GET_FILENAME_FOR_AUDIO_CONVERSATION(label0) : nullptr;
        model = text && *text && std::strcmp(text, "NULL") != 0 ? text : (label0 ? label0 : "-");
    }
    label(model, r.x + 0.01f, r.y + 0.006f, 0.27f, withAlpha(theme::Muted, a));
    // Speed.
    const std::string speed = std::to_string(kph);
    label(speed, r.x + r.w - 0.042f, r.y + 0.018f, 0.9f, withAlpha(theme::Text, a), Align::Right);
    label("км/ч", r.x + r.w - 0.036f, r.y + 0.052f, 0.3f, withAlpha(theme::Accent, a));
    // Speed bar relative to the estimated top speed.
    const float top = veh ? std::max(1.0f, VEHICLE::GET_VEHICLE_ESTIMATED_MAX_SPEED(veh)) : 1.0f;
    const float bx = r.x + 0.01f, bw = r.w - 0.02f, by = r.y + 0.078f;
    rect(bx, by, bw, 0.005f, withAlpha(theme::SurfaceHi, a));
    rect(bx, by, bw * std::clamp(mps / top, 0.0f, 1.0f), 0.005f, withAlpha(theme::Accent, a));
    // Fuel (the server's shared "fuel" of the vehicle).
    float fuel = 0, tank = 0;
    if (RemoteVehicle* rv = myRemoteVehicle(); rv && veh && rv->handle == veh) fuel = vehicleFuel(*rv, &tank);
    else if (screen_ == Screen::Layout) fuel = 45, tank = 60;
    if (tank > 0) {
        char text[48];
        std::snprintf(text, sizeof(text), "%.1f / %.0f л", fuel, tank);
        const bool low = fuel < tank * 0.15f;
        label("Топливо", r.x + 0.01f, r.y + 0.088f, 0.26f, withAlpha(theme::Muted, a));
        label(text, r.x + r.w - 0.01f, r.y + 0.088f, 0.26f, withAlpha(low ? theme::Negative : theme::Text, a), Align::Right);
        rect(bx, r.y + 0.11f, bw, 0.005f, withAlpha(theme::SurfaceHi, a));
        rect(bx, r.y + 0.11f, bw * std::clamp(fuel / tank, 0.0f, 1.0f), 0.005f, withAlpha(low ? theme::Negative : theme::Positive, a));
    }
    // Indicators: engine, lights, lock, seat belt, engine condition.
    BOOL lights = FALSE, high = FALSE;
    bool engine = false, locked = false;
    int condition = 100;
    if (veh) {
        VEHICLE::GET_VEHICLE_LIGHTS_STATE(veh, &lights, &high);
        engine = VEHICLE::GET_IS_VEHICLE_ENGINE_RUNNING(veh);
        locked = VEHICLE::GET_VEHICLE_DOOR_LOCK_STATUS(veh) >= 2;
        condition = std::clamp(static_cast<int>(VEHICLE::GET_VEHICLE_ENGINE_HEALTH(veh) / 10), 0, 100);
    }
    const float iy = r.y + 0.122f;
    float ix = r.x + 0.01f;
    auto indicator = [&](const char* text, bool on, Rgba onColor) {
        ix += pill(text, ix, iy, 0.022f, 0.24f, withAlpha(on ? theme::AccentSoft : theme::Surface, a),
                   withAlpha(on ? onColor : theme::Muted, a)) + 0.004f;
    };
    indicator("ДВИГ", engine, theme::Accent);
    indicator(high ? "ДАЛЬН" : "ФАРЫ", lights || high, theme::Accent);
    indicator(locked ? "ЗАКР" : "ОТКР", locked, theme::Negative);
    // An unbelted driver at speed sees the belt indicator blink.
    const bool blink = !belted_ && kph > 20 && (GetTickCount() / 400) % 2;
    ix += pill("РЕМЕНЬ", ix, iy, 0.022f, 0.24f, withAlpha(belted_ ? theme::AccentSoft : blink ? theme::Negative : theme::Surface, a),
               withAlpha(belted_ ? theme::Positive : blink ? theme::OnAccent : theme::Muted, a)) + 0.004f;
    // Engine condition next to the model name.
    label(std::to_string(condition) + "%", r.x + r.w - 0.01f, r.y + 0.006f, 0.27f,
          withAlpha(condition > 50 ? theme::Positive : theme::Negative, a), Align::Right);
}

// ------------------------------------------------------------------ HUD

void GameClient::drawHud() {
    tickMinimap();
    // The round sprite of the menus streams in early; log which one the game has.
    static bool spriteLogged = false;
    if (!spriteLogged) {
        if (const Sprite* s = circleSprite()) {
            log(std::string("circle sprite: ") + s->dict + "/" + s->name);
            spriteLogged = true;
        }
    }
    if (menuRequested_.exchange(false) && screen_ == Screen::None && spawned_) openScreen(Screen::Menu);
    textureUses_.clear();  // icon instances are counted per frame
    if (spawned_ && !lobbyScreen()) tickWeaponControls();
    if (lobbyScreen() || !spawned_ || HUD::IS_PAUSE_MENU_ACTIVE()) return;
    tickVehicles();
    tickPhone();
    const bool interact = interactRequested_.exchange(false);
    tickPlaces(interact, tickHouses(interact));
    if (screen_ == Screen::None) drawCrosshair(false, 0.5f, 0.5f);
    if (!settings_.hud) return;
    const Value* cash = props::shared(selfShared_, "cash");
    const Value* bank = props::shared(selfShared_, "bank");
    const Value* statik = props::shared(selfShared_, "static");

    if (screen_ == Screen::None || screen_ == Screen::Layout || screen_ == Screen::Phone) {
        drawHotbar();
        drawAmmo();
        drawSpeedometer();
    }

    // Right of the minimap (Majestic style): compass, street and district, then money and time.
    Rect r = infoRect();
    Vector3 p = ENTITY::GET_ENTITY_COORDS(PLAYER::PLAYER_PED_ID(), true);
    Hash street = 0, crossing = 0;
    PATH::GET_STREET_NAME_AT_COORD(p.x, p.y, p.z, &street, &crossing);
    const char* streetName = street ? HUD::GET_STREET_NAME_FROM_HASH_KEY(street) : "";
    const char* zone = ZONE::GET_NAME_OF_ZONE(p.x, p.y, p.z);
    const char* district = zone ? HUD::GET_FILENAME_FOR_AUDIO_CONVERSATION(zone) : "";
    static const char* const kDirections[] = {"С", "СЗ", "З", "ЮЗ", "Ю", "ЮВ", "В", "СВ"};
    float heading = CAMERA::GET_GAMEPLAY_CAM_ROT(2).z;  // 0 = north, counter-clockwise
    int dir = static_cast<int>(std::lround(std::fmod(heading + 360.0f, 360.0f) / 45.0f)) % 8;

    const float badge = 0.046f;
    roundRect(r.x, r.y, badge * 0.6f, badge, theme::Hud, 8);
    label(kDirections[dir], r.x + badge * 0.3f, r.y, 0.48f, theme::Accent, Align::Center, badge);
    const float tx = r.x + badge * 0.6f + 0.008f;
    label(streetName && *streetName ? streetName : "Los Santos", tx, r.y + 0.001f, 0.42f, theme::Text);
    label(district && *district ? district : "", tx, r.y + 0.025f, 0.32f, theme::Muted);

    const float py = r.y + badge + 0.008f, ph = 0.03f;
    float px = r.x;
    px += pill(money(cash ? cash->asInt() : 0), px, py, ph, 0.34f, theme::Hud, theme::Positive) + 0.005f;
    px += pill("Банк " + money(bank ? bank->asInt() : 0), px, py, ph, 0.34f, theme::Hud, theme::Accent) + 0.005f;
    char clock[8];
    std::snprintf(clock, sizeof(clock), "%02d:%02d", CLOCK::GET_CLOCK_HOURS(), CLOCK::GET_CLOCK_MINUTES());
    pill(clock, px, py, ph, 0.34f, theme::Hud, theme::Text);

    // Top right: logo, online and static, character name.
    Rect t = topRect();
    const float right = settings_.topX;
    label("GoMP", right, t.y - 0.006f, 0.72f, theme::Accent, Align::Right);
    const float rowY = t.y + 0.048f, rowH = 0.028f;
    float rx = right;
    rx -= pill("#" + (statik ? std::to_string(statik->asInt()) : std::string("-")), rx, rowY, rowH, 0.32f, theme::Accent,
               theme::OnAccent, Align::Right) + 0.005f;
    pill("Онлайн " + std::to_string(onlineCount_), rx, rowY, rowH, 0.32f, theme::Hud, theme::Text, Align::Right);
    std::string name;
    if (auto it = selfProps_.find(prop::Name); it != selfProps_.end() && it->second.kind == Value::Kind::String) name = it->second.s;
    if (name.empty()) name = cfg_.name;
    label(name, right, rowY + rowH + 0.004f, 0.36f, theme::Text, Align::Right);
}

// ------------------------------------------------------------------ layout editor

void GameClient::cancelLayout() {
    settings_ = layoutBackup_;
    applyMinimapPosition();
    dragging_ = -1;
}

void GameClient::drawLayout() {
    const bool mapMovable = minimapSearch_ == 2;
    // Every movable element: its rectangle and how a new top-left corner is stored.
    struct Element {
        const char* name;
        Rect rect;
        std::function<void(float, float, const Rect&)> place;
    };
    Settings& s = settings_;
    const Element elements[] = {
        {"Карта", minimapRect(), [&](float x, float y, const Rect& r) { s.mapDX += x - r.x; s.mapDY += y - r.y; }},
        {"Деньги и местоположение", infoRect(),
         [&](float x, float y, const Rect&) { s.infoAttached = false; s.infoX = x; s.infoY = y; }},
        {"Онлайн и ник", topRect(), [&](float x, float y, const Rect& r) { s.topX = x + r.w; s.topY = y; }},
        {"Быстрые слоты", hotbarRect(), [&](float x, float y, const Rect& r) { s.hotbarX = x + r.w / 2; s.hotbarY = y + r.h; }},
        {"Патроны", ammoRect(), [&](float x, float y, const Rect& r) { s.ammoX = x + r.w; s.ammoY = y; }},
        {"Спидометр", speedoRect(), [&](float x, float y, const Rect& r) { s.speedoX = x + r.w; s.speedoY = y + r.h; }},
    };
    const int n = static_cast<int>(std::size(elements));
    rect(0, 0, 1, 1, {0, 0, 0, 110});
    for (int i = 0; i < n; ++i) {
        const Rect& r = elements[i].rect;
        panel(r.x, r.y, r.w, r.h, withAlpha(theme::Accent, i == dragging_ ? 90 : 40), theme::Accent, 8);
        label(elements[i].name, r.x + r.w / 2, r.y, 0.32f, theme::Text, Align::Center, r.h);
    }

    // Help and buttons.
    const float pw = 0.34f, px = 0.5f - pw / 2, py = 0.36f;
    const float ph = 0.25f;
    panel(px, py, pw, ph);
    label("Расположение интерфейса", 0.5f, py + 0.016f, 0.48f, theme::Text, Align::Center);
    label("Перетащите элементы мышью", 0.5f, py + 0.058f, 0.33f, theme::Muted, Align::Center);
    if (!mapMovable)
        label(minimapSearch_ == 1 ? "Поиск данных карты..." : "Карту в этой версии игры двигать нельзя", 0.5f, py + 0.085f,
              0.3f, theme::Negative, Align::Center);
    if (uiButton(px + 0.01f, py + 0.12f, pw - 0.02f, 0.04f,
                 std::string("Быстрые слоты: ") + (s.hotbarVertical ? "вертикально" : "горизонтально"))) {
        s.hotbarVertical = !s.hotbarVertical;
    }
    const float bw = (pw - 0.04f) / 3, by = py + 0.185f;
    if (uiButton(px + 0.01f, by, bw, 0.045f, "Сохранить", true)) {
        saveSettings();
        closeScreens();
        return;
    }
    if (uiButton(px + 0.02f + bw, by, bw, 0.045f, "Сбросить")) {
        const Settings d;
        s.mapDX = d.mapDX;
        s.mapDY = d.mapDY;
        s.infoAttached = true;
        s.topX = d.topX;
        s.topY = d.topY;
        s.hotbarX = d.hotbarX;
        s.hotbarY = d.hotbarY;
        s.hotbarVertical = d.hotbarVertical;
        s.ammoX = d.ammoX;
        s.ammoY = d.ammoY;
        s.speedoX = d.speedoX;
        s.speedoY = d.speedoY;
        applyMinimapPosition();
    }
    if (uiButton(px + 0.03f + bw * 2, by, bw, 0.045f, "Отмена")) {
        cancelLayout();
        closeScreens();
        return;
    }

    // Dragging.
    const bool held = PAD::IS_DISABLED_CONTROL_PRESSED(2, 237);
    if (mouseClick_ && dragging_ < 0 && !Rect{px, py, pw, ph}.contains(mouseX_, mouseY_)) {
        for (int i = n - 1; i >= 0; --i)
            if (elements[i].rect.contains(mouseX_, mouseY_) && (i != 0 || mapMovable)) {
                dragging_ = i;
                dragDX_ = mouseX_ - elements[i].rect.x;
                dragDY_ = mouseY_ - elements[i].rect.y;
                break;
            }
    }
    if (dragging_ >= 0 && dragging_ < n && held) {
        const Rect& r = elements[dragging_].rect;
        float nx = std::clamp(mouseX_ - dragDX_, 0.0f, 1.0f - r.w), ny = std::clamp(mouseY_ - dragDY_, 0.0f, 1.0f - r.h);
        elements[dragging_].place(nx, ny, r);
    } else if (dragging_ >= 0) {
        if (dragging_ == 0) applyMinimapPosition();
        dragging_ = -1;
    }
}

// ------------------------------------------------------------------ F2 menu

void GameClient::drawMenu() {
    // Majestic-style window: a sidebar with sections and the content on the right.
    const float w = 0.56f, h = 0.66f, x = 0.5f - w / 2, y = 0.5f - h / 2, side = 0.14f;
    panel(x, y, w, h);
    roundRect(x + 0.004f, y + 0.006f, side, h - 0.012f, theme::Surface, 8);
    label("GoMP", x + 0.016f, y + 0.016f, 0.62f, theme::Accent);
    label("Меню игрока", x + 0.016f, y + 0.062f, 0.3f, theme::Muted);
    const char* tabs[] = {"Персонаж", "Анимации", "Прицел", "Настройки"};
    const int tabCount = static_cast<int>(std::size(tabs));
    for (int i = 0; i < tabCount; ++i) {
        const float ty = y + 0.105f + i * 0.048f, tw = side - 0.016f, tx = x + 0.012f;
        bool active = menuTab_ == i, hover = mouseX_ >= tx && mouseX_ <= tx + tw && mouseY_ >= ty && mouseY_ <= ty + 0.04f;
        if (active || hover) roundRect(tx, ty, tw, 0.04f, active ? theme::AccentSoft : theme::SurfaceHi, 6);
        if (active) rect(tx, ty + 0.008f, 0.003f, 0.024f, theme::Accent);
        label(tabs[i], tx + 0.012f, ty, 0.36f, active ? theme::Accent : theme::Text, Align::Left, 0.04f);
        if (hover && mouseClick_) menuTab_ = i;
    }
    menuTab_ = std::clamp(menuTab_, 0, tabCount - 1);
    label("F2 / Esc — закрыть", x + 0.016f, y + h - 0.04f, 0.27f, theme::Muted);

    const float cx = x + side + 0.022f, cw = w - side - 0.04f;
    float cy = y + 0.022f;
    label(tabs[menuTab_], cx, cy, 0.5f, theme::Text);
    cy += 0.055f;

    // Toggle rows: caption on the left, a switch on the right.
    auto toggle = [&](const std::string& caption, bool& v, float tw) {
        const float rh = 0.042f;
        bool hover = mouseX_ >= cx && mouseX_ <= cx + tw && mouseY_ >= cy && mouseY_ <= cy + rh;
        roundRect(cx, cy, tw, rh, hover ? theme::SurfaceHi : theme::Surface, 7);
        label(caption, cx + 0.012f, cy, 0.34f, theme::Text, Align::Left, rh);
        const float sw = 0.036f, sh = 0.022f, sx = cx + tw - sw - 0.012f, sy = cy + (rh - sh) / 2;
        int pxw, pyh;
        screenSize(pxw, pyh);
        roundRect(sx, sy, sw, sh, v ? theme::Accent : theme::Border, sh * pyh / 2);
        const float knob = sh - 0.006f, kx = v ? sx + sw - knob * pyh / pxw - 0.004f : sx + 0.004f;
        roundRect(kx, sy + 0.003f, knob * pyh / pxw, knob, theme::Text, knob * pyh / 2);
        bool changed = hover && mouseClick_;
        if (changed) {
            v = !v;
            saveSettings();
        }
        cy += rh + 0.007f;
        return changed;
    };

    if (menuTab_ == 0) {
        auto shared = [&](const char* k) -> std::string {
            const Value* v = props::shared(selfShared_, k);
            if (!v) return "-";
            return v->kind == Value::Kind::String ? v->s : std::to_string(v->asInt());
        };
        std::string name;
        if (auto it = selfProps_.find(prop::Name); it != selfProps_.end()) name = it->second.s;
        Ped me = PLAYER::PLAYER_PED_ID();
        const Value* cash = props::shared(selfShared_, "cash");
        const Value* bank = props::shared(selfShared_, "bank");
        const std::string kit = shared("kit");
        // Header card: name and static.
        roundRect(cx, cy, cw, 0.07f, theme::Surface, 8);
        label(name.empty() ? "-" : name, cx + 0.014f, cy + 0.01f, 0.5f, theme::Text);
        label(shared("gender") == "f" ? "Женский персонаж" : "Мужской персонаж", cx + 0.014f, cy + 0.042f, 0.3f, theme::Muted);
        pill("#" + shared("static"), cx + cw - 0.012f, cy + 0.02f, 0.03f, 0.34f, theme::Accent, theme::OnAccent, Align::Right);
        cy += 0.082f;
        const std::pair<std::string, std::string> rows[] = {
            {"Аккаунт", shared("account")},
            {"Наличные", money(cash ? cash->asInt() : 0)},
            {"Банковский счёт", money(bank ? bank->asInt() : 0)},
            {"Стартовый набор", kit == "driver" ? "Водитель" : kit == "guard" ? "Охрана" : kit == "civil" ? "Гражданский" : kit},
            {"Здоровье", std::to_string(std::max(0, ENTITY::GET_ENTITY_HEALTH(me) - 100))},
            {"Броня", std::to_string(PED::GET_PED_ARMOUR(me))},
            {"Игроков онлайн", std::to_string(onlineCount_)},
        };
        for (const auto& [caption, value] : rows) {
            label(caption, cx + 0.004f, cy, 0.34f, theme::Muted, Align::Left, 0.036f);
            label(value, cx + cw - 0.004f, cy, 0.34f, theme::Text, Align::Right, 0.036f);
            rect(cx, cy + 0.037f, cw, 0.001f, theme::Border);
            cy += 0.04f;
        }
    } else if (menuTab_ == 1) {
        const int n = static_cast<int>(std::size(kAnimations));
        const float bw = (cw - 0.008f) / 2, bh = 0.038f;
        for (int i = 0; i < n; ++i) {
            float bx = cx + (i % 2) * (bw + 0.008f), byy = cy + (i / 2) * (bh + 0.007f);
            if (uiButton(bx, byy, bw, bh, kAnimations[i])) send(ScriptEvent{"gomp:anim", {Value::integer(i)}});
        }
        cy += ((n + 1) / 2) * (bh + 0.007f) + 0.008f;
        if (uiButton(cx, cy, cw, 0.042f, "Остановить анимацию", true)) send(ScriptEvent{"gomp:anim", {Value::integer(-1)}});
    } else if (menuTab_ == 2) {
        // Crosshair: settings on the left, a live preview on the right.
        Settings& s = settings_;
        const float lw = cw * 0.6f;
        auto step = [&](const std::string& caption, const std::string& value, int& v, int lo, int hi, int stepBy = 1) {
            if (int d = uiStepper(cx, cy, lw, caption, value)) {
                v = std::clamp(v + d * stepBy, lo, hi);
                saveSettings();
            }
            cy += 0.039f;
        };
        toggle("Свой прицел", s.crossOn, lw);
        step("Стиль", kCrossStyles[std::clamp(s.crossStyle, 0, 3)], s.crossStyle, 0, 3);
        const int colors = static_cast<int>(std::size(kCrossColors));
        if (int d = uiStepper(cx, cy, lw, "Цвет", kCrossColors[std::clamp(s.crossColor, 0, colors - 1)].name)) {
            s.crossColor = (s.crossColor + d + colors) % colors;
            saveSettings();
        }
        cy += 0.039f;
        step("Длина линий", std::to_string(s.crossLen) + " px", s.crossLen, 1, 30);
        step("Толщина", std::to_string(s.crossThick) + " px", s.crossThick, 1, 8);
        step("Зазор", std::to_string(s.crossGap) + " px", s.crossGap, 0, 30);
        step("Прозрачность", std::to_string(s.crossAlpha) + "%", s.crossAlpha, 10, 100, 10);
        toggle("Обводка", s.crossOutline, lw);
        toggle("Точка в центре", s.crossDot, lw);
        toggle("Расширяется при стрельбе и беге", s.crossDynamic, lw);

        const float pvx = cx + lw + 0.012f, pvw = cw - lw - 0.012f, pvy = y + 0.077f, pvh = 0.26f;
        roundRect(pvx, pvy, pvw, pvh, {60, 70, 72, 255}, 8);
        label("Предпросмотр", pvx + pvw / 2, pvy + 0.008f, 0.28f, theme::Muted, Align::Center);
        drawCrosshair(true, pvx + pvw / 2, pvy + pvh / 2 + 0.01f);
        label("Виден при прицеливании (ПКМ) и стрельбе,", pvx + pvw / 2, pvy + pvh + 0.01f, 0.26f, theme::Muted, Align::Center);
        label("гаснет через 2 секунды", pvx + pvw / 2, pvy + pvh + 0.03f, 0.26f, theme::Muted, Align::Center);
    } else {
        toggle("Ники над игроками", settings_.nametags, cw);
        toggle("Свой HUD: деньги, район, онлайн, патроны, спидометр", settings_.hud, cw);
        toggle("Счётчик FPS", settings_.perf, cw);
        bool ru = lang_.load() == Lang::Ru;
        const bool wasRu = ru;
        toggle("Русская раскладка ввода (Alt+Shift)", ru, cw);
        if (ru != wasRu) {
            lang_ = ru ? Lang::Ru : Lang::En;
            saveSettings();
        }
        cy += 0.01f;
        if (uiButton(cx, cy, cw, 0.046f, "Изменить расположение интерфейса и карты", true)) {
            layoutBackup_ = settings_;
            dragging_ = -1;
            screen_ = Screen::Layout;
            return;
        }
    }
}

}  // namespace gompgame
