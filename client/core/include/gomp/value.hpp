// Dynamically typed script values (wire/proto/value.go).
#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "gomp/buffer.hpp"

namespace gomp {

enum class EntityType : uint8_t {
    None = 0, Player = 1, Vehicle = 2, Object = 3, Ped = 4, Blip = 5,
    Checkpoint = 6, Marker = 7, Colshape = 8, TextLabel = 9, Dummy = 10,
};

struct EntityRef {
    EntityType type = EntityType::None;
    uint16_t id = 0;
    bool operator==(const EntityRef&) const = default;
};

struct Value {
    enum class Kind : uint8_t { Nil, Bool, Int, Float, String, Array, Map, Vec3, Entity };
    Kind kind = Kind::Nil;
    bool b = false;
    int64_t i = 0;
    double f = 0;
    std::string s;
    gomp::Vec3 v;
    EntityRef e;
    std::vector<Value> arr;
    // Key order is preserved so decode → encode reproduces the input bytes.
    std::vector<std::pair<std::string, Value>> map;

    Value() = default;
    static Value nil() { return {}; }
    static Value boolean(bool x) { Value r; r.kind = Kind::Bool; r.b = x; return r; }
    static Value integer(int64_t x) { Value r; r.kind = Kind::Int; r.i = x; return r; }
    static Value number(double x) { Value r; r.kind = Kind::Float; r.f = x; return r; }
    static Value string(std::string x) { Value r; r.kind = Kind::String; r.s = std::move(x); return r; }
    static Value vec3(gomp::Vec3 x) { Value r; r.kind = Kind::Vec3; r.v = x; return r; }
    static Value entity(EntityRef x) { Value r; r.kind = Kind::Entity; r.e = x; return r; }
    static Value array(std::vector<Value> x) { Value r; r.kind = Kind::Array; r.arr = std::move(x); return r; }

    bool isNil() const { return kind == Kind::Nil; }
    // Numeric view of Int/Float/Bool values.
    double asNumber() const {
        switch (kind) {
            case Kind::Int: return static_cast<double>(i);
            case Kind::Float: return f;
            case Kind::Bool: return b ? 1 : 0;
            default: return 0;
        }
    }
    int64_t asInt() const { return kind == Kind::Float ? static_cast<int64_t>(f) : static_cast<int64_t>(asNumber()); }
    const Value* get(std::string_view key) const {
        for (const auto& [k, val] : map)
            if (k == key) return &val;
        return nullptr;
    }
};

constexpr int kMaxValueDepth = 32;

namespace tag {
constexpr uint8_t Nil = 0, False = 1, True = 2, Int = 3, Float = 4, String = 5, Array = 6, Map = 7, Vec3 = 8, Entity = 9;
}

inline void writeValue(Writer& w, const Value& v) {
    switch (v.kind) {
        case Value::Kind::Nil: w.u8(tag::Nil); break;
        case Value::Kind::Bool: w.u8(v.b ? tag::True : tag::False); break;
        case Value::Kind::Int: w.u8(tag::Int); w.varint(v.i); break;
        case Value::Kind::Float: w.u8(tag::Float); w.f64(v.f); break;
        case Value::Kind::String: w.u8(tag::String); w.string(v.s); break;
        case Value::Kind::Array:
            w.u8(tag::Array);
            w.uvarint(v.arr.size());
            for (const auto& e : v.arr) writeValue(w, e);
            break;
        case Value::Kind::Map:
            w.u8(tag::Map);
            w.uvarint(v.map.size());
            for (const auto& [k, e] : v.map) {
                w.string(k);
                writeValue(w, e);
            }
            break;
        case Value::Kind::Vec3: w.u8(tag::Vec3); w.vec3(v.v); break;
        case Value::Kind::Entity: w.u8(tag::Entity); w.u8(static_cast<uint8_t>(v.e.type)); w.u16(v.e.id); break;
    }
}

inline Value readValue(Reader& r, int depth = 0) {
    Value v;
    if (depth > kMaxValueDepth) { r.fail(); return v; }
    uint8_t t = r.u8();
    if (!r.ok()) return v;
    switch (t) {
        case tag::Nil: break;
        case tag::False: v.kind = Value::Kind::Bool; v.b = false; break;
        case tag::True: v.kind = Value::Kind::Bool; v.b = true; break;
        case tag::Int: v.kind = Value::Kind::Int; v.i = r.varint(); break;
        case tag::Float: v.kind = Value::Kind::Float; v.f = r.f64(); break;
        case tag::String: v.kind = Value::Kind::String; v.s = r.string(); break;
        case tag::Array: {
            v.kind = Value::Kind::Array;
            std::size_t n = r.len(r.remaining());
            v.arr.reserve(n);
            for (std::size_t k = 0; k < n && r.ok(); ++k) v.arr.push_back(readValue(r, depth + 1));
            break;
        }
        case tag::Map: {
            v.kind = Value::Kind::Map;
            std::size_t n = r.len(r.remaining() / 2);
            v.map.reserve(n);
            for (std::size_t k = 0; k < n && r.ok(); ++k) {
                std::string key = r.string();
                v.map.emplace_back(std::move(key), readValue(r, depth + 1));
            }
            break;
        }
        case tag::Vec3: v.kind = Value::Kind::Vec3; v.v = r.vec3(); break;
        case tag::Entity:
            v.kind = Value::Kind::Entity;
            v.e.type = static_cast<EntityType>(r.u8());
            v.e.id = r.u16();
            break;
        default: r.fail(); break;
    }
    return v;
}

inline void writeValues(Writer& w, const std::vector<Value>& vs) {
    w.uvarint(vs.size());
    for (const auto& v : vs) writeValue(w, v);
}

inline std::vector<Value> readValues(Reader& r) {
    std::size_t n = r.len(r.remaining());
    std::vector<Value> out;
    out.reserve(n);
    for (std::size_t k = 0; k < n && r.ok(); ++k) out.push_back(readValue(r));
    return out;
}

}  // namespace gomp
