// A small JSON reader and writer over gomp::Value (fastdl manifests, the download
// index, mp.storage): objects keep their key order, integers stay Int, other
// numbers Float, \uXXXX escapes (surrogate pairs too) become UTF-8.
#pragma once

#include <optional>
#include <string>
#include <string_view>

#include "gomp/value.hpp"

namespace gomp::json {

// The value of a JSON text, or nullopt (error: where and why) when it is not JSON.
std::optional<Value> parse(std::string_view text, std::string* error = nullptr);

// JSON text of a value (entities and vectors as arrays).
std::string write(const Value& v);

}  // namespace gomp::json
