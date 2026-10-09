// Diagnostics for houses.js: with "probe": "houses" in gomp.json (the launcher
// writes it from GOMP_PROBE) the client takes the player from the login screen
// through every house interior and door and logs what is there:
//   probe: <name> at x y z: interior <id> ready <0|1> ..., ground <z|none>
// An interior must have an id and get ready; a door must be outside (interior 0)
// with the ground just below it; for a door inside a building the nearest spot
// outside is suggested. "houses,ui" then shows the house window and every app of
// the phone for a few seconds each (probe-ui: lines), for screenshots.
#include <cmath>

#include "game_client.hpp"
#include "natives.hpp"

namespace gompgame {

namespace {
constexpr DWORD kDoorStepMs = 5000;       // time to stream a door in
constexpr DWORD kInteriorStepMs = 15000;  // an interior gets this long to get ready
constexpr DWORD kUiStepMs = 8000;

std::string fmt(const char* f, double a, double b, double c) {
    char buf[96];
    std::snprintf(buf, sizeof(buf), f, a, b, c);
    return buf;
}
}  // namespace

// "rotation": how the game turns an object for SET_ENTITY_ROTATION(x, y, z, 2) —
// the axes of its matrix and its quaternion, for GoMP Studio's rotation math
// (tools/studio/testdata/rotations.json):
//   probe-rot: x y z | right rx ry rz | forward fx fy fz | up ux uy uz | quat qx qy qz qw | rot gx gy gz
static void probeRotations(const std::function<void(const std::string&)>& log) {
    static const float kAngles[][3] = {{0, 0, 90}, {30, 0, 0}, {0, 30, 0}, {30, 40, 50}, {-20, 70, -130}, {10, -80, 170}, {89, 10, 20}, {0, 0, -45}};
    const Hash model = gomp::joaat("prop_bench_01a");
    STREAMING::REQUEST_MODEL(model);
    for (int i = 0; i < 200 && !STREAMING::HAS_MODEL_LOADED(model); ++i) shv::wait(10);
    const Vector3 at = ENTITY::GET_ENTITY_COORDS(PLAYER::PLAYER_PED_ID(), true);
    Object obj = OBJECT::CREATE_OBJECT_NO_OFFSET(model, at.x, at.y + 4, at.z, false, false, false, 0);
    for (const auto& a : kAngles) {
        ENTITY::SET_ENTITY_ROTATION(obj, a[0], a[1], a[2], 2, true);
        Vector3 fwd{}, right{}, up{}, pos{};
        ENTITY::GET_ENTITY_MATRIX(obj, &fwd, &right, &up, &pos);
        float qx = 0, qy = 0, qz = 0, qw = 0;
        ENTITY::GET_ENTITY_QUATERNION(obj, &qx, &qy, &qz, &qw);
        const Vector3 r = ENTITY::GET_ENTITY_ROTATION(obj, 2);
        char line[400];
        std::snprintf(line, sizeof(line),
                      "probe-rot: %g %g %g | right %.6f %.6f %.6f | forward %.6f %.6f %.6f | up %.6f %.6f %.6f | quat %.6f %.6f %.6f %.6f | rot %.4f %.4f %.4f",
                      a[0], a[1], a[2], right.x, right.y, right.z, fwd.x, fwd.y, fwd.z, up.x, up.y, up.z, qx, qy, qz, qw, r.x, r.y, r.z);
        log(line);
    }
    OBJECT::DELETE_OBJECT(&obj);
    STREAMING::SET_MODEL_AS_NO_LONGER_NEEDED(model);
}

// "vehicles[:model,model...]": what the game made of the vehicles of the add-on
// packs (after editing them in GoMP Studio): the name from vehicles.meta and what
// the handling gives (fInitialDriveMaxFlatVel, fInitialDriveForce, fBrakeForce):
//   probe-veh: <model> cdimage <0|1> name <gameName> maxspeed <m/s> accel <a> braking <b>
static void probeVehicles(const std::string& models, const std::function<void(const std::string&)>& log) {
    size_t start = 0;
    while (start < models.size()) {
        size_t end = models.find(',', start);
        if (end == std::string::npos) end = models.size();
        const std::string name = models.substr(start, end - start);
        start = end + 1;
        const Hash model = gomp::joaat(name);
        const bool known = STREAMING::IS_MODEL_IN_CDIMAGE(model);
        if (known) {
            STREAMING::REQUEST_MODEL(model);
            for (int i = 0; i < 300 && !STREAMING::HAS_MODEL_LOADED(model); ++i) shv::wait(10);
        }
        char line[300];
        std::snprintf(line, sizeof(line), "probe-veh: %s cdimage %d name %s maxspeed %.3f accel %.4f braking %.4f", name.c_str(), known ? 1 : 0,
                      known ? VEHICLE::GET_DISPLAY_NAME_FROM_VEHICLE_MODEL(model) : "-", known ? VEHICLE::GET_VEHICLE_MODEL_ESTIMATED_MAX_SPEED(model) : 0.0f,
                      known ? VEHICLE::GET_VEHICLE_MODEL_ACCELERATION(model) : 0.0f, known ? VEHICLE::GET_VEHICLE_MODEL_MAX_BRAKING(model) : 0.0f);
        log(line);
        if (known) STREAMING::SET_MODEL_AS_NO_LONGER_NEEDED(model);
    }
}

void GameClient::tickProbe() {
    if (cfg_.probe == "rotation" && probeIndex_ < 0 && screen_ == Screen::Login) {
        probeIndex_ = 0;
        probeRotations([this](const std::string& line) { log(line); });
        log("probe: done");
        return;
    }
    if (cfg_.probe.rfind("vehicles", 0) == 0 && probeIndex_ < 0 && screen_ == Screen::Login) {
        probeIndex_ = 0;
        probeVehicles(cfg_.probe.size() > 9 ? cfg_.probe.substr(9) : "g37s,felon2", [this](const std::string& line) { log(line); });
        log("probe: done");
        return;
    }
    if (cfg_.probe.rfind("houses", 0) != 0 || houses_.empty() || houseClasses_.empty()) return;
    const int places = static_cast<int>(probeTargets_.size());
    if (probeIndex_ < 0 && screen_ != Screen::Login) return;  // from the login screen only
    const Ped me = PLAYER::PLAYER_PED_ID();
    const DWORD now = GetTickCount();
    if (probeIndex_ < 0) {
        for (const auto& [key, c] : houseClasses_) probeTargets_.push_back({"interior " + key, c.interior, true});
        for (const House& h : houses_) probeTargets_.push_back({"door #" + std::to_string(h.id) + " " + h.name, h.door, false});
        log("probe: " + std::to_string(probeTargets_.size()) + " places");
        probing_ = true;
        CAMERA::RENDER_SCRIPT_CAMS(false, false, 0, true, false, 0);
        probeIndex_ = 0;
        probeAt_ = 0;
        return;
    }

    // The places.
    if (probeIndex_ < places) {
        const ProbeTarget& t = probeTargets_[probeIndex_];
        if (!probeAt_) {
            ENTITY::FREEZE_ENTITY_POSITION(me, true);
            ENTITY::SET_ENTITY_COORDS_NO_OFFSET(me, t.pos.x, t.pos.y, t.pos.z, false, false, false);
            CAMERA::SET_GAMEPLAY_CAM_RELATIVE_HEADING(0.0f);
            probeAt_ = now;
            return;
        }
        STREAMING::REQUEST_COLLISION_AT_COORD(t.pos.x, t.pos.y, t.pos.z);
        const Interior interior = INTERIOR::GET_INTERIOR_AT_COORDS(t.pos.x, t.pos.y, t.pos.z);
        const bool disabled = interior && INTERIOR::IS_INTERIOR_DISABLED(interior), capped = interior && INTERIOR::IS_INTERIOR_CAPPED(interior);
        if (interior) {
            // What houses.cpp does on the way in.
            if (disabled) INTERIOR::DISABLE_INTERIOR(interior, false);
            if (capped) INTERIOR::CAP_INTERIOR(interior, false);
            INTERIOR::PIN_INTERIOR_IN_MEMORY(interior);
        }
        const bool ready = interior && INTERIOR::IS_INTERIOR_READY(interior);
        const DWORD step = t.interior ? kInteriorStepMs : kDoorStepMs;
        if (now - probeAt_ < step && !(t.interior && ready && now - probeAt_ > 2000)) return;

        float ground = 0;
        const bool hasGround = MISC::GET_GROUND_Z_FOR_3D_COORD(t.pos.x, t.pos.y, t.pos.z + 1.0f, &ground, false, false);
        char line[400];
        std::snprintf(line, sizeof(line), "probe: %s at %.2f %.2f %.2f: interior %d ready %d disabled %d capped %d after %lu ms, ground %s",
                      t.name.c_str(), t.pos.x, t.pos.y, t.pos.z, interior, ready ? 1 : 0, disabled ? 1 : 0, capped ? 1 : 0,
                      static_cast<unsigned long>(now - probeAt_), hasGround ? std::to_string(ground).c_str() : "none");
        log(line);
        // A door inside a building: the nearest spot outside, on the ground near the door's level.
        if (!t.interior && interior) {
            bool found = false;
            for (float r = 1.5f; r <= 12.0f && !found; r += 1.5f)
                for (int a = 0; a < 16 && !found; ++a) {
                    const float ang = a * 6.2831853f / 16;
                    const float x = t.pos.x + r * std::cos(ang), y = t.pos.y + r * std::sin(ang);
                    float gz = 0;
                    if (!MISC::GET_GROUND_Z_FOR_3D_COORD(x, y, t.pos.z + 1.0f, &gz, false, false)) continue;
                    if (gz < t.pos.z - 3.0f || gz > t.pos.z + 0.5f || INTERIOR::GET_INTERIOR_AT_COORDS(x, y, gz + 1.0f)) continue;
                    log("probe:   outside " + fmt("%.2f %.2f %.2f", x, y, gz + 1.0f) + " (" + std::to_string(static_cast<int>(r * 10) / 10.0f).substr(0, 4) +
                        " m away)");
                    found = true;
                }
            if (!found) log("probe:   no spot outside within 12 m");
        }
        probeAt_ = 0;
        if (++probeIndex_ == places) {
            log("probe: places done");
            if (cfg_.probe.find("ui") == std::string::npos) {
                probing_ = false;
                probeIndex_ = places + 100;  // finished
                if (uiCam_) CAMERA::RENDER_SCRIPT_CAMS(true, false, 0, true, false, 0);
                log("probe: done");
            }
        }
        return;
    }

    // The windows, for screenshots: the house window, then every app of the phone.
    static const std::pair<const char*, PhoneApp> kUi[] = {
        {"house window", PhoneApp::Home}, {"phone home", PhoneApp::Home}, {"phone contacts", PhoneApp::Contacts},
        {"phone messages", PhoneApp::Messages}, {"phone thread", PhoneApp::Thread}, {"phone bank", PhoneApp::Bank},
        {"phone house", PhoneApp::House}, {"phone gps", PhoneApp::Gps}, {"phone settings", PhoneApp::Settings}};
    const int ui = probeIndex_ - places;
    if (ui >= static_cast<int>(sizeof(kUi) / sizeof(kUi[0]))) return;
    if (probeAt_ && now - probeAt_ < kUiStepMs) return;
    if (ui == 0) {
        // Outside the first house, as a player coming up to it.
        const House& h = houses_.front();
        ENTITY::SET_ENTITY_COORDS_NO_OFFSET(me, h.door.x, h.door.y, h.door.z, false, false, false);
        probing_ = false;
        phoneNumber_ = "555-1234";
        contacts_ = {{"Анна", "555-0101"}, {"Иван Петров", "555-2233"}, {"Механик Дима", "555-7788"}};
        sms_ = {{"555-0101", "Привет! Ты где?", false, true, 1760000000000LL},
                {"555-0101", "У дома на Grove Street, подъезжай", true, true, 1760000060000LL},
                {"555-0101", "Ок, буду через 5 минут. Возьми ремкомплект, у меня машина еле едет", false, false, 1760000120000LL},
                {"555-2233", "Перевёл тебе за ужин", false, true, 1760000200000LL}};
        bankLog_ = {{1760000300000LL, -55000, "Покупка дома: Grove Street, 1"}, {1760000200000LL, 250, "Перевод от Иван Петров"},
                    {1760000100000LL, -36, "АЗС: 18.0 л"}};
        houseMenu_ = h.id;
        houseInfo_ = {};
        openScreen(Screen::House);
    } else {
        if (screen_ != Screen::Phone) {
            closeScreens();
            phoneOpenedAt_ = now;
            openScreen(Screen::Phone);
        }
        phoneThread_ = "555-0101";
        phoneApp_ = kUi[ui].second;
        phoneBack_ = {PhoneApp::Home};
    }
    log(std::string("probe-ui: ") + kUi[ui].first);
    probeAt_ = now;
    if (++probeIndex_ - places == static_cast<int>(sizeof(kUi) / sizeof(kUi[0]))) log("probe: done (the last window stays)");
}

}  // namespace gompgame
