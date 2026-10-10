// Login, character selection, character creator and the HUD, drawn with game
// natives (no browser). The server drives the screens with script events
// (see server-files/packages/freeroam/roleplay.js).
#include <cmath>

#include "game_client.hpp"
#include "natives.hpp"
#include "props.hpp"
#include "ui.hpp"

namespace gompgame {

using namespace gomp;
using namespace ui;

namespace {

constexpr int kInputCursorX = 239, kInputCursorY = 240, kInputCursorAccept = 237;
constexpr std::size_t kMaxFieldLength = 20;

const char* const kKits[] = {"Гражданский", "Водитель", "Охрана"};
const char* const kKitInfo[] = {
    "$5 000 наличными и $10 000 на карте",
    "Свой автомобиль Blista, $1 500 и $5 000 на карте",
    "Пистолет, дубинка, бронежилет, $1 500 и $5 000 на карте",
};

int wrap(int v, int lo, int hi) {
    if (hi < lo) return lo;
    int n = hi - lo + 1;
    return lo + ((v - lo) % n + n) % n;
}

using props::field;

Value mapValue(std::vector<std::pair<std::string, Value>> kv) {
    Value v;
    v.kind = Value::Kind::Map;
    v.map = std::move(kv);
    return v;
}


// Shop metadata of a clothing item (EXTRAMETADATA natives), 8-byte slots.
struct ShopComponent {
    int lockHash, pad1, hash, pad2, locate, pad3, drawable, pad4, texture, pad5, f5, pad6, componentType, pad7, f7, pad8,
        f8, pad9;
    char gxt[64];
    char reserve[64];
};

// The drawable the game forces into `type` (3 arms, 8 undershirt) when this item is worn,
// exactly as GTA Online's clothes shop does; fallback when the item forces nothing.
int forcedDrawable(Ped ped, int component, int drawable, int texture, int type, int fallback) {
    Hash item = EXTRAMETADATA::GET_HASH_NAME_FOR_COMPONENT(ped, component, drawable, texture);
    if (!item) return fallback;
    int n = EXTRAMETADATA::GET_SHOP_PED_APPAREL_FORCED_COMPONENT_COUNT(item);
    for (int i = 0; i < n; ++i) {
        Hash name = 0;
        int value = 0, forcedType = 0;
        EXTRAMETADATA::GET_FORCED_COMPONENT(item, i, &name, &value, &forcedType);
        if (forcedType != type) continue;
        if (!name) return value;
        ShopComponent sc{};
        EXTRAMETADATA::GET_SHOP_PED_COMPONENT(name, reinterpret_cast<Any*>(&sc));
        return sc.drawable;
    }
    return fallback;
}

// The game's display name of a clothing item ("" when it has none).
std::string clothingName(Ped ped, int component, int drawable, int texture) {
    Hash item = EXTRAMETADATA::GET_HASH_NAME_FOR_COMPONENT(ped, component, drawable, texture);
    if (!item) return {};
    ShopComponent sc{};
    EXTRAMETADATA::GET_SHOP_PED_COMPONENT(item, reinterpret_cast<Any*>(&sc));
    sc.gxt[63] = 0;
    if (!sc.gxt[0]) return {};
    const char* text = HUD::GET_FILENAME_FOR_AUDIO_CONVERSATION(sc.gxt);
    return std::string(text && *text ? text : sc.gxt);
}

// Four plain starter outfits per model: top, top texture, legs, legs texture, shoes, shoes texture.
struct Outfit {
    const char* name;
    int top, topTex, legs, legsTex, shoes, shoesTex;
};
constexpr int kOutfits = 4;
const Outfit kMaleOutfits[kOutfits] = {
    {"Старая футболка", 0, 1, 0, 0, 1, 0},
    {"Майка и треники", 5, 0, 5, 0, 5, 0},
    {"Толстовка", 7, 0, 3, 0, 1, 1},
    {"Рубашка навыпуск", 1, 0, 1, 0, 3, 0},
};
const Outfit kFemaleOutfits[kOutfits] = {
    {"Старая футболка", 2, 0, 0, 0, 1, 0},
    {"Майка и треники", 5, 0, 2, 0, 5, 0},
    {"Толстовка", 3, 0, 3, 0, 1, 0},
    {"Рубашка навыпуск", 9, 0, 1, 0, 3, 0},
};

const Outfit& outfitOf(bool female, int i) { return (female ? kFemaleOutfits : kMaleOutfits)[wrap(i, 0, kOutfits - 1)]; }
std::string outfitName(bool female, int i) { return outfitOf(female, i).name; }
}  // namespace

// Arms (type 3) or undershirt (type 8) the game forces for a top; fallback when none.
int topForcedDrawable(Ped ped, int drawable, int texture, int type, int fallback) {
    return forcedDrawable(ped, 11, drawable, texture, type, fallback);
}

// ------------------------------------------------------------------ events

bool GameClient::handleUiEvent(const ScriptEvent& e) {
    const auto& a = e.args;
    if (e.name == "gomp:auth:show") {
        uiBusy_ = false;
        uiError_ = a.empty() ? "" : props::fieldStr(a[0], "error");
        if (!a.empty()) {
            if (auto l = props::fieldStr(a[0], "login"); !l.empty()) loginName_ = l;
            if (const Value* r = field(a[0], "register")) registerMode_ = r->asNumber() != 0;
        }
        loginPassword_.clear();
        openScreen(Screen::Login);
        focus_ = loginName_.empty() ? &loginName_ : &loginPassword_;
        return true;
    }
    if (e.name == "gomp:chars:show") {
        uiBusy_ = false;
        uiError_.clear();
        chars_.clear();
        if (!a.empty() && a[0].kind == Value::Kind::Array) {
            for (const auto& c : a[0].arr) {
                CharInfo ci;
                ci.id = static_cast<int>(props::fieldInt(c, "id"));
                ci.statik = static_cast<int>(props::fieldInt(c, "static"));
                ci.first = props::fieldStr(c, "first");
                ci.last = props::fieldStr(c, "last");
                ci.female = props::fieldStr(c, "gender") == "f";
                ci.cash = props::fieldInt(c, "cash");
                ci.bank = props::fieldInt(c, "bank");
                chars_.push_back(ci);
            }
        }
        if (a.size() > 1) maxChars_ = static_cast<int>(a[1].asInt());
        if (chars_.empty()) {
            creator_ = Creator{};
            openScreen(Screen::Creator);
        } else {
            openScreen(Screen::Characters);
        }
        return true;
    }
    if (e.name == "gomp:spawn:show") {
        // After choosing a character: where to appear. Options: {id, title, sub, pos}.
        uiBusy_ = false;
        uiError_.clear();
        spawnOptions_.clear();
        if (!a.empty() && a[0].kind == Value::Kind::Array) {
            for (const auto& o : a[0].arr) {
                SpawnOption so;
                so.id = props::fieldStr(o, "id");
                so.title = props::fieldStr(o, "title");
                so.sub = props::fieldStr(o, "sub");
                if (const Value* p = field(o, "pos"); p && p->kind == Value::Kind::Array && p->arr.size() >= 3) {
                    so.hasPos = true;
                    so.pos = {static_cast<float>(props::at(*p, 0)), static_cast<float>(props::at(*p, 1)), static_cast<float>(props::at(*p, 2))};
                }
                if (so.id == "last" && so.hasPos) {
                    // The street the character left on, when the game knows it.
                    Hash street = 0, crossing = 0;
                    PATH::GET_STREET_NAME_AT_COORD(so.pos.x, so.pos.y, so.pos.z, &street, &crossing);
                    const char* name = street ? HUD::GET_STREET_NAME_FROM_HASH_KEY(street) : nullptr;
                    if (name && *name) so.sub = name;
                }
                spawnOptions_.push_back(std::move(so));
            }
        }
        if (spawnOptions_.empty()) spawnOptions_.push_back({"last", "Там, где вышел", "", {}, false});
        openScreen(Screen::Spawn);
        return true;
    }
    if (e.name == "gomp:creator:error") {
        uiBusy_ = false;
        uiError_ = a.empty() ? "Ошибка" : a[0].s;
        return true;
    }
    if (e.name == "gomp:ui:close") {
        closeScreens();
        return true;
    }
    if (e.name == "gomp:inv:defs") {
        if (!a.empty()) onInventoryDefs(a[0]);
        return true;
    }
    if (e.name == "gomp:inv:sync") {
        if (!a.empty()) onInventorySync(a[0]);
        return true;
    }
    if (e.name == "gomp:inv:open") {  // a storage opened (orgs.js): the inventory window shows it
        if (screen_ != Screen::Inventory) {
            if (screen_ != Screen::None) closeScreens();
            invSelected_ = invPress_ = {};
            invDragging_ = false;
            openScreen(Screen::Inventory);
        }
        return true;
    }
    if (e.name == "gomp:hud:online") {
        if (!a.empty()) onlineCount_ = static_cast<int>(a[0].asInt());
        return true;
    }
    return false;
}

// ------------------------------------------------------------------ screen state

void GameClient::openScreen(Screen s) {
    Ped me = PLAYER::PLAYER_PED_ID();
    screen_ = s;
    screenActive_ = true;
    focus_ = nullptr;
    if (!lobbyScreen()) return;  // the F2 menu and the layout editor keep the game camera
    Vector3 p = ENTITY::GET_ENTITY_COORDS(me, true);
    if (!uiCam_) {
        uiCam_ = CAMERA::CREATE_CAM_WITH_PARAMS("DEFAULT_SCRIPTED_CAMERA", p.x, p.y, p.z, 0, 0, 0, 50.0f, true, 2);
        CAMERA::RENDER_SCRIPT_CAMS(true, false, 0, true, false, 0);
    }
    if (s == Screen::Creator) {
        // Face the camera from two metres away.
        creatorHeading_ = 180.0f;
        ENTITY::SET_ENTITY_HEADING(me, creatorHeading_);
        CAMERA::SET_CAM_COORD(uiCam_, p.x, p.y - 2.2f, p.z + 0.35f);
        CAMERA::POINT_CAM_AT_COORD(uiCam_, p.x, p.y, p.z + 0.25f);
        creator_.dirty = true;
        focus_ = &creator_.first;
    } else {
        // A view over the city from the lobby.
        CAMERA::SET_CAM_COORD(uiCam_, p.x - 4.0f, p.y - 20.0f, p.z + 14.0f);
        CAMERA::POINT_CAM_AT_COORD(uiCam_, p.x + 30.0f, p.y - 600.0f, p.z - 120.0f);
    }
    CAMERA::SET_CAM_ACTIVE(uiCam_, true);
}

void GameClient::closeScreens() {
    if (screen_ == Screen::Tuning) endTuning();
    if (screen_ == Screen::Phone) closePhone();
    if (screen_ == Screen::Dealer) closeDealer();
    // A storage open next to the inventory closes with it.
    if (screen_ == Screen::Inventory && !storage_.empty()) {
        storage_.clear();
        if (invSelected_.container == 3) invSelected_ = {};
        send(ScriptEvent{"gomp:inv:close", {}});
    }
    // A question closed without an answer (Esc).
    if (screen_ == Screen::Choice && choiceCancel_) {
        auto cancel = std::move(choiceCancel_);
        choiceCancel_ = nullptr;
        screen_ = Screen::None;
        cancel();
    }
    screen_ = Screen::None;
    screenActive_ = false;
    focus_ = nullptr;
    uiError_.clear();
    loginPassword_.clear();
    if (uiCam_) {
        CAMERA::SET_CAM_ACTIVE(uiCam_, false);
        CAMERA::RENDER_SCRIPT_CAMS(false, false, 0, true, false, 0);
        CAMERA::DESTROY_CAM(uiCam_, false);
        uiCam_ = 0;
    }
    Ped me = PLAYER::PLAYER_PED_ID();
    ENTITY::FREEZE_ENTITY_POSITION(me, false);
    ENTITY::SET_ENTITY_VISIBLE(me, true, false);
    HUD::DISPLAY_RADAR(true);
    HUD::DISPLAY_HUD(true);
}

bool GameClient::uiBlocksPause() {
    EnterCriticalSection(&chatLock_);
    bool typing = chatOpen_ || consoleOpen_;
    LeaveCriticalSection(&chatLock_);
    return typing || screen_ != Screen::None || GetTickCount() - escHandledAt_.load() < 400;
}

// ------------------------------------------------------------------ widgets

bool GameClient::uiButton(float x, float y, float w, float h, const std::string& text, bool primary, bool enabled) {
    bool hover = enabled && mouseX_ >= x && mouseX_ <= x + w && mouseY_ >= y && mouseY_ <= y + h;
    Rgba bg = !enabled ? theme::Surface : primary ? (hover ? theme::AccentHi : theme::Accent) : (hover ? theme::SurfaceHi : theme::Surface);
    Rgba fg = !enabled ? theme::Muted : primary ? theme::OnAccent : theme::Text;
    roundRect(x, y, w, h, bg, 6);
    label(text, x + w / 2, y, 0.36f, fg, Align::Center, h);
    return hover && mouseClick_;
}

void GameClient::uiTextField(float x, float y, float w, const std::string& caption, std::string& value, bool password) {
    label(caption, x, y, 0.29f, theme::Muted);
    const float fy = y + 0.024f, fh = 0.038f;
    bool focused = focus_ == &value;
    panel(x, fy, w, fh, focused ? theme::SurfaceHi : theme::Surface, focused ? theme::Accent : theme::Border, 6);
    std::string shown = password ? std::string(value.size(), '*') : value;
    if (focused && (GetTickCount() / 500) % 2 == 0) shown += "|";
    label(shown, x + 0.008f, fy, 0.37f, theme::Text, Align::Left, fh);
    if (focused) {
        const bool latinOnly = &value == &loginName_ || &value == &loginPassword_;
        label(latinOnly ? "EN" : (lang_.load() == Lang::Ru ? "RU" : "EN"), x + w - 0.007f, fy, 0.28f, theme::Accent, Align::Right, fh);
    }
    if (mouseClick_ && mouseX_ >= x && mouseX_ <= x + w && mouseY_ >= fy && mouseY_ <= fy + fh) focus_ = &value;
    focusDrawn_.push_back(&value);
}

// A row "caption      < value >"; returns -1 or +1 when an arrow is clicked.
int GameClient::uiStepper(float x, float y, float w, const std::string& caption, const std::string& value) {
    const float h = 0.032f, bw = 0.024f;
    label(caption, x, y, 0.33f, theme::Muted, Align::Left, h);
    const float vx = x + w * 0.42f, vw = w * 0.58f;
    roundRect(vx, y, vw, h, theme::Surface, 6);
    label(value, vx + vw / 2, y, 0.33f, theme::Text, Align::Center, h);
    int delta = 0;
    auto arrow = [&](float ax, const char* t) {
        bool hover = mouseX_ >= ax && mouseX_ <= ax + bw && mouseY_ >= y && mouseY_ <= y + h;
        if (hover) roundRect(ax, y, bw, h, theme::SurfaceHi, 6);
        label(t, ax + bw / 2, y, 0.36f, hover ? theme::Accent : theme::Muted, Align::Center, h);
        return hover && mouseClick_;
    };
    if (arrow(vx, "<")) delta = -1;
    if (arrow(vx + vw - bw, ">")) delta = 1;
    return delta;
}

// A small uppercase section header with a turquoise tick and a hairline.
static void sectionTitle(const std::string& s, float x, float y, float w) {
    rect(x, y + 0.004f, 0.003f, 0.016f, theme::Accent);
    const float tw = textWidth(s, 0.3f);
    label(s, x + 0.008f, y, 0.3f, theme::Muted);
    rect(x + 0.014f + tw, y + 0.012f, std::max(0.0f, w - tw - 0.016f), 0.001f, theme::Border);
}

// ------------------------------------------------------------------ frame

void GameClient::tickScreens() {
    if (screen_ == Screen::None || probing_) return;  // the house probe moves the player (probe.cpp)
    Ped me = PLAYER::PLAYER_PED_ID();
    PAD::DISABLE_ALL_CONTROL_ACTIONS(0);
    PAD::DISABLE_ALL_CONTROL_ACTIONS(2);
    HUD::SET_MOUSE_CURSOR_THIS_FRAME();
    // With the phone out one can still walk and drive, unless typing.
    if (screen_ == Screen::Phone && !focus_)
        for (int c : {21, 30, 31, 32, 33, 34, 35, 59, 60, 63, 64, 71, 72, 76}) PAD::ENABLE_CONTROL_ACTION(0, c, true);
    if (lobbyScreen()) {
        HUD::DISPLAY_RADAR(false);
        HUD::HIDE_HUD_AND_RADAR_THIS_FRAME();
        ENTITY::FREEZE_ENTITY_POSITION(me, true);
        ENTITY::SET_ENTITY_VISIBLE(me, screen_ == Screen::Creator, false);
    }
    mouseX_ = PAD::GET_DISABLED_CONTROL_NORMAL(2, kInputCursorX);
    mouseY_ = PAD::GET_DISABLED_CONTROL_NORMAL(2, kInputCursorY);
    mouseClick_ = PAD::IS_DISABLED_CONTROL_JUST_PRESSED(2, kInputCursorAccept);

    // Keys typed since the last frame (keyboard thread).
    EnterCriticalSection(&chatLock_);
    auto keys = std::move(uiKeys_);
    uiKeys_.clear();
    LeaveCriticalSection(&chatLock_);
    bool submit = false;
    for (const auto& k : keys) {
        if (!lobbyScreen() && (k.key == VK_ESCAPE || k.key == VK_F2 || (screen_ == Screen::Inventory && k.key == VK_TAB) ||
                               (screen_ == Screen::VehMenu && k.key == 'G') ||
                               (screen_ == Screen::Phone && k.key == VK_UP))) {  // F2 menu, inventory, G menu, phone, shops
            if (screen_ == Screen::Layout) cancelLayout();
            escHandledAt_ = GetTickCount();
            closeScreens();
            return;
        }
        if (k.key == VK_TAB && !focusOrder_.empty()) {
            auto it = std::find(focusOrder_.begin(), focusOrder_.end(), focus_);
            focus_ = (it == focusOrder_.end() || ++it == focusOrder_.end()) ? focusOrder_.front() : *it;
        } else if (k.key == VK_RETURN) {
            submit = true;
        } else if (k.key == VK_BACK) {
            if (focus_)
                while (!focus_->empty()) {
                    unsigned char c = static_cast<unsigned char>(focus_->back());
                    focus_->pop_back();
                    if (isLeadByte(c)) break;
                }
        } else if (focus_) {
            const bool latinOnly = focus_ == &loginName_ || focus_ == &loginPassword_;
            const std::string& t = latinOnly ? k.latin : k.text;
            // Messages are longer than names (bytes: Cyrillic letters take two).
            const std::size_t limit = focus_ == &phoneText_ ? 320 : focus_ == &phoneField1_ || focus_ == &phoneField2_ ? 48 : kMaxFieldLength * 2;
            if (!t.empty() && focus_->size() + t.size() <= limit) *focus_ += t;
        }
    }

    focusDrawn_.clear();
    switch (screen_) {
        case Screen::Login:
            drawLogin();
            if (submit) submitLogin();
            break;
        case Screen::Characters: drawCharacters(); break;
        case Screen::Spawn: drawSpawn(); break;
        case Screen::Choice: drawChoice(); break;
        case Screen::Creator:
            applyCreatorPreview();
            drawCreator();
            if (submit) submitCreator();
            break;
        case Screen::Menu: drawMenu(); break;
        case Screen::Layout: drawLayout(); break;
        case Screen::Inventory: drawInventory(); break;
        case Screen::VehMenu: drawVehicleMenu(); break;
        case Screen::Shop: drawShop(); break;
        case Screen::Fuel: drawFuel(); break;
        case Screen::Tuning: drawTuning(); break;
        case Screen::House: drawHouse(); break;
        case Screen::Phone: drawPhone(submit); break;
        case Screen::Dealer: drawDealer(); break;
        default: break;
    }
    focusOrder_ = focusDrawn_;
}

// ------------------------------------------------------------------ login

void GameClient::submitLogin() {
    if (uiBusy_) return;
    if (loginName_.empty() || loginPassword_.empty()) {
        uiError_ = "Введите логин и пароль";
        return;
    }
    uiError_.clear();
    uiBusy_ = true;
    send(ScriptEvent{registerMode_ ? "gomp:auth:register" : "gomp:auth:login",
                     {Value::string(loginName_), Value::string(loginPassword_)}});
}

void GameClient::drawLogin() {
    const float w = 0.24f, h = 0.40f, x = 0.5f - w / 2, y = 0.5f - h / 2;
    panel(x, y, w, h);
    label("GoMP", 0.5f, y + 0.02f, 0.9f, theme::Accent, Align::Center);
    label("ROLEPLAY", 0.5f, y + 0.075f, 0.3f, theme::Muted, Align::Center);
    // Segmented switch: login | registration.
    const float sx = x + 0.02f, sw = w - 0.04f, sy = y + 0.11f, segW = sw / 2;
    roundRect(sx, sy, sw, 0.036f, theme::Surface, 8);
    const char* segs[] = {"Вход", "Регистрация"};
    for (int i = 0; i < 2; ++i) {
        bool active = registerMode_ == (i == 1);
        float bx = sx + i * segW;
        if (active) roundRect(bx + 0.002f, sy + 0.003f, segW - 0.004f, 0.030f, theme::SurfaceHi, 7);
        label(segs[i], bx + segW / 2, sy, 0.34f, active ? theme::Text : theme::Muted, Align::Center, 0.036f);
        if (mouseClick_ && !active && mouseX_ >= bx && mouseX_ <= bx + segW && mouseY_ >= sy && mouseY_ <= sy + 0.036f) {
            registerMode_ = i == 1;
            uiError_.clear();
        }
    }
    const float fx = x + 0.02f, fw = w - 0.04f;
    uiTextField(fx, y + 0.165f, fw, "Логин", loginName_, false);
    uiTextField(fx, y + 0.235f, fw, "Пароль", loginPassword_, true);
    if (!uiError_.empty()) label(uiError_, 0.5f, y + 0.305f, 0.3f, theme::Negative, Align::Center);
    else if (uiBusy_) label("Подождите...", 0.5f, y + 0.305f, 0.3f, theme::Muted, Align::Center);
    if (uiButton(fx, y + 0.335f, fw, 0.045f, registerMode_ ? "Создать аккаунт" : "Войти", true, !uiBusy_)) submitLogin();
}

// ------------------------------------------------------------------ characters

void GameClient::drawCharacters() {
    // Majestic-style cards in a row at the bottom of the screen.
    const int n = std::max(1, maxChars_);
    const float cw = 0.17f, ch = 0.2f, gap = 0.014f, total = n * cw + (n - 1) * gap;
    const float y = 0.72f;
    label("ВЫБОР ПЕРСОНАЖА", 0.5f, y - 0.06f, 0.5f, theme::Text, Align::Center);
    for (int i = 0; i < n; ++i) {
        const float x = 0.5f - total / 2 + i * (cw + gap);
        if (i < static_cast<int>(chars_.size())) {
            const CharInfo& c = chars_[i];
            panel(x, y, cw, ch);
            pill("#" + std::to_string(c.statik), x + 0.01f, y + 0.012f, 0.026f, 0.28f, theme::AccentSoft, theme::Accent);
            label(c.female ? "Ж" : "М", x + cw - 0.012f, y + 0.012f, 0.3f, theme::Muted, Align::Right, 0.026f);
            label(c.first, x + 0.01f, y + 0.045f, 0.5f, theme::Text);
            label(c.last, x + 0.01f, y + 0.078f, 0.38f, theme::Muted);
            label("Наличные", x + 0.01f, y + 0.112f, 0.28f, theme::Muted);
            label(money(c.cash), x + cw - 0.01f, y + 0.112f, 0.28f, theme::Positive, Align::Right);
            label("Карта", x + 0.01f, y + 0.130f, 0.28f, theme::Muted);
            label(money(c.bank), x + cw - 0.01f, y + 0.130f, 0.28f, theme::Accent, Align::Right);
            if (uiButton(x + 0.01f, y + ch - 0.048f, cw - 0.02f, 0.038f, "Играть", true, !uiBusy_)) {
                uiBusy_ = true;
                send(ScriptEvent{"gomp:chars:select", {Value::integer(c.id)}});
            }
        } else {
            bool hover = mouseX_ >= x && mouseX_ <= x + cw && mouseY_ >= y && mouseY_ <= y + ch;
            panel(x, y, cw, ch, hover ? theme::Surface : withAlpha(theme::Bg, 170), hover ? theme::Accent : theme::Border);
            label("+", x + cw / 2, y + 0.045f, 0.9f, hover ? theme::Accent : theme::Muted, Align::Center);
            label("Новый персонаж", x + cw / 2, y + 0.125f, 0.36f, theme::Text, Align::Center);
            if (hover && mouseClick_ && !uiBusy_) {
                creator_ = Creator{};
                uiError_.clear();
                openScreen(Screen::Creator);
            }
        }
    }
}

// ------------------------------------------------------------------ spawn place

void GameClient::drawSpawn() {
    // The same cards as the character screen: where to appear.
    const int n = std::max(1, static_cast<int>(spawnOptions_.size()));
    const float cw = 0.2f, ch = 0.15f, gap = 0.014f, total = n * cw + (n - 1) * gap;
    const float y = 0.72f;
    label("ГДЕ ПОЯВИТЬСЯ", 0.5f, y - 0.06f, 0.5f, theme::Text, Align::Center);
    for (int i = 0; i < static_cast<int>(spawnOptions_.size()); ++i) {
        const SpawnOption& o = spawnOptions_[i];
        const float x = 0.5f - total / 2 + i * (cw + gap);
        panel(x, y, cw, ch);
        label(o.title, x + 0.01f, y + 0.016f, 0.5f, theme::Text);
        if (!o.sub.empty()) {
            std::string sub = o.sub;
            while (sub.size() > 1 && textWidth(sub, 0.3f) > cw - 0.02f) {
                sub.pop_back();
                while (sub.size() > 1 && !isLeadByte(static_cast<unsigned char>(sub.back()))) sub.pop_back();
            }
            label(sub, x + 0.01f, y + 0.058f, 0.3f, theme::Muted);
        }
        if (uiButton(x + 0.01f, y + ch - 0.048f, cw - 0.02f, 0.038f, "Появиться", true, !uiBusy_ && houseFade_ == 0)) {
            if (o.id == "house") {
                // The fade hides the move into the house and the wait for its interior.
                startHouseFade(ScriptEvent{"gomp:spawn:choose", {Value::string("house")}}, 0);
            } else {
                uiBusy_ = true;
                send(ScriptEvent{"gomp:spawn:choose", {Value::string("last")}});
            }
        }
    }
}

// ------------------------------------------------------------------ choice menu

void GameClient::openChoice(const std::string& title, std::vector<ChoiceOption> options, std::string text, std::function<void()> onCancel) {
    choiceTitle_ = title;
    choiceText_ = std::move(text);
    choice_ = std::move(options);
    choiceCancel_ = std::move(onCancel);
    openScreen(Screen::Choice);
}

void GameClient::drawChoice() {
    const float textH = choiceText_.empty() ? 0.0f : 0.034f;
    const float w = std::max(0.24f, textWidth(choiceText_, 0.3f) + 0.05f), bh = 0.044f, gap = 0.008f, pad = 0.018f;
    const float h = 0.088f + textH + choice_.size() * (bh + gap) + 0.006f;
    const float x = 0.5f - w / 2, y = 0.5f - h / 2;
    panel(x, y, w, h);
    label(choiceTitle_, x + pad, y + 0.014f, 0.46f, theme::Text);
    if (!choiceText_.empty()) label(choiceText_, x + pad, y + 0.052f, 0.3f, theme::Text);
    label("Esc — отмена", x + pad, y + 0.05f + textH, 0.26f, theme::Muted);
    float by = y + 0.088f + textH;
    for (std::size_t i = 0; i < choice_.size(); ++i) {
        if (uiButton(x + pad, by, w - 2 * pad, bh, choice_[i].title, i == 0)) {
            auto action = choice_[i].action;
            choiceCancel_ = nullptr;  // answered
            closeScreens();
            if (action) action();
            return;
        }
        by += bh + gap;
    }
}

// ------------------------------------------------------------------ creator

void GameClient::applyCreatorPreview() {
    Creator& c = creator_;
    if (!c.dirty) return;
    Ped me = PLAYER::PLAYER_PED_ID();
    const Hash want = joaat(c.female ? "mp_f_freemode_01" : "mp_m_freemode_01");
    if (ENTITY::GET_ENTITY_MODEL(me) != want) {
        if (!ensureModel(want)) return;  // streaming; try next frame
        Vector3 p = ENTITY::GET_ENTITY_COORDS(me, true);
        PLAYER::SET_PLAYER_MODEL(PLAYER::PLAYER_ID(), want);
        STREAMING::SET_MODEL_AS_NO_LONGER_NEEDED(want);
        me = PLAYER::PLAYER_PED_ID();
        PED::SET_PED_DEFAULT_COMPONENT_VARIATION(me);
        ENTITY::SET_ENTITY_COORDS_NO_OFFSET(me, p.x, p.y, p.z, false, false, false);
        ENTITY::SET_ENTITY_HEADING(me, creatorHeading_);
        c.hair = PED::GET_PED_DRAWABLE_VARIATION(me, 2);
        c.beard = -1;
        c.needDefaults = true;
    }
    if (c.needDefaults) {
        dressOutfit(me, c);
        c.needDefaults = false;
    }
    PED::SET_PED_HEAD_BLEND_DATA(me, c.father, c.mother, 0, c.father, c.mother, 0, c.shapeMix, c.skinMix, 0.0f, false);
    PED::SET_PED_COMPONENT_VARIATION(me, 2, c.hair, 0, 0);
    PED::SET_PED_COMPONENT_VARIATION(me, 3, c.torso, 0, 0);
    PED::SET_PED_COMPONENT_VARIATION(me, 4, c.legs, c.legsTex, 0);
    PED::SET_PED_COMPONENT_VARIATION(me, 6, c.shoes, c.shoesTex, 0);
    PED::SET_PED_COMPONENT_VARIATION(me, 8, c.undershirt, 0, 0);
    PED::SET_PED_COMPONENT_VARIATION(me, 11, c.top, c.topTex, 0);
    PED::SET_PED_HAIR_TINT(me, c.hairColor, c.hairColor);
    PED::SET_HEAD_BLEND_EYE_COLOR(me, c.eyeColor);
    PED::SET_PED_HEAD_OVERLAY(me, 2, c.brows, 1.0f);
    PED::SET_PED_HEAD_OVERLAY_TINT(me, 2, 1, c.hairColor, c.hairColor);
    PED::SET_PED_HEAD_OVERLAY(me, 1, c.beard < 0 ? 255 : c.beard, 1.0f);
    PED::SET_PED_HEAD_OVERLAY_TINT(me, 1, 1, c.hairColor, c.hairColor);
    c.dirty = false;
}

// Puts the selected outfit on with the arms and undershirt the game expects for the top.
void GameClient::dressOutfit(Ped ped, Creator& c) {
    const Outfit& o = outfitOf(c.female, c.outfit);
    c.top = o.top;
    c.topTex = o.topTex;
    c.legs = o.legs;
    c.legsTex = o.legsTex;
    c.shoes = o.shoes;
    c.shoesTex = o.shoesTex;
    c.torso = forcedDrawable(ped, 11, c.top, c.topTex, 3, 0);
    c.undershirt = forcedDrawable(ped, 11, c.top, c.topTex, 8, c.female ? 14 : 15);
}

// Writes the names of the first tops, legs and shoes of the current model to gomp.log
// (console command "clothes"; used to pick the starter outfits).
void GameClient::dumpClothes() {
    Ped me = PLAYER::PLAYER_PED_ID();
    const std::pair<int, const char*> parts[] = {{11, "top"}, {4, "legs"}, {6, "shoes"}, {8, "undershirt"}};
    for (auto [comp, label] : parts) {
        int n = std::min(60, PED::GET_NUMBER_OF_PED_DRAWABLE_VARIATIONS(me, comp));
        for (int d = 0; d < n; ++d) {
            std::string line = std::string(label) + " " + std::to_string(d) + ": " + clothingName(me, comp, d, 0) + " (textures " +
                               std::to_string(PED::GET_NUMBER_OF_PED_TEXTURE_VARIATIONS(me, comp, d)) + ")";
            if (comp == 11) line += " arms=" + std::to_string(forcedDrawable(me, 11, d, 0, 3, -1)) +
                                    " undershirt=" + std::to_string(forcedDrawable(me, 11, d, 0, 8, -1));
            log(line);
        }
    }
    consolePrint("Список одежды записан в gomp.log");
}

void GameClient::submitCreator() {
    if (uiBusy_) return;
    const Creator& c = creator_;
    if (c.first.empty() || c.last.empty()) {
        uiError_ = "Введите имя и фамилию";
        return;
    }
    uiError_.clear();
    uiBusy_ = true;
    auto i = [](int v) { return Value::integer(v); };
    Value appearance = mapValue({{"father", i(c.father)}, {"mother", i(c.mother)}, {"shapeMix", Value::number(c.shapeMix)},
                                 {"skinMix", Value::number(c.skinMix)}, {"hair", i(c.hair)}, {"hairColor", i(c.hairColor)},
                                 {"eyeColor", i(c.eyeColor)}, {"brows", i(c.brows)}, {"beard", i(c.beard)}, {"top", i(c.top)},
                                 {"topTex", i(c.topTex)}, {"torso", i(c.torso)}, {"undershirt", i(c.undershirt)},
                                 {"legs", i(c.legs)}, {"legsTex", i(c.legsTex)}, {"shoes", i(c.shoes)}, {"shoesTex", i(c.shoesTex)}});
    Value data = mapValue({{"first", Value::string(c.first)}, {"last", Value::string(c.last)},
                           {"gender", Value::string(c.female ? "f" : "m")}, {"kit", i(c.kit)}, {"appearance", appearance}});
    send(ScriptEvent{"gomp:chars:create", {data}});
}

void GameClient::drawCreator() {
    Creator& c = creator_;
    Ped me = PLAYER::PLAYER_PED_ID();
    const float x = 0.025f, w = 0.27f, rowH = 0.037f;
    const float y = 0.03f, h = 0.94f;
    panel(x, y, w, h);
    label("СОЗДАНИЕ ПЕРСОНАЖА", x + 0.014f, y + 0.014f, 0.46f, theme::Text);
    const float fx = x + 0.014f, fw = w - 0.028f;
    float ry = y + 0.06f;
    auto count = [&](int component) { return std::max(1, PED::GET_NUMBER_OF_PED_DRAWABLE_VARIATIONS(me, component)); };
    auto step = [&](const std::string& caption, const std::string& value, int& v, int lo, int hi) {
        if (int d = uiStepper(fx, ry, fw, caption, value)) {
            v = wrap(v + d, lo, hi);
            c.dirty = true;
        }
        ry += rowH;
    };
    auto stepF = [&](const std::string& caption, float& v) {
        int pct = static_cast<int>(std::lround(v * 100));
        if (int d = uiStepper(fx, ry, fw, caption, std::to_string(pct) + "%")) {
            v = std::clamp(v + d * 0.1f, 0.0f, 1.0f);
            c.dirty = true;
        }
        ry += rowH;
    };
    auto section = [&](const std::string& s) {
        ry += 0.006f;
        sectionTitle(s, fx, ry, fw);
        ry += 0.028f;
    };

    section("ЛИЧНОСТЬ");
    // Gender as a segmented switch.
    const float segW = fw / 2;
    roundRect(fx, ry, fw, 0.034f, theme::Surface, 8);
    for (int i = 0; i < 2; ++i) {
        bool active = c.female == (i == 1);
        float bx = fx + i * segW;
        if (active) roundRect(bx + 0.002f, ry + 0.003f, segW - 0.004f, 0.028f, theme::Accent, 7);
        label(i ? "Женский" : "Мужской", bx + segW / 2, ry, 0.33f, active ? theme::OnAccent : theme::Muted, Align::Center, 0.034f);
        if (mouseClick_ && !active && mouseX_ >= bx && mouseX_ <= bx + segW && mouseY_ >= ry && mouseY_ <= ry + 0.034f) {
            c.female = i == 1;
            c.dirty = true;
        }
    }
    ry += 0.042f;
    uiTextField(fx, ry, fw / 2 - 0.004f, "Имя", c.first, false);
    uiTextField(fx + fw / 2 + 0.004f, ry, fw / 2 - 0.004f, "Фамилия", c.last, false);
    ry += 0.07f;

    section("НАСЛЕДСТВЕННОСТЬ");
    step("Отец", std::to_string(c.father + 1), c.father, 0, 20);
    step("Мать", std::to_string(c.mother - 20), c.mother, 21, 41);
    stepF("Сходство с отцом", c.shapeMix);
    stepF("Тон кожи", c.skinMix);

    section("ВНЕШНОСТЬ");
    step("Причёска", std::to_string(c.hair + 1) + " / " + std::to_string(count(2)), c.hair, 0, count(2) - 1);
    step("Цвет волос", std::to_string(c.hairColor + 1), c.hairColor, 0, 63);
    step("Брови", std::to_string(c.brows + 1), c.brows, 0, 33);
    if (!c.female) step("Борода", c.beard < 0 ? "Нет" : std::to_string(c.beard + 1), c.beard, -1, 28);
    step("Цвет глаз", std::to_string(c.eyeColor + 1), c.eyeColor, 0, 31);

    section("ОДЕЖДА И СТАРТ");
    if (int d = uiStepper(fx, ry, fw, "Одежда", outfitName(c.female, c.outfit))) {
        c.outfit = wrap(c.outfit + d, 0, kOutfits - 1);
        c.needDefaults = true;  // re-dress
        c.dirty = true;
    }
    ry += rowH;
    if (int d = uiStepper(fx, ry, fw, "Стартовый набор", kKits[c.kit])) c.kit = wrap(c.kit + d, 0, 2);
    ry += rowH;
    label(kKitInfo[c.kit], fx, ry, 0.28f, theme::Accent);

    // Bottom: error, create, back.
    const float by = y + h - 0.105f;
    if (!uiError_.empty()) label(uiError_, x + w / 2, by - 0.03f, 0.3f, theme::Negative, Align::Center);
    else if (uiBusy_) label("Создание...", x + w / 2, by - 0.03f, 0.3f, theme::Muted, Align::Center);
    if (uiButton(fx, by, fw, 0.046f, "Создать персонажа", true, !uiBusy_)) submitCreator();
    if (!chars_.empty() && uiButton(fx, by + 0.054f, fw, 0.034f, "Назад к персонажам", false, !uiBusy_)) {
        uiError_.clear();
        openScreen(Screen::Characters);
    }

    // Turn the character around.
    panel(0.56f, 0.9f, 0.13f, 0.05f, theme::Hud);
    if (uiButton(0.565f, 0.906f, 0.035f, 0.038f, "<")) creatorHeading_ -= 30;
    label("Поворот", 0.625f, 0.9f, 0.32f, theme::Muted, Align::Center, 0.05f);
    if (uiButton(0.65f, 0.906f, 0.035f, 0.038f, ">")) creatorHeading_ += 30;
    ENTITY::SET_ENTITY_HEADING(me, creatorHeading_);
}

}  // namespace gompgame
