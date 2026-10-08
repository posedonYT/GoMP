// Immediate-mode drawing helpers shared by the HUD, chat, console and screens.
#pragma once

#include <algorithm>
#include <cmath>
#include <string>

#include "natives.hpp"
#include "props.hpp"

namespace gompgame::ui {

using Rgba = props::Rgba;

enum class Align { Left, Center, Right };

inline bool isLeadByte(unsigned char c) { return (c & 0xC0) != 0x80; }

// Text components hold at most 99 bytes; longer strings are split on UTF-8 boundaries.
inline void addText(const std::string& s) {
    constexpr std::size_t kChunk = 99;
    for (std::size_t i = 0; i < s.size();) {
        std::size_t n = std::min(kChunk, s.size() - i);
        while (i + n < s.size() && n > 0 && !isLeadByte(static_cast<unsigned char>(s[i + n]))) --n;
        if (n == 0) break;
        std::string part = s.substr(i, n);
        HUD::ADD_TEXT_COMPONENT_SUBSTRING_PLAYER_NAME(part.c_str());
        i += n;
    }
}

inline void drawText(const std::string& s, float x, float y, float scale, int font, Rgba c, bool center) {
    HUD::SET_TEXT_FONT(font);
    HUD::SET_TEXT_SCALE(0.0f, scale);
    HUD::SET_TEXT_COLOUR(c.r, c.g, c.b, c.a);
    HUD::SET_TEXT_CENTRE(center);
    HUD::SET_TEXT_OUTLINE();
    HUD::BEGIN_TEXT_COMMAND_DISPLAY_TEXT("STRING");
    addText(s);
    HUD::END_TEXT_COMMAND_DISPLAY_TEXT(x, y, 0);
}

inline void drawText3d(const std::string& s, gomp::Vec3 pos, float scale, int font, Rgba c) {
    GRAPHICS::SET_DRAW_ORIGIN(pos.x, pos.y, pos.z, false);
    drawText(s, 0.0f, 0.0f, scale, font, c, true);
    GRAPHICS::CLEAR_DRAW_ORIGIN();
}

// RAGE colour codes (!{#rrggbb}) are not supported by the game's text renderer.
inline std::string stripColors(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (std::size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '!' && i + 1 < s.size() && s[i + 1] == '{') {
            auto end = s.find('}', i);
            if (end != std::string::npos) {
                i = end;
                continue;
            }
        }
        out += s[i];
    }
    return out;
}

// The printable text a key produces with the current layout and modifiers, as UTF-8.
// GoMP keeps its own input language: the game window does not follow the
// Windows layout switch (GTA swallows Alt+Shift).
enum class Lang { En, Ru };

inline HKL layoutOf(Lang lang) {
    static const HKL en = LoadKeyboardLayoutA("00000409", 0);
    static const HKL ru = LoadKeyboardLayoutA("00000419", 0);
    return lang == Lang::Ru && ru ? ru : en;
}

// The language of the layout active in the foreground window (the initial GoMP language).
inline Lang systemLang() {
    HKL hkl = GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), nullptr));
    return (reinterpret_cast<uintptr_t>(hkl) & 0x3FF) == LANG_RUSSIAN ? Lang::Ru : Lang::En;
}

inline std::string keyText(DWORD key, Lang lang) {
    BYTE state[256] = {};
    for (int vk : {VK_SHIFT, VK_LSHIFT, VK_RSHIFT, VK_CONTROL, VK_LCONTROL, VK_RCONTROL, VK_MENU, VK_LMENU, VK_RMENU})
        if (GetAsyncKeyState(vk) & 0x8000) state[vk] = 0x80;
    if (GetKeyState(VK_CAPITAL) & 1) state[VK_CAPITAL] = 1;
    HKL layout = layoutOf(lang);
    UINT scan = MapVirtualKeyExW(key, MAPVK_VK_TO_VSC, layout);
    wchar_t buf[8] = {};
    int n = ToUnicodeEx(key, scan, state, buf, 8, 0x4 /* keep the keyboard state */, layout);
    if (n <= 0) return {};
    std::wstring w;
    for (int i = 0; i < n; ++i)
        if (buf[i] >= 0x20 && buf[i] != 0x7F) w += buf[i];
    if (w.empty()) return {};
    char out[32] = {};
    int len = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), out, sizeof(out), nullptr, nullptr);
    return len > 0 ? std::string(out, len) : std::string();
}

