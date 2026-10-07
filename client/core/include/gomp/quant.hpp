// Quantization helpers, bit-identical to wire/proto/quant.go and math.go.
#pragma once

#include <cmath>
#include <cstdint>

#include "gomp/buffer.hpp"

namespace gomp {

struct Quat {
    float x = 0, y = 0, z = 0, w = 1;
};

constexpr double kPi = 3.14159265358979323846;
constexpr double kVelocityScale = 100;
constexpr double kAngVelocityScale = 1000;

inline double clampRound(double v, double lo, double hi) {
    if (std::isnan(v)) return 0;
    v = std::round(v);  // half away from zero, like Go's math.Round
    return v < lo ? lo : (v > hi ? hi : v);
}

inline uint16_t quantizeHeading(float deg) {
    double d = std::fmod(static_cast<double>(deg), 360.0);
    if (d < 0) d += 360;
    if (std::isnan(d)) return 0;
    return static_cast<uint16_t>(static_cast<uint32_t>(std::round(d / 360.0 * 65536.0)) & 0xFFFF);
}
inline float dequantizeHeading(uint16_t q) { return static_cast<float>(static_cast<double>(q) * 360.0 / 65536.0); }

inline int16_t quantizeSigned(float v, double scale) {
    return static_cast<int16_t>(clampRound(static_cast<double>(v) * scale, -32767, 32767));
}
inline float dequantizeSigned(int16_t q, double scale) { return static_cast<float>(static_cast<double>(q) / scale); }

inline int8_t quantizeUnitS8(float v) { return static_cast<int8_t>(clampRound(static_cast<double>(v) * 127, -127, 127)); }
inline float dequantizeUnitS8(int8_t q) { return static_cast<float>(q) / 127.0f; }
inline uint8_t quantizeUnitU8(float v) { return static_cast<uint8_t>(clampRound(static_cast<double>(v) * 255, 0, 255)); }
inline float dequantizeUnitU8(uint8_t q) { return static_cast<float>(q) / 255.0f; }
inline int16_t quantizeHealth(float v) { return static_cast<int16_t>(clampRound(static_cast<double>(v), -32767, 32767)); }

inline Quat normalize(Quat q) {
    double l = std::sqrt(static_cast<double>(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w));
    if (l < 1e-9 || std::isnan(l)) return {};
    auto s = static_cast<float>(1 / l);
    return {q.x * s, q.y * s, q.z * s, q.w * s};
}

constexpr int kQuatBits = 10;
constexpr uint32_t kQuatMax = (1u << kQuatBits) - 1;
constexpr double kQuatRange = 0.70710678118654752;

// Smallest-three quaternion packing into 32 bits.
inline uint32_t packQuat(Quat q) {
    q = normalize(q);
    double c[4] = {q.x, q.y, q.z, q.w};
    int largest = 0;
    for (int i = 1; i < 4; ++i)
        if (std::fabs(c[i]) > std::fabs(c[largest])) largest = i;
    double sign = c[largest] < 0 ? -1 : 1;
    uint32_t packed = static_cast<uint32_t>(largest) << 30;
    int shift = 20;
    for (int i = 0; i < 4; ++i) {
        if (i == largest) continue;
        double v = c[i] * sign;
        double n = (v + kQuatRange) / (2 * kQuatRange) * kQuatMax;
        packed |= static_cast<uint32_t>(clampRound(n, 0, kQuatMax)) << shift;
        shift -= kQuatBits;
    }
    return packed;
}

inline Quat unpackQuat(uint32_t p) {
    int largest = static_cast<int>(p >> 30);
    double c[4] = {0, 0, 0, 0};
    int shift = 20;
    double sum = 0;
    for (int i = 0; i < 4; ++i) {
        if (i == largest) continue;
        double n = static_cast<double>((p >> shift) & kQuatMax);
        double v = n / kQuatMax * (2 * kQuatRange) - kQuatRange;
        c[i] = v;
        sum += v * v;
        shift -= kQuatBits;
    }
    double rest = 1 - sum;
    c[largest] = std::sqrt(rest < 0 ? 0 : rest);
    return {static_cast<float>(c[0]), static_cast<float>(c[1]), static_cast<float>(c[2]), static_cast<float>(c[3])};
}

inline Quat mul(Quat a, Quat b) {
    return {a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
            a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z};
}

// GTA Euler (degrees, rotation order 2) → quaternion: R = Rz(yaw)·Rx(pitch)·Ry(roll).
inline Quat quatFromEuler(Vec3 r) {
    auto axis = [](float x, float y, float z, float deg) {
        double h = static_cast<double>(deg) * kPi / 360;
        auto s = static_cast<float>(std::sin(h));
        return Quat{x * s, y * s, z * s, static_cast<float>(std::cos(h))};
    };
    return normalize(mul(mul(axis(0, 0, 1, r.z), axis(1, 0, 0, r.x)), axis(0, 1, 0, r.y)));
}

inline Vec3 eulerFromQuat(Quat q) {
    q = normalize(q);
    double x = q.x, y = q.y, z = q.z, w = q.w;
    double r01 = 2 * (x * y - z * w), r11 = 1 - 2 * (x * x + z * z);
    double r20 = 2 * (x * z - y * w), r21 = 2 * (y * z + x * w), r22 = 1 - 2 * (x * x + y * y);
    r21 = r21 > 1 ? 1 : (r21 < -1 ? -1 : r21);
    constexpr double deg = 180 / kPi;
    return {static_cast<float>(std::asin(r21) * deg), static_cast<float>(std::atan2(-r20, r22) * deg),
            static_cast<float>(std::atan2(-r01, r11) * deg)};
}

}  // namespace gomp
