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
constexpr std::size_t kChatLinesShown = 10;
constexpr float kMarkerDrawDistance = 300.0f;
constexpr float kNameTagDistance = 25.0f;

float dist(Vec3 a, Vec3 b) {
    float dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return std::sqrt(dx * dx + dy * dy + dz * dz);
}

void setBlipName(Blip blip, const std::string& name) {
    HUD::BEGIN_TEXT_COMMAND_SET_BLIP_NAME("STRING");
    HUD::ADD_TEXT_COMPONENT_SUBSTRING_PLAYER_NAME(name.c_str());
    HUD::END_TEXT_COMMAND_SET_BLIP_NAME(blip);
}

}  // namespace

// ------------------------------------------------------------------ world entities

void GameClient::spawnWorldEntity(WorldEntity& e) {
    const Props& p = e.props;
    switch (e.type) {
        case EntityType::Object: {
            if (!ensureModel(e.model)) return;  // retried from drawWorld
            Object obj = OBJECT::CREATE_OBJECT_NO_OFFSET(e.model, e.pos.x, e.pos.y, e.pos.z, false, false, false, 0);
            STREAMING::SET_MODEL_AS_NO_LONGER_NEEDED(e.model);
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
            if (auto name = props::str(p, prop::BlipName); !name.empty()) setBlipName(blip, name);
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
        Vector3 pp = ENTITY::GET_ENTITY_COORDS(r.ped, true);
        Vec3 pos{pp.x, pp.y, pp.z + 1.1f};
        if (dist(here, pos) > kNameTagDistance) continue;
        props::Rgba c = r.dead ? props::Rgba{200, 60, 60, 255} : props::Rgba{};
        std::string tag = r.name;
        for (const auto& [k, v] : r.shared)
            if (k == "static") tag += " [" + std::to_string(v.asInt()) + "]";
        drawText3d(tag + " (" + std::to_string(r.health) + ")", pos, 0.3f, 4, c);
    }
}

// ------------------------------------------------------------------ UI

void GameClient::drawUi() {
    if (!status_.empty()) drawText("GoMP: " + status_, 0.5f, 0.45f, 0.45f, 4, {}, true);

    EnterCriticalSection(&chatLock_);
    const bool open = chatOpen_;
    const std::string input = chatInput_;
    LeaveCriticalSection(&chatLock_);

    if (screen_ != Screen::None) return;
    const float x = 0.015f, top = 0.28f, line = 0.026f;
    std::size_t first = chatLines_.size() > kChatLinesShown ? chatLines_.size() - kChatLinesShown : 0;
    float y = top;
    for (std::size_t i = first; i < chatLines_.size(); ++i, y += line)
        drawText(stripColors(chatLines_[i]), x, y, 0.33f, 4, {}, false);
    if (open) {
        y = top + line * kChatLinesShown + 0.01f;
        GRAPHICS::DRAW_RECT(0.2f, y + 0.014f, 0.38f, 0.03f, 0, 0, 0, 160, false);
        drawText(langTag() + " > " + input + "_", x, y, 0.33f, 4, {}, false);
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
constexpr std::size_t kConsoleLines = 300;
constexpr std::size_t kConsoleShown = 16;
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

void GameClient::consolePrint(const std::string& text) {
    consoleLines_.push_back(stripColors(text));
    while (consoleLines_.size() > kConsoleLines) consoleLines_.pop_front();
}

void GameClient::runConsole(const std::string& raw) {
    std::string line = raw;
    while (!line.empty() && (line.front() == ' ' || line.front() == '/')) line.erase(line.begin());
    while (!line.empty() && line.back() == ' ') line.pop_back();
    if (line.empty()) return;
    consolePrint("~c~> " + line);
    const std::string cmd = lower(line.substr(0, line.find(' ')));
    if (cmd == "help") {
        consolePrint("~y~Локальные:~s~ help, clear, perf (оверлей FPS), pos, status, scripts, reconnect");
        consolePrint("~y~Админ:~s~ alogin <пароль>, players, kick <id> [причина], ban <id> [причина], goto <id>,");
        consolePrint("  bring <id>, sethp <id> <hp>, setarmour <id> <n>, give <id> <оружие> [патроны], slay <id>,");
        consolePrint("  respawn <id>, setdim <id> <n>, delveh [all], announce <текст>, ahelp");
        consolePrint("~y~Для всех:~s~ veh, weapon, tp, dim, hp, kill, pos, time, weather");
        consolePrint("Любая другая строка уходит на сервер как команда /<строка>.");
        return;
    }
    if (cmd == "clear") {
        consoleLines_.clear();
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
    GRAPHICS::DRAW_RECT(0.5f, height / 2, 1.0f, height, 0, 0, 0, 200, false);
    GRAPHICS::DRAW_RECT(0.5f, height, 1.0f, 0.002f, 120, 180, 255, 255, false);
    drawText("GoMP console  -  help: список команд, Esc или \\ закрывает", 0.01f, 0.005f, 0.3f, 0, {120, 180, 255, 255}, false);
    const float line = 0.024f;
    std::size_t first = consoleLines_.size() > kConsoleShown ? consoleLines_.size() - kConsoleShown : 0;
    float y = 0.035f;
    for (std::size_t i = first; i < consoleLines_.size(); ++i, y += line) drawText(consoleLines_[i], 0.01f, y, 0.3f, 0, {}, false);
    drawText(langTag() + " ] " + input + "_", 0.01f, height - 0.032f, 0.32f, 0, {255, 255, 160, 255}, false);
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
        " remotes=" + std::to_string(players_.size()) + " world=" + std::to_string(world_.size()));
    perf_.realSum = perf_.gameSum = perf_.tickSum = perf_.tickMax = 0;
    perf_.frames = 0;
    perf_.windowStart = now;
}

void GameClient::drawPerf() {
    std::string s = "FPS " + fixed(perf_.fps, 0) + "  time scale " + fixed(perf_.timeScale, 2) + "  tick " +
                    fixed(perf_.tickAvgMs, 2) + "/" + fixed(perf_.tickMaxMs, 2) + " ms";
    drawTextAligned(s, 0.985f, 0.07f, 0.3f, 0, {160, 255, 160, 255}, Align::Right);
}

// ------------------------------------------------------------------ keyboard

// Called on the keyboard thread: no natives here, only the input buffers under chatLock_.
void GameClient::onKey(DWORD key, bool down, bool alt) {
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
                if (!chatInput_.empty()) pendingChat_.push_back(chatInput_);
                chatInput_.clear();
                chatOpen_ = false;
                break;
            case VK_BACK: popChar(chatInput_); break;
            default:
                if (std::string s = keyText(key, lang_.load()); !s.empty() && chatInput_.size() + s.size() <= kMaxChatInput) chatInput_ += s;
                break;
        }
    } else if (screenActive_ && !(isConsoleKey(key) && !alt)) {
        uiKeys_.push_back({key, keyText(key, lang_.load()), keyText(key, Lang::En)});  // login / creator fields
    } else if (!alt && isConsoleKey(key)) {
        consoleOpen_ = true;
        consoleInput_.clear();
        historyPos_ = consoleHistory_.size();
    } else if (key == VK_F2) {
        menuRequested_ = true;
    } else if (!alt && key == 'T') {
        chatOpen_ = true;
        chatInput_.clear();
    }
    LeaveCriticalSection(&chatLock_);
}

}  // namespace gompgame