// Text with left, centre or right alignment (x is the anchor), with outline.
inline void drawTextAligned(const std::string& s, float x, float y, float scale, int font, Rgba c, Align align) {
    HUD::SET_TEXT_FONT(font);
    HUD::SET_TEXT_SCALE(0.0f, scale);
    HUD::SET_TEXT_COLOUR(c.r, c.g, c.b, c.a);
    HUD::SET_TEXT_OUTLINE();
    if (align == Align::Right) {
        HUD::SET_TEXT_JUSTIFICATION(2);
        HUD::SET_TEXT_WRAP(0.0f, x);
    } else {
        HUD::SET_TEXT_CENTRE(align == Align::Center);
    }
    HUD::BEGIN_TEXT_COMMAND_DISPLAY_TEXT("STRING");
    addText(s);
    HUD::END_TEXT_COMMAND_DISPLAY_TEXT(align == Align::Right ? 0.0f : x, y, 0);
}

// A filled rectangle given by its top-left corner.
inline void rect(float x, float y, float w, float h, Rgba c) {
    GRAPHICS::DRAW_RECT(x + w / 2, y + h / 2, w, h, c.r, c.g, c.b, c.a, false);
}

// The name of a map blip (shown in the pause-menu map legend).
inline void blipName(Blip blip, const std::string& name) {
    HUD::BEGIN_TEXT_COMMAND_SET_BLIP_NAME("STRING");
    HUD::ADD_TEXT_COMPONENT_SUBSTRING_PLAYER_NAME(name.c_str());
    HUD::END_TEXT_COMMAND_SET_BLIP_NAME(blip);
}

// 12500 -> "$12 500"
inline std::string money(long long v) {
    std::string digits = std::to_string(v < 0 ? -v : v), out;
    for (std::size_t i = 0; i < digits.size(); ++i) {
        if (i && (digits.size() - i) % 3 == 0) out += ' ';
        out += digits[i];
    }
    return (v < 0 ? "-$" : "$") + out;
}

// ------------------------------------------------------------------ theme

// Perplexity dark palette (app dark mode + brand turquoise), used by every GoMP screen.
namespace theme {
inline constexpr Rgba Bg{25, 26, 26, 238};          // #191A1A
inline constexpr Rgba Surface{32, 34, 34, 245};     // #202222
inline constexpr Rgba SurfaceHi{45, 47, 47, 250};   // #2D2F2F
inline constexpr Rgba Border{58, 61, 61, 255};      // #3A3D3D
inline constexpr Rgba Text{232, 232, 230, 255};     // #E8E8E6
inline constexpr Rgba Muted{141, 145, 145, 255};    // #8D9191
inline constexpr Rgba Accent{32, 184, 205, 255};    // #20B8CD true turquoise
inline constexpr Rgba AccentHi{90, 208, 224, 255};
inline constexpr Rgba AccentDeep{32, 128, 141, 255};  // #20808D
inline constexpr Rgba AccentSoft{19, 52, 59, 235};    // #13343B
inline constexpr Rgba OnAccent{9, 23, 23, 255};       // #091717 text on turquoise
inline constexpr Rgba Positive{110, 196, 128, 255};
inline constexpr Rgba Negative{226, 96, 108, 255};
inline constexpr Rgba Hud{25, 26, 26, 200};           // translucent HUD plates
inline constexpr Rgba Slot{40, 43, 43, 250};          // inventory cells: visible even when empty
inline constexpr Rgba SlotHover{52, 56, 56, 250};
inline constexpr Rgba SlotBorder{82, 88, 88, 255};
inline constexpr int Font = 4;                        // Chalet Comprime: the narrow GTA UI font
}  // namespace theme

