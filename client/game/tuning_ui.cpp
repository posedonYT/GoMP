// Los Santos Customs: the tuning window. At the workshop door the vehicle is
// moved into the bay inside (the interior is loaded behind a fade) and stands
// frozen there; a camera circles it (drag, wheel, view buttons, and it turns to
// the part being chosen), every choice is shown on the vehicle at once and goes
// into the order; leaving puts it back in the street; "Купить" sends the order to the
// server (server-files/packages/freeroam/tuning.js), which charges it and sets
// the vehicle's properties. The parts come from the vehicle's mod kit, so the
// game's vehicles and add-on ones are tuned alike.
#include <cmath>
#include <cstdio>
#include <cstring>

#include "game_client.hpp"
#include "natives.hpp"
#include "props.hpp"
#include "ui.hpp"

namespace gompgame {

using namespace gomp;
using namespace ui;

namespace {

constexpr int kModTypes = 50;
constexpr DWORD kResyncMs = 1500;
constexpr int kVisibleRows = 14;

bool unusedModType(int type) { return type == 17 || type == 19 || type == 21; }

// Russian names of the mod slots (the game's own slot name is used for add-on kits when it has one).
const char* modTypeName(int type) {
    static const char* const kNames[kModTypes] = {
        "Спойлер",        "Передний бампер", "Задний бампер",  "Пороги",          "Выхлоп",        "Каркас",
        "Решётка",        "Капот",           "Крыло",          "Правое крыло",    "Крыша",         "Двигатель",
        "Тормоза",        "Коробка передач", "Сигнал",         "Подвеска",        "Броня",         "",
        "Турбо",          "",                "Дым от шин",     "",                "Ксенон",        "Диски",
        "Задние диски",   "Рамка номера",    "Номер",          "Отделка салона",  "Украшения",     "Панель приборов",
        "Циферблат",      "Динамики дверей", "Сиденья",        "Руль",            "Рычаг КПП",     "Таблички",
        "Аудиосистема",   "Багажник",        "Гидравлика",     "Блок двигателя",  "Воздушный фильтр", "Стойки",
        "Арки",           "Антенна",         "Детали кузова",  "Бак",             "Окна",          "Детали",
        "Ливрея (кит)",   "Детали"};
    return type >= 0 && type < kModTypes ? kNames[type] : "Детали";
}

struct NamedColor {
    int index;
    const char* name;
    Rgba rgb;
};
// GTA paint indices with their look, for the colour palette.
const NamedColor kPaints[] = {
    {0, "Чёрный", {13, 17, 22, 255}},        {1, "Графит", {28, 29, 33, 255}},        {4, "Серебро", {153, 157, 160, 255}},
    {111, "Белый", {255, 255, 246, 255}},    {112, "Снежный", {234, 234, 234, 255}},  {27, "Красный", {192, 14, 26, 255}},
    {28, "Ярко-красный", {218, 25, 24, 255}}, {35, "Вишнёвый", {143, 47, 85, 255}},  {38, "Оранжевый", {246, 113, 0, 255}},
    {89, "Жёлтый", {255, 207, 32, 255}},     {88, "Такси", {251, 226, 18, 255}},       {92, "Лайм", {102, 184, 31, 255}},
    {53, "Зелёный", {21, 92, 45, 255}},      {55, "Ярко-зелёный", {58, 213, 29, 255}}, {64, "Синий", {34, 52, 87, 255}},
    {70, "Ультрамарин", {11, 32, 141, 255}}, {73, "Голубой", {39, 102, 245, 255}},     {74, "Небесный", {108, 162, 238, 255}},
    {145, "Фиолетовый", {98, 18, 118, 255}}, {137, "Розовый", {242, 125, 165, 255}},  {135, "Фуксия", {245, 87, 183, 255}},
    {96, "Шоколад", {34, 27, 25, 255}},      {90, "Бронза", {124, 65, 30, 255}},       {158, "Золото", {182, 151, 64, 255}},
};
const Rgba kNeons[] = {{255, 255, 255, 255}, {2, 21, 255, 255},  {3, 83, 255, 255},  {0, 255, 140, 255}, {94, 255, 1, 255},
                       {255, 255, 0, 255},   {255, 150, 5, 255}, {255, 1, 1, 255},   {255, 50, 100, 255}, {35, 1, 255, 255}};
const char* const kWheelTypes[] = {"Спорт", "Маслкар", "Лоурайдер", "Внедорожник", "SUV", "Тюнер", "Мото",
                                   "Хай-энд", "Benny's Original", "Benny's Bespoke", "Open Wheel", "Street", "Track"};
const char* const kTints[] = {"Без тонировки", "Чёрная", "Тёмная", "Светлая", "Заводская", "Лимузин", "Зелёная"};
const char* const kPlates[] = {"Синий на белом", "Жёлтый на чёрном", "Жёлтый на синем", "Синий на белом 2",
                               "Синий на белом 3", "North Yankton"};

std::string optionName(Vehicle veh, int type, int index) {
    if (index < 0) return "Стандарт";
    const char* label = VEHICLE::GET_MOD_TEXT_LABEL(veh, type, index);
    const char* text = label && *label ? HUD::GET_FILENAME_FOR_AUDIO_CONVERSATION(label) : nullptr;
    if (text && *text && std::strcmp(text, "NULL") != 0) return text;
    return "Вариант " + std::to_string(index + 1);
}

}  // namespace

// ------------------------------------------------------------------ vehicle state

GameClient::TuneState GameClient::readTuning(Vehicle veh) const {
    TuneState s;
    for (int type = 0; type < kModTypes; ++type) {
        if (unusedModType(type)) continue;
        s.mods[type] = logic::isToggleMod(type) ? (VEHICLE::IS_TOGGLE_MOD_ON(veh, type) ? 0 : -1) : VEHICLE::GET_VEHICLE_MOD(veh, type);
    }
    VEHICLE::GET_VEHICLE_COLOURS(veh, &s.primary, &s.secondary);
    VEHICLE::GET_VEHICLE_EXTRA_COLOURS(veh, &s.pearl, &s.wheelColor);
    s.wheelType = VEHICLE::GET_VEHICLE_WHEEL_TYPE(veh);
    s.windowTint = std::max(0, VEHICLE::GET_VEHICLE_WINDOW_TINT(veh));
    s.plateType = VEHICLE::GET_VEHICLE_NUMBER_PLATE_TEXT_INDEX(veh);
    s.livery = VEHICLE::GET_VEHICLE_LIVERY(veh);
    s.neonOn = VEHICLE::GET_VEHICLE_NEON_ENABLED(veh, 0);
    VEHICLE::GET_VEHICLE_NEON_COLOUR(veh, &s.neonR, &s.neonG, &s.neonB);
    return s;
}

void GameClient::previewTuning(Vehicle veh, const TuneState& s) {
    VEHICLE::SET_VEHICLE_MOD_KIT(veh, 0);
    VEHICLE::SET_VEHICLE_WHEEL_TYPE(veh, s.wheelType);
    for (const auto& [type, index] : s.mods) {
        if (logic::isToggleMod(type)) VEHICLE::TOGGLE_VEHICLE_MOD(veh, type, index >= 0);
        else if (index >= 0) VEHICLE::SET_VEHICLE_MOD(veh, type, index, false);
        else VEHICLE::REMOVE_VEHICLE_MOD(veh, type);
    }
    VEHICLE::SET_VEHICLE_COLOURS(veh, s.primary, s.secondary);
    VEHICLE::SET_VEHICLE_EXTRA_COLOURS(veh, s.pearl, s.wheelColor);
    VEHICLE::SET_VEHICLE_WINDOW_TINT(veh, s.windowTint);
    VEHICLE::SET_VEHICLE_NUMBER_PLATE_TEXT_INDEX(veh, s.plateType);
    if (s.livery >= 0) VEHICLE::SET_VEHICLE_LIVERY(veh, s.livery);
    for (int i = 0; i < 4; ++i) VEHICLE::SET_VEHICLE_NEON_ENABLED(veh, i, s.neonOn);
    VEHICLE::SET_VEHICLE_NEON_COLOUR(veh, s.neonR, s.neonG, s.neonB);
}

// The price of everything that differs from the vehicle as it came in (as tuning.js counts it).
int GameClient::tuningPrice() const {
    int sum = 0;
    for (const auto& [type, index] : tune_.mods) {
        auto o = tuneOrig_.mods.find(type);
        if (o == tuneOrig_.mods.end() || o->second != index) sum += logic::tuneModPrice(tunePrices_, type, index);
    }
    auto field = [&](int now, int was, const char* name) {
        if (now != was) sum += logic::tuneFieldPrice(tunePrices_, name);
    };
    field(tune_.primary, tuneOrig_.primary, "primary");
    field(tune_.secondary, tuneOrig_.secondary, "secondary");
    field(tune_.pearl, tuneOrig_.pearl, "pearl");
    field(tune_.wheelColor, tuneOrig_.wheelColor, "wheelColor");
    field(tune_.wheelType, tuneOrig_.wheelType, "wheelType");
    field(tune_.windowTint, tuneOrig_.windowTint, "windowTint");
    field(tune_.plateType, tuneOrig_.plateType, "plateType");
    if (tune_.livery >= 0) field(tune_.livery, tuneOrig_.livery, "livery");
    const bool neonChanged = tune_.neonOn != tuneOrig_.neonOn ||
                             (tune_.neonOn && (tune_.neonR != tuneOrig_.neonR || tune_.neonG != tuneOrig_.neonG || tune_.neonB != tuneOrig_.neonB));
    if (neonChanged && tune_.neonOn) sum += logic::tuneFieldPrice(tunePrices_, "neon");
    return sum;
}

// The order for the server: only what changed.
Value GameClient::tuningOrder() const {
    Value order;
    order.kind = Value::Kind::Map;
    Value mods;
    mods.kind = Value::Kind::Map;
    for (const auto& [type, index] : tune_.mods) {
        auto o = tuneOrig_.mods.find(type);
        if (o == tuneOrig_.mods.end() || o->second != index) mods.map.emplace_back(std::to_string(type), Value::integer(index));
    }
    if (!mods.map.empty()) order.map.emplace_back("mods", mods);
    auto field = [&](const char* name, int now, int was) {
        if (now != was) order.map.emplace_back(name, Value::integer(now));
    };
    field("primary", tune_.primary, tuneOrig_.primary);
    field("secondary", tune_.secondary, tuneOrig_.secondary);
    field("pearl", tune_.pearl, tuneOrig_.pearl);
    field("wheelColor", tune_.wheelColor, tuneOrig_.wheelColor);
    field("wheelType", tune_.wheelType, tuneOrig_.wheelType);
    field("windowTint", tune_.windowTint, tuneOrig_.windowTint);
    field("plateType", tune_.plateType, tuneOrig_.plateType);
    if (tune_.livery >= 0) field("livery", tune_.livery, tuneOrig_.livery);
    if (tune_.neonOn != tuneOrig_.neonOn || tune_.neonR != tuneOrig_.neonR || tune_.neonG != tuneOrig_.neonG || tune_.neonB != tuneOrig_.neonB)
        order.map.emplace_back("neon", Value::array({Value::boolean(tune_.neonOn), Value::integer(tune_.neonR),
                                                     Value::integer(tune_.neonG), Value::integer(tune_.neonB)}));
    return order;
}

// ------------------------------------------------------------------ open / close

void GameClient::openTuning(uint16_t id) {
    const Vehicle veh = vehicleHandle(id);
    if (!veh) return;
    VEHICLE::SET_VEHICLE_MOD_KIT(veh, 0);
    tuneVehicle_ = id;
    tuneOrig_ = tune_ = readTuning(veh);
    tuneBought_ = false;
    tuneCat_ = tuneCatScroll_ = tuneOptScroll_ = 0;
    tuneLastMouseX_ = -1;
    tuneView_ = tuneViewGoal_ = logic::tunePreset(logic::ViewOverview);
    tuneView_.yaw += 40;  // a short swing round to start with
    for (bool& d : tuneDoors_) d = false;

    // The categories this vehicle has: paint first, then the parts of its mod kit.
    tuneCats_.clear();
    tuneCats_.push_back({"Цвет кузова", TuneKind::Primary});
    tuneCats_.push_back({"Второй цвет", TuneKind::Secondary});
    tuneCats_.push_back({"Перламутр", TuneKind::Pearl});
    tuneCats_.push_back({"Тип дисков", TuneKind::WheelType});
    tuneCats_.push_back({"Цвет дисков", TuneKind::WheelColor});
    static const int kOrder[] = {23, 24, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 14, 25, 26, 27, 28, 29, 30, 31,
                                 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49};
    for (int type : kOrder) {
        if (VEHICLE::GET_NUM_VEHICLE_MODS(veh, type) <= 0) continue;
        const char* slot = VEHICLE::GET_MOD_SLOT_NAME(veh, type);
        const char* text = slot && *slot ? HUD::GET_FILENAME_FOR_AUDIO_CONVERSATION(slot) : nullptr;
        // Add-on kits often name their slots ("Wing", "Diffuser"); the game's slots get Russian names.
        std::string name = text && *text && std::strcmp(text, "NULL") != 0 ? text : modTypeName(type);
        tuneCats_.push_back({name, TuneKind::Mod, type});
    }
    tuneCats_.push_back({"Турбонаддув", TuneKind::Toggle, 18});
    tuneCats_.push_back({"Ксенон", TuneKind::Toggle, 22});
    tuneCats_.push_back({"Тонировка", TuneKind::Tint});
    tuneCats_.push_back({"Неон", TuneKind::Neon});
    tuneCats_.push_back({"Номерной знак", TuneKind::Plate});
    if (VEHICLE::GET_VEHICLE_LIVERY_COUNT(veh) > 0) tuneCats_.push_back({"Ливрея", TuneKind::Livery});

    ENTITY::FREEZE_ENTITY_POSITION(veh, true);
    openScreen(Screen::Tuning);
    if (!uiCam_) {
        const Vector3 p = ENTITY::GET_ENTITY_COORDS(veh, true);
        uiCam_ = CAMERA::CREATE_CAM_WITH_PARAMS("DEFAULT_SCRIPTED_CAMERA", p.x, p.y, p.z + 2, 0, 0, 0, 50.0f, true, 2);
        CAMERA::RENDER_SCRIPT_CAMS(true, true, 600, true, false, 0);
    }
    CAMERA::SET_CAM_ACTIVE(uiCam_, true);
}

// Called by closeScreens(): back to driving; an order not bought is taken off the vehicle.
void GameClient::endTuning() {
    const Vehicle veh = vehicleHandle(tuneVehicle_);
    if (veh) {
        if (!tuneBought_) previewTuning(veh, tuneOrig_);
        for (int d = 0; d < 6; ++d)
            if (tuneDoors_[d]) VEHICLE::SET_VEHICLE_DOOR_SHUT(veh, d, true);
    }
    // Out into the street again (tickTuningTransition), behind a fade.
    if (tuneStage_ == 3) {
        tuneStage_ = 4;
        tuneStageAt_ = GetTickCount();
        CAMERA::DO_SCREEN_FADE_OUT(400);
    } else if (veh) {
        ENTITY::FREEZE_ENTITY_POSITION(veh, false);
    }
    // A moment later the vehicle takes the server's properties: the bought tuning,
    // or the old state when the purchase was refused.
    tuneResyncVehicle_ = tuneVehicle_;
    tuneResyncAt_ = GetTickCount() + (tuneBought_ ? kResyncMs : 0);
    tuneVehicle_ = kNoID;
}

void GameClient::tickTuningResync() {
    if (!tuneResyncAt_ || static_cast<int>(GetTickCount() - tuneResyncAt_) < 0) return;
    tuneResyncAt_ = 0;
    auto it = vehicles_.find(tuneResyncVehicle_);
    if (it == vehicles_.end() || !it->second.handle) return;
    previewTuning(it->second.handle, tuneOrig_);
    applyVehicleProps(it->second.handle, it->second.props, &it->second);
}

// ------------------------------------------------------------------ window

void GameClient::drawTuning() {
    const Vehicle veh = vehicleHandle(tuneVehicle_);
    if (!veh || !PED::IS_PED_IN_VEHICLE(PLAYER::PLAYER_PED_ID(), veh, false)) {
        closeScreens();
        return;
    }
    HUD::HIDE_HUD_AND_RADAR_THIS_FRAME();
    const float aspect = GRAPHICS::GET_ASPECT_RATIO(false);

    // Panels: categories on the left, options next to them, the order at the bottom.
    const float LX = 0.02f, LY = 0.08f, LW = 0.2f, rowH = 0.032f;
    const float OX = LX + LW + 0.01f, OW = 0.24f;
    const float LH = 0.09f + kVisibleRows * rowH + 0.02f;
    const float BY = LY + LH + 0.012f, BH = 0.13f, BW = LW + 0.01f + OW;
    const bool overPanels = (mouseX_ >= LX && mouseX_ <= LX + BW && mouseY_ >= LY && mouseY_ <= BY + BH);

    // The driver is hidden: the vehicle is inspected empty, and the cabin view needs the room.
    NETWORK::SET_ENTITY_LOCALLY_INVISIBLE(PLAYER::PLAYER_PED_ID());

    // Camera: drag to turn it round the vehicle and up/down, the wheel brings it closer.
    const float toolY = 0.9f;
    const bool overToolbar = mouseY_ >= toolY - 0.005f;
    const bool held = PAD::IS_DISABLED_CONTROL_PRESSED(2, 237);
    if (held && !overPanels && !overToolbar && tuneLastMouseX_ >= 0) {
        tuneViewGoal_.yaw = std::fmod(tuneViewGoal_.yaw - (mouseX_ - tuneLastMouseX_) * 360.0f + 360.0f, 360.0f);
        tuneViewGoal_.pitch = std::clamp(tuneViewGoal_.pitch + (mouseY_ - tuneLastMouseY_) * 120.0f, -10.0f, 75.0f);
    }
    tuneLastMouseX_ = held ? mouseX_ : -1;
    tuneLastMouseY_ = held ? mouseY_ : -1;
    if (!overPanels && !overToolbar) {
        const bool cabin = tuneViewGoal_.dist < 1.2f;
        if (PAD::IS_DISABLED_CONTROL_JUST_PRESSED(2, 241)) tuneViewGoal_.dist *= 0.88f;
        if (PAD::IS_DISABLED_CONTROL_JUST_PRESSED(2, 242)) tuneViewGoal_.dist *= 1.14f;
        tuneViewGoal_.dist = cabin ? std::clamp(tuneViewGoal_.dist, 0.3f, 1.1f) : std::clamp(tuneViewGoal_.dist, 1.8f, 8.0f);
    }
    tuneView_ = logic::blend(tuneView_, tuneViewGoal_, 0.14f);
    // Whatever switched script cameras off (the game, a cleanup), this view stays on.
    if (!CAMERA::IS_CAM_RENDERING(uiCam_)) {
        CAMERA::SET_CAM_ACTIVE(uiCam_, true);
        CAMERA::RENDER_SCRIPT_CAMS(true, false, 0, true, false, 0);
    }
    {
        const Vector3 vp = ENTITY::GET_ENTITY_COORDS(veh, true);
        const Vector3 fwd = ENTITY::GET_ENTITY_FORWARD_VECTOR(veh);
        const float fl = std::max(0.001f, std::hypot(fwd.x, fwd.y));
        logic::V3 target, cam;
        logic::orbitPoints(tuneView_, fwd.x / fl, fwd.y / fl, target, cam);
        CAMERA::SET_CAM_COORD(uiCam_, vp.x + cam.x, vp.y + cam.y, vp.z + cam.z);
        CAMERA::POINT_CAM_AT_COORD(uiCam_, vp.x + target.x, vp.y + target.y, vp.z + target.z);
    }

    // A row of a list: hover highlight, selection mark, text and a right-hand note.
    auto row = [&](float x, float y, float w, const std::string& text, const std::string& note, bool selected) {
        const bool hover = mouseX_ >= x && mouseX_ <= x + w && mouseY_ >= y && mouseY_ <= y + rowH - 0.002f;
        if (selected || hover) rect(x, y, w, rowH - 0.002f, selected ? withAlpha(theme::AccentSoft, 240) : theme::SurfaceHi);
        if (selected) rect(x, y + 0.006f, 0.003f, rowH - 0.014f, theme::Accent);
        label(text, x + 0.01f, y, 0.32f, selected ? theme::Accent : theme::Text, Align::Left, rowH);
        if (!note.empty()) label(note, x + w - 0.008f, y, 0.28f, theme::Muted, Align::Right, rowH);
        return hover && mouseClick_;
    };
    // Mouse wheel over a list scrolls it.
    auto wheel = [&](float x, float y, float w, float h) {
        if (mouseX_ < x || mouseX_ > x + w || mouseY_ < y || mouseY_ > y + h) return 0;
        if (PAD::IS_DISABLED_CONTROL_JUST_PRESSED(2, 241)) return -1;
        if (PAD::IS_DISABLED_CONTROL_JUST_PRESSED(2, 242)) return 1;
        return 0;
    };

    // Categories.
    panel(LX, LY, LW, LH, withAlpha(theme::Bg, 230));
    label("LOS SANTOS CUSTOMS", LX + 0.012f, LY + 0.012f, 0.42f, theme::Accent);
    label(vehicleName(veh), LX + 0.012f, LY + 0.048f, 0.3f, theme::Muted);
    const int cats = static_cast<int>(tuneCats_.size());
    tuneCatScroll_ = std::clamp(tuneCatScroll_ + wheel(LX, LY + 0.08f, LW, kVisibleRows * rowH), 0, std::max(0, cats - kVisibleRows));
    for (int i = tuneCatScroll_; i < std::min(cats, tuneCatScroll_ + kVisibleRows); ++i) {
        const float y = LY + 0.08f + (i - tuneCatScroll_) * rowH;
        if (row(LX + 0.006f, y, LW - 0.012f, tuneCats_[i].name, "", i == tuneCat_)) {
            tuneCat_ = i;
            tuneOptScroll_ = 0;
            // The camera turns to the part being chosen.
            const TuneCategory& c = tuneCats_[i];
            const int preset = c.kind == TuneKind::Mod || c.kind == TuneKind::Toggle ? logic::presetForMod(c.modType)
                               : c.kind == TuneKind::WheelType || c.kind == TuneKind::WheelColor ? logic::ViewWheels
                               : c.kind == TuneKind::Plate ? logic::ViewRear
                               : c.kind == TuneKind::Neon || c.kind == TuneKind::Tint ? logic::ViewSide
                                                                                        : logic::ViewOverview;
            setTuneView(preset);
        }
    }
    if (cats > kVisibleRows) label(std::to_string(tuneCatScroll_ + 1) + "-" + std::to_string(std::min(cats, tuneCatScroll_ + kVisibleRows)) +
                                       " из " + std::to_string(cats) + "  ·  колесо мыши",
                                   LX + 0.012f, LY + LH - 0.026f, 0.24f, theme::Muted);

    // Options of the selected category.
    tuneCat_ = std::clamp(tuneCat_, 0, std::max(0, cats - 1));
    const TuneCategory& cat = tuneCats_.empty() ? TuneCategory{} : tuneCats_[tuneCat_];
    panel(OX, LY, OW, LH, withAlpha(theme::Bg, 230));
    label(cat.name, OX + 0.012f, LY + 0.012f, 0.4f, theme::Text);
    bool changed = false;
    const float listY = LY + 0.08f;

    // A list of named options (index -1 .. count-1 for mods); returns nothing, changes `value`.
    auto optionList = [&](int first, int count, int& value, const std::function<std::string(int)>& name,
                          const std::function<int(int)>& price) {
        tuneOptScroll_ = std::clamp(tuneOptScroll_ + wheel(OX, listY, OW, kVisibleRows * rowH), 0, std::max(0, count - kVisibleRows));
        for (int i = tuneOptScroll_; i < std::min(count, tuneOptScroll_ + kVisibleRows); ++i) {
            const int option = first + i;
            const int cost = price(option);
            if (row(OX + 0.006f, listY + (i - tuneOptScroll_) * rowH, OW - 0.012f, name(option), cost > 0 ? money(cost) : "", value == option)) {
                value = option;
                changed = true;
            }
        }
    };
    // A palette of paint swatches.
    auto palette = [&](int& value, const char* field) {
        const float sw = (OW - 0.024f - 5 * 0.006f) / 6, shh = sw * aspect;
        for (int i = 0; i < static_cast<int>(std::size(kPaints)); ++i) {
            const float x = OX + 0.012f + (i % 6) * (sw + 0.006f), y = listY + (i / 6) * (shh + 0.008f);
            const bool sel = value == kPaints[i].index;
            const bool hover = mouseX_ >= x && mouseX_ <= x + sw && mouseY_ >= y && mouseY_ <= y + shh;
            frame(x, y, sw, shh, kPaints[i].rgb, sel ? theme::Accent : hover ? theme::Text : theme::SlotBorder);
            if (hover && mouseClick_) {
                value = kPaints[i].index;
                changed = true;
            }
        }
        const NamedColor* now = nullptr;
        for (const auto& p : kPaints)
            if (p.index == value) now = &p;
        const float ty = listY + 4 * (shh + 0.008f) + 0.006f;
        label(now ? now->name : "Цвет №" + std::to_string(value), OX + 0.012f, ty, 0.32f, theme::Text);
        label(money(logic::tuneFieldPrice(tunePrices_, field)), OX + OW - 0.012f, ty, 0.3f, theme::Muted, Align::Right);
    };

    switch (cat.kind) {
        case TuneKind::Mod: {
            int& value = tune_.mods[cat.modType];
            const int count = VEHICLE::GET_NUM_VEHICLE_MODS(veh, cat.modType);
            optionList(-1, count + 1, value, [&](int i) { return optionName(veh, cat.modType, i); },
                       [&](int i) { return logic::tuneModPrice(tunePrices_, cat.modType, i); });
            break;
        }
        case TuneKind::Toggle: {
            int& value = tune_.mods[cat.modType];
            optionList(-1, 2, value, [](int i) { return std::string(i < 0 ? "Нет" : "Установить"); },
                       [&](int i) { return logic::tuneModPrice(tunePrices_, cat.modType, i); });
            break;
        }
        case TuneKind::Primary: palette(tune_.primary, "primary"); break;
        case TuneKind::Secondary: palette(tune_.secondary, "secondary"); break;
        case TuneKind::Pearl: palette(tune_.pearl, "pearl"); break;
        case TuneKind::WheelColor: palette(tune_.wheelColor, "wheelColor"); break;
        case TuneKind::WheelType: {
            const int before = tune_.wheelType;
            optionList(0, static_cast<int>(std::size(kWheelTypes)), tune_.wheelType, [](int i) { return std::string(kWheelTypes[i]); },
                       [&](int) { return logic::tuneFieldPrice(tunePrices_, "wheelType"); });
            if (tune_.wheelType != before) tune_.mods[23] = -1;  // the wheels of another type
            break;
        }
        case TuneKind::Tint:
            optionList(0, static_cast<int>(std::size(kTints)), tune_.windowTint, [](int i) { return std::string(kTints[i]); },
                       [&](int) { return logic::tuneFieldPrice(tunePrices_, "windowTint"); });
            break;
        case TuneKind::Plate:
            optionList(0, static_cast<int>(std::size(kPlates)), tune_.plateType, [](int i) { return std::string(kPlates[i]); },
                       [&](int) { return logic::tuneFieldPrice(tunePrices_, "plateType"); });
            break;
        case TuneKind::Livery:
            optionList(0, VEHICLE::GET_VEHICLE_LIVERY_COUNT(veh), tune_.livery, [](int i) { return "Ливрея " + std::to_string(i + 1); },
                       [&](int) { return logic::tuneFieldPrice(tunePrices_, "livery"); });
            break;
        case TuneKind::Neon: {
            // Off, then the neon colours as round swatches.
            const float d = 0.05f, gap = 0.012f, dw = d / aspect;
            const int per = 5;
            for (int i = -1; i < static_cast<int>(std::size(kNeons)); ++i) {
                const int slot = i + 1;
                const float x = OX + 0.012f + (slot % per) * (dw + gap) + dw / 2, y = listY + (slot / per) * (d + gap) + d / 2;
                const bool sel = i < 0 ? !tune_.neonOn
                                       : tune_.neonOn && tune_.neonR == kNeons[i].r && tune_.neonG == kNeons[i].g && tune_.neonB == kNeons[i].b;
                const bool hover = std::hypot((mouseX_ - x) * aspect, mouseY_ - y) <= d / 2;
                if (sel || hover) circle(x, y, d + 0.008f, sel ? theme::Accent : theme::Text);
                circle(x, y, d, i < 0 ? theme::Surface : kNeons[i]);
                if (i < 0) label("нет", x, y - 0.012f, 0.26f, theme::Muted, Align::Center);
                if (hover && mouseClick_) {
                    tune_.neonOn = i >= 0;
                    if (i >= 0) tune_.neonR = kNeons[i].r, tune_.neonG = kNeons[i].g, tune_.neonB = kNeons[i].b;
                    changed = true;
                }
            }
            label("Неон " + money(logic::tuneFieldPrice(tunePrices_, "neon")), OX + 0.012f, listY + 3 * (d + gap), 0.3f, theme::Muted);
            break;
        }
    }
    if (changed) previewTuning(veh, tune_);

    // The order: total, payment, buttons.
    panel(LX, BY, BW, BH, withAlpha(theme::Bg, 230));
    const int total = tuningPrice();
    label("Итого", LX + 0.012f, BY + 0.01f, 0.34f, theme::Muted);
    label(money(total), LX + BW - 0.012f, BY + 0.004f, 0.52f, total > 0 ? theme::Positive : theme::Muted, Align::Right);
    const Value* cash = props::shared(selfShared_, "cash");
    const Value* bank = props::shared(selfShared_, "bank");
    const float pw = (BW - 0.032f) / 2, py = BY + 0.045f;
    if (uiButton(LX + 0.012f, py, pw, 0.032f, "Наличные " + money(cash ? cash->asInt() : 0), !payByCard_)) payByCard_ = false;
    if (uiButton(LX + 0.02f + pw, py, pw, 0.032f, "Карта " + money(bank ? bank->asInt() : 0), payByCard_)) payByCard_ = true;
    const float bw = (BW - 0.04f) / 3, by = BY + 0.087f;
    if (uiButton(LX + 0.012f, by, bw, 0.034f, "Купить", true, total > 0)) {
        send(ScriptEvent{"gomp:tune:buy", {Value::integer(tuneVehicle_), tuningOrder(), Value::string(payByCard_ ? "bank" : "cash")}});
        tuneBought_ = true;
        closeScreens();
        return;
    }
    if (uiButton(LX + 0.02f + bw, by, bw, 0.034f, "Сбросить")) {
        tune_ = tuneOrig_;
        previewTuning(veh, tune_);
    }
    if (uiButton(LX + 0.028f + bw * 2, by, bw, 0.034f, "Выйти")) {
        closeScreens();
        return;
    }
    // Inspection toolbar: views and doors.
    static const std::pair<const char*, int> kViews[] = {{"Обзор", logic::ViewOverview}, {"Перед", logic::ViewFront},
                                                         {"Зад", logic::ViewRear},          {"Бок", logic::ViewSide},
                                                         {"Колёса", logic::ViewWheels},     {"Салон", logic::ViewCabin},
                                                         {"Сверху", logic::ViewTop}};
    static const std::pair<const char*, int> kDoors[] = {{"Капот", 4}, {"Багажник", 5}, {"Двери", 0}};
    const float tw = 0.062f, th = 0.034f, tg = 0.005f;
    const int tools = static_cast<int>(std::size(kViews) + std::size(kDoors));
    float tx = 0.5f - (tools * tw + (tools - 1) * tg + 0.012f) / 2;
    for (const auto& [name, preset] : kViews) {
        if (uiButton(tx, toolY, tw, th, name)) setTuneView(preset);
        tx += tw + tg;
    }
    tx += 0.012f;
    for (const auto& [name, door] : kDoors) {
        if (uiButton(tx, toolY, tw, th, name, tuneDoors_[door])) toggleTuneDoor(door);
        tx += tw + tg;
    }
    label("Мышь — осмотреть со всех сторон  ·  колесо — ближе/дальше  ·  Esc — выйти", 0.5f, toolY + th + 0.01f, 0.27f, theme::Text, Align::Center);
}

// ------------------------------------------------------------------ workshop: in and out

// At the door: fade out, then tickTuningTransition moves the vehicle into the bay.
void GameClient::enterTuning(uint16_t id, const Place& shop) {
    const Vehicle veh = vehicleHandle(id);
    if (!veh || tuneStage_ != 0) return;
    const Vector3 p = ENTITY::GET_ENTITY_COORDS(veh, true);
    tuneReturnPos_ = {p.x, p.y, p.z};
    tuneReturnHeading_ = ENTITY::GET_ENTITY_HEADING(veh);
    tuneBay_ = shop.bay;
    tuneBayHeading_ = shop.bayHeading;
    tuneEnterVehicle_ = id;
    tuneStage_ = 1;
    tuneStageAt_ = GetTickCount();
    CAMERA::DO_SCREEN_FADE_OUT(400);
}

void GameClient::tickTuningTransition() {
    if (tuneStage_ == 0 || tuneStage_ == 3) return;
    PAD::DISABLE_ALL_CONTROL_ACTIONS(0);  // no driving while the screen is dark
    const DWORD now = GetTickCount();
    const Vehicle veh = vehicleHandle(tuneEnterVehicle_);
    if (!veh) {  // the vehicle is gone: back to the game
        tuneStage_ = 0;
        CAMERA::DO_SCREEN_FADE_IN(300);
        return;
    }
    if (tuneStage_ == 1) {
        if (!CAMERA::IS_SCREEN_FADED_OUT() && now - tuneStageAt_ < 2000) return;
        // Into the bay: the interior is pinned in memory so its walls and lights are there.
        tuneInterior_ = INTERIOR::GET_INTERIOR_AT_COORDS(tuneBay_.x, tuneBay_.y, tuneBay_.z);
        if (tuneInterior_) INTERIOR::PIN_INTERIOR_IN_MEMORY(tuneInterior_);
        STREAMING::REQUEST_COLLISION_AT_COORD(tuneBay_.x, tuneBay_.y, tuneBay_.z);
        ENTITY::SET_ENTITY_VELOCITY(veh, 0, 0, 0);
        ENTITY::SET_ENTITY_COORDS(veh, tuneBay_.x, tuneBay_.y, tuneBay_.z + 0.3f, false, false, false, false);
        ENTITY::SET_ENTITY_HEADING(veh, tuneBayHeading_);
        ENTITY::FREEZE_ENTITY_POSITION(veh, true);
        tuneStage_ = 2;
        tuneStageAt_ = now;
        return;
    }
    if (tuneStage_ == 2) {
        const bool ready = !tuneInterior_ || INTERIOR::IS_INTERIOR_READY(tuneInterior_);
        if ((!ready || now - tuneStageAt_ < 400) && now - tuneStageAt_ < 5000) return;
        ENTITY::FREEZE_ENTITY_POSITION(veh, false);
        VEHICLE::SET_VEHICLE_ON_GROUND_PROPERLY(veh, 5.0f);
        tuneStage_ = 3;
        openTuning(tuneEnterVehicle_);  // freezes it again
        CAMERA::DO_SCREEN_FADE_IN(500);
        return;
    }
    if (tuneStage_ == 4) {
        if (!CAMERA::IS_SCREEN_FADED_OUT() && now - tuneStageAt_ < 2000) return;
        // Back where the vehicle came from, facing away from the workshop.
        ENTITY::FREEZE_ENTITY_POSITION(veh, false);
        STREAMING::REQUEST_COLLISION_AT_COORD(tuneReturnPos_.x, tuneReturnPos_.y, tuneReturnPos_.z);
        ENTITY::SET_ENTITY_COORDS(veh, tuneReturnPos_.x, tuneReturnPos_.y, tuneReturnPos_.z + 0.3f, false, false, false, false);
        ENTITY::SET_ENTITY_HEADING(veh, std::fmod(tuneReturnHeading_ + 180.0f, 360.0f));
        VEHICLE::SET_VEHICLE_ON_GROUND_PROPERLY(veh, 5.0f);
        if (tuneInterior_) INTERIOR::UNPIN_INTERIOR(tuneInterior_);
        tuneInterior_ = 0;
        tuneStage_ = 0;
        CAMERA::DO_SCREEN_FADE_IN(500);
    }
}

// Turns the camera to a view; the bonnet or the boot opens for the engine and the boot views.
void GameClient::setTuneView(int preset) {
    tuneViewGoal_ = logic::tunePreset(preset);
    const bool engine = preset == logic::ViewEngine, trunk = preset == logic::ViewTrunk;
    if (engine != tuneDoors_[4]) toggleTuneDoor(4);
    if (trunk != tuneDoors_[5]) toggleTuneDoor(5);
}

// Opens or shuts a door of the vehicle on this client (0: all four doors, 4 bonnet, 5 boot).
void GameClient::toggleTuneDoor(int door) {
    const Vehicle veh = vehicleHandle(tuneVehicle_);
    if (!veh) return;
    tuneDoors_[door] = !tuneDoors_[door];
    const int from = door == 0 ? 0 : door, to = door == 0 ? 3 : door;
    for (int d = from; d <= to; ++d) {
        if (tuneDoors_[door]) VEHICLE::SET_VEHICLE_DOOR_OPEN(veh, d, false, false);
        else VEHICLE::SET_VEHICLE_DOOR_SHUT(veh, d, false);
    }
}

}  // namespace gompgame
