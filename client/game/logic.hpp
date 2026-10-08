// Pure client logic without game natives, covered by client/tests/test_game_logic.cpp.
#pragma once

#include <algorithm>
#include <cmath>
#include <map>
#include <string>
#include <vector>

namespace gompgame::logic {

// The item of a radial menu with n items (item 0 at the top, clockwise) under a
// cursor at (dx, dy) from the centre, in screen-height units (x already scaled by
// the aspect ratio); -1 inside the dead zone or without items.
inline int radialHover(float dx, float dy, int n, float deadZone) {
    if (n <= 0 || std::hypot(dx, dy) <= deadZone) return -1;
    constexpr float kTau = 6.2831853f;
    float angle = std::atan2(dx, -dy);  // 0 at the top, clockwise
    if (angle < 0) angle += kTau;
    return static_cast<int>(std::lround(angle / (kTau / static_cast<float>(n)))) % n;
}

// Mk II weapons share the icon of the original and get a badge.
inline bool isMk2(const std::string& key) {
    return key.size() > 4 && key.compare(key.size() - 4, 4, "_mk2") == 0;
}

// Tuning prices as sent by the server (server-files/packages/freeroam/tuning.js, PRICES).
struct TunePrices {
    double levelStep = 0.5;
    std::map<int, int> mods;     // base price by mod type
    int otherMod = 700;          // types without an own base price
    std::map<int, int> toggles;  // turbo, tyre smoke, xenon
    std::map<std::string, int> fields;  // primary, secondary, pearl, wheelColor, wheelType, windowTint, neon, plateType, livery
};

inline bool isToggleMod(int type) { return type == 18 || type == 20 || type == 22; }

// The price of mod index `index` of a type (index -1, the stock part, is free); the same
// formula as modPrice() in tuning.js: base * (1 + index * levelStep), rounded to $10.
inline int tuneModPrice(const TunePrices& p, int type, int index) {
    if (index < 0) return 0;
    if (isToggleMod(type)) {
        auto it = p.toggles.find(type);
        return it == p.toggles.end() ? 0 : it->second;
    }
    auto it = p.mods.find(type);
    const double base = it == p.mods.end() ? p.otherMod : it->second;
    return static_cast<int>(std::lround(base * (1 + index * p.levelStep) / 10.0)) * 10;
}

inline int tuneFieldPrice(const TunePrices& p, const std::string& field) {
    auto it = p.fields.find(field);
    return it == p.fields.end() ? 0 : it->second;
}

// ------------------------------------------------------------------ tuning camera

// A camera circling a vehicle: yaw (degrees) around it relative to its nose (0 in
// front, 90 on its right, 180 behind), pitch above the horizon, distance in metres,
// and the point it looks at in vehicle space (right, forward, up from its origin).
struct OrbitView {
    float yaw = 35, pitch = 12, dist = 5.0f;
    float right = 0, forward = 0, up = 0.2f;
};

struct V3 {
    float x = 0, y = 0, z = 0;
};

// Moves a view a fraction t towards another (the yaw the short way round).
inline OrbitView blend(const OrbitView& a, const OrbitView& b, float t) {
    auto mix = [t](float x, float y) { return x + (y - x) * t; };
    OrbitView r;
    const float dyaw = std::fmod(b.yaw - a.yaw + 540.0f, 360.0f) - 180.0f;
    r.yaw = std::fmod(a.yaw + dyaw * t + 360.0f, 360.0f);
    r.pitch = mix(a.pitch, b.pitch);
    r.dist = mix(a.dist, b.dist);
    r.right = mix(a.right, b.right);
    r.forward = mix(a.forward, b.forward);
    r.up = mix(a.up, b.up);
    return r;
}

// The looked-at point and the camera position as offsets from the vehicle origin,
// for a vehicle whose (horizontal, unit) forward vector is (fx, fy).
inline void orbitPoints(const OrbitView& v, float fx, float fy, V3& target, V3& camera) {
    const float rx = fy, ry = -fx;  // the vehicle's right
    target = {rx * v.right + fx * v.forward, ry * v.right + fy * v.forward, v.up};
    const float yaw = v.yaw * 3.14159265f / 180.0f, pitch = v.pitch * 3.14159265f / 180.0f;
    const float h = v.dist * std::cos(pitch);
    camera = {target.x + fx * h * std::cos(yaw) + rx * h * std::sin(yaw),
              target.y + fy * h * std::cos(yaw) + ry * h * std::sin(yaw), target.z + v.dist * std::sin(pitch)};
}

enum TunePreset { ViewOverview, ViewFront, ViewRear, ViewSide, ViewWheels, ViewCabin, ViewTop, ViewEngine, ViewTrunk, ViewExhaust, ViewCount };

inline OrbitView tunePreset(int preset) {
    switch (preset) {
        case ViewFront: return {0, 8, 4.2f, 0, 1.0f, 0.3f};
        case ViewRear: return {180, 10, 4.2f, 0, -1.0f, 0.3f};
        case ViewSide: return {90, 5, 4.4f, 0, 0, 0.2f};
        case ViewWheels: return {65, 2, 2.4f, 0.85f, 1.3f, -0.15f};
        case ViewCabin: return {180, 6, 0.55f, -0.3f, 0.35f, 0.5f};
        case ViewTop: return {20, 62, 5.5f, 0, 0, 0};
        case ViewEngine: return {0, 38, 2.8f, 0, 1.5f, 0.3f};
        case ViewTrunk: return {180, 32, 3.0f, 0, -1.7f, 0.3f};
        case ViewExhaust: return {160, 2, 2.6f, 0, -2.0f, -0.15f};
        default: return {35, 12, 5.2f, 0, 0, 0.2f};
    }
}

// Where to look when a kind of part is chosen (GTA mod slot types).
inline int presetForMod(int type) {
    switch (type) {
        case 1: case 6: case 7: case 22: return ViewFront;       // front bumper, grille, bonnet, xenon
        case 0: case 2: case 25: case 26: return ViewRear;       // spoiler, rear bumper, plates
        case 3: case 8: case 9: case 42: return ViewSide;        // skirts, fenders, arches
        case 4: return ViewExhaust;
        case 10: case 43: return ViewTop;                        // roof, aerials
        case 11: case 18: case 39: case 40: case 41: return ViewEngine;  // engine, turbo, block, filter, struts
        case 12: case 15: case 23: case 24: return ViewWheels;   // brakes, suspension, wheels
        case 27: case 28: case 29: case 30: case 31: case 32: case 33: case 34: case 35: case 36: return ViewCabin;
        case 37: case 38: return ViewTrunk;                      // boot, hydraulics
        default: return ViewOverview;
    }
}

// ------------------------------------------------------------------ phone

// "5551234" or "555 12 34" -> "555-1234"; anything else is left as typed.
inline std::string phoneNumber(const std::string& s) {
    std::string digits;
    for (char c : s)
        if (c >= '0' && c <= '9') digits += c;
    return digits.size() == 7 ? digits.substr(0, 3) + "-" + digits.substr(3) : s;
}

// A number as the server gives them out: 123-4567.
inline bool validPhoneNumber(const std::string& s) {
    if (s.size() != 8 || s[3] != '-') return false;
    for (std::size_t i = 0; i < s.size(); ++i)
        if (i != 3 && (s[i] < '0' || s[i] > '9')) return false;
    return true;
}

// The first character of a UTF-8 text (a whole Cyrillic letter), "?" when empty.
inline std::string firstLetter(const std::string& s) {
    if (s.empty()) return "?";
    std::size_t n = 1;
    while (n < s.size() && (static_cast<unsigned char>(s[n]) & 0xC0) == 0x80) ++n;
    return s.substr(0, n);
}

// Conversations of a message list (index of each one's latest message), the latest first.
template <typename Msg>
std::vector<std::size_t> conversations(const std::vector<Msg>& msgs) {
    std::vector<std::size_t> out;
    for (std::size_t i = msgs.size(); i-- > 0;) {
        bool seen = false;
        for (std::size_t j : out) seen = seen || msgs[j].number == msgs[i].number;
        if (!seen) out.push_back(i);
    }
    return out;
}

}  // namespace gompgame::logic
