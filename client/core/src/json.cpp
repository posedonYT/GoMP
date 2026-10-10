#include "gomp/json.hpp"

#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace gomp::json {

namespace {

struct Reader {
    std::string_view s;
    std::size_t i = 0;
    std::string err;
    int depth = 0;

    bool fail(const char* why) {
        if (err.empty()) err = std::string(why) + " at " + std::to_string(i);
        return false;
    }
    void ws() {
        while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
    }
    bool lit(std::string_view w) {
        if (s.substr(i, w.size()) != w) return false;
        i += w.size();
        return true;
    }

    static void utf8(std::string& out, uint32_t cp) {
        if (cp < 0x80) {
            out += static_cast<char>(cp);
        } else if (cp < 0x800) {
            out += static_cast<char>(0xC0 | (cp >> 6));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            out += static_cast<char>(0xE0 | (cp >> 12));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else {
            out += static_cast<char>(0xF0 | (cp >> 18));
            out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
    }

    bool hex4(uint32_t& out) {
        if (i + 4 > s.size()) return fail("short \\u escape");
        out = 0;
        for (int k = 0; k < 4; ++k) {
            const char c = s[i++];
            out <<= 4;
            if (c >= '0' && c <= '9') out |= c - '0';
            else if (c >= 'a' && c <= 'f') out |= c - 'a' + 10;
            else if (c >= 'A' && c <= 'F') out |= c - 'A' + 10;
            else return fail("bad \\u escape");
        }
        return true;
    }

    bool string(std::string& out) {
        ++i;  // the opening quote
        while (i < s.size()) {
            const char c = s[i++];
            if (c == '"') return true;
            if (static_cast<unsigned char>(c) < 0x20) return fail("control character in a string");
            if (c != '\\') {
                out += c;
                continue;
            }
            if (i >= s.size()) break;
            const char e = s[i++];
            switch (e) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u': {
                    uint32_t cp;
                    if (!hex4(cp)) return false;
                    if (cp >= 0xD800 && cp <= 0xDBFF && s.substr(i, 2) == "\\u") {
                        i += 2;
                        uint32_t lo;
                        if (!hex4(lo)) return false;
                        if (lo >= 0xDC00 && lo <= 0xDFFF) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        else return fail("bad surrogate pair");
                    }
                    utf8(out, cp);
                    break;
                }
                default: return fail("bad escape");
            }
        }
        return fail("unterminated string");
    }

    bool number(Value& out) {
        const std::size_t start = i;
        if (s[i] == '-') ++i;
        bool isFloat = false;
        while (i < s.size()) {
            const char c = s[i];
            if (c >= '0' && c <= '9') ++i;
            else if (c == '.' || c == 'e' || c == 'E' || c == '+' || (c == '-' && i > start)) {
                isFloat = true;
                ++i;
            } else break;
        }
        const char* b = s.data() + start;
        const char* e = s.data() + i;
        if (!isFloat) {
            int64_t v = 0;
            auto [p, ec] = std::from_chars(b, e, v);
            if (ec == std::errc() && p == e) {
                out = Value::integer(v);
                return true;
            }
        }
        // strtod: from_chars for doubles is missing in some standard libraries.
        std::string tmp(b, e);
        char* end = nullptr;
        const double d = std::strtod(tmp.c_str(), &end);
        if (end != tmp.c_str() + tmp.size() || tmp.empty() || tmp == "-") return fail("bad number");
        out = Value::number(d);
        return true;
    }

