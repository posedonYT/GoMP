// Reads gomp.json from the GTA V directory:
//   { "server": "127.0.0.1:22005", "name": "Player", "interpolationDelayMs": 100 }
#include <fstream>
#include <sstream>

#include "game_client.hpp"

namespace gompgame {
namespace {

// Extracts "key": value from a flat JSON object (strings or numbers).
std::string field(const std::string& json, const std::string& key) {
    auto k = json.find("\"" + key + "\"");
    if (k == std::string::npos) return {};
    auto colon = json.find(':', k);
    if (colon == std::string::npos) return {};
    auto i = json.find_first_not_of(" \t\r\n", colon + 1);
    if (i == std::string::npos) return {};
    if (json[i] == '"') {
        auto end = json.find('"', i + 1);
        return end == std::string::npos ? std::string() : json.substr(i + 1, end - i - 1);
    }
    auto end = json.find_first_of(",}\r\n", i);
    return json.substr(i, end - i);
}

}  // namespace

Config loadConfig(const std::string& path) {
    Config c;
    std::ifstream f(path);
    if (!f) return c;
    std::stringstream ss;
    ss << f.rdbuf();
    const std::string json = ss.str();
    if (auto s = field(json, "server"); !s.empty()) {
        auto colon = s.rfind(':');
        if (colon != std::string::npos) {
            c.host = s.substr(0, colon);
            c.port = static_cast<uint16_t>(std::stoi(s.substr(colon + 1)));
        } else {
            c.host = s;
        }
    }
    if (auto s = field(json, "name"); !s.empty()) c.name = s.substr(0, 32);
    if (auto s = field(json, "interpolationDelayMs"); !s.empty()) c.interpolationDelayMs = std::stoi(s);
    // A per-installation serial derived from the Windows machine GUID.
    char guid[64] = {};
    DWORD size = sizeof(guid);
    if (RegGetValueA(HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Cryptography", "MachineGuid", RRF_RT_REG_SZ, nullptr,
                     guid, &size) == ERROR_SUCCESS) {
        c.serial = std::to_string(gomp::joaat(guid)) + "-" + std::to_string(gomp::joaat(std::string(guid) + "gomp"));
    }
    return c;
}

}  // namespace gompgame
