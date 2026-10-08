// Typed access to entity properties (see wire/proto/types.go for the formats).
#pragma once

#include <cstdlib>
#include <string>
#include <string_view>

#include "gomp/messages.hpp"

namespace gompgame::props {

inline const gomp::Value* find(const gomp::Props& p, uint8_t id) {
    auto it = p.find(id);
    return it == p.end() || it->second.isNil() ? nullptr : &it->second;
}
inline double num(const gomp::Props& p, uint8_t id, double def) {
    const gomp::Value* v = find(p, id);
    return v ? v->asNumber() : def;
}
inline int integer(const gomp::Props& p, uint8_t id, int def) {
    const gomp::Value* v = find(p, id);
    return v ? static_cast<int>(v->asInt()) : def;
}
inline bool flag(const gomp::Props& p, uint8_t id, bool def) {
    const gomp::Value* v = find(p, id);
    return v ? v->asNumber() != 0 : def;
}
inline std::string str(const gomp::Props& p, uint8_t id) {
    const gomp::Value* v = find(p, id);
    return v && v->kind == gomp::Value::Kind::String ? v->s : std::string();
}
inline gomp::Vec3 vec(const gomp::Props& p, uint8_t id, gomp::Vec3 def = {}) {
    const gomp::Value* v = find(p, id);
    return v && v->kind == gomp::Value::Kind::Vec3 ? v->v : def;
}
// Element i of an array value as a number.
inline double at(const gomp::Value& v, std::size_t i, double def = 0) {
    return v.kind == gomp::Value::Kind::Array && i < v.arr.size() ? v.arr[i].asNumber() : def;
}

struct Rgba {
    int r = 255, g = 255, b = 255, a = 255;
};
inline Rgba color(const gomp::Props& p, uint8_t id, Rgba def = {}) {
    const gomp::Value* v = find(p, id);
    if (!v || v->kind != gomp::Value::Kind::Array || v->arr.size() < 3) return def;
    return {static_cast<int>(at(*v, 0)), static_cast<int>(at(*v, 1)), static_cast<int>(at(*v, 2)),
            static_cast<int>(at(*v, 3, 255))};
}
// Map keys are decimal numbers ("<component>": ...).
inline int key(const std::string& k) { return std::atoi(k.c_str()); }

// Fields of a map value (script event arguments): nullptr / "" / 0 when absent.
inline const gomp::Value* field(const gomp::Value& m, const char* name) {
    return m.kind == gomp::Value::Kind::Map ? m.get(name) : nullptr;
}
inline std::string fieldStr(const gomp::Value& m, const char* name) {
    const gomp::Value* v = field(m, name);
    return v && v->kind == gomp::Value::Kind::String ? v->s : std::string();
}
inline long long fieldInt(const gomp::Value& m, const char* name) {
    const gomp::Value* v = field(m, name);
    return v ? v->asInt() : 0;
}
inline double fieldNum(const gomp::Value& m, const char* name) {
    const gomp::Value* v = field(m, name);
    return v ? v->asNumber() : 0;
}

// A shared variable of an entity (nullptr when it is not set).
inline const gomp::Value* shared(const gomp::KV& kv, std::string_view name) {
    for (const auto& [k, v] : kv)
        if (k == name) return &v;
    return nullptr;
}

}  // namespace gompgame::props