    bool value(Value& out) {
        ws();
        if (i >= s.size()) return fail("unexpected end");
        if (++depth > 256) return fail("too deep");
        bool ok = true;
        const char c = s[i];
        if (c == '{') {
            ++i;
            out.kind = Value::Kind::Map;
            ws();
            if (i < s.size() && s[i] == '}') {
                ++i;
            } else {
                for (;;) {
                    ws();
                    if (i >= s.size() || s[i] != '"') {
                        ok = fail("expected a key");
                        break;
                    }
                    std::string key;
                    if (!string(key)) {
                        ok = false;
                        break;
                    }
                    ws();
                    if (i >= s.size() || s[i] != ':') {
                        ok = fail("expected ':'");
                        break;
                    }
                    ++i;
                    Value v;
                    if (!value(v)) {
                        ok = false;
                        break;
                    }
                    out.map.emplace_back(std::move(key), std::move(v));
                    ws();
                    if (i < s.size() && s[i] == ',') {
                        ++i;
                        continue;
                    }
                    if (i < s.size() && s[i] == '}') {
                        ++i;
                        break;
                    }
                    ok = fail("expected ',' or '}'");
                    break;
                }
            }
        } else if (c == '[') {
            ++i;
            out.kind = Value::Kind::Array;
            ws();
            if (i < s.size() && s[i] == ']') {
                ++i;
            } else {
                for (;;) {
                    Value v;
                    if (!value(v)) {
                        ok = false;
                        break;
                    }
                    out.arr.push_back(std::move(v));
                    ws();
                    if (i < s.size() && s[i] == ',') {
                        ++i;
                        continue;
                    }
                    if (i < s.size() && s[i] == ']') {
                        ++i;
                        break;
                    }
                    ok = fail("expected ',' or ']'");
                    break;
                }
            }
        } else if (c == '"') {
            std::string str;
            ok = string(str);
            out = Value::string(std::move(str));
        } else if (lit("true")) {
            out = Value::boolean(true);
        } else if (lit("false")) {
            out = Value::boolean(false);
        } else if (lit("null")) {
            out = Value::nil();
        } else if (c == '-' || (c >= '0' && c <= '9')) {
            ok = number(out);
        } else {
            ok = fail("unexpected character");
        }
        --depth;
        return ok;
    }
};

void writeString(std::string& out, const std::string& s) {
    out += '"';
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    out += '"';
}

void writeValue(std::string& out, const Value& v) {
    switch (v.kind) {
        case Value::Kind::Nil: out += "null"; break;
        case Value::Kind::Bool: out += v.b ? "true" : "false"; break;
        case Value::Kind::Int: out += std::to_string(v.i); break;
        case Value::Kind::Float: {
            if (!std::isfinite(v.f)) {
                out += "null";
                break;
            }
            char buf[32];
            std::snprintf(buf, sizeof(buf), "%.17g", v.f);
            out += buf;
            break;
        }
        case Value::Kind::String: writeString(out, v.s); break;
        case Value::Kind::Array:
            out += '[';
            for (std::size_t k = 0; k < v.arr.size(); ++k) {
                if (k) out += ',';
                writeValue(out, v.arr[k]);
            }
            out += ']';
            break;
        case Value::Kind::Map:
            out += '{';
            for (std::size_t k = 0; k < v.map.size(); ++k) {
                if (k) out += ',';
                writeString(out, v.map[k].first);
                out += ':';
                writeValue(out, v.map[k].second);
            }
            out += '}';
            break;
        case Value::Kind::Vec3:
            writeValue(out, Value::array({Value::number(v.v.x), Value::number(v.v.y), Value::number(v.v.z)}));
            break;
        case Value::Kind::Entity:
            writeValue(out, Value::array({Value::integer(static_cast<int64_t>(v.e.type)), Value::integer(v.e.id)}));
            break;
    }
}

}  // namespace

std::optional<Value> parse(std::string_view text, std::string* error) {
    Reader r;
    r.s = text;
    Value v;
    if (!r.value(v)) {
        if (error) *error = r.err;
        return std::nullopt;
    }
    r.ws();
    if (r.i != text.size()) {
        if (error) *error = "trailing data at " + std::to_string(r.i);
        return std::nullopt;
    }
    return v;
}

std::string write(const Value& v) {
    std::string out;
    writeValue(out, v);
    return out;
}

}  // namespace gomp::json