inline Rgba withAlpha(Rgba c, int a) { return {c.r, c.g, c.b, a}; }

inline void screenSize(int& w, int& h) {
    GRAPHICS::GET_ACTUAL_SCREEN_RESOLUTION(&w, &h);
    if (w <= 0 || h <= 0) w = 1920, h = 1080;
}

// A rectangle with rounded corners, drawn as pixel rows (the game has no rounded primitive).
inline void roundRect(float x, float y, float w, float h, Rgba c, float radiusPx = 7, int maxStrips = 4) {
    int sw, sh;
    screenSize(sw, sh);
    const float px = 1.0f / sw, py = 1.0f / sh;
    int r = static_cast<int>(std::min({radiusPx, w / px / 2, h / py / 2}));
    if (r < 2) {
        rect(x, y, w, h, c);
        return;
    }
    // The game caps script draw commands per frame, so each corner takes few strips
    // (4 by default: small plates are many).
    const int strips = std::min(r, maxStrips);
    rect(x, y + r * py, w, h - 2 * r * py, c);
    for (int i = 0; i < strips; ++i) {
        const float top = static_cast<float>(r) * i / strips, height = static_cast<float>(r) / strips;
        const float dy = r - (top + height / 2);
        const float inset = (r - std::sqrt(std::max(0.0f, static_cast<float>(r * r) - dy * dy))) * px;
        rect(x + inset, y + top * py, w - 2 * inset, height * py, c);
        rect(x + inset, y + h - (top + height) * py, w - 2 * inset, height * py, c);
    }
}

// A round sprite of the game's own texture dictionaries for smooth circles (rounded
// rectangles are made of strips and look stepped at large radii). The first
// candidate the game has is used; nullptr until one has streamed in.
struct Sprite {
    const char* dict;
    const char* name;
};
inline const Sprite* circleSprite() {
    static const Sprite kCandidates[] = {
        {"mpinventory", "in_world_circle"}, {"shared", "medaldot_32"}, {"mpmissmarkers256", "corona_point"}};
    static const Sprite* chosen = nullptr;
    static int checks = 0;
    if (chosen || checks > 600) return chosen;  // give up after ~10 s: rounded rectangles then
    ++checks;
    for (const Sprite& s : kCandidates) {
        if (!GRAPHICS::HAS_STREAMED_TEXTURE_DICT_LOADED(s.dict)) {
            GRAPHICS::REQUEST_STREAMED_TEXTURE_DICT(s.dict, false);
            continue;
        }
        if (GRAPHICS::GET_TEXTURE_RESOLUTION(s.dict, s.name).x > 1) return chosen = &s;
    }
    return nullptr;
}

// A filled circle of height h (screen fractions) centred at (cx, cy); translucent colours work.
inline void circle(float cx, float cy, float h, Rgba c) {
    int sw, sh;
    screenSize(sw, sh);
    const float w = h * sh / sw;
    if (const Sprite* s = circleSprite()) {
        GRAPHICS::DRAW_SPRITE(s->dict, s->name, cx, cy, w, h, 0.0f, c.r, c.g, c.b, c.a, false, 0);
        return;
    }
    roundRect(cx - w / 2, cy - h / 2, w, h, c, h * sh / 2);
}

// A large rounded rectangle (the phone, app icons): more strips for smooth corners.
// (The round sprite does not fill its texture to the edge, so it cannot make corners.)
inline void softRect(float x, float y, float w, float h, Rgba c, float radiusPx) {
    roundRect(x, y, w, h, c, radiusPx, 12);
}

