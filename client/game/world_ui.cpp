// Static world entities (objects, peds, blips, markers, checkpoints, labels),
// on-screen UI (status, chat, name tags) and keyboard input for the chat.
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>

#include "game_client.hpp"
#include "natives.hpp"
#include "props.hpp"
#include "ui.hpp"

namespace gompgame {

using namespace gomp;
using namespace ui;

namespace {

constexpr int kPedTypeMission = 26;
constexpr std::size_t kMaxChatInput = 128;
constexpr std::size_t kChatLinesShown = 12;
constexpr float kMarkerDrawDistance = 300.0f;
constexpr float kNameTagDistance = 25.0f;

float dist(Vec3 a, Vec3 b) {
    float dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return std::sqrt(dx * dx + dy * dy + dz * dz);
}

}  // namespace

// ------------------------------------------------------------------ world entities

void GameClient::spawnWorldEntity(WorldEntity& e) {
    const Props& p = e.props;
    switch (e.type) {
        case EntityType::Object: {
            // A dropped item whose model this game does not have lies as a paper bag.
            Hash model = e.model;
            if (props::shared(e.shared, "drop") && !STREAMING::IS_MODEL_IN_CDIMAGE(model)) model = joaat("prop_paper_bag_small");
            if (!ensureModel(model)) return;  // retried from drawWorld
            Object obj = OBJECT::CREATE_OBJECT_NO_OFFSET(model, e.pos.x, e.pos.y, e.pos.z, false, false, false, 0);
            STREAMING::SET_MODEL_AS_NO_LONGER_NEEDED(model);
            if (!obj) return;
            ENTITY::SET_ENTITY_AS_MISSION_ENTITY(obj, true, true);
            ENTITY::SET_ENTITY_ROTATION(obj, e.rot.x, e.rot.y, e.rot.z, 2, true);
            ENTITY::FREEZE_ENTITY_POSITION(obj, true);
            if (int a = props::integer(p, prop::Alpha, 255); a < 255) ENTITY::SET_ENTITY_ALPHA(obj, a, false);
            if (!props::flag(p, prop::Visible, true)) ENTITY::SET_ENTITY_VISIBLE(obj, false, false);
            e.handle = obj;
            return;
        }
        case EntityType::Ped: {
            if (!ensureModel(e.model)) return;
            float heading = static_cast<float>(props::num(p, prop::Heading, e.rot.z));
            Ped ped = PED::CREATE_PED(kPedTypeMission, e.model, e.pos.x, e.pos.y, e.pos.z, heading, false, true);
            STREAMING::SET_MODEL_AS_NO_LONGER_NEEDED(e.model);
            if (!ped) return;
            ENTITY::SET_ENTITY_AS_MISSION_ENTITY(ped, true, true);
            PED::SET_BLOCKING_OF_NON_TEMPORARY_EVENTS(ped, true);
            PED::SET_PED_FLEE_ATTRIBUTES(ped, 0, false);
            PED::SET_PED_CAN_RAGDOLL_FROM_PLAYER_IMPACT(ped, false);
            PED::SET_PED_CAN_EVASIVE_DIVE(ped, false);
            PED::SET_PED_DEFAULT_COMPONENT_VARIATION(ped);
            applyAppearance(ped, p);
            if (props::flag(p, prop::Invincible, false)) ENTITY::SET_ENTITY_INVINCIBLE(ped, true, false);
            // Static peds stay in place unless the script made them dynamic.
            if (props::flag(p, prop::Frozen, !props::flag(p, prop::Dynamic, false))) ENTITY::FREEZE_ENTITY_POSITION(ped, true);
            if (!props::flag(p, prop::Visible, true)) ENTITY::SET_ENTITY_VISIBLE(ped, false, false);
            e.handle = ped;
            return;
        }
        case EntityType::Blip: {
            if (!props::flag(p, prop::Visible, true)) return;
            Blip blip = HUD::ADD_BLIP_FOR_COORD(e.pos.x, e.pos.y, e.pos.z);
            HUD::SET_BLIP_SPRITE(blip, props::integer(p, prop::BlipSprite, 1));
            HUD::SET_BLIP_COLOUR(blip, props::integer(p, prop::BlipColor, 0));
            HUD::SET_BLIP_SCALE(blip, static_cast<float>(props::num(p, prop::BlipScale, 1.0)));
            HUD::SET_BLIP_AS_SHORT_RANGE(blip, props::flag(p, prop::BlipShortRange, false));
            if (props::find(p, prop::BlipRotation)) HUD::SET_BLIP_ROTATION(blip, props::integer(p, prop::BlipRotation, 0));
            if (auto name = props::str(p, prop::BlipName); !name.empty()) blipName(blip, name);
            e.handle = blip;
            return;
        }
        default:
            return;  // markers, checkpoints and labels are drawn every frame; colshapes are server-side
    }
}

void GameClient::despawnWorldEntity(WorldEntity& e) {
    if (!e.handle) return;
    if (e.type == EntityType::Blip) {
        if (HUD::DOES_BLIP_EXIST(e.handle)) HUD::REMOVE_BLIP(&e.handle);
    } else if (ENTITY::DOES_ENTITY_EXIST(e.handle)) {
        ENTITY::SET_ENTITY_AS_MISSION_ENTITY(e.handle, true, true);
        ENTITY::DELETE_ENTITY(&e.handle);
    }
    e.handle = 0;
    e.placed = false;
}

void GameClient::drawWorld() {
    Ped me = PLAYER::PLAYER_PED_ID();
    Vector3 mp = ENTITY::GET_ENTITY_COORDS(me, true);
    const Vec3 here{mp.x, mp.y, mp.z};
    for (auto& [key, e] : world_) {
        const Props& p = e.props;
        if ((e.type == EntityType::Object || e.type == EntityType::Ped) && !e.handle) {
            spawnWorldEntity(e);  // its model is streaming in
            continue;
        }
        // Dropped items lie on the ground (weapons flat) and do not get in the way.
        if (e.type == EntityType::Object && !e.placed && props::shared(e.shared, "drop")) {
            float gz = 0;
            if (MISC::GET_GROUND_Z_FOR_3D_COORD(e.pos.x, e.pos.y, e.pos.z + 1.0f, &gz, false, false)) {
                const bool flat = e.rot.x > 45;
                ENTITY::SET_ENTITY_COORDS_NO_OFFSET(e.handle, e.pos.x, e.pos.y, gz + (flat ? 0.03f : 0.0f), false, false, false);
                if (!flat) OBJECT::PLACE_OBJECT_ON_GROUND_PROPERLY(e.handle);
                ENTITY::SET_ENTITY_COLLISION(e.handle, false, false);
                e.placed = true;
            }
        }
        if (!props::flag(p, prop::Visible, true)) continue;
        switch (e.type) {
            case EntityType::Marker: {
                if (dist(here, e.pos) > kMarkerDrawDistance) break;
                auto c = props::color(p, prop::MarkerColor);
                auto s = static_cast<float>(props::num(p, prop::MarkerScale, 1.0));
                Vec3 dir = props::vec(p, prop::MarkerDirection);
                GRAPHICS::DRAW_MARKER(props::integer(p, prop::MarkerType, 1), e.pos.x, e.pos.y, e.pos.z, dir.x, dir.y, dir.z,
                                      e.rot.x, e.rot.y, e.rot.z, s, s, s, c.r, c.g, c.b, c.a, false, false, 2, false,
                                      nullptr, nullptr, false);
                break;
            }
            case EntityType::Checkpoint: {
                if (dist(here, e.pos) > kMarkerDrawDistance) break;
                auto c = props::color(p, prop::CheckpointColor);
                auto r = static_cast<float>(props::num(p, prop::CheckpointRadius, 1.0));
                GRAPHICS::DRAW_MARKER(1 /* cylinder */, e.pos.x, e.pos.y, e.pos.z - 1.0f, 0, 0, 0, 0, 0, 0, r * 2, r * 2,
                                      2.0f, c.r, c.g, c.b, c.a, false, false, 2, false, nullptr, nullptr, false);
                break;
            }
            case EntityType::TextLabel: {
                float range = static_cast<float>(props::num(p, prop::LabelDrawDistance, 20.0));
                float d = dist(here, e.pos);
                if (d > range) break;
                float scale = 0.35f * std::max(0.6f, 1.0f - d / range * 0.4f);
                drawText3d(stripColors(props::str(p, prop::LabelText)), e.pos, scale, props::integer(p, prop::LabelFont, 4),
                           props::color(p, prop::LabelColor));
                break;
            }
            default: break;
        }
    }
    drawNameTags();
}

void GameClient::drawNameTags() {
    if (!settings_.nametags) return;
    Vector3 mp = ENTITY::GET_ENTITY_COORDS(PLAYER::PLAYER_PED_ID(), true);
    const Vec3 here{mp.x, mp.y, mp.z};
    for (auto& [id, r] : players_) {
        if (!r.ped || r.name.empty()) continue;
        if (const Value* inv = props::shared(r.shared, "invisible"); inv && inv->kind == Value::Kind::Bool && inv->b) continue;  // an invisible admin
        Vector3 pp = ENTITY::GET_ENTITY_COORDS(r.ped, true);
        Vec3 pos{pp.x, pp.y, pp.z + 1.1f};
        if (dist(here, pos) > kNameTagDistance) continue;
        std::string statik = "-";
        for (const auto& [k, v] : r.shared)
            if (k == "static") statik = std::to_string(v.asInt());
        GRAPHICS::SET_DRAW_ORIGIN(pos.x, pos.y, pos.z, false);
        label(r.name, 0.0f, -0.012f, 0.34f, r.dead ? theme::Negative : theme::Text, Align::Center);
        label("#" + statik, 0.0f, 0.013f, 0.27f, theme::Accent, Align::Center);
        // health bar
        rect(-0.022f, 0.036f, 0.044f, 0.004f, withAlpha(theme::Bg, 200));
        rect(-0.022f, 0.036f, 0.044f * std::clamp(r.health, 0, 100) / 100.0f, 0.004f, theme::Positive);
        GRAPHICS::CLEAR_DRAW_ORIGIN();
    }
}

// ------------------------------------------------------------------ UI

void GameClient::drawUi() {
    if (!status_.empty()) {
        const std::string s = "GoMP  " + status_;
        pill(s, 0.5f + (textWidth(s, 0.38f) + 0.0104f) / 2, 0.45f, 0.04f, 0.38f, theme::Bg, theme::Text, Align::Right);
    }

    EnterCriticalSection(&chatLock_);
    const bool open = chatOpen_;
    const std::string input = chatInput_;
    LeaveCriticalSection(&chatLock_);

    if (screen_ != Screen::None) return;
    // The very top-left corner: 2 px from the left edge, 5 px from the top.
    int sw, sh;
    screenSize(sw, sh);
    const float x = 2.0f / sw, top = 5.0f / sh, line = 0.026f;
    std::size_t first = chatLines_.size() > kChatLinesShown ? chatLines_.size() - kChatLinesShown : 0;
    float y = top;
    for (std::size_t i = first; i < chatLines_.size(); ++i, y += line)
        drawText(stripColors(chatLines_[i]), x, y, 0.33f, 4, {}, false);
    if (open) {
        y = top + line * kChatLinesShown + 0.006f;
        panel(x, y, 0.36f, 0.036f, theme::Bg, theme::Accent, 6);
        pill(lang_.load() == Lang::Ru ? "RU" : "EN", x + 0.005f, y + 0.006f, 0.024f, 0.26f, theme::AccentSoft, theme::Accent);
        label(input + ((GetTickCount() / 500) % 2 ? "" : "|"), x + 0.033f, y, 0.34f, theme::Text, Align::Left, 0.036f);
        // The game must not react to the keys typed into the chat (pause menu included).
        PAD::DISABLE_ALL_CONTROL_ACTIONS(0);
        PAD::DISABLE_ALL_CONTROL_ACTIONS(2);
    }
}

void GameClient::notify(const std::string& text) {
    HUD::BEGIN_TEXT_COMMAND_THEFEED_POST("STRING");
    addText(stripColors(text));
    HUD::END_TEXT_COMMAND_THEFEED_POST_TICKER(false, true);
}

// ------------------------------------------------------------------ admin console

namespace {
constexpr std::size_t kConsoleShown = 15;
constexpr std::size_t kConsoleHistory = 50;

// "\" on the main block (and the extra key left of Z on ISO keyboards); the same key is "\" in the Russian layout.
bool isConsoleKey(DWORD key) { return key == VK_OEM_5 || key == VK_OEM_102; }

std::string lower(std::string s) {
    for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

std::string fixed(double v, int digits) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.*f", digits, v);
    return buf;
}
}  // namespace

// Replies of client commands are printed into the chat.
void GameClient::consolePrint(const std::string& text) {
    chatLines_.push_back(text);
    while (chatLines_.size() > 50) chatLines_.pop_front();
}

void GameClient::runConsole(const std::string& raw) {
    std::string line = raw;
    while (!line.empty() && (line.front() == ' ' || line.front() == '/')) line.erase(line.begin());
    while (!line.empty() && line.back() == ' ') line.pop_back();
    if (line.empty()) return;
    const std::string cmd = lower(line.substr(0, line.find(' ')));
    if (cmd == "help") {  // the server prints its commands too
        consolePrint("~b~Клиент:~s~ /perf (FPS), /status, /scripts, /clothes, /clear, /reconnect");
        if (net_->state() == Client::State::Connected) send(Chat{"/help"});
        return;
    }
    if (cmd == "clear") {
        chatLines_.clear();
        return;
    }
    if (cmd == "perf" || cmd == "fps") {
        settings_.perf = !settings_.perf;
        saveSettings();
        consolePrint(std::string("Оверлей производительности ") + (settings_.perf ? "включён" : "выключен"));
        return;
    }
    if (cmd == "pos") {
        Ped me = PLAYER::PLAYER_PED_ID();
        Vector3 p = ENTITY::GET_ENTITY_COORDS(me, true);
        consolePrint(fixed(p.x, 2) + " " + fixed(p.y, 2) + " " + fixed(p.z, 2) + " heading " +
                     fixed(ENTITY::GET_ENTITY_HEADING(me), 1));
        return;
    }
    if (cmd == "status") {
        consolePrint("id " + std::to_string(myId_) + ", игроков рядом " + std::to_string(players_.size()) + ", машин " +
                     std::to_string(vehicles_.size()) + ", FPS " + fixed(perf_.fps, 0) + ", time scale " +
                     fixed(perf_.timeScale, 2) + ", tick " + fixed(perf_.tickAvgMs, 2) + " ms");
        return;
    }
    if (cmd == "clothes") {
        dumpClothes();
        return;
    }
    if (cmd == "scripts") {
        auto list = runningScripts();
        std::string line;
        for (auto& [id, name] : list) line += name + " ";
        consolePrint("Скрипты игры (" + std::to_string(list.size()) + "): " + line);
        log("scripts: " + line);
        return;
    }
    if (cmd == "reconnect") {
        net_->disconnect("reconnect");
        lastConnectTry_ = {};
        consolePrint("Переподключение...");
        return;
    }
    if (net_->state() != Client::State::Connected) {
        consolePrint("~r~Нет подключения к серверу");
        return;
    }
    send(Chat{"/" + line});
}

void GameClient::drawConsole() {
    EnterCriticalSection(&chatLock_);
    const bool open = consoleOpen_;
    const std::string input = consoleInput_;
    LeaveCriticalSection(&chatLock_);
    if (settings_.perf) drawPerf();
    if (!open) return;
    const float height = 0.46f;
    panel(0.008f, 0.008f, 0.984f, height, theme::Bg, theme::Border, 10);
    label("GoMP", 0.02f, 0.016f, 0.5f, theme::Accent);
    label("консоль администратора  ·  help — команды  ·  Esc или \\ — закрыть", 0.065f, 0.026f, 0.3f, theme::Muted);
    const float line = 0.024f;
    std::size_t first = consoleLines_.size() > kConsoleShown ? consoleLines_.size() - kConsoleShown : 0;
    float y = 0.06f;
    for (std::size_t i = first; i < consoleLines_.size(); ++i, y += line) label(consoleLines_[i], 0.022f, y, 0.31f, theme::Text);
    panel(0.016f, height - 0.038f, 0.968f, 0.036f, theme::Surface, theme::Accent, 6);
    pill(lang_.load() == Lang::Ru ? "RU" : "EN", 0.022f, height - 0.032f, 0.024f, 0.26f, theme::AccentSoft, theme::Accent);
    label("> " + input + ((GetTickCount() / 500) % 2 ? "" : "|"), 0.05f, height - 0.038f, 0.34f, theme::Text, Align::Left, 0.036f);
    PAD::DISABLE_ALL_CONTROL_ACTIONS(0);
    PAD::DISABLE_ALL_CONTROL_ACTIONS(2);
}

// ------------------------------------------------------------------ diagnostics

void GameClient::samplePerf(Clock::time_point frameStart) {
    const auto now = Clock::now();
    const double tickMs = std::chrono::duration<double, std::milli>(now - frameStart).count();
    if (perf_.lastFrame != Clock::time_point{}) {
        perf_.realSum += std::chrono::duration<double>(frameStart - perf_.lastFrame).count();
        perf_.gameSum += MISC::GET_FRAME_TIME();
        perf_.tickSum += tickMs;
        perf_.tickMax = std::max(perf_.tickMax, tickMs);
        ++perf_.frames;
    } else {
        perf_.windowStart = frameStart;
    }
    perf_.lastFrame = frameStart;
    if (now - perf_.windowStart < std::chrono::seconds(5) || perf_.frames == 0 || perf_.realSum <= 0) return;
    perf_.fps = perf_.frames / perf_.realSum;
    perf_.timeScale = perf_.gameSum / perf_.realSum;
    perf_.tickAvgMs = perf_.tickSum / perf_.frames;
    perf_.tickMaxMs = perf_.tickMax;
    Player player = PLAYER::PLAYER_ID();
    Ped me = PLAYER::PLAYER_PED_ID();
    log("perf fps=" + fixed(perf_.fps, 1) + " timescale=" + fixed(perf_.timeScale, 3) + " tick_avg_ms=" +
        fixed(perf_.tickAvgMs, 3) + " tick_max_ms=" + fixed(perf_.tickMaxMs, 3) + " speed=" +
        fixed(ENTITY::GET_ENTITY_SPEED(me), 2) + " ability=" + std::to_string(PLAYER::IS_SPECIAL_ABILITY_ACTIVE(player, 0)) +
        " switch=" + std::to_string(STREAMING::IS_PLAYER_SWITCH_IN_PROGRESS()) + " health=" +
        std::to_string(ENTITY::GET_ENTITY_HEALTH(me)) + "/" + std::to_string(PED::GET_PED_MAX_HEALTH(me)) +
        " remotes=" + std::to_string(players_.size()) + " vehicles=" + std::to_string(vehicles_.size()) +
        " world=" + std::to_string(world_.size()));
    // Average cost of each part of the tick, to find what a slow frame spends its time on.
    static constexpr const char* kPartNames[Perf::Parts] = {"population", "net", "remotes", "world", "hud", "ui"};
    std::string parts = "perf parts_ms";
    for (int i = 0; i < Perf::Parts; ++i) {
        parts += std::string(" ") + kPartNames[i] + "=" + fixed(perf_.parts[i] / perf_.frames, 3);
        perf_.parts[i] = 0;
    }
    log(parts);
    perf_.realSum = perf_.gameSum = perf_.tickSum = perf_.tickMax = 0;
    perf_.frames = 0;
    perf_.windowStart = now;
}

void GameClient::drawPerf() {
    std::string s = "FPS " + fixed(perf_.fps, 0) + "  time scale " + fixed(perf_.timeScale, 2) + "  tick " +
                    fixed(perf_.tickAvgMs, 2) + "/" + fixed(perf_.tickMaxMs, 2) + " ms";
    label(s, settings_.topX, settings_.topY + 0.13f, 0.28f, theme::Muted, Align::Right);  // below the online/name block
}

// ------------------------------------------------------------------ keyboard

// Called on the keyboard thread: no natives here, only the input buffers under chatLock_.
void GameClient::onKey(DWORD key, bool down, bool alt, bool repeat) {
    if (!down) return;
    // Alt+Shift or Ctrl+Shift switches the GoMP input language (the game ignores the Windows switch).
    const bool shiftDown = GetAsyncKeyState(VK_SHIFT) & 0x8000, ctrlDown = GetAsyncKeyState(VK_CONTROL) & 0x8000;
    if ((key == VK_SHIFT && (alt || ctrlDown)) || ((key == VK_MENU || key == VK_CONTROL) && shiftDown)) {
        lang_ = lang_.load() == Lang::En ? Lang::Ru : Lang::En;
        return;
    }
    auto popChar = [](std::string& s) {
        while (!s.empty()) {
            unsigned char c = static_cast<unsigned char>(s.back());
            s.pop_back();
            if (isLeadByte(c)) break;
        }
    };
    EnterCriticalSection(&chatLock_);
    if (consoleOpen_) {
        switch (key) {
            case VK_ESCAPE:
                escHandledAt_ = GetTickCount();
                consoleOpen_ = false;
                break;
            case VK_RETURN:
                if (!consoleInput_.empty()) {
                    pendingConsole_.push_back(consoleInput_);
                    consoleHistory_.push_back(consoleInput_);
                    if (consoleHistory_.size() > kConsoleHistory) consoleHistory_.erase(consoleHistory_.begin());
                }
                historyPos_ = consoleHistory_.size();
                consoleInput_.clear();
                break;
            case VK_BACK: popChar(consoleInput_); break;
            case VK_UP:
                if (historyPos_ > 0) consoleInput_ = consoleHistory_[--historyPos_];
                break;
            case VK_DOWN:
                if (historyPos_ + 1 < consoleHistory_.size()) {
                    consoleInput_ = consoleHistory_[++historyPos_];
                } else {
                    historyPos_ = consoleHistory_.size();
                    consoleInput_.clear();
                }
                break;
            default:
                if (isConsoleKey(key)) {
                    consoleOpen_ = false;
                } else if (std::string s = keyText(key, lang_.load()); !s.empty() && consoleInput_.size() + s.size() <= kMaxChatInput) {
                    consoleInput_ += s;
                }
                break;
        }
    } else if (chatOpen_) {
        switch (key) {
            case VK_ESCAPE:
                escHandledAt_ = GetTickCount();
                chatOpen_ = false;
                chatInput_.clear();
                break;
            case VK_RETURN:
                if (!chatInput_.empty()) {
                    pendingChat_.push_back(chatInput_);
                    consoleHistory_.push_back(chatInput_);
                    if (consoleHistory_.size() > kConsoleHistory) consoleHistory_.erase(consoleHistory_.begin());
                }
                historyPos_ = consoleHistory_.size();
                chatInput_.clear();
                chatOpen_ = false;
                break;
            case VK_BACK: popChar(chatInput_); break;
            case VK_UP:
                if (historyPos_ > 0) chatInput_ = consoleHistory_[--historyPos_];
                break;
            case VK_DOWN:
                if (historyPos_ + 1 < consoleHistory_.size()) {
                    chatInput_ = consoleHistory_[++historyPos_];
                } else {
                    historyPos_ = consoleHistory_.size();
                    chatInput_.clear();
                }
                break;
            default:
                if (std::string s = keyText(key, lang_.load()); !s.empty() && chatInput_.size() + s.size() <= kMaxChatInput) chatInput_ += s;
                break;
        }
    } else if (screenActive_) {
        // A held key that opened a window must not close it again by auto-repeat.
        const bool toggle = key == 'G' || key == VK_TAB || key == VK_F2 || key == VK_ESCAPE || key == VK_UP;
        if (!(repeat && toggle)) uiKeys_.push_back({key, keyText(key, lang_.load()), keyText(key, Lang::En)});  // login / creator fields
    } else if (repeat) {
        // Held keys do not repeat game actions (inventory, hotkeys, G, L, J, E).
    } else if (key == VK_TAB && !alt) {
        inventoryRequested_ = true;
    } else if (key >= '1' && key <= '9' && !alt) {
        hotkeyRequested_ = static_cast<int>(key - '0');
    } else if (key >= VK_NUMPAD1 && key <= VK_NUMPAD9) {
        hotkeyRequested_ = static_cast<int>(key - VK_NUMPAD0);
    } else if (key == VK_F2) {
        menuRequested_ = true;
    } else if (!alt && key == 'G') {
        vehMenuRequested_ = true;
    } else if (!alt && key == 'L') {
        lockRequested_ = true;
    } else if (!alt && key == 'J') {
        beltRequested_ = true;
    } else if (!alt && key == 'E') {
        interactRequested_ = true;
    } else if (key == VK_UP) {
        phoneRequested_ = true;
    } else if (!alt && key == 'T') {
        chatOpen_ = true;
        chatInput_.clear();
    }
    LeaveCriticalSection(&chatLock_);
}

}  // namespace gompgame
