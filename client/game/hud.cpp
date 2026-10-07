// GoMP HUD next to the minimap, the F2 menu (character, animations, settings),
// the layout editor and the movable minimap. Settings live in
// %APPDATA%\GoMP\settings.ini so they survive the launcher's cleanup.
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
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

const Rgba kPanel{12, 14, 20, 230}, kPanelLight{30, 34, 46, 235}, kAccent{64, 156, 255, 255}, kText{235, 238, 245, 255},
    kMuted{150, 158, 175, 255}, kCash{114, 204, 114, 255}, kBank{110, 170, 255, 255}, kOutline{64, 156, 255, 120};

constexpr float kLine = 0.028f;

// Animations of the F2 menu; the same order as ANIMATIONS in server-files/packages/freeroam/roleplay.js.
const char* const kAnimations[] = {
    "Помахать",  "Руки вверх", "Скрестить руки", "Фейспалм",    "Сесть",          "Лечь",          "Танец",
    "Курить",    "Облокотиться", "Кофе",         "Фото на телефон", "Отжимания",  "Аплодировать", "Гитара",
};

const Value* findShared(const KV& kv, const char* key) {
    for (const auto& [k, v] : kv)
        if (k == key) return &v;
    return nullptr;
}

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

void GameClient::loadSettings() {
    std::ifstream f(settingsPath());
    std::string line;
    while (std::getline(f, line)) {
        auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string k = line.substr(0, eq);
        float v = std::strtof(line.c_str() + eq + 1, nullptr);
        if (k == "mapDX") settings_.mapDX = v;
        else if (k == "mapDY") settings_.mapDY = v;
        else if (k == "infoAttached") settings_.infoAttached = v != 0;
        else if (k == "infoX") settings_.infoX = v;
        else if (k == "infoY") settings_.infoY = v;
        else if (k == "topX") settings_.topX = v;
        else if (k == "topY") settings_.topY = v;
        else if (k == "nametags") settings_.nametags = v != 0;
        else if (k == "hud") settings_.hud = v != 0;
        else if (k == "perf") settings_.perf = v != 0;
        else if (k == "lang") lang_ = v != 0 ? Lang::Ru : Lang::En;
    }
}

