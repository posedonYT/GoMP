// GoMP wire codec primitives. Byte-for-byte compatible with wire/proto/buffer.go:
// little-endian integers, unsigned LEB128 varints and zigzag signed varints.
#pragma once

#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

namespace gomp {

struct Vec3 {
    float x = 0, y = 0, z = 0;
    bool operator==(const Vec3&) const = default;
};

constexpr std::size_t kMaxStringLen = 1 << 16;

class Writer {
public:
    Writer() { buf_.reserve(128); }
    explicit Writer(std::vector<uint8_t>&& reuse) : buf_(std::move(reuse)) { buf_.clear(); }

    const std::vector<uint8_t>& bytes() const { return buf_; }
    std::vector<uint8_t>& bytes() { return buf_; }
    std::size_t size() const { return buf_.size(); }
    void clear() { buf_.clear(); }

    void u8(uint8_t v) { buf_.push_back(v); }
    void i8(int8_t v) { u8(static_cast<uint8_t>(v)); }
    void u16(uint16_t v) { put(v); }
    void i16(int16_t v) { u16(static_cast<uint16_t>(v)); }
    void u32(uint32_t v) { put(v); }
    void i32(int32_t v) { u32(static_cast<uint32_t>(v)); }
    void u64(uint64_t v) { put(v); }
    void f32(float v) { uint32_t b; std::memcpy(&b, &v, 4); u32(b); }
    void f64(double v) { uint64_t b; std::memcpy(&b, &v, 8); u64(b); }
    void boolean(bool v) { u8(v ? 1 : 0); }

    void uvarint(uint64_t v) {
        while (v >= 0x80) {
            buf_.push_back(static_cast<uint8_t>(v) | 0x80);
            v >>= 7;
        }
        buf_.push_back(static_cast<uint8_t>(v));
    }
    void varint(int64_t v) {
        uint64_t z = (static_cast<uint64_t>(v) << 1) ^ static_cast<uint64_t>(v >> 63);
        uvarint(z);
    }
    void string(std::string_view s) {
        uvarint(s.size());
        buf_.insert(buf_.end(), s.begin(), s.end());
    }
    void raw(const uint8_t* p, std::size_t n) { buf_.insert(buf_.end(), p, p + n); }
    void vec3(const Vec3& v) { f32(v.x); f32(v.y); f32(v.z); }

private:
    template <typename T> void put(T v) {
        // Little-endian on every supported platform (x86-64, arm64).
        uint8_t tmp[sizeof(T)];
        for (std::size_t i = 0; i < sizeof(T); ++i) tmp[i] = static_cast<uint8_t>(v >> (8 * i));
        buf_.insert(buf_.end(), tmp, tmp + sizeof(T));
    }
    std::vector<uint8_t> buf_;
};

// Reader decodes values written by Writer. Errors are sticky: after the first
// failure every read returns zero and ok() is false.
class Reader {
public:
    Reader(const uint8_t* data, std::size_t size) : p_(data), n_(size) {}
    explicit Reader(const std::vector<uint8_t>& v) : p_(v.data()), n_(v.size()) {}

    bool ok() const { return ok_; }
    std::size_t remaining() const { return ok_ ? n_ - off_ : 0; }
    std::size_t offset() const { return off_; }
    void fail() { ok_ = false; }

    uint8_t u8() { const uint8_t* b = take(1); return b ? b[0] : 0; }
    int8_t i8() { return static_cast<int8_t>(u8()); }
    uint16_t u16() { return get<uint16_t>(); }
    int16_t i16() { return static_cast<int16_t>(u16()); }
    uint32_t u32() { return get<uint32_t>(); }
    int32_t i32() { return static_cast<int32_t>(u32()); }
    uint64_t u64() { return get<uint64_t>(); }
    float f32() { uint32_t b = u32(); float f; std::memcpy(&f, &b, 4); return f; }
    double f64() { uint64_t b = u64(); double f; std::memcpy(&f, &b, 8); return f; }
    bool boolean() { return u8() != 0; }

    uint64_t uvarint() {
        uint64_t v = 0;
        for (int shift = 0; shift < 70; shift += 7) {
            const uint8_t* b = take(1);
            if (!b) return 0;
            if (shift == 63 && *b > 1) { ok_ = false; return 0; }
            v |= static_cast<uint64_t>(*b & 0x7f) << shift;
            if (!(*b & 0x80)) return v;
        }
        ok_ = false;
        return 0;
    }
    int64_t varint() {
        uint64_t z = uvarint();
        return static_cast<int64_t>(z >> 1) ^ -static_cast<int64_t>(z & 1);
    }
    // Length prefix validated against max and the remaining bytes.
    std::size_t len(std::size_t max) {
        uint64_t n = uvarint();
        if (!ok_) return 0;
        if (n > max || n > remaining()) { ok_ = false; return 0; }
        return static_cast<std::size_t>(n);
    }
    std::string string() {
        std::size_t n = len(kMaxStringLen);
        const uint8_t* b = take(n);
        return b ? std::string(reinterpret_cast<const char*>(b), n) : std::string();
    }
    Vec3 vec3() { Vec3 v; v.x = f32(); v.y = f32(); v.z = f32(); return v; }

    const uint8_t* take(std::size_t k) {
        if (!ok_ || off_ + k > n_) { ok_ = false; return nullptr; }
        const uint8_t* b = p_ + off_;
        off_ += k;
        return b;
    }

private:
    template <typename T> T get() {
        const uint8_t* b = take(sizeof(T));
        if (!b) return 0;
        T v = 0;
        for (std::size_t i = 0; i < sizeof(T); ++i) v |= static_cast<T>(static_cast<T>(b[i]) << (8 * i));
        return v;
    }
    const uint8_t* p_;
    std::size_t n_;
    std::size_t off_ = 0;
    bool ok_ = true;
};

// Jenkins one-at-a-time hash (GTA V model/weapon names), lower-cased input.
inline uint32_t joaat(std::string_view s) {
    uint32_t h = 0;
    for (char ch : s) {
        auto c = static_cast<uint8_t>(ch);
        if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
        h += c;
        h += h << 10;
        h ^= h >> 6;
    }
    h += h << 3;
    h ^= h >> 11;
    h += h << 15;
    return h;
}

}  // namespace gomp