// A plain cell: one-pixel border and fill, 2 draw commands (5 when the fill is translucent).
inline void frame(float x, float y, float w, float h, Rgba fill, Rgba border) {
    int sw, sh;
    screenSize(sw, sh);
    const float px = 1.0f / sw, py = 1.0f / sh;
    if (fill.a >= 230) {
        rect(x, y, w, h, border);
        rect(x + px, y + py, w - 2 * px, h - 2 * py, fill);
        return;
    }
    rect(x + px, y + py, w - 2 * px, h - 2 * py, fill);
    rect(x, y, w, py, border);
    rect(x, y + h - py, w, py, border);
    rect(x, y + py, px, h - 2 * py, border);
    rect(x + w - px, y + py, px, h - 2 * py, border);
}

// A rounded panel with a one-pixel border.
inline void panel(float x, float y, float w, float h, Rgba fill = theme::Bg, Rgba border = theme::Border, float radiusPx = 10) {
    int sw, sh;
    screenSize(sw, sh);
    if (fill.a >= 230) {
        // Opaque: a border-coloured shape under a slightly smaller fill gives rounded borders.
        roundRect(x, y, w, h, border, radiusPx);
        roundRect(x + 1.0f / sw, y + 1.0f / sh, w - 2.0f / sw, h - 2.0f / sh, fill, radiusPx - 1);
        return;
    }
    // Translucent: the fill must not show the border through it, so the border is drawn as edges.
    roundRect(x, y, w, h, fill, radiusPx);
    const float rx = radiusPx / sw, ry = radiusPx / sh, px = 1.0f / sw, py = 1.0f / sh;
    rect(x + rx, y, w - 2 * rx, py, border);
    rect(x + rx, y + h - py, w - 2 * rx, py, border);
    rect(x, y + ry, px, h - 2 * ry, border);
    rect(x + w - px, y + ry, px, h - 2 * ry, border);
}

inline float textWidth(const std::string& s, float scale, int font = theme::Font) {
    HUD::BEGIN_TEXT_COMMAND_GET_SCREEN_WIDTH_OF_DISPLAY_TEXT("STRING");
    addText(s);
    HUD::SET_TEXT_FONT(font);
    HUD::SET_TEXT_SCALE(0.0f, scale);
    return HUD::END_TEXT_COMMAND_GET_SCREEN_WIDTH_OF_DISPLAY_TEXT(true);
}

// Approximate height of a text line for vertical centring (font 4).
inline float textHeight(float scale) { return scale * 0.062f; }

// Text without outline (panels are opaque enough), optionally vertically centred in [y, y+h].
inline void label(const std::string& s, float x, float y, float scale, Rgba c, Align align = Align::Left, float h = 0) {
    if (h > 0) y += (h - textHeight(scale)) / 2;
    HUD::SET_TEXT_FONT(theme::Font);
    HUD::SET_TEXT_SCALE(0.0f, scale);
    HUD::SET_TEXT_COLOUR(c.r, c.g, c.b, c.a);
    if (align == Align::Right) {
        HUD::SET_TEXT_JUSTIFICATION(2);
        HUD::SET_TEXT_WRAP(0.0f, x);
    } else {
        HUD::SET_TEXT_CENTRE(align == Align::Center);
    }
    HUD::BEGIN_TEXT_COMMAND_DISPLAY_TEXT("STRING");
    addText(s);
    HUD::END_TEXT_COMMAND_DISPLAY_TEXT(align == Align::Right ? 0.0f : x, y, 0);
}

// A rounded plate sized to its text: [ text ]; returns its width. x is the left edge,
// or the right edge with Align::Right.
inline float pill(const std::string& s, float x, float y, float h, float scale, Rgba bg, Rgba fg,
                  Align align = Align::Left) {
    int sw, sh;
    screenSize(sw, sh);
    const float pad = 10.0f / sw, w = textWidth(s, scale) + 2 * pad;
    const float left = align == Align::Right ? x - w : x;
    roundRect(left, y, w, h, bg, h * sh / 2);
    label(s, left + pad, y, scale, fg, Align::Left, h);
    return w;
}

}  // namespace gompgame::ui
