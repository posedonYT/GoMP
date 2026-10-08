// The phone: the up arrow takes it out (with a phone in the inventory). A home
// screen with the clock and apps: contacts, messages, the bank (balance,
// transfers, the statement), the house and its garage, map routes and settings
// (wallpaper, sounds). The server keeps the number, contacts, messages and money
// (server-files/packages/freeroam/phone.js); the phone asks for them when opened.
#include <cmath>
#include <cstring>
#include <ctime>
#include <unordered_map>

#include "game_client.hpp"
#include "natives.hpp"
#include "ui.hpp"

namespace gompgame {

using namespace gomp;
using namespace ui;

namespace {

constexpr float kPhoneH = 0.64f;   // screen fractions
constexpr float kAspect = 0.47f;   // width : height of the body
constexpr DWORD kSlideMs = 220;
constexpr DWORD kConfirmMs = 4000;

constexpr Rgba kBezel{10, 10, 12, 255};
constexpr Rgba kAppBg{16, 17, 19, 255};
constexpr Rgba kCard{30, 32, 35, 255};
constexpr Rgba kCardHi{44, 47, 50, 255};
constexpr Rgba kLine{40, 42, 45, 255};

struct Wallpaper {
    const char* name;
    Rgba base, glow1, glow2;
};
constexpr Wallpaper kWallpapers[] = {
    {"Лагуна", {12, 46, 54, 255}, {32, 184, 205, 90}, {20, 90, 160, 80}},
    {"Ночь", {20, 22, 46, 255}, {90, 80, 220, 90}, {200, 60, 160, 70}},
    {"Аметист", {46, 20, 60, 255}, {230, 90, 160, 80}, {120, 70, 230, 80}},
    {"Графит", {26, 27, 29, 255}, {120, 124, 130, 60}, {70, 74, 80, 70}},
    {"Лес", {14, 44, 30, 255}, {60, 200, 120, 70}, {200, 220, 90, 50}},
    {"Закат", {60, 18, 26, 255}, {240, 90, 70, 80}, {250, 170, 60, 60}},
};
constexpr int kWallpaperCount = sizeof(kWallpapers) / sizeof(kWallpapers[0]);

constexpr Rgba kAvatarColors[] = {{52, 199, 89, 255}, {10, 132, 255, 255}, {255, 159, 10, 255},
                                  {191, 90, 242, 255}, {255, 69, 58, 255}, {32, 184, 205, 255}};

const char* const kWeekdays[] = {"Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"};
const char* const kMonths[] = {"января", "февраля", "марта", "апреля", "мая", "июня",
                               "июля", "августа", "сентября", "октября", "ноября", "декабря"};

std::string two(int v) { return (v < 10 ? "0" : "") + std::to_string(v); }

// Server time (ms since 1970) as "14:05", or "09.10" for another day.
std::string stamp(long long ms) {
    const std::time_t t = static_cast<std::time_t>(ms / 1000), now = std::time(nullptr);
    std::tm tm{}, today{};
    localtime_s(&tm, &t);
    localtime_s(&today, &now);
    if (tm.tm_yday == today.tm_yday && tm.tm_year == today.tm_year) return two(tm.tm_hour) + ":" + two(tm.tm_min);
    return two(tm.tm_mday) + "." + two(tm.tm_mon + 1);
}

// Cuts text to a width, ending with "...". Measures at most twice.
std::string fit(const std::string& s, float scale, float maxW) {
    const float w = textWidth(s, scale);
    if (w <= maxW || s.empty()) return s;
    std::size_t keep = static_cast<std::size_t>(s.size() * std::max(0.0f, maxW - textWidth("...", scale)) / w);
    while (keep > 0 && keep < s.size() && !isLeadByte(static_cast<unsigned char>(s[keep]))) --keep;
    return s.substr(0, keep) + "...";
}

// Message text split into lines of a width (cached: measuring is a native call per word).
const std::vector<std::string>& wrap(const std::string& text, float scale, float maxW) {
    static std::unordered_map<std::string, std::vector<std::string>> cache;
    if (cache.size() > 400) cache.clear();
    const std::string key = std::to_string(static_cast<int>(maxW * 10000)) + "|" + text;
    auto it = cache.find(key);
    if (it != cache.end()) return it->second;
    std::vector<std::string> lines;
    std::string line, word;
    auto flush = [&]() {
        if (word.empty()) return;
        const std::string tryLine = line.empty() ? word : line + " " + word;
        if (line.empty() || textWidth(tryLine, scale) <= maxW) {
            line = tryLine;
        } else {
            lines.push_back(line);
            line = word;
        }
        // A word longer than the line is cut.
        while (textWidth(line, scale) > maxW && line.size() > 1) {
            std::string head = fit(line, scale, maxW);
            head.resize(head.size() - 3);
            if (head.empty()) break;
            lines.push_back(head);
            line = line.substr(head.size());
        }
        word.clear();
    };
    for (char c : text) {
        if (c == ' ') flush();
        else word += c;
    }
    flush();
    if (!line.empty()) lines.push_back(line);
    if (lines.empty()) lines.push_back("");
    return cache.emplace(key, std::move(lines)).first->second;
}

float dist2d(Vector3 a, Vec3 b) { return std::hypot(a.x - b.x, a.y - b.y); }

std::string distance(float m) {
    if (m < 1000) return std::to_string(static_cast<int>(m)) + " м";
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.1f км", m / 1000);
    return buf;
}

}  // namespace

// ------------------------------------------------------------------ data

bool GameClient::handlePhoneEvent(const ScriptEvent& e) {
    const auto& a = e.args;
    if (e.name == "gomp:phone:data") {
        if (a.empty() || a[0].kind != Value::Kind::Map) return true;
        const Value& m = a[0];
        phoneNumber_ = props::fieldStr(m, "number");
        contacts_.clear();
        if (const Value* c = props::field(m, "contacts"); c && c->kind == Value::Kind::Array)
            for (const Value& v : c->arr) contacts_.push_back({props::fieldStr(v, "name"), props::fieldStr(v, "number")});
        sms_.clear();
        if (const Value* s = props::field(m, "sms"); s && s->kind == Value::Kind::Array)
            for (const Value& v : s->arr)
                sms_.push_back({props::fieldStr(v, "n"), props::fieldStr(v, "t"), props::fieldNum(v, "o") != 0, props::fieldNum(v, "r") != 0,
                                props::fieldInt(v, "at")});
        bankLog_.clear();
        if (const Value* b = props::field(m, "bankLog"); b && b->kind == Value::Kind::Array)
            for (const Value& v : b->arr) bankLog_.push_back({props::fieldInt(v, "at"), props::fieldInt(v, "sum"), props::fieldStr(v, "text")});
        // The open conversation is read.
        if (screen_ == Screen::Phone && phoneApp_ == PhoneApp::Thread)
            for (auto& s : sms_)
                if (s.number == phoneThread_) s.read = true;
        return true;
    }
    if (e.name == "gomp:phone:sms") {
        if (a.empty() || a[0].kind != Value::Kind::Map) return true;
        const std::string from = props::fieldStr(a[0], "from");
        if (screen_ == Screen::Phone && phoneApp_ == PhoneApp::Thread && phoneThread_ == from) {
            send(ScriptEvent{"gomp:phone:read", {Value::string(from)}});
        } else {
            notify("SMS от " + props::fieldStr(a[0], "name") + ": " + props::fieldStr(a[0], "text"));
        }
        if (settings_.phoneSound) AUDIO::PLAY_SOUND_FRONTEND(-1, "Text_Arrive_Tone", "Phone_SoundSet_Default", true);
        return true;
    }
    if (e.name == "gomp:phone:show") {
        openPhone();
        return true;
    }
    return false;
}

std::string GameClient::contactName(const std::string& number) const {
    for (const auto& c : contacts_)
        if (c.number == number) return c.name;
    return number;
}

int GameClient::unreadSms() const {
    int n = 0;
    for (const auto& s : sms_) n += !s.out && !s.read;
    return n;
}

// ------------------------------------------------------------------ open and close

void GameClient::tickPhone() {
    if (phoneRequested_.exchange(false) && screen_ == Screen::None) openPhone();
}

void GameClient::openPhone() {
    if (!spawned_ || dead_ || lobbyScreen()) return;
    if (itemCount("phone") <= 0) {
        notify("У вас нет телефона: его продают в магазинах 24/7");
        return;
    }
    if (screen_ == Screen::Inventory) closeScreens();  // used from the inventory
    if (screen_ != Screen::None) return;
    // Forms do not survive closing the phone.
    if (phoneApp_ == PhoneApp::ContactEdit || phoneApp_ == PhoneApp::Transfer || phoneApp_ == PhoneApp::NewMessage) {
        phoneApp_ = PhoneApp::Home;
        phoneBack_.clear();
    }
    phoneOpenedAt_ = GetTickCount();
    send(ScriptEvent{"gomp:phone:open", {}});
    openScreen(Screen::Phone);
    if (phoneApp_ == PhoneApp::House)
        if (const House* h = myHouse()) send(ScriptEvent{"gomp:house:info", {Value::integer(h->id)}});
    const Ped me = PLAYER::PLAYER_PED_ID();
    if (!PED::IS_PED_IN_ANY_VEHICLE(me, false) && !WEAPON::IS_PED_ARMED(me, 7)) {
        TASK::TASK_USE_MOBILE_PHONE(me, true, 0);
        phoneTask_ = true;
    }
    if (settings_.phoneSound) AUDIO::PLAY_SOUND_FRONTEND(-1, "Pull_Out", "Phone_SoundSet_Default", true);
}

// Called by closeScreens().
void GameClient::closePhone() {
    if (phoneTask_) TASK::TASK_USE_MOBILE_PHONE(PLAYER::PLAYER_PED_ID(), false, 0);
    phoneTask_ = false;
    phoneClosedAt_ = GetTickCount();
    if (settings_.phoneSound) AUDIO::PLAY_SOUND_FRONTEND(-1, "Put_Away", "Phone_SoundSet_Default", true);
}

void GameClient::phoneGo(PhoneApp app) {
    if (app == PhoneApp::Home) phoneBack_.clear();
    else phoneBack_.push_back(phoneApp_);
    phoneApp_ = app;
    phoneScroll_ = 0;
    phoneConfirmAt_ = 0;
    focus_ = nullptr;
    if (app == PhoneApp::Thread) {
        bool unread = false;
        for (auto& s : sms_)
            if (s.number == phoneThread_ && !s.read) s.read = unread = true;
        if (unread) send(ScriptEvent{"gomp:phone:read", {Value::string(phoneThread_)}});
    }
    if (app == PhoneApp::House)
        if (const House* h = myHouse()) send(ScriptEvent{"gomp:house:info", {Value::integer(h->id)}});
}

// ------------------------------------------------------------------ drawing

void GameClient::drawPhone(bool submit) {
    int sw, sh;
    screenSize(sw, sh);
    const float px = 1.0f / sw, py = 1.0f / sh;

    // The body slides up from the bottom right corner.
    const float H = kPhoneH, W = H * kAspect * sh / sw;
    const float t = std::min(1.0f, static_cast<float>(GetTickCount() - phoneOpenedAt_) / kSlideMs);
    const float ease = 1 - (1 - t) * (1 - t) * (1 - t);
    const float X = 0.985f - W, Y = 1.02f + ((1.0f - H - 0.03f) - 1.02f) * ease;
    softRect(X, Y, W, H, kBezel, 40);
    const float SX = X + 7 * px, SY = Y + 7 * py, SW = W - 14 * px, SH = H - 14 * py;
    const bool home = phoneApp_ == PhoneApp::Home;
    const Wallpaper& wp = kWallpapers[std::clamp(settings_.phoneWallpaper, 0, kWallpaperCount - 1)];
    softRect(SX, SY, SW, SH, home ? wp.base : kAppBg, 34);
    auto toY = [&](float xUnits) { return xUnits * sw / sh; };  // a width as a height
    if (home) {
        circle(SX + SW * 0.36f, SY + SH * 0.3f, toY(SW * 0.62f), wp.glow1);
        circle(SX + SW * 0.66f, SY + SH * 0.66f, toY(SW * 0.6f), wp.glow2);
    }
    auto inRect = [&](float x, float y, float w, float h) { return mouseX_ >= x && mouseX_ <= x + w && mouseY_ >= y && mouseY_ <= y + h; };
    auto clicked = [&](float x, float y, float w, float h) { return mouseClick_ && inRect(x, y, w, h); };

    // Status bar: the game clock, the network and the battery.
    const int hh = CLOCK::GET_CLOCK_HOURS(), mm = CLOCK::GET_CLOCK_MINUTES();
    const float stY = SY + 8 * py, stH = 0.022f;
    label(two(hh) + ":" + two(mm), SX + 22 * px, stY, 0.3f, theme::Text, Align::Left, stH);
    {
        float bx = SX + SW - 22 * px - 22 * px;
        frame(bx, stY + stH / 2 - 5 * py, 20 * px, 10 * py, withAlpha(theme::Text, 0), withAlpha(theme::Text, 200));
        rect(bx + 2 * px, stY + stH / 2 - 3 * py, 14 * px, 6 * py, theme::Text);
        rect(bx + 20 * px, stY + stH / 2 - 2 * py, 2 * px, 4 * py, withAlpha(theme::Text, 200));
        bx -= 8 * px;
        for (int i = 3; i >= 0; --i) {
            const float bh = (3 + 2.5f * i) * py;
            bx -= 4 * px;
            rect(bx, stY + stH / 2 + 5 * py - bh, 3 * px, bh, theme::Text);
        }
        label("GoMP", bx - 4 * px, stY, 0.26f, theme::Text, Align::Right, stH);
    }

    // Header of an app: back, the title and an optional action on the right.
    const float CY0 = SY + 0.072f, CY1 = SY + SH - 0.028f;
    const float CX = SX + 14 * px, CW = SW - 28 * px;
    auto back = [&]() {
        focus_ = nullptr;
        phoneConfirmAt_ = 0;
        phoneScroll_ = 0;
        if (phoneBack_.empty()) {
            phoneApp_ = PhoneApp::Home;
        } else {
            phoneApp_ = phoneBack_.back();
            phoneBack_.pop_back();
        }
    };
    auto header = [&](const std::string& title, const char* action = nullptr) {
        const float hy = SY + 0.03f, hh2 = 0.036f;
        const bool hover = inRect(SX, hy, 0.05f, hh2);
        label("< Назад", CX, hy, 0.3f, hover ? theme::AccentHi : theme::Accent, Align::Left, hh2);
        if (hover && mouseClick_) back();
        label(fit(title, 0.36f, SW * 0.5f), SX + SW / 2, hy, 0.36f, theme::Text, Align::Center, hh2);
        bool act = false;
        if (action) {
            const bool ah = inRect(SX + SW - 0.04f, hy, 0.04f, hh2);
            label(action, CX + CW, hy, 0.44f, ah ? theme::AccentHi : theme::Accent, Align::Right, hh2);
            act = ah && mouseClick_;
        }
        return act;
    };
    // Buttons and fields in the phone's style.
    auto button = [&](float x, float y, float w, float h, const std::string& text, bool primary = false, bool enabled = true) {
        const bool hover = enabled && inRect(x, y, w, h);
        const Rgba bg = !enabled ? kCard : primary ? (hover ? theme::AccentHi : theme::Accent) : (hover ? kCardHi : kCard);
        roundRect(x, y, w, h, bg, 10);
        label(text, x + w / 2, y, 0.32f, !enabled ? theme::Muted : primary ? theme::OnAccent : theme::Text, Align::Center, h);
        return hover && mouseClick_;
    };
    auto field = [&](float x, float y, float w, const std::string& caption, std::string& value, const std::string& placeholder) {
        float fy = y;
        if (!caption.empty()) {
            label(caption, x, y, 0.26f, theme::Muted);
            fy += 0.022f;
        }
        const float fh = 0.034f;
        const bool focused = focus_ == &value;
        roundRect(x, fy, w, fh, focused ? kCardHi : kCard, 10);
        std::string shown = value.empty() && !focused ? placeholder : value;
        // The end of a long text stays visible while typing.
        if (textWidth(shown, 0.3f) > w - 0.02f) {
            std::size_t cut = 0;
            while (cut < shown.size() && textWidth(shown.substr(cut), 0.3f) > w - 0.02f) {
                cut += 4;
                while (cut < shown.size() && !isLeadByte(static_cast<unsigned char>(shown[cut]))) ++cut;
            }
            shown = shown.substr(std::min(cut, shown.size()));
        }
        if (focused && (GetTickCount() / 500) % 2 == 0) shown += "|";
        label(shown, x + 0.008f, fy, 0.3f, value.empty() && !focused ? theme::Muted : theme::Text, Align::Left, fh);
        if (mouseClick_ && inRect(x, fy, w, fh)) focus_ = &value;
        focusDrawn_.push_back(&value);
        return fy + fh;
    };
    auto avatar = [&](float cx, float cy, float d, const std::string& name) {
        std::size_t hsh = 0;
        for (char c : name) hsh = hsh * 31 + static_cast<unsigned char>(c);
        circle(cx, cy, d, kAvatarColors[hsh % 6]);
        label(logic::firstLetter(name), cx, cy - d / 2, d * 9.0f, theme::Text, Align::Center, d);
    };
    // Mouse wheel over the content scrolls it (rows).
    auto wheel = [&](int rows, int visible) {
        if (inRect(SX, CY0, SW, CY1 - CY0)) {
            if (PAD::IS_DISABLED_CONTROL_JUST_PRESSED(2, 241)) --phoneScroll_;
            if (PAD::IS_DISABLED_CONTROL_JUST_PRESSED(2, 242)) ++phoneScroll_;
        }
        phoneScroll_ = std::clamp(phoneScroll_, 0, std::max(0, rows - visible));
    };
    auto separator = [&](float y) { rect(CX + 0.04f, y, CW - 0.04f, py, kLine); };
    const Value* cashV = props::shared(selfShared_, "cash");
    const Value* bankV = props::shared(selfShared_, "bank");
    const long long cash = cashV ? cashV->asInt() : 0, bank = bankV ? bankV->asInt() : 0;

    switch (phoneApp_) {
        case PhoneApp::Home: {
            // The clock and the date of the game world.
            label(two(hh) + ":" + two(mm), SX + SW / 2, SY + 0.045f, 1.15f, theme::Text, Align::Center);
            const int dow = std::clamp(CLOCK::GET_CLOCK_DAY_OF_WEEK(), 0, 6), month = std::clamp(CLOCK::GET_CLOCK_MONTH(), 0, 11);
            label(std::string(kWeekdays[dow]) + ", " + std::to_string(CLOCK::GET_CLOCK_DAY_OF_MONTH()) + " " + kMonths[month], SX + SW / 2,
                  SY + 0.122f, 0.32f, withAlpha(theme::Text, 220), Align::Center);
            struct AppIcon {
                PhoneApp app;
                const char* name;
                const char* icon;
                Rgba color;
            };
            static const AppIcon apps[] = {
                {PhoneApp::Contacts, "Контакты", "app_contacts", {52, 199, 89, 255}},
                {PhoneApp::Messages, "Сообщения", "app_messages", {10, 132, 255, 255}},
                {PhoneApp::Bank, "Банк", "app_bank", {255, 159, 10, 255}},
                {PhoneApp::House, "Дом", "app_house", {32, 184, 205, 255}},
                {PhoneApp::Gps, "Карта", "app_gps", {255, 69, 58, 255}},
                {PhoneApp::Settings, "Настройки", "app_settings", {120, 124, 130, 255}},
            };
            const float iw = SW * 0.22f, ih = toY(iw), gapX = (SW - 3 * iw) / 4, rowH = ih + 0.036f;
            const int unread = unreadSms();
            for (int i = 0; i < 6; ++i) {
                const float x = SX + gapX + (i % 3) * (iw + gapX), y = SY + 0.19f + (i / 3) * rowH;
                const bool hover = inRect(x, y, iw, ih);
                softRect(x, y, iw, ih, hover ? Rgba{std::min(255, apps[i].color.r + 25), std::min(255, apps[i].color.g + 25),
                                                    std::min(255, apps[i].color.b + 25), 255}
                                             : apps[i].color,
                         16);
                drawIcon(apps[i].icon, x + iw * 0.2f, y + ih * 0.2f, iw * 0.6f, ih * 0.6f, theme::Text);
                label(apps[i].name, x + iw / 2, y + ih + 0.004f, 0.25f, theme::Text, Align::Center);
                if (apps[i].app == PhoneApp::Messages && unread > 0) {
                    const float d = 0.024f;
                    circle(x + iw - 2 * px, y + 2 * py, d, theme::Negative);
                    label(std::to_string(std::min(unread, 99)), x + iw - 2 * px, y + 2 * py - d / 2, 0.24f, theme::Text, Align::Center, d);
                }
                if (hover && mouseClick_) phoneGo(apps[i].app);
            }
            // The number at the bottom.
            if (!phoneNumber_.empty())
                label("Мой номер: " + phoneNumber_, SX + SW / 2, CY1 - 0.03f, 0.26f, withAlpha(theme::Text, 200), Align::Center);
            break;
        }

        case PhoneApp::Contacts: {
            if (header("Контакты", "+")) {
                phoneField1_.clear();
                phoneField2_.clear();
                phoneThread_.clear();
                phoneGo(PhoneApp::ContactEdit);
                break;
            }
            const float rowH = 0.048f;
            const int visible = static_cast<int>((CY1 - CY0) / rowH);
            wheel(static_cast<int>(contacts_.size()), visible);
            if (contacts_.empty()) {
                label("Контактов пока нет", SX + SW / 2, CY0 + 0.05f, 0.34f, theme::Muted, Align::Center);
                label("Нажмите +, чтобы добавить", SX + SW / 2, CY0 + 0.08f, 0.28f, theme::Muted, Align::Center);
            }
            for (int i = phoneScroll_; i < std::min<int>(contacts_.size(), phoneScroll_ + visible); ++i) {
                const auto& c = contacts_[i];
                const float y = CY0 + (i - phoneScroll_) * rowH;
                if (inRect(SX, y, SW, rowH)) rect(SX, y, SW, rowH, kCard);
                avatar(CX + 0.016f, y + rowH / 2, 0.034f, c.name);
                label(fit(c.name, 0.33f, CW - 0.05f), CX + 0.036f, y + 0.005f, 0.33f, theme::Text);
                label(c.number, CX + 0.036f, y + 0.026f, 0.26f, theme::Muted);
                separator(y + rowH - py);
                if (clicked(SX, y, SW, rowH)) {
                    phoneThread_ = c.number;
                    phoneGo(PhoneApp::Contact);
                }
            }
            break;
        }

        case PhoneApp::Contact: {
            const std::string name = contactName(phoneThread_);
            header("");
            avatar(SX + SW / 2, CY0 + 0.055f, 0.09f, name);
            label(fit(name, 0.5f, CW), SX + SW / 2, CY0 + 0.108f, 0.5f, theme::Text, Align::Center);
            label(phoneThread_, SX + SW / 2, CY0 + 0.146f, 0.32f, theme::Muted, Align::Center);
            float y = CY0 + 0.19f;
            const float bh = 0.04f;
            if (button(CX, y, CW, bh, "Написать сообщение", true)) phoneGo(PhoneApp::Thread);
            y += bh + 0.01f;
            if (button(CX, y, CW, bh, "Перевести деньги")) {
                phoneField1_ = phoneThread_;
                phoneField2_.clear();
                phoneGo(PhoneApp::Transfer);
            }
            y += bh + 0.01f;
            if (button(CX, y, CW, bh, "Изменить")) {
                phoneField1_ = name;
                phoneField2_ = phoneThread_;
                phoneGo(PhoneApp::ContactEdit);
            }
            y += bh + 0.01f;
            const bool sure = phoneConfirmAt_ && GetTickCount() - phoneConfirmAt_ < kConfirmMs;
            if (button(CX, y, CW, bh, sure ? "Точно удалить?" : "Удалить контакт")) {
                if (sure) {
                    send(ScriptEvent{"gomp:phone:uncontact", {Value::string(phoneThread_)}});
                    back();
                } else {
                    phoneConfirmAt_ = GetTickCount();
                }
            }
            break;
        }

        case PhoneApp::ContactEdit: {
            header(phoneThread_.empty() ? "Новый контакт" : "Изменить");
            float y = CY0 + 0.01f;
            y = field(CX, y, CW, "Имя", phoneField1_, "Например, Иван") + 0.012f;
            y = field(CX, y, CW, "Номер", phoneField2_, "123-4567") + 0.02f;
            const std::string number = logic::phoneNumber(phoneField2_);
            const bool ok = !phoneField1_.empty() && logic::validPhoneNumber(number);
            if (button(CX, y, CW, 0.042f, "Сохранить", true, ok) || (submit && ok)) {
                send(ScriptEvent{"gomp:phone:contact", {Value::string(phoneField1_), Value::string(number)}});
                phoneThread_ = number;
                back();
            }
            if (!phoneField2_.empty() && !logic::validPhoneNumber(number))
                label("Номер из 7 цифр: 123-4567", SX + SW / 2, y + 0.05f, 0.26f, theme::Muted, Align::Center);
            break;
        }

        case PhoneApp::Messages: {
            if (header("Сообщения", "+")) {
                phoneField2_.clear();
                phoneGo(PhoneApp::NewMessage);
                break;
            }
            // Conversations, the latest first.
            std::vector<const PhoneSms*> last;
            for (std::size_t i : logic::conversations(sms_)) last.push_back(&sms_[i]);
            const float rowH = 0.054f;
            const int visible = static_cast<int>((CY1 - CY0) / rowH);
            wheel(static_cast<int>(last.size()), visible);
            if (last.empty()) label("Сообщений пока нет", SX + SW / 2, CY0 + 0.05f, 0.34f, theme::Muted, Align::Center);
            for (int i = phoneScroll_; i < std::min<int>(last.size(), phoneScroll_ + visible); ++i) {
                const PhoneSms& s = *last[i];
                const float y = CY0 + (i - phoneScroll_) * rowH;
                bool unread = false;
                for (const auto& m : sms_) unread = unread || (m.number == s.number && !m.out && !m.read);
                if (inRect(SX, y, SW, rowH)) rect(SX, y, SW, rowH, kCard);
                const std::string name = contactName(s.number);
                avatar(CX + 0.016f, y + rowH / 2, 0.036f, name);
                const std::string when = stamp(s.at);
                label(when, CX + CW, y + 0.006f, 0.24f, theme::Muted, Align::Right);
                label(fit(name, 0.33f, CW - 0.07f - textWidth(when, 0.24f)), CX + 0.038f, y + 0.005f, 0.33f, theme::Text);
                label(fit((s.out ? "Вы: " : "") + s.text, 0.27f, CW - 0.06f), CX + 0.038f, y + 0.028f, 0.27f, unread ? theme::Text : theme::Muted);
                if (unread) circle(CX + CW - 0.006f, y + 0.036f, 0.012f, theme::Accent);
                separator(y + rowH - py);
                if (clicked(SX, y, SW, rowH)) {
                    phoneThread_ = s.number;
                    phoneGo(PhoneApp::Thread);
                }
            }
            break;
        }

        case PhoneApp::NewMessage: {
            header("Новое сообщение");
            float y = field(CX, CY0 + 0.01f, CW, "Кому", phoneField2_, "Номер: 123-4567") + 0.012f;
            const std::string number = logic::phoneNumber(phoneField2_);
            if (button(CX, y, CW, 0.04f, "Написать", true, logic::validPhoneNumber(number)) || (submit && logic::validPhoneNumber(number))) {
                phoneThread_ = number;
                phoneApp_ = PhoneApp::Messages;  // back from the conversation goes to the list
                if (!phoneBack_.empty()) phoneBack_.pop_back();
                phoneGo(PhoneApp::Thread);
                break;
            }
            y += 0.054f;
            if (!contacts_.empty()) label("Контакты", CX, y, 0.26f, theme::Muted);
            y += 0.024f;
            const float rowH = 0.04f;
            for (std::size_t i = 0; i < contacts_.size() && y + rowH <= CY1; ++i, y += rowH) {
                if (inRect(SX, y, SW, rowH)) rect(SX, y, SW, rowH, kCard);
                avatar(CX + 0.014f, y + rowH / 2, 0.028f, contacts_[i].name);
                label(fit(contacts_[i].name, 0.3f, CW * 0.55f), CX + 0.032f, y, 0.3f, theme::Text, Align::Left, rowH);
                label(contacts_[i].number, CX + CW, y, 0.26f, theme::Muted, Align::Right, rowH);
                if (clicked(SX, y, SW, rowH)) {
                    phoneThread_ = contacts_[i].number;
                    phoneApp_ = PhoneApp::Messages;
                    if (!phoneBack_.empty()) phoneBack_.pop_back();
                    phoneGo(PhoneApp::Thread);
                    break;
                }
            }
            break;
        }

        case PhoneApp::Thread: {
            header(contactName(phoneThread_));
            // The input at the bottom; Enter sends.
            const float inH = 0.034f, inY = CY1 - inH - 0.006f, sendD = 0.034f, sendW = sendD * sh / sw;
            field(CX, inY, CW - sendW - 0.008f, "", phoneText_, "Сообщение");
            const float scx = CX + CW - sendW / 2, scy = inY + inH / 2;
            const bool can = !phoneText_.empty();
            circle(scx, scy, sendD, can ? theme::Accent : kCard);
            label(">", scx, inY, 0.42f, can ? theme::OnAccent : theme::Muted, Align::Center, inH);
            if (can && (submit || clicked(scx - sendW / 2, inY, sendW, inH))) {
                send(ScriptEvent{"gomp:phone:sms", {Value::string(phoneThread_), Value::string(phoneText_)}});
                phoneText_.clear();
                phoneScroll_ = 0;
            }
            if (focus_ == nullptr && !submit) focus_ = &phoneText_;
            // Bubbles from the bottom up; the wheel scrolls back in time.
            std::vector<const PhoneSms*> msgs;
            for (const auto& s : sms_)
                if (s.number == phoneThread_) msgs.push_back(&s);
            wheel(static_cast<int>(msgs.size()), 1);
            const float scale = 0.29f, lineH = 0.022f, maxW = CW * 0.7f;
            float y = inY - 0.01f;
            for (int i = static_cast<int>(msgs.size()) - 1 - phoneScroll_; i >= 0; --i) {
                const PhoneSms& s = *msgs[i];
                const auto& lines = wrap(s.text, scale, maxW - 0.016f);
                float bw = 0;
                for (const auto& l : lines) bw = std::max(bw, textWidth(l, scale));
                bw = std::max(bw + 0.016f, 0.04f);
                const float bh = lines.size() * lineH + 0.02f;
                if (y - bh < CY0) break;
                y -= bh;
                const float bx = s.out ? CX + CW - bw : CX;
                roundRect(bx, y, bw, bh, s.out ? theme::Accent : kCardHi, 12);
                for (std::size_t l = 0; l < lines.size(); ++l)
                    label(lines[l], bx + 0.008f, y + 0.004f + l * lineH, scale, s.out ? theme::OnAccent : theme::Text);
                label(stamp(s.at), bx + bw - 0.006f, y + bh - 0.017f, 0.2f, s.out ? withAlpha(theme::OnAccent, 160) : theme::Muted, Align::Right);
                y -= 0.008f;
            }
            if (msgs.empty()) label("Напишите первое сообщение", SX + SW / 2, CY0 + 0.05f, 0.3f, theme::Muted, Align::Center);
            break;
        }

        case PhoneApp::Bank: {
            header("GoMP Bank");
            // The card.
            const float cy = CY0 + 0.006f, ch = 0.11f;
            softRect(CX, cy, CW, ch, theme::AccentDeep, 18);
            roundRect(CX + 8 * px, cy + 8 * py, CW - 16 * px, ch * 0.42f, withAlpha(theme::AccentHi, 40), 12);
            label("GoMP Bank", CX + 0.012f, cy + 0.008f, 0.32f, theme::Text);
            label("DEBIT", CX + CW - 0.012f, cy + 0.01f, 0.26f, withAlpha(theme::Text, 200), Align::Right);
            const int st = std::max(0, myStatic());
            label("****  ****  ****  " + std::string(4 - std::min<std::size_t>(4, std::to_string(st % 10000).size()), '0') +
                      std::to_string(st % 10000),
                  CX + 0.012f, cy + 0.036f, 0.3f, withAlpha(theme::Text, 220));
            label("Баланс", CX + 0.012f, cy + 0.062f, 0.24f, withAlpha(theme::Text, 200));
            label(money(bank), CX + 0.012f, cy + 0.074f, 0.5f, theme::Text);
            float y = cy + ch + 0.012f;
            label("Наличные", CX, y, 0.3f, theme::Muted);
            label(money(cash), CX + CW, y, 0.3f, theme::Positive, Align::Right);
            y += 0.03f;
            if (button(CX, y, CW, 0.038f, "Перевести по номеру", true)) {
                phoneField1_.clear();
                phoneField2_.clear();
                phoneGo(PhoneApp::Transfer);
                break;
            }
            y += 0.05f;
            rect(CX, y + 0.004f, 0.003f, 0.014f, theme::Accent);
            label("ИСТОРИЯ ОПЕРАЦИЙ", CX + 0.008f, y, 0.26f, theme::Muted);
            y += 0.026f;
            const float rowH = 0.04f;
            const int visible = std::max(1, static_cast<int>((CY1 - y) / rowH));
            if (inRect(SX, y, SW, CY1 - y)) wheel(static_cast<int>(bankLog_.size()), visible);
            if (bankLog_.empty()) label("Операций по карте пока нет", CX, y + 0.004f, 0.28f, theme::Muted);
            for (int i = phoneScroll_; i < std::min<int>(bankLog_.size(), phoneScroll_ + visible); ++i) {
                const auto& b = bankLog_[i];
                const std::string sum = (b.sum > 0 ? "+" : "") + money(b.sum);
                label(fit(b.text, 0.29f, CW - textWidth(sum, 0.3f) - 0.012f), CX, y + 0.002f, 0.29f, theme::Text);
                label(stamp(b.at), CX, y + 0.021f, 0.23f, theme::Muted);
                label(sum, CX + CW, y + 0.008f, 0.3f, b.sum > 0 ? theme::Positive : theme::Text, Align::Right);
                y += rowH;
                rect(CX, y - 0.003f, CW, py, kLine);
            }
            break;
        }

        case PhoneApp::Transfer: {
            header("Перевод");
            float y = CY0 + 0.01f;
            label("На карте " + money(bank), CX, y, 0.3f, theme::Muted);
            y += 0.03f;
            y = field(CX, y, CW, "Номер получателя", phoneField1_, "123-4567") + 0.01f;
            if (const std::string n = logic::phoneNumber(phoneField1_); logic::validPhoneNumber(n) && contactName(n) != n)
                label(contactName(n), CX, y, 0.27f, theme::Accent);
            y += 0.022f;
            std::string digits;
            for (char c : phoneField2_)
                if (c >= '0' && c <= '9') digits += c;
            phoneField2_ = digits.substr(0, 9);
            y = field(CX, y, CW, "Сумма, $", phoneField2_, "0") + 0.02f;
            const long long sum = phoneField2_.empty() ? 0 : std::stoll(phoneField2_);
            const std::string number = logic::phoneNumber(phoneField1_);
            const bool ok = logic::validPhoneNumber(number) && sum > 0 && sum <= bank && number != phoneNumber_;
            if (button(CX, y, CW, 0.042f, sum > 0 ? "Перевести " + money(sum) : "Перевести", true, ok) || (submit && ok)) {
                send(ScriptEvent{"gomp:phone:transfer", {Value::string(number), Value::integer(sum)}});
                back();
                break;
            }
            if (sum > bank) label("Недостаточно денег на карте", SX + SW / 2, y + 0.05f, 0.26f, theme::Negative, Align::Center);
            break;
        }

        case PhoneApp::House: {
            header("Дом");
            const House* h = myHouse();
            float y = CY0 + 0.006f;
            if (!h) {
                label("У вас пока нет дома", SX + SW / 2, y + 0.02f, 0.4f, theme::Text, Align::Center);
                label("Дома на продажу отмечены на карте", SX + SW / 2, y + 0.056f, 0.27f, theme::Muted, Align::Center);
                label("зелёными домиками", SX + SW / 2, y + 0.076f, 0.27f, theme::Muted, Align::Center);
                y += 0.11f;
                // The cheapest house of each class, from the simplest.
                std::vector<std::pair<std::string, HouseClass>> classes(houseClasses_.begin(), houseClasses_.end());
                std::sort(classes.begin(), classes.end(), [](const auto& a, const auto& b) { return a.second.garage < b.second.garage; });
                for (const auto& [key, cls] : classes) {
                    long long cheapest = 0;
                    int free = 0;
                    for (const House& x : houses_)
                        if (x.cls == key && x.owner < 0) {
                            ++free;
                            if (!cheapest || x.price < cheapest) cheapest = x.price;
                        }
                    roundRect(CX, y, CW, 0.044f, kCard, 10);
                    label(cls.name, CX + 0.01f, y + 0.004f, 0.32f, theme::Text);
                    label("свободно: " + std::to_string(free) + "  ·  гараж " + std::to_string(cls.garage), CX + 0.01f, y + 0.024f, 0.24f, theme::Muted);
                    label(free ? "от " + money(cheapest) : "нет", CX + CW - 0.01f, y, 0.3f, free ? theme::Positive : theme::Muted, Align::Right, 0.044f);
                    y += 0.05f;
                }
                y += 0.006f;
                if (button(CX, y, CW, 0.04f, "Маршрут к ближайшему", true)) {
                    const Vector3 me = ENTITY::GET_ENTITY_COORDS(PLAYER::PLAYER_PED_ID(), true);
                    const House* best = nullptr;
                    for (const House& x : houses_)
                        if (x.owner < 0 && (!best || dist2d(me, x.door) < dist2d(me, best->door))) best = &x;
                    if (best) {
                        HUD::SET_NEW_WAYPOINT(best->door.x, best->door.y);
                        notify("Метка на карте: " + best->name);
                    }
                }
                break;
            }
            auto cls = houseClasses_.find(h->cls);
            softRect(CX, y, CW, 0.088f, kCard, 14);
            label(fit(h->name, 0.4f, CW - 0.02f), CX + 0.01f, y + 0.008f, 0.4f, theme::Text);
            label(cls != houseClasses_.end() ? cls->second.name + "  ·  " + cls->second.interiorName : h->cls, CX + 0.01f, y + 0.038f, 0.26f,
                  theme::Muted);
            label(h->locked ? "Дверь закрыта" : "Дверь открыта для гостей", CX + 0.01f, y + 0.06f, 0.26f, h->locked ? theme::Negative : theme::Positive);
            y += 0.098f;
            const float half = (CW - 0.008f) / 2;
            if (button(CX, y, half, 0.038f, "Маршрут", true)) {
                HUD::SET_NEW_WAYPOINT(h->door.x, h->door.y);
                notify("Метка на карте: " + h->name);
            }
            if (button(CX + half + 0.008f, y, half, 0.038f, h->locked ? "Открыть" : "Закрыть"))
                send(ScriptEvent{"gomp:house:lock", {Value::integer(h->id)}});
            y += 0.05f;
            rect(CX, y + 0.004f, 0.003f, 0.014f, theme::Accent);
            const bool loaded = houseInfo_.id == h->id;
            label("ГАРАЖ" + (loaded ? "  " + std::to_string(houseInfo_.garage.size()) + " / " + std::to_string(houseInfo_.cap) : std::string()),
                  CX + 0.008f, y, 0.26f, theme::Muted);
            y += 0.026f;
            if (loaded && houseInfo_.garage.empty()) label("Пусто: подъедьте к дому и нажмите E", CX, y, 0.26f, theme::Muted);
            if (loaded)
                for (const auto& c : houseInfo_.garage) {
                    if (y + 0.04f > CY1) break;
                    const char* label0 = VEHICLE::GET_DISPLAY_NAME_FROM_VEHICLE_MODEL(c.model);
                    const char* text = label0 && *label0 ? HUD::GET_FILENAME_FOR_AUDIO_CONVERSATION(label0) : nullptr;
                    const std::string name = text && *text && std::strcmp(text, "NULL") != 0 ? text : label0 ? label0 : "Транспорт";
                    label(fit(name, 0.3f, CW * 0.6f), CX, y + 0.002f, 0.3f, theme::Text);
                    label(c.out ? "на улице" : "в гараже", CX + CW, y + 0.004f, 0.26f, c.out ? theme::Accent : theme::Muted, Align::Right);
                    label(std::to_string(static_cast<int>(std::round(c.fuel))) + " л", CX, y + 0.021f, 0.23f, theme::Muted);
                    y += 0.04f;
                    rect(CX, y - 0.003f, CW, py, kLine);
                }
            break;
        }

        case PhoneApp::Gps: {
            header("Карта");
            const Vector3 me = ENTITY::GET_ENTITY_COORDS(PLAYER::PLAYER_PED_ID(), true);
            struct Target {
                std::string title;
                Vec3 pos;
                Rgba color;
            };
            std::vector<Target> targets;
            if (const House* h = myHouse()) targets.push_back({"Мой дом", h->door, theme::Accent});
            auto nearest = [&](PlaceKind kind, const char* title, Rgba color) {
                const Place* best = nullptr;
                for (const Place& p : places_)
                    if (p.kind == kind && (!best || dist2d(me, p.pos) < dist2d(me, best->pos))) best = &p;
                if (best) targets.push_back({title, best->pos, color});
            };
            nearest(PlaceKind::Fuel, "Ближайшая АЗС", {255, 159, 10, 255});
            nearest(PlaceKind::Shop, "Магазин 24/7", {52, 199, 89, 255});
            nearest(PlaceKind::Tune, "Los Santos Customs", {191, 90, 242, 255});
            const House* sale = nullptr;
            for (const House& x : houses_)
                if (x.owner < 0 && (!sale || dist2d(me, x.door) < dist2d(me, sale->door))) sale = &x;
            if (sale) targets.push_back({"Дом на продажу", sale->door, theme::Positive});
            float y = CY0 + 0.006f;
            const float rowH = 0.05f;
            for (const auto& tg : targets) {
                if (inRect(SX, y, SW, rowH)) rect(SX, y, SW, rowH, kCard);
                circle(CX + 0.012f, y + rowH / 2, 0.026f, tg.color);
                label(tg.title, CX + 0.03f, y + 0.006f, 0.32f, theme::Text);
                label(distance(dist2d(me, tg.pos)), CX + 0.03f, y + 0.027f, 0.25f, theme::Muted);
                label(">", CX + CW, y, 0.34f, theme::Muted, Align::Right, rowH);
                separator(y + rowH - py);
                if (clicked(SX, y, SW, rowH)) {
                    HUD::SET_NEW_WAYPOINT(tg.pos.x, tg.pos.y);
                    notify("Метка на карте: " + tg.title);
                }
                y += rowH;
            }
            y += 0.012f;
            if (button(CX, y, CW, 0.038f, "Убрать метку", false, HUD::IS_WAYPOINT_ACTIVE())) HUD::SET_WAYPOINT_OFF();
            break;
        }

        case PhoneApp::Settings: {
            header("Настройки");
            float y = CY0 + 0.008f;
            label("Обои", CX, y, 0.3f, theme::Muted);
            y += 0.028f;
            const float d = 0.05f, dw = d * sh / sw, gx = (CW - 3 * dw) / 2;
            for (int i = 0; i < kWallpaperCount; ++i) {
                const float cx = CX + dw / 2 + (i % 3) * (dw + gx), cy = y + d / 2 + (i / 3) * (d + 0.03f);
                if (i == settings_.phoneWallpaper) circle(cx, cy, d + 0.008f, theme::Accent);
                circle(cx, cy, d, kWallpapers[i].base);
                circle(cx + dw * 0.12f, cy - d * 0.12f, d * 0.5f, kWallpapers[i].glow1);
                label(kWallpapers[i].name, cx, cy + d / 2 + 0.002f, 0.22f, theme::Muted, Align::Center);
                if (clicked(cx - dw / 2, cy - d / 2, dw, d)) {
                    settings_.phoneWallpaper = i;
                    saveSettings();
                }
            }
            y += 2 * (d + 0.03f) + 0.01f;
            // A switch: sounds of the phone and of new messages.
            roundRect(CX, y, CW, 0.042f, kCard, 10);
            label("Звуки", CX + 0.01f, y, 0.32f, theme::Text, Align::Left, 0.042f);
            const float tw = 0.034f * sh / sw * 1.7f, th = 0.024f, tx = CX + CW - tw - 0.008f, ty = y + 0.009f;
            roundRect(tx, ty, tw, th, settings_.phoneSound ? theme::Positive : kCardHi, th * sh / 2);
            circle(settings_.phoneSound ? tx + tw - th * sh / sw / 2 - 2 * px : tx + th * sh / sw / 2 + 2 * px, ty + th / 2, th - 4 * py, theme::Text);
            if (clicked(CX, y, CW, 0.042f)) {
                settings_.phoneSound = !settings_.phoneSound;
                saveSettings();
            }
            y += 0.054f;
            roundRect(CX, y, CW, 0.042f, kCard, 10);
            label("Мой номер", CX + 0.01f, y, 0.32f, theme::Text, Align::Left, 0.042f);
            label(phoneNumber_.empty() ? "..." : phoneNumber_, CX + CW - 0.01f, y, 0.32f, theme::Muted, Align::Right, 0.042f);
            y += 0.06f;
            label("GoMP OS 1.0", SX + SW / 2, y, 0.24f, theme::Muted, Align::Center);
            break;
        }
    }

    // The home bar.
    const float hbW = SW * 0.34f, hbY = SY + SH - 14 * py;
    const bool hbHover = inRect(SX + (SW - hbW) / 2, hbY - 10 * py, hbW, 22 * py);
    rect(SX + (SW - hbW) / 2, hbY, hbW, 4 * py, withAlpha(theme::Text, hbHover ? 255 : 170));
    if (hbHover && mouseClick_ && !home) phoneGo(PhoneApp::Home);
}

}  // namespace gompgame
