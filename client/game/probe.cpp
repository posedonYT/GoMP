// Diagnostics for houses.js: with "probe": "houses" (or "garages": only the garages) in
// gomp.json (the launcher writes it from GOMP_PROBE) the client takes the player from the
// login screen through every house interior, door and garage and logs what is there:
//   probe: <name> at x y z: interior <id> ready <0|1> ..., ground <z|none>
// An interior must have an id and get ready; a door must be outside (interior 0)
// with the ground just below it; for a door inside a building the nearest spot
// outside is suggested. Garage slots and garage points get a test car (probe: garage ...
// slot / probe: garagepoint ...). "houses,ui" / "garages,ui" then show the windows for a few
// seconds each (probe-ui: lines), for screenshots.
//
// "perf": once spawned (on any server, e.g. the stress server full of bots) the client
// stays 60 s where it is; the perf lines (fps, tick cost and its parts, every 5 s) go to
// the log between "probe: perf start" and "probe: done".
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

namespace {

std::string groundText(bool has, float g) {
    if (!has) return "none";
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.2f", g);
    return buf;
}

// The test car's model is requested at the start of the tour and kept requested; the car is made once
// it has streamed in (no busy wait: the game streams between frames).
const Hash kTestCarModel = gomp::joaat("sultan");
DWORD gCarWaitSince = 0;  // when a place started waiting for the model

// nullptr when the model is loaded, else why it is not (yet).
const char* testCarModelState() {
    if (!STREAMING::IS_MODEL_IN_CDIMAGE(kTestCarModel)) return "model not in cdimage";
    STREAMING::REQUEST_MODEL(kTestCarModel);
    return STREAMING::HAS_MODEL_LOADED(kTestCarModel) ? nullptr : "model not loaded";
}

void releaseTestCarModel() { STREAMING::SET_MODEL_AS_NO_LONGER_NEEDED(kTestCarModel); }

// Waits (over frames, up to 8 s) for the model; true when the caller should go on (loaded or given up).
bool testCarWaitDone(DWORD now, const char* why, DWORD& waited) {
    waited = 0;
    if (why && !std::strcmp(why, "model not loaded")) {
        if (!gCarWaitSince) gCarWaitSince = now;
        if (now - gCarWaitSince < 8000) return false;
    }
    waited = gCarWaitSince ? now - gCarWaitSince : 0;
    gCarWaitSince = 0;
    return true;
}

// A sultan standing where a car of a garage slot or a garage point would be put. The model must be loaded.
Vehicle makeTestCar(gomp::Vec3 p, float heading) {
    Vehicle v = VEHICLE::CREATE_VEHICLE(kTestCarModel, p.x, p.y, p.z - 0.5f, heading, false, false, false);
    // A car made by a script that is not a mission is removed by the population manager within
    // a frame or two (the probe then saw "could not be made" for a car that was created).
    if (v) ENTITY::SET_ENTITY_AS_MISSION_ENTITY(v, true, true);
    return v;
}

// What IS_POSITION_OCCUPIED sees at a position, by kind.
std::string occupiedBy(gomp::Vec3 p) {
    std::string r;
    auto add = [&](const char* what) {
        if (!r.empty()) r += ", ";
        r += what;
    };
    if (MISC::IS_POSITION_OCCUPIED(p.x, p.y, p.z, 2.0f, false, true, false, false, false, 0, false)) add("vehicle");
    if (MISC::IS_POSITION_OCCUPIED(p.x, p.y, p.z, 2.0f, false, false, true, false, false, 0, false)) add("ped");
    if (MISC::IS_POSITION_OCCUPIED(p.x, p.y, p.z, 2.0f, false, false, false, true, false, 0, false)) add("object");
    return r.empty() ? "unknown" : r;
}

void deleteTestCar(Vehicle& veh) {
    if (veh && ENTITY::DOES_ENTITY_EXIST(veh)) {
        ENTITY::SET_ENTITY_AS_MISSION_ENTITY(veh, true, true);
        Entity e = veh;
        ENTITY::DELETE_ENTITY(&e);
    }
    veh = 0;
}

}  // namespace

