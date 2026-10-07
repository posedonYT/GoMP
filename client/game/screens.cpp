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

const Rgba kPanel{12, 14, 20, 225}, kPanelLight{30, 34, 46, 235}, kAccent{64, 156, 255, 255},
    kAccentHover{96, 176, 255, 255}, kButton{44, 50, 66, 255}, kButtonHover{62, 70, 92, 255}, kText{235, 238, 245, 255},
    kMuted{150, 158, 175, 255}, kError{255, 96, 96, 255}, kField{24, 27, 36, 255}, kFieldFocus{34, 40, 56, 255};

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

const Value* field(const Value& m, const char* key) { return m.kind == Value::Kind::Map ? m.get(key) : nullptr; }

std::string str(const Value& m, const char* key) {
    const Value* v = field(m, key);
    return v && v->kind == Value::Kind::String ? v->s : std::string();
}

long long num(const Value& m, const char* key) {
    const Value* v = field(m, key);
    return v ? v->asInt() : 0;
}

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

// ------------------------------------------------------------------ events

bool GameClient::handleUiEvent(const ScriptEvent& e) {
    const auto& a = e.args;
    if (e.name == "gomp:auth:show") {
        uiBusy_ = false;
        uiError_ = a.empty() ? "" : str(a[0], "error");
        if (!a.empty()) {
            if (auto l = str(a[0], "login"); !l.empty()) loginName_ = l;
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
                ci.id = static_cast<int>(num(c, "id"));
                ci.statik = static_cast<int>(num(c, "static"));
                ci.first = str(c, "first");
                ci.last = str(c, "last");
                ci.female = str(c, "gender") == "f";
                ci.cash = num(c, "cash");
                ci.bank = num(c, "bank");
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
    if (e.name == "gomp:creator:error") {
        uiBusy_ = false;
        uiError_ = a.empty() ? "Ошибка" : a[0].s;
        return true;
    }
    if (e.name == "gomp:ui:close") {
        closeScreens();
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
    Rgba bg = !enabled ? kPanelLight : primary ? (hover ? kAccentHover : kAccent) : (hover ? kButtonHover : kButton);
    rect(x, y, w, h, bg);
    drawTextAligned(text, x + w / 2, y + h / 2 - 0.015f, 0.38f, 4, enabled ? kText : kMuted, Align::Center);
    return hover && mouseClick_;
}

void GameClient::uiTextField(float x, float y, float w, const std::string& label, std::string& value, bool password) {
    drawTextAligned(label, x, y, 0.32f, 4, kMuted, Align::Left);
    const float fy = y + 0.026f, fh = 0.036f;
    bool focused = focus_ == &value;
    rect(x, fy, w, fh, focused ? kFieldFocus : kField);
    if (focused) rect(x, fy + fh - 0.003f, w, 0.003f, kAccent);
    std::string shown = password ? std::string(value.size(), '*') : value;
    if (focused && (GetTickCount() / 500) % 2 == 0) shown += "_";
    drawTextAligned(shown, x + 0.006f, fy + 0.004f, 0.38f, 4, kText, Align::Left);
    if (focused) {
        const bool latinOnly = &value == &loginName_ || &value == &loginPassword_;
        drawTextAligned(latinOnly ? "[EN]" : langTag(), x + w - 0.004f, fy + 0.008f, 0.3f, 4, kMuted, Align::Right);
    }
    if (mouseClick_ && mouseX_ >= x && mouseX_ <= x + w && mouseY_ >= fy && mouseY_ <= fy + fh) focus_ = &value;
    focusDrawn_.push_back(&value);
}

// A row "label   <  value  >"; returns -1 or +1 when an arrow is clicked.
int GameClient::uiStepper(float x, float y, float w, const std::string& label, const std::string& value) {
    const float h = 0.03f, bw = 0.022f;
    drawTextAligned(label, x, y + 0.002f, 0.34f, 4, kMuted, Align::Left);
    const float vx = x + w * 0.45f, vw = w * 0.55f;
    rect(vx, y, vw, h, kField);
    drawTextAligned(value, vx + vw / 2, y + 0.002f, 0.34f, 4, kText, Align::Center);
    int delta = 0;
    if (uiButton(vx, y, bw, h, "<")) delta = -1;
    if (uiButton(vx + vw - bw, y, bw, h, ">")) delta = 1;
    return delta;
}

// ------------------------------------------------------------------ frame

void GameClient::tickScreens() {
    if (screen_ == Screen::None) return;
    Ped me = PLAYER::PLAYER_PED_ID();
    PAD::DISABLE_ALL_CONTROL_ACTIONS(0);
    PAD::DISABLE_ALL_CONTROL_ACTIONS(2);
    HUD::SET_MOUSE_CURSOR_THIS_FRAME();
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
        if (!lobbyScreen() && (k.key == VK_ESCAPE || k.key == VK_F2)) {  // F2 menu and layout editor
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
            if (!t.empty() && focus_->size() + t.size() <= kMaxFieldLength * 2) *focus_ += t;
        }
    }

    focusDrawn_.clear();
    switch (screen_) {
        case Screen::Login:
            drawLogin();
            if (submit) submitLogin();
            break;
        case Screen::Characters: drawCharacters(); break;
        case Screen::Creator:
            applyCreatorPreview();
            drawCreator();
            if (submit) submitCreator();
            break;
        case Screen::Menu: drawMenu(); break;
        case Screen::Layout: drawLayout(); break;
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
    const float w = 0.26f, h = 0.40f, x = 0.5f - w / 2, y = 0.28f;
    rect(x, y, w, h, kPanel);
    rect(x, y, w, 0.004f, kAccent);
    drawTextAligned("GoMP", 0.5f, y + 0.02f, 0.8f, 7, kText, Align::Center);
    drawTextAligned(registerMode_ ? "Регистрация аккаунта" : "Вход в аккаунт", 0.5f, y + 0.075f, 0.4f, 4, kMuted, Align::Center);
    const float fx = x + 0.02f, fw = w - 0.04f;
    uiTextField(fx, y + 0.115f, fw, "Логин", loginName_, false);
    uiTextField(fx, y + 0.185f, fw, "Пароль", loginPassword_, true);
    if (!uiError_.empty()) drawTextAligned(uiError_, 0.5f, y + 0.252f, 0.32f, 4, kError, Align::Center);
    if (uiBusy_) drawTextAligned("Подождите...", 0.5f, y + 0.252f, 0.32f, 4, kMuted, Align::Center);
    if (uiButton(fx, y + 0.285f, fw, 0.042f, registerMode_ ? "Создать аккаунт" : "Войти", true, !uiBusy_)) submitLogin();
    if (uiButton(fx, y + 0.338f, fw, 0.034f, registerMode_ ? "Уже есть аккаунт? Войти" : "Нет аккаунта? Регистрация")) {
        registerMode_ = !registerMode_;
        uiError_.clear();
    }
}

// ------------------------------------------------------------------ characters

void GameClient::drawCharacters() {
    const float w = 0.34f, rowH = 0.075f, x = 0.5f - w / 2;
    const float h = 0.09f + rowH * maxChars_ + 0.01f * maxChars_, y = 0.5f - h / 2;
    rect(x, y, w, h, kPanel);
    rect(x, y, w, 0.004f, kAccent);
    drawTextAligned("Выбор персонажа", 0.5f, y + 0.02f, 0.5f, 4, kText, Align::Center);
    float ry = y + 0.075f;
    for (int i = 0; i < maxChars_; ++i, ry += rowH + 0.01f) {
        const float rx = x + 0.015f, rw = w - 0.03f;
        if (i < static_cast<int>(chars_.size())) {
            const CharInfo& c = chars_[i];
            rect(rx, ry, rw, rowH, kPanelLight);
            drawTextAligned(c.first + " " + c.last, rx + 0.01f, ry + 0.008f, 0.45f, 4, kText, Align::Left);
            drawTextAligned("Статик: " + std::to_string(c.statik) + "   Наличные: " + money(c.cash) + "   Карта: " + money(c.bank),
                            rx + 0.01f, ry + 0.042f, 0.3f, 4, kMuted, Align::Left);
            if (uiButton(rx + rw - 0.075f, ry + 0.018f, 0.065f, 0.04f, "Играть", true, !uiBusy_)) {
                uiBusy_ = true;
                send(ScriptEvent{"gomp:chars:select", {Value::integer(c.id)}});
            }
        } else if (uiButton(rx, ry, rw, rowH, "+ Создать персонажа", false, !uiBusy_)) {
            creator_ = Creator{};
            uiError_.clear();
            openScreen(Screen::Creator);
        }
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
    const float x = 0.03f, w = 0.30f, rowH = 0.036f;
    const float h = 0.94f, y = 0.03f;
    rect(x, y, w, h, kPanel);
    rect(x, y, w, 0.004f, kAccent);
    drawTextAligned("Создание персонажа", x + w / 2, y + 0.012f, 0.5f, 4, kText, Align::Center);
    const float fx = x + 0.012f, fw = w - 0.024f;
    float ry = y + 0.055f;
    auto count = [&](int component) { return std::max(1, PED::GET_NUMBER_OF_PED_DRAWABLE_VARIATIONS(me, component)); };
    auto step = [&](const std::string& label, const std::string& value, int& v, int lo, int hi) {
        if (int d = uiStepper(fx, ry, fw, label, value)) {
            v = wrap(v + d, lo, hi);
            c.dirty = true;
        }
        ry += rowH;
    };
    auto stepF = [&](const std::string& label, float& v) {
        int pct = static_cast<int>(std::lround(v * 100));
        if (int d = uiStepper(fx, ry, fw, label, std::to_string(pct) + "%")) {
            v = std::clamp(v + d * 0.1f, 0.0f, 1.0f);
            c.dirty = true;
        }
        ry += rowH;
    };

    if (int d = uiStepper(fx, ry, fw, "Пол", c.female ? "Женский" : "Мужской")) {
        (void)d;
        c.female = !c.female;
        c.dirty = true;
    }
    ry += rowH;
    uiTextField(fx, ry, fw / 2 - 0.004f, "Имя", c.first, false);
    uiTextField(fx + fw / 2 + 0.004f, ry, fw / 2 - 0.004f, "Фамилия", c.last, false);
    ry += 0.072f;
    step("Отец", std::to_string(c.father + 1), c.father, 0, 20);
    step("Мать", std::to_string(c.mother - 20), c.mother, 21, 41);
    stepF("Сходство с отцом", c.shapeMix);
    stepF("Тон кожи", c.skinMix);
    step("Причёска", std::to_string(c.hair + 1) + " / " + std::to_string(count(2)), c.hair, 0, count(2) - 1);
    step("Цвет волос", std::to_string(c.hairColor + 1), c.hairColor, 0, 63);
    step("Брови", std::to_string(c.brows + 1), c.brows, 0, 33);
    if (!c.female) step("Борода", c.beard < 0 ? "Нет" : std::to_string(c.beard + 1), c.beard, -1, 28);
    step("Цвет глаз", std::to_string(c.eyeColor + 1), c.eyeColor, 0, 31);
    if (int d = uiStepper(fx, ry, fw, "Одежда", outfitName(c.female, c.outfit))) {
        c.outfit = wrap(c.outfit + d, 0, kOutfits - 1);
        c.needDefaults = true;  // re-dress
        c.dirty = true;
    }
    ry += rowH;
    ry += 0.008f;
    if (int d = uiStepper(fx, ry, fw, "Стартовый набор", kKits[c.kit])) c.kit = wrap(c.kit + d, 0, 2);
    ry += rowH;
    drawTextAligned(kKitInfo[c.kit], fx, ry - 0.004f, 0.3f, 4, kMuted, Align::Left);
    ry += 0.034f;
    if (!uiError_.empty()) drawTextAligned(uiError_, x + w / 2, ry, 0.32f, 4, kError, Align::Center);
    if (uiBusy_) drawTextAligned("Создание...", x + w / 2, ry, 0.32f, 4, kMuted, Align::Center);
    ry += 0.034f;
    if (uiButton(fx, ry, fw, 0.044f, "Создать персонажа", true, !uiBusy_)) submitCreator();
    ry += 0.052f;
    if (!chars_.empty() && uiButton(fx, ry, fw, 0.034f, "Назад к персонажам", false, !uiBusy_)) {
        uiError_.clear();
        openScreen(Screen::Characters);
    }

    // Turn the character around.
    if (uiButton(0.60f, 0.90f, 0.05f, 0.04f, "<<")) creatorHeading_ -= 30;
    if (uiButton(0.66f, 0.90f, 0.05f, 0.04f, ">>")) creatorHeading_ += 30;
    ENTITY::SET_ENTITY_HEADING(me, creatorHeading_);
}

}  // namespace gompgame
