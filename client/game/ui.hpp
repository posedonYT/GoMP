// Immediate-mode drawing helpers shared by the HUD, chat, console and screens.
#pragma once

#include <algorithm>
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

// 12500 -> "$12 500"
inline std::string money(long long v) {
    std::string digits = std::to_string(v < 0 ? -v : v), out;
    for (std::size_t i = 0; i < digits.size(); ++i) {
        if (i && (digits.size() - i) % 3 == 0) out += ' ';
        out += digits[i];
    }
    return (v < 0 ? "-$" : "$") + out;
}

}  // namespace gompgame::ui