void GameClient::tickProbe() {
    if (cfg_.probe == "perf") {
        constexpr DWORD kPerfProbeMs = 60000;
        static DWORD started = 0;
        if (!spawned_ || probeIndex_ > 0) return;
        if (probeIndex_ < 0) {
            probeIndex_ = 0;
            started = GetTickCount();
            const Vector3 at = ENTITY::GET_ENTITY_COORDS(PLAYER::PLAYER_PED_ID(), true);
            log("probe: perf start" + fmt(" at %.0f %.0f %.0f", at.x, at.y, at.z));
        } else if (GetTickCount() - started > kPerfProbeMs) {
            probeIndex_ = 1;
            log("probe: perf remotes=" + std::to_string(players_.size()) + " vehicles=" + std::to_string(vehicles_.size()));
            log("probe: done");
        }
        return;
    }
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
    const bool garagesOnly = cfg_.probe.rfind("garages", 0) == 0;
    if (cfg_.probe.rfind("houses", 0) != 0 && !garagesOnly) return;
    if (houses_.empty() || houseClasses_.empty()) return;
    const int places = static_cast<int>(probeTargets_.size());
    if (probeIndex_ < 0 && screen_ != Screen::Login) return;  // from the login screen only
    const Ped me = PLAYER::PLAYER_PED_ID();
    const DWORD now = GetTickCount();
    if (probeIndex_ < 0) {
        if (!garagesOnly) {
            // Interior templates when the server sends them (each: its spawn, then its exit point), else the classes.
            if (!houseInteriors_.empty()) {
                for (const auto& [key, t] : houseInteriors_) {
                    probeTargets_.push_back({"interior " + key + " spawn", t.spawn, true, ProbeKind::InteriorSpawn, key});
                    probeTargets_.push_back({"interior " + key + " exit", t.exit, true, ProbeKind::InteriorExit, key});
                }
            } else {
                for (const auto& [key, c] : houseClasses_) probeTargets_.push_back({"interior " + key, c.interior, true, ProbeKind::InteriorSpawn, {}});
            }
            for (const House& h : houses_) probeTargets_.push_back({"door #" + std::to_string(h.id) + " " + h.name, h.door, false, ProbeKind::Door, {}});
        }
        // The garages: spawn, exit and every slot; then the garage point of every house.
        for (const auto& [key, g] : garageTemplates_) {
            probeTargets_.push_back({"garage " + key + " spawn", g.spawn, true, ProbeKind::GarageSpawn, key, g.heading, g.spawn, 0});
            probeTargets_.push_back({"garage " + key + " exit", g.exit, true, ProbeKind::GarageExit, key, 0, g.exit, 0});
            for (std::size_t i = 0; i < g.slots.size(); ++i)
                probeTargets_.push_back({"garage " + key + " slot " + std::to_string(i + 1), g.slots[i].first, true, ProbeKind::GarageSlot, key,
                                         g.slots[i].second, g.spawn, static_cast<int>(i + 1)});
        }
        for (const House& h : houses_)
            if (h.hasGarage && h.hasGaragePoint)
                probeTargets_.push_back({"garagepoint #" + std::to_string(h.id), h.garagePoint, false, ProbeKind::GaragePoint, {}, h.garageHeading,
                                         h.door, h.id});
        log("probe: " + std::to_string(probeTargets_.size()) + " places");
        gCarWaitSince = 0;
        if (const char* why = testCarModelState(); why && !std::strcmp(why, "model not in cdimage")) log(std::string("probe:   test car: ") + why);
        probing_ = true;
        CAMERA::RENDER_SCRIPT_CAMS(false, false, 0, true, false, 0);
        probeIndex_ = 0;
        probeAt_ = 0;
        probeStage_ = 0;
        return;
    }

    // The places.
    if (probeIndex_ < places) {
        const ProbeTarget& t = probeTargets_[probeIndex_];
        const bool carTest = t.kind == ProbeKind::GarageSlot || t.kind == ProbeKind::GaragePoint;
        const Vec3 at = carTest ? t.stand : t.pos;  // where the ped stands
        if (!probeAt_) {
            ENTITY::FREEZE_ENTITY_POSITION(me, true);
            ENTITY::SET_ENTITY_COORDS_NO_OFFSET(me, at.x, at.y, at.z, false, false, false);
            CAMERA::SET_GAMEPLAY_CAM_RELATIVE_HEADING(0.0f);
            probeAt_ = now;
            probeStage_ = 0;
            return;
        }
        STREAMING::REQUEST_COLLISION_AT_COORD(at.x, at.y, at.z);
        if (carTest) STREAMING::REQUEST_COLLISION_AT_COORD(t.pos.x, t.pos.y, t.pos.z);
        const Interior stood = INTERIOR::GET_INTERIOR_AT_COORDS(at.x, at.y, at.z);
        const Interior interior = carTest ? INTERIOR::GET_INTERIOR_AT_COORDS(t.pos.x, t.pos.y, t.pos.z) : stood;
        const bool disabled = stood && INTERIOR::IS_INTERIOR_DISABLED(stood), capped = stood && INTERIOR::IS_INTERIOR_CAPPED(stood);
        if (stood) {
            // What houses.cpp does on the way in.
            if (disabled) INTERIOR::DISABLE_INTERIOR(stood, false);
            if (capped) INTERIOR::CAP_INTERIOR(stood, false);
            INTERIOR::PIN_INTERIOR_IN_MEMORY(stood);
        }
        const bool ready = stood && INTERIOR::IS_INTERIOR_READY(stood);
        auto finish = [&]() {
            probeAt_ = 0;
            probeStage_ = 0;
            if (++probeIndex_ == places) {
                log("probe: places done");
                if (cfg_.probe.find("ui") == std::string::npos) {
                    probing_ = false;
                    probeIndex_ = places + 100;  // finished
                    releaseTestCarModel();
                    if (uiCam_) CAMERA::RENDER_SCRIPT_CAMS(true, false, 0, true, false, 0);
                    log("probe: done");
                }
            }
        };

        if (carTest) {
            if (probeStage_ == 0) {
                // A slot waits for its garage to get ready; a garage point for the street around it to stream in.
                const bool go = t.kind == ProbeKind::GarageSlot ? (ready && now - probeAt_ > 1000) || now - probeAt_ > kInteriorStepMs
                                                                : now - probeAt_ >= kDoorStepMs;
                if (!go) return;
                const char* why = testCarModelState();
                DWORD waited = 0;
                if (!testCarWaitDone(now, why, waited)) return;  // streams in over the next frames
                if (MISC::IS_POSITION_OCCUPIED(t.pos.x, t.pos.y, t.pos.z, 2.0f, false, true, true, false, false, 0, false))
                    log("probe:   " + t.name + " is occupied before the test car (" + occupiedBy(t.pos) + ")");
                probeCar_ = 0;
                probeFailure_.clear();
                if (why) {
                    probeFailure_ = why;
                    if (!std::strcmp(why, "model not loaded")) probeFailure_ += " after " + std::to_string(waited) + " ms";
                } else {
                    probeCar_ = makeTestCar(t.pos, t.heading);
                    if (!probeCar_) probeFailure_ = "CREATE_VEHICLE returned 0";
                }
                if (probeCar_) {
                    const Vector3 c = ENTITY::GET_ENTITY_COORDS(probeCar_, true);
                    probeCarStart_ = {c.x, c.y, c.z};
                }
                probeCarAt_ = now;
                probeStage_ = 1;
                return;
            }
            if (now - probeCarAt_ < 1500) return;
            float ground = 0;
            const bool hasGround = MISC::GET_GROUND_Z_FOR_3D_COORD(t.pos.x, t.pos.y, t.pos.z + 1.0f, &ground, false, false);
            float dz = 0, tilt = 0, moved = 0;
            if (probeCar_ && ENTITY::DOES_ENTITY_EXIST(probeCar_)) {
                const Vector3 c = ENTITY::GET_ENTITY_COORDS(probeCar_, true);
                const Vector3 r = ENTITY::GET_ENTITY_ROTATION(probeCar_, 2);
                dz = c.z - probeCarStart_.z;
                moved = std::sqrt((c.x - probeCarStart_.x) * (c.x - probeCarStart_.x) + (c.y - probeCarStart_.y) * (c.y - probeCarStart_.y) +
                                  dz * dz);
                tilt = std::sqrt(r.x * r.x + r.y * r.y);
            } else {
                log("probe:   " + t.name + ": the test car could not be made (" + probeFailure_ + ")");
            }
            char line[400];
            if (t.kind == ProbeKind::GarageSlot) {
                std::snprintf(line, sizeof(line), "probe: garage %s slot %d %.2f %.2f %.2f h %.0f: interior %d ground %s car dz %.2f tilt %.1f moved %.2f",
                              t.key.c_str(), t.slot, t.pos.x, t.pos.y, t.pos.z, t.heading, interior, groundText(hasGround, ground).c_str(), dz, tilt,
                              moved);
            } else {
                // The nearest vehicle node: a point on a road is within a metre or two of one.
                Vector3 node{};
                float nodeHeading = 0;
                int lanes = 0;
                float road = -1;
                if (PATH::GET_NTH_CLOSEST_VEHICLE_NODE_WITH_HEADING(t.pos.x, t.pos.y, t.pos.z, 1, &node, &nodeHeading, &lanes, 0, 3.0f, 0.0f))
                    road = std::sqrt((node.x - t.pos.x) * (node.x - t.pos.x) + (node.y - t.pos.y) * (node.y - t.pos.y) +
                                     (node.z - t.pos.z) * (node.z - t.pos.z));
                std::snprintf(line, sizeof(line),
                              "probe: garagepoint #%d %.2f %.2f %.2f h %.0f: interior %d ground %s road %.1f car dz %.2f tilt %.1f moved %.2f", t.slot,
                              t.pos.x, t.pos.y, t.pos.z, t.heading, interior, groundText(hasGround, ground).c_str(), road, dz, tilt, moved);
            }
            log(line);
            deleteTestCar(probeCar_);
            finish();
            return;
        }

        const DWORD step = t.interior ? kInteriorStepMs : kDoorStepMs;
        if (now - probeAt_ < step && !(t.interior && ready && now - probeAt_ > 2000)) return;

        float ground = 0;
        const bool hasGround = MISC::GET_GROUND_Z_FOR_3D_COORD(t.pos.x, t.pos.y, t.pos.z + 1.0f, &ground, false, false);
        char line[400];
        if (t.kind == ProbeKind::InteriorExit || t.kind == ProbeKind::GarageExit) {
            Vec3 s = t.pos;
            if (t.kind == ProbeKind::InteriorExit) {
                const auto it = houseInteriors_.find(t.key);
                if (it != houseInteriors_.end()) s = it->second.spawn;
            } else {
                const auto it = garageTemplates_.find(t.key);
                if (it != garageTemplates_.end()) s = it->second.spawn;
            }
            const float dx = t.pos.x - s.x, dy = t.pos.y - s.y, dz = t.pos.z - s.z;
            std::snprintf(line, sizeof(line), "probe: %s %s exit %.2f %.2f %.2f: interior %d ground %s dist-from-spawn %.2f",
                          t.kind == ProbeKind::GarageExit ? "garage" : "interior", t.key.c_str(), t.pos.x, t.pos.y, t.pos.z, interior,
                          groundText(hasGround, ground).c_str(), std::sqrt(dx * dx + dy * dy + dz * dz));
        } else if (t.kind == ProbeKind::GarageSpawn) {
            std::snprintf(line, sizeof(line), "probe: garage %s spawn %.2f %.2f %.2f: interior %d ready %d ground %s", t.key.c_str(), t.pos.x, t.pos.y,
                          t.pos.z, interior, ready ? 1 : 0, groundText(hasGround, ground).c_str());
        } else if (!t.key.empty()) {
            std::snprintf(line, sizeof(line), "probe: interior %s spawn %.2f %.2f %.2f: interior %d ready %d ground %s", t.key.c_str(), t.pos.x,
                          t.pos.y, t.pos.z, interior, ready ? 1 : 0, groundText(hasGround, ground).c_str());
        } else {
            std::snprintf(line, sizeof(line), "probe: %s at %.2f %.2f %.2f: interior %d ready %d disabled %d capped %d after %lu ms, ground %s",
                          t.name.c_str(), t.pos.x, t.pos.y, t.pos.z, interior, ready ? 1 : 0, disabled ? 1 : 0, capped ? 1 : 0,
                          static_cast<unsigned long>(now - probeAt_), groundText(hasGround, ground).c_str());
        }
        log(line);
        // A door inside a building: the nearest spot outside, on the ground near the door's level.
        if (t.kind == ProbeKind::Door && interior) {
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
        finish();
        return;
    }

    // The windows, for screenshots: the house window and every app of the phone (houses), then each
    // garage full of cars, the exit menu and the spawn screen.
    static const std::pair<const char*, PhoneApp> kUi[] = {
        {"house window", PhoneApp::Home}, {"phone home", PhoneApp::Home}, {"phone contacts", PhoneApp::Contacts},
        {"phone messages", PhoneApp::Messages}, {"phone thread", PhoneApp::Thread}, {"phone bank", PhoneApp::Bank},
        {"phone house", PhoneApp::House}, {"phone gps", PhoneApp::Gps}, {"phone settings", PhoneApp::Settings}};
    const int base = garagesOnly ? 0 : static_cast<int>(sizeof(kUi) / sizeof(kUi[0]));
    const int garages = static_cast<int>(garageTemplates_.size());
    const int total = base + garages + 2;
    const int ui = probeIndex_ - places;
    if (ui >= total) return;

    if (ui >= base && ui < base + garages) {
        // A garage with a test car on every slot.
        if (probeStage_ == 0 && probeAt_ && now - probeAt_ < kUiStepMs) return;
        auto it = garageTemplates_.begin();
        std::advance(it, ui - base);
        const GarageTemplate& g = it->second;
        if (probeStage_ == 0) {
            closeScreens();
            probing_ = true;
            ENTITY::FREEZE_ENTITY_POSITION(me, true);
            ENTITY::SET_ENTITY_COORDS_NO_OFFSET(me, g.spawn.x, g.spawn.y, g.spawn.z, false, false, false);
            ENTITY::SET_ENTITY_HEADING(me, g.heading);
            probeAt_ = now;
            probeStage_ = 1;
            return;
        }
        STREAMING::REQUEST_COLLISION_AT_COORD(g.spawn.x, g.spawn.y, g.spawn.z);
        const Interior interior = INTERIOR::GET_INTERIOR_AT_COORDS(g.spawn.x, g.spawn.y, g.spawn.z);
        if (interior) {
            if (INTERIOR::IS_INTERIOR_DISABLED(interior)) INTERIOR::DISABLE_INTERIOR(interior, false);
            if (INTERIOR::IS_INTERIOR_CAPPED(interior)) INTERIOR::CAP_INTERIOR(interior, false);
            INTERIOR::PIN_INTERIOR_IN_MEMORY(interior);
        }
        if (probeStage_ == 1) {
            const bool ready = interior && INTERIOR::IS_INTERIOR_READY(interior);
            if (!((ready && now - probeAt_ > 2000) || now - probeAt_ > kInteriorStepMs)) return;
            const char* why = testCarModelState();
            DWORD waited = 0;
            if (!testCarWaitDone(now, why, waited)) return;
            for (const auto& [pos, heading] : g.slots) {
                Vehicle v = why ? 0 : makeTestCar(pos, heading);
                if (!v) log("probe:   garage " + it->first + ": the test car could not be made (" + (why ? why : "CREATE_VEHICLE returned 0") + ")");
                probeCars_.push_back(v);
            }
            probeAt_ = now;
            probeStage_ = 2;
            return;
        }
        if (probeStage_ == 2) {
            if (now - probeAt_ < 1500) return;
            log("probe-ui: garage " + it->first + " (" + std::to_string(probeCars_.size()) + " cars)");
            probeAt_ = now;
            probeStage_ = 3;
            return;
        }
        if (now - probeAt_ < kUiStepMs) return;
        for (Vehicle& v : probeCars_) deleteTestCar(v);
        probeCars_.clear();
        probeStage_ = 0;
        probeAt_ = 0;
        ++probeIndex_;
        return;
    }

    if (probeAt_ && now - probeAt_ < kUiStepMs) return;
    if (ui < base) {
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
    } else if (ui == base + garages) {
        probing_ = false;
        closeScreens();
        openChoice("Куда выйти?", {{"На улицу", nullptr}, {"В дом", nullptr}});
        log("probe-ui: exit menu");
    } else {
        probing_ = false;
        closeScreens();
        spawnOptions_ = {{"last", "Там, где вышел", "Grove Street", {}, false}, {"house", "Дом", "Grove Street, 1", {}, false}};
        openScreen(Screen::Spawn);
        log("probe-ui: spawn screen");
    }
    probeAt_ = now;
    if (++probeIndex_ - places == total) {
        releaseTestCarModel();
        log("probe: done (the last window stays)");
    }
}

}  // namespace gompgame