void GameClient::saveSettings() {
    std::ofstream f(settingsPath(), std::ios::trunc);
    f << "mapDX=" << settings_.mapDX << "\nmapDY=" << settings_.mapDY << "\ninfoAttached=" << settings_.infoAttached
      << "\ninfoX=" << settings_.infoX << "\ninfoY=" << settings_.infoY << "\ntopX=" << settings_.topX
      << "\ntopY=" << settings_.topY << "\nnametags=" << settings_.nametags << "\nhud=" << settings_.hud
      << "\nperf=" << settings_.perf << "\nlang=" << (lang_.load() == Lang::Ru ? 1 : 0) << "\n";
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
    r.w = 0.16f;
    r.h = kLine * 4 + 0.008f;
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
    r.w = 0.17f;
    r.h = 0.06f;
    r.x = settings_.topX - r.w;
    r.y = settings_.topY;
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

// ------------------------------------------------------------------ HUD

void GameClient::drawHud() {
    tickMinimap();
    if (menuRequested_.exchange(false) && screen_ == Screen::None && spawned_) openScreen(Screen::Menu);
    if (lobbyScreen() || !spawned_ || !settings_.hud || HUD::IS_PAUSE_MENU_ACTIVE()) return;
    const Value* cash = findShared(selfShared_, "cash");
    const Value* bank = findShared(selfShared_, "bank");
    const Value* statik = findShared(selfShared_, "static");

    // Right of the minimap: cash, card, street, district.
    Rect r = infoRect();
    float y = r.y;
    drawTextAligned("Наличные  " + money(cash ? cash->asInt() : 0), r.x, y, 0.42f, 4, kCash, Align::Left);
    y += kLine;
    drawTextAligned("Карта  " + money(bank ? bank->asInt() : 0), r.x, y, 0.42f, 4, kBank, Align::Left);
    y += kLine;
    Vector3 p = ENTITY::GET_ENTITY_COORDS(PLAYER::PLAYER_PED_ID(), true);
    Hash street = 0, crossing = 0;
    PATH::GET_STREET_NAME_AT_COORD(p.x, p.y, p.z, &street, &crossing);
    const char* streetName = street ? HUD::GET_STREET_NAME_FROM_HASH_KEY(street) : "";
    const char* zone = ZONE::GET_NAME_OF_ZONE(p.x, p.y, p.z);
    const char* district = zone ? HUD::GET_FILENAME_FOR_AUDIO_CONVERSATION(zone) : "";
    drawTextAligned(streetName && *streetName ? streetName : "-", r.x, y, 0.42f, 4, kText, Align::Left);
    y += kLine;
    drawTextAligned(district && *district ? district : "", r.x, y, 0.38f, 4, kMuted, Align::Left);

    // Top right: online, name and static.
    Rect t = topRect();
    drawTextAligned("Онлайн: " + std::to_string(onlineCount_), settings_.topX, t.y, 0.4f, 4, kText, Align::Right);
    std::string name;
    if (auto it = selfProps_.find(prop::Name); it != selfProps_.end() && it->second.kind == Value::Kind::String) name = it->second.s;
    if (name.empty()) name = cfg_.name;
    if (statik) name += "  [" + std::to_string(statik->asInt()) + "]";
    drawTextAligned(name, settings_.topX, t.y + kLine, 0.4f, 4, kAccent, Align::Right);
}

// ------------------------------------------------------------------ layout editor

void GameClient::cancelLayout() {
    settings_ = layoutBackup_;
    applyMinimapPosition();
    dragging_ = -1;
}

void GameClient::drawLayout() {
    const bool mapMovable = minimapSearch_ == 2;
    Rect rects[3] = {minimapRect(), infoRect(), topRect()};
    const char* names[3] = {"Карта", "Деньги и местоположение", "Онлайн и ник"};
    rect(0, 0, 1, 1, {0, 0, 0, 90});
    for (int i = 0; i < 3; ++i) {
        const Rect& r = rects[i];
        rect(r.x, r.y, r.w, r.h, i == dragging_ ? Rgba{64, 156, 255, 90} : Rgba{64, 156, 255, 45});
        rect(r.x, r.y, r.w, 0.002f, kOutline);
        rect(r.x, r.y + r.h - 0.002f, r.w, 0.002f, kOutline);
        drawTextAligned(names[i], r.x + r.w / 2, r.y + r.h / 2 - 0.014f, 0.34f, 4, kText, Align::Center);
    }

    // Help and buttons.
    const float pw = 0.34f, px = 0.5f - pw / 2, py = 0.36f;
    rect(px, py, pw, 0.2f, kPanel);
    rect(px, py, pw, 0.004f, kAccent);
    drawTextAligned("Расположение интерфейса", 0.5f, py + 0.015f, 0.45f, 4, kText, Align::Center);
    drawTextAligned("Перетащите элементы мышью", 0.5f, py + 0.055f, 0.34f, 4, kMuted, Align::Center);
    if (!mapMovable)
        drawTextAligned(minimapSearch_ == 1 ? "Поиск данных карты..." : "Карту в этой версии игры двигать нельзя", 0.5f,
                        py + 0.082f, 0.3f, 4, kMuted, Align::Center);
    const float bw = (pw - 0.04f) / 3, by = py + 0.13f;
    if (uiButton(px + 0.01f, by, bw, 0.045f, "Сохранить", true)) {
        saveSettings();
        closeScreens();
        return;
    }
    if (uiButton(px + 0.02f + bw, by, bw, 0.045f, "Сбросить")) {
        Settings d;
        settings_.mapDX = d.mapDX;
        settings_.mapDY = d.mapDY;
        settings_.infoAttached = true;
        settings_.topX = d.topX;
        settings_.topY = d.topY;
        applyMinimapPosition();
    }
    if (uiButton(px + 0.03f + bw * 2, by, bw, 0.045f, "Отмена")) {
        cancelLayout();
        closeScreens();
        return;
    }

    // Dragging.
    const bool held = PAD::IS_DISABLED_CONTROL_PRESSED(2, 237);
    if (mouseClick_ && dragging_ < 0 && !Rect{px, py, pw, 0.2f}.contains(mouseX_, mouseY_)) {
        for (int i = 2; i >= 0; --i)
            if (rects[i].contains(mouseX_, mouseY_) && (i != 0 || mapMovable)) {
                dragging_ = i;
                dragDX_ = mouseX_ - rects[i].x;
                dragDY_ = mouseY_ - rects[i].y;
                break;
            }
    }
    if (dragging_ >= 0 && held) {
        const Rect& r = rects[dragging_];
        float nx = std::clamp(mouseX_ - dragDX_, 0.0f, 1.0f - r.w), ny = std::clamp(mouseY_ - dragDY_, 0.0f, 1.0f - r.h);
        if (dragging_ == 0) {
            settings_.mapDX += nx - r.x;
            settings_.mapDY += ny - r.y;
        } else if (dragging_ == 1) {
            settings_.infoAttached = false;
            settings_.infoX = nx;
            settings_.infoY = ny;
        } else {
            settings_.topX = nx + r.w;
            settings_.topY = ny;
        }
    } else if (dragging_ >= 0) {
        if (dragging_ == 0) applyMinimapPosition();
        dragging_ = -1;
    }
}

// ------------------------------------------------------------------ F2 menu

void GameClient::drawMenu() {
    const float w = 0.44f, h = 0.58f, x = 0.5f - w / 2, y = 0.5f - h / 2;
    rect(x, y, w, h, kPanel);
    rect(x, y, w, 0.004f, kAccent);
    drawTextAligned("Меню игрока", x + 0.015f, y + 0.014f, 0.5f, 4, kText, Align::Left);
    drawTextAligned("F2 / Esc — закрыть", x + w - 0.015f, y + 0.022f, 0.3f, 4, kMuted, Align::Right);
    const char* tabs[] = {"Персонаж", "Анимации", "Настройки"};
    const float tw = (w - 0.04f) / 3;
    for (int i = 0; i < 3; ++i)
        if (uiButton(x + 0.01f + i * (tw + 0.01f), y + 0.06f, tw, 0.04f, tabs[i], menuTab_ == i)) menuTab_ = i;
    const float cx = x + 0.02f, cw = w - 0.04f;
    float cy = y + 0.125f;

    if (menuTab_ == 0) {
        auto shared = [&](const char* k) -> std::string {
            const Value* v = findShared(selfShared_, k);
            if (!v) return "-";
            return v->kind == Value::Kind::String ? v->s : std::to_string(v->asInt());
        };
        std::string name;
        if (auto it = selfProps_.find(prop::Name); it != selfProps_.end()) name = it->second.s;
        Ped me = PLAYER::PLAYER_PED_ID();
        const Value* cash = findShared(selfShared_, "cash");
        const Value* bank = findShared(selfShared_, "bank");
        const std::string kit = shared("kit");
        const std::pair<std::string, std::string> rows[] = {
            {"Имя", name.empty() ? "-" : name},
            {"Статик", shared("static")},
            {"Пол", shared("gender") == "f" ? "Женский" : "Мужской"},
            {"Аккаунт", shared("account")},
            {"Наличные", money(cash ? cash->asInt() : 0)},
            {"На карте", money(bank ? bank->asInt() : 0)},
            {"Стартовый набор", kit == "driver" ? "Водитель" : kit == "guard" ? "Охрана" : kit == "civil" ? "Гражданский" : kit},
            {"Здоровье", std::to_string(std::max(0, ENTITY::GET_ENTITY_HEALTH(me) - 100))},
            {"Броня", std::to_string(PED::GET_PED_ARMOUR(me))},
            {"Игроков онлайн", std::to_string(onlineCount_)},
        };
        for (const auto& [label, value] : rows) {
            rect(cx, cy, cw, 0.034f, kPanelLight);
            drawTextAligned(label, cx + 0.01f, cy + 0.003f, 0.38f, 4, kMuted, Align::Left);
            drawTextAligned(value, cx + cw - 0.01f, cy + 0.003f, 0.38f, 4, kText, Align::Right);
            cy += 0.04f;
        }
    } else if (menuTab_ == 1) {
        const int n = static_cast<int>(std::size(kAnimations));
        const float bw = (cw - 0.01f) / 2, bh = 0.04f;
        for (int i = 0; i < n; ++i) {
            float bx = cx + (i % 2) * (bw + 0.01f), byy = cy + (i / 2) * (bh + 0.008f);
            if (uiButton(bx, byy, bw, bh, kAnimations[i])) send(ScriptEvent{"gomp:anim", {Value::integer(i)}});
        }
        cy += ((n + 1) / 2) * (bh + 0.008f) + 0.01f;
        if (uiButton(cx, cy, cw, 0.045f, "Остановить анимацию", true)) send(ScriptEvent{"gomp:anim", {Value::integer(-1)}});
    } else {
        auto toggle = [&](const std::string& label, bool& v) {
            if (uiButton(cx, cy, cw, 0.042f, label + ":  " + (v ? "Вкл" : "Выкл"))) {
                v = !v;
                saveSettings();
            }
            cy += 0.05f;
        };
        toggle("Ники над игроками", settings_.nametags);
        toggle("Свой HUD (деньги, район, онлайн)", settings_.hud);
        toggle("Счётчик FPS", settings_.perf);
        if (uiButton(cx, cy, cw, 0.042f, std::string("Язык ввода:  ") + (lang_.load() == Lang::Ru ? "Русский" : "English") +
                                             "   (Alt+Shift)")) {
            lang_ = lang_.load() == Lang::Ru ? Lang::En : Lang::Ru;
            saveSettings();
        }
        cy += 0.065f;
        if (uiButton(cx, cy, cw, 0.046f, "Изменить расположение интерфейса и карты", true)) {
            layoutBackup_ = settings_;
            dragging_ = -1;
            screen_ = Screen::Layout;
            return;
        }
    }
}

}  // namespace gompgame
