// Network handling and message dispatch of the GoMP game client.
#include "game_client.hpp"

#include <cmath>

#include "natives.hpp"
#include "patches.hpp"
#include "props.hpp"

namespace gompgame {

using namespace gomp;

GameClient::GameClient(Config cfg) : cfg_(std::move(cfg)) {
    InitializeCriticalSection(&chatLock_);
    log_ = std::fopen("gomp.log", "w");
    lang_ = ui::systemLang();
    loadSettings();
    log("GoMP client started, server " + cfg_.host + ":" + std::to_string(cfg_.port) + ", name " + cfg_.name);
    for (const auto& line : patches::log()) log(line);
}

GameClient::~GameClient() {
    if (log_) std::fclose(log_);
    DeleteCriticalSection(&chatLock_);
}

void GameClient::log(const std::string& text) {
    if (!log_) return;
    SYSTEMTIME t;
    GetLocalTime(&t);
    std::fprintf(log_, "[%02d:%02d:%02d.%03d] %s\n", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, text.c_str());
    std::fflush(log_);
}

uint32_t GameClient::clock() const {
    return static_cast<uint32_t>(std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - epoch_).count());
}

void GameClient::connect() {
    ConnectInfo info;
    info.name = cfg_.name;
    info.serial = cfg_.serial;
    info.socialClub = cfg_.name;
    info.build = 0;
    std::string err;
    if (!net_->connect(cfg_.host, cfg_.port, info.marshal(), err)) {
        status_ = "connect error: " + err;
        log(status_);
        return;
    }
    status_ = "connecting to " + cfg_.host + ":" + std::to_string(cfg_.port);
    log(status_);
}

void GameClient::tick() {
    auto now = Clock::now();
    const auto frameStart = now;
    perf_.mark = now;
    suppressPopulation();
    perf_.lap(Perf::Population);
    // Console lines typed on the keyboard thread.
    EnterCriticalSection(&chatLock_);
    auto consoleLines = std::move(pendingConsole_);
    pendingConsole_.clear();
    LeaveCriticalSection(&chatLock_);
    for (auto& l : consoleLines) runConsole(l);
    if (net_->state() == Client::State::Idle ||
        ((net_->state() == Client::State::Disconnected || net_->state() == Client::State::Rejected) &&
         now - lastConnectTry_ > std::chrono::seconds(10))) {
        lastConnectTry_ = now;
        if (net_->state() != Client::State::Idle) {
            status_ = "disconnected (" + net_->reason() + "), reconnecting";
            log(status_);
            consolePrint("~r~" + status_);
            for (auto& [id, r] : players_) despawnPlayer(r);
            for (auto& [id, v] : vehicles_) despawnVehicle(v);
            for (auto& [k, e] : world_) despawnWorldEntity(e);
            closeScreens();
            clearHouseBlips();
            houses_.clear();
            clearHouseProps();
            housePropsWanted_.clear();
            insideHouse_ = -1;
            insideGarage_ = -1;
            spawnOptions_.clear();
            pendingAnims_.clear();
            dealerLoaded_ = false;
            dealerCars_.clear();
            orgBases_.clear();
            propertyView_ = {};
            orgView_ = {};
            storage_.clear();
            tpmPending_ = false;
            blipRound_ = false;
            houseFade_ = 0;
            houseFadeVehicle_ = 0;
            houseFadeHasHeading_ = false;
            houseFadeRequest_ = ScriptEvent{};
            CAMERA::DO_SCREEN_FADE_IN(0);
            selfShared_.clear();
            selfProps_.clear();
            players_.clear();
            vehicles_.clear();
            world_.clear();
            myId_ = gomp::kNoID;
            readySent_ = spawned_ = false;
            packages_.reset();
            packagesReady_ = false;
            net_ = std::make_unique<Client>();
        }
        connect();
    }
    net_->update(now);
    if (net_->state() == Client::State::Connected) {
        if (status_.rfind("connecting", 0) == 0) {
            log("connected");
            status_.clear();
        }
        pump();
        perf_.lap(Perf::Net);
        if (myId_ != gomp::kNoID && !readySent_ && tickPackages()) {
            send(Ready{});
            readySent_ = true;
        }
        if (now - lastAmbientSweep_ > std::chrono::milliseconds(500)) {
            lastAmbientSweep_ = now;
            clearAmbient();
        }
        // Chat lines typed on the keyboard thread.
        EnterCriticalSection(&chatLock_);
        auto lines = std::move(pendingChat_);
        pendingChat_.clear();
        LeaveCriticalSection(&chatLock_);
        // "/command" lines are commands: the client's own (/perf, /status...) or the server's.
        for (auto& l : lines) {
            if (!l.empty() && l[0] == '/') runConsole(l);
            else send(Chat{l});
        }

        if (spawned_) {
            handleVehicleKeys();
            detectShots();
            detectHits();
            detectSelfDamage();
            if (now - lastSync_ >= std::chrono::milliseconds(33)) {
                lastSync_ = now;
                syncLocal();
                sendControlledVehicles();
            }
        }
        updateRemotes();
        if (!pendingAnims_.empty()) tickAnims();
        perf_.lap(Perf::Remotes);
        tickHouseFade();  // also on the lobby screens (the spawn place fade)
        drawWorld();
        perf_.lap(Perf::World);
        drawHud();
        perf_.lap(Perf::Hud);
        net_->flush(now);
    } else if (net_->state() == Client::State::Rejected) {
        status_ = "rejected: " + net_->reason();
    }
    tickProbe();
    tickScreens();
    drawUi();
    drawConsole();
    perf_.lap(Perf::Ui);
    samplePerf(frameStart);
}

// The cache of one server's client_packages: <game>/gomp/cache/<host>_<port>/client_packages.
std::filesystem::path GameClient::packagesDir() const {
    char path[MAX_PATH] = {};
    GetModuleFileNameA(shv::module, path, MAX_PATH);
    std::filesystem::path dir = std::filesystem::path(path).parent_path() / "gomp" / "cache";
    std::string server = cfg_.host + "_" + std::to_string(cfg_.port);
    for (char& c : server)
        if (c == ':' || c == '/' || c == '\\') c = '_';
    return dir / server / "client_packages";
}

// Downloads the server's client_packages before the client says Ready (like RAGE.MP):
// the status line shows the progress. A server without them (or without fastdl) is
// not waited for.
bool GameClient::tickPackages() {
    if (packagesReady_) return true;
    if (!packages_) {
        packages_ = std::make_unique<gomp::fastdl::Downloader>();
        packages_->start(cfg_.host, static_cast<uint16_t>(cfg_.port + 1), packagesDir());
        log("client packages: " + packagesDir().string());
    }
    const auto p = packages_->progress();
    using State = gomp::fastdl::Downloader::State;
    if (p.state == State::Running) {
        const int pct = p.bytesTotal > 0 ? static_cast<int>(p.bytesDone * 100 / p.bytesTotal) : 0;
        status_ = "загрузка ресурсов сервера " + std::to_string(pct) + "% (" + std::to_string(p.filesDone) + "/" + std::to_string(p.filesTotal) + ")";
        return false;
    }
    if (p.state == State::Failed) log("client packages not downloaded: " + p.error);
    else log("client packages: " + std::to_string(packages_->files().size()) + " files, " + std::to_string(p.filesTotal) + " downloaded");
    if (status_.rfind("загрузка ресурсов", 0) == 0) status_.clear();
    packagesReady_ = true;
    return true;
}

void GameClient::pump() {
    inbox_.clear();
    net_->drain(inbox_);
    for (auto& m : inbox_) handle(m.data.data(), m.data.size());
}

void GameClient::handle(const uint8_t* d, std::size_t n) {
    MsgID id;
    if (!peekId(d, n, id)) return;
    switch (id) {
        case MsgID::Welcome: {
            Welcome w;
            if (!unmarshal(d, n, w)) return;
            myId_ = w.playerId;
            CLOCK::SET_CLOCK_TIME(w.hour, w.minute, w.second);
            CLOCK::PAUSE_CLOCK(true);
            if (!w.weather.empty()) MISC::SET_WEATHER_TYPE_NOW_PERSIST(w.weather.c_str());
            notify("~g~GoMP~s~: " + w.serverName);
            return;
        }
        case MsgID::EntityCreate: {
            EntityCreate c;
            if (unmarshal(d, n, c)) onCreate(c);
            return;
        }
        case MsgID::EntityDestroy: {
            EntityDestroy e;
            if (unmarshal(d, n, e)) onDestroy(e.type, e.id);
            return;
        }
        case MsgID::EntitySetProps: {
            EntitySetProps p;
            if (unmarshal(d, n, p)) onProps(p.type, p.id, p.props);
            return;
        }
        case MsgID::PlayerSyncOut: {
            PlayerSyncOut s;
            if (!unmarshal(d, n, s)) return;
            auto it = players_.find(s.playerId);
            if (it == players_.end()) return;
            RemotePlayer& r = it->second;
            Sample smp{Clock::now(), s.sync.pos, s.sync.vel, {}, s.sync.heading, s.sync.flags, s.sync.move};
            r.samples.push_back(smp);
            while (r.samples.size() > 20) r.samples.pop_front();
            r.aimPos = s.sync.aimPos;
            r.weapon = s.sync.weapon;
            return;
        }
        case MsgID::PassengerSyncOut: {
            PassengerSyncOut s;
            if (!unmarshal(d, n, s)) return;
            if (auto it = players_.find(s.playerId); it != players_.end()) {
                it->second.aimPos = s.sync.aimPos;
                it->second.weapon = s.sync.weapon;
                it->second.lastFlags = s.sync.flags;
            }
            return;
        }
        case MsgID::VehicleSyncOut: {
            VehicleSyncOut s;
            if (!unmarshal(d, n, s)) return;
            auto it = vehicles_.find(s.sync.vehicleId);
            if (it == vehicles_.end()) return;
            RemoteVehicle& v = it->second;
            if (myVehicle_ == v.id && mySeat_ == kSeatDriver) return;  // we simulate it
            Sample smp{Clock::now(), s.sync.pos, s.sync.vel, s.sync.rot, 0, s.sync.flags, MoveState::Idle};
            v.samples.push_back(smp);
            while (v.samples.size() > 20) v.samples.pop_front();
            v.flags = s.sync.flags;
            v.steer = s.sync.steer;
            v.bodyHealth = s.sync.bodyHealth;
            v.engineHealth = s.sync.engineHealth;
            return;
        }
        case MsgID::WeaponShotOut: {
            WeaponShotOut s;
            if (unmarshal(d, n, s)) onShot(s);
            return;
        }
        case MsgID::SharedData: {
            SharedData sd;
            if (!unmarshal(d, n, sd)) return;
            KV* target = nullptr;
            if (sd.type == EntityType::Player) {
                if (auto it = players_.find(sd.id); it != players_.end()) target = &it->second.shared;
            } else if (sd.type == EntityType::Vehicle) {
                if (auto it = vehicles_.find(sd.id); it != vehicles_.end()) target = &it->second.shared;
            } else if (auto it = world_.find({static_cast<uint8_t>(sd.type), sd.id}); it != world_.end()) {
                target = &it->second.shared;
            }
            if (sd.type == EntityType::Player && sd.id == myId_) target = &selfShared_;  // cash, bank, static
            if (!target) return;
            for (auto& [k, v] : sd.values) {
                std::erase_if(*target, [&](auto& kv) { return kv.first == k; });
                if (!v.isNil()) target->emplace_back(k, v);
            }
            return;
        }
        case MsgID::SetPosition: {
            SetPosition sp;
            if (unmarshal(d, n, sp)) onSetPosition(sp);
            return;
        }
        case MsgID::Loadout: {
            Loadout l;
            if (unmarshal(d, n, l)) onLoadout(l);
            return;
        }
        case MsgID::PutIntoVehicle: {
            PutIntoVehicle p;
            if (unmarshal(d, n, p)) onPutIntoVehicle(p);
            return;
        }
        case MsgID::EnterVehicleResponse: {
            EnterVehicleResponse r;
            if (!unmarshal(d, n, r)) return;
            Ped me = PLAYER::PLAYER_PED_ID();
            Vehicle veh = vehicleHandle(r.vehicleId);
            if (r.result == EnterResult::Allowed && veh) {
                enteringVehicle_ = r.vehicleId;
                enteringSeat_ = r.seat;
                enterStarted_ = Clock::now();
                TASK::TASK_ENTER_VEHICLE(me, veh, 10000, gtaSeat(r.seat), 1.0f, 1, nullptr);
            } else if (r.result == EnterResult::Locked) {
                notify("~r~Транспорт закрыт");
            }
            return;
        }
        case MsgID::VehicleTask: {
            VehicleTask t;
            if (unmarshal(d, n, t)) onVehicleTask(t);
            return;
        }
        case MsgID::ControllerAssign: {
            ControllerAssign c;
            if (!unmarshal(d, n, c)) return;
            if (auto it = vehicles_.find(c.vehicleId); it != vehicles_.end()) {
                it->second.controlled = c.controlled;
                it->second.samples.clear();
            }
            return;
        }
        case MsgID::World: {
            World w;
            if (!unmarshal(d, n, w)) return;
            CLOCK::SET_CLOCK_TIME(w.hour, w.minute, w.second);
            if (w.transitionMs > 0) MISC::SET_WEATHER_TYPE_OVERTIME_PERSIST(w.weather.c_str(), w.transitionMs / 1000.0f);
            else MISC::SET_WEATHER_TYPE_NOW_PERSIST(w.weather.c_str());
            return;
        }
        case MsgID::Ipl: {
            Ipl ipl;
            if (!unmarshal(d, n, ipl)) return;
            if (ipl.load) STREAMING::REQUEST_IPL(ipl.name.c_str());
            else STREAMING::REMOVE_IPL(ipl.name.c_str());
            return;
        }
        case MsgID::Chat: {
            Chat c;
            if (!unmarshal(d, n, c)) return;
            chatLines_.push_back(c.text);
            while (chatLines_.size() > 50) chatLines_.pop_front();
            return;
        }
        case MsgID::Notify: {
            Notify nt;
            if (unmarshal(d, n, nt)) notify(nt.text);
            return;
        }
        case MsgID::ScriptEvent: {
            ScriptEvent e;
            if (unmarshal(d, n, e)) onScriptEvent(e);
            return;
        }
        case MsgID::ProcCall: {
            ProcCall c;
            if (unmarshal(d, n, c)) onProcCall(c);
            return;
        }
        case MsgID::Invoke: {
            Invoke inv;
            if (unmarshal(d, n, inv)) onInvoke(inv);
            return;
        }
        case MsgID::PlayAnim: {
            PlayAnim a;
            if (unmarshal(d, n, a)) onAnim(a);
            return;
        }
        case MsgID::VehicleExplode: {
            VehicleExplode e;
            if (!unmarshal(d, n, e)) return;
            if (Vehicle veh = vehicleHandle(e.vehicleId)) VEHICLE::EXPLODE_VEHICLE(veh, true, false);
            return;
        }
        default:
            return;
    }
}

// ------------------------------------------------------------------ entities

void GameClient::onCreate(const EntityCreate& c) {
    switch (c.type) {
        case EntityType::Player: {
            if (c.id == myId_) {
                // The server's model (mp_m_freemode_01 by default) replaces the story character.
                Props p = c.props;
                if (c.model && !p.count(prop::Model)) p[prop::Model] = Value::integer(c.model);
                applySelfProps(p);
                return;
            }
            RemotePlayer& r = players_[c.id];
            despawnPlayer(r);
            r = RemotePlayer{};
            r.id = c.id;
            r.model = c.model;
            r.props = c.props;
            r.shared = c.shared;
            r.spawnPos = c.pos;
            if (auto it = c.props.find(prop::Heading); it != c.props.end()) r.spawnHeading = static_cast<float>(it->second.asNumber());
            onProps(EntityType::Player, c.id, c.props);
            return;
        }
        case EntityType::Vehicle: {
            RemoteVehicle& v = vehicles_[c.id];
            despawnVehicle(v);
            v = RemoteVehicle{};
            v.id = c.id;
            v.model = c.model;
            v.spawnPos = c.pos;
            v.spawnRot = c.rot;
            v.props = c.props;
            v.shared = c.shared;
            return;
        }
        default: {
            auto key = std::make_pair(static_cast<uint8_t>(c.type), c.id);
            WorldEntity& e = world_[key];
            despawnWorldEntity(e);
            e = WorldEntity{c.type, c.id, c.model, c.pos, c.rot, c.props, c.shared, 0};
            spawnWorldEntity(e);
            return;
        }
    }
}

void GameClient::onDestroy(EntityType t, uint16_t id) {
    if (t == EntityType::Player) {
        if (auto it = players_.find(id); it != players_.end()) {
            despawnPlayer(it->second);
            players_.erase(it);
        }
    } else if (t == EntityType::Vehicle) {
        if (auto it = vehicles_.find(id); it != vehicles_.end()) {
            despawnVehicle(it->second);
            vehicles_.erase(it);
        }
        if (myVehicle_ == id) myVehicle_ = kNoID;
    } else if (auto it = world_.find({static_cast<uint8_t>(t), id}); it != world_.end()) {
        despawnWorldEntity(it->second);
        world_.erase(it);
    }
}

void GameClient::onProps(EntityType t, uint16_t id, const Props& p) {
    if (t == EntityType::Player) {
        if (id == myId_) {
            applySelfProps(p);
            return;
        }
        auto it = players_.find(id);
        if (it == players_.end()) return;
        RemotePlayer& r = it->second;
        for (auto& [k, v] : p) {
            if (v.isNil()) r.props.erase(k);
            else r.props[k] = v;
            switch (k) {
                case prop::Name: r.name = v.s; break;
                case prop::Health: r.health = static_cast<int>(v.asInt()); break;
                case prop::Armour: r.armour = static_cast<int>(v.asInt()); break;
                case prop::Weapon: r.weapon = static_cast<uint32_t>(v.asInt()); break;
                case prop::Model:
                    r.model = static_cast<Hash>(v.asInt());
                    despawnPlayer(r);  // respawned with the new model next frame
                    break;
                case prop::Dead: {
                    bool dead = v.kind == Value::Kind::Bool && v.b;
                    if (r.ped && dead && !r.dead) ENTITY::SET_ENTITY_HEALTH(r.ped, 0, 0, 0);
                    if (r.ped && !dead && r.dead) {
                        PED::RESURRECT_PED(r.ped);
                        PED::REVIVE_INJURED_PED(r.ped);
                        ENTITY::SET_ENTITY_HEALTH(r.ped, 200, 0, 0);
                        TASK::CLEAR_PED_TASKS_IMMEDIATELY(r.ped);
                    }
                    r.dead = dead;
                    break;
                }
                case prop::Vehicle:
                    if (v.kind == Value::Kind::Array && v.arr.size() == 2) {
                        r.vehicle = static_cast<uint16_t>(v.arr[0].asInt());
                        r.seat = static_cast<uint8_t>(v.arr[1].asInt());
                        Vehicle veh = vehicleHandle(r.vehicle);
                        if (r.ped && veh) PED::SET_PED_INTO_VEHICLE(r.ped, veh, gtaSeat(r.seat));
                    } else {
                        r.vehicle = kNoID;
                    }
                    break;
                case prop::Alpha:
                    if (r.ped) ENTITY::SET_ENTITY_ALPHA(r.ped, static_cast<int>(v.asInt()), false);
                    break;
                default: break;
            }
        }
        if (r.ped) applyAppearance(r.ped, p);
        return;
    }
    if (t == EntityType::Vehicle) {
        auto it = vehicles_.find(id);
        if (it == vehicles_.end()) return;
        RemoteVehicle& v = it->second;
        for (auto& [k, val] : p) {
            if (val.isNil()) v.props.erase(k);
            else v.props[k] = val;
        }
        if (v.handle) applyVehicleProps(v.handle, p, &v);
        return;
    }
    auto it = world_.find({static_cast<uint8_t>(t), id});
    if (it == world_.end()) return;
    WorldEntity& e = it->second;
    std::vector<uint8_t> changed;
    changed.reserve(p.size());
    for (auto& [k, v] : p) {
        if (v.isNil()) e.props.erase(k);
        else e.props[k] = v;
        if (k == prop::Position && v.kind == Value::Kind::Vec3) e.pos = v.v;
        if (k == prop::Rotation && v.kind == Value::Kind::Vec3) e.rot = v.v;
        changed.push_back(k);
    }
    // A moved, turned or faded object (doors, lifts, scripted props) is changed in
    // place: recreating it for every step of an animation cost a model request and
    // a new object per update. Anything else is recreated with the new state.
    if (e.type == EntityType::Object && e.handle && ENTITY::DOES_ENTITY_EXIST(e.handle) && budget::appliesInPlace(changed)) {
        for (uint8_t k : changed) {
            switch (k) {
                case prop::Position:
                    ENTITY::SET_ENTITY_COORDS_NO_OFFSET(e.handle, e.pos.x, e.pos.y, e.pos.z, false, false, false);
                    e.placed = false;  // a dropped item is laid on the ground again
                    break;
                case prop::Rotation: ENTITY::SET_ENTITY_ROTATION(e.handle, e.rot.x, e.rot.y, e.rot.z, 2, true); break;
                case prop::Alpha:
                    if (int a = props::integer(e.props, prop::Alpha, 255); a < 255) ENTITY::SET_ENTITY_ALPHA(e.handle, a, false);
                    else ENTITY::RESET_ENTITY_ALPHA(e.handle);
                    break;
                case prop::Visible: ENTITY::SET_ENTITY_VISIBLE(e.handle, props::flag(e.props, prop::Visible, true), false); break;
                default: break;
            }
        }
        return;
    }
    despawnWorldEntity(e);
    spawnWorldEntity(e);
}

void GameClient::applySelfProps(const Props& p) {
    Ped me = PLAYER::PLAYER_PED_ID();
    for (auto& [k, v] : p) {
        if (v.isNil()) selfProps_.erase(k);
        else selfProps_[k] = v;
    }
    for (auto& [k, v] : p) {
        switch (k) {
            case prop::Health:
                serverHealth_ = static_cast<int>(v.asInt());
                if (!dead_) ENTITY::SET_ENTITY_HEALTH(me, 100 + serverHealth_, 0, 0);
                lastLocalHealth_ = ENTITY::GET_ENTITY_HEALTH(me);
                break;
            case prop::Armour:
                serverArmour_ = static_cast<int>(v.asInt());
                PED::SET_PED_ARMOUR(me, serverArmour_);
                break;
            case prop::Dead: {
                bool dead = v.kind == Value::Kind::Bool && v.b;
                if (dead && !dead_) ENTITY::SET_ENTITY_HEALTH(me, 0, 0, 0);
                dead_ = dead;
                break;
            }
            case prop::Model: {
                // Applied by suppressPopulation() once the model has streamed in.
                auto model = static_cast<Hash>(v.asInt());
                if (model && model != ENTITY::GET_ENTITY_MODEL(me) && STREAMING::IS_MODEL_IN_CDIMAGE(model)) {
                    pendingSelfModel_ = model;
                    ensureModel(model);
                }
                break;
            }
            default: break;
        }
    }
    applyAppearance(me, p);

    // Clothes given by the server may come with the wrong arms: the game knows the right
    // ones for each top, so report them and the server stores them with the item.
    const Value* clothes = props::find(selfProps_, prop::Clothes);
    if (props::find(p, prop::Clothes) && clothes && clothes->kind == Value::Kind::Map && !pendingSelfModel_) {
        const Value* top = clothes->get("11");
        const Value* torso = clothes->get("3");
        if (top && top->kind == Value::Kind::Array) {
            int drawable = static_cast<int>(props::at(*top, 0)), texture = static_cast<int>(props::at(*top, 1));
            int arms = topForcedDrawable(me, drawable, texture, 3, -1);
            int under = topForcedDrawable(me, drawable, texture, 8, -1);
            int current = torso ? static_cast<int>(props::at(*torso, 0)) : -1;
            if (arms >= 0 && arms != current && lastTopFix_ != std::make_pair(drawable, arms)) {
                lastTopFix_ = {drawable, arms};
                send(ScriptEvent{"gomp:inv:fixtop", {Value::integer(arms), Value::integer(under)}});
            }
        }
    }
}

void GameClient::onSetPosition(const SetPosition& sp) {
    Ped me = PLAYER::PLAYER_PED_ID();
    if (sp.reason == PosReason::Spawn) {
        if (ENTITY::IS_ENTITY_DEAD(me, false) || dead_) {
            // Story-mode death screens must not run; resurrect in place.
            MISC::SET_FADE_OUT_AFTER_DEATH(false);
            PED::RESURRECT_PED(me);
            PED::REVIVE_INJURED_PED(me);
            TASK::CLEAR_PED_TASKS_IMMEDIATELY(me);
        }
        dead_ = false;
        ENTITY::SET_ENTITY_HEALTH(me, 200, 0, 0);
        lastLocalHealth_ = 200;
        if (!spawned_) {
            spawned_ = true;
            if (houseFade_ == 0) CAMERA::DO_SCREEN_FADE_IN(500);  // a fade for the house spawn fades in itself
        }
        if (!PED::IS_PED_IN_ANY_VEHICLE(me, false)) TASK::CLEAR_PED_TASKS_IMMEDIATELY(me);  // drop story-scene tasks
        restorePlayerState();
    }
    STREAMING::REQUEST_COLLISION_AT_COORD(sp.pos.x, sp.pos.y, sp.pos.z);
    Vehicle veh = PED::IS_PED_IN_ANY_VEHICLE(me, false) ? PED::GET_VEHICLE_PED_IS_IN(me, false) : 0;
    Entity target = (veh && mySeat_ == kSeatDriver) ? veh : me;
    ENTITY::SET_ENTITY_COORDS_NO_OFFSET(target, sp.pos.x, sp.pos.y, sp.pos.z, false, false, false);
    if (!std::isnan(sp.heading)) ENTITY::SET_ENTITY_HEADING(target, sp.heading);
    send(TeleportAck{sp.seq});
}

void GameClient::onLoadout(const Loadout& l) {
    Ped me = PLAYER::PLAYER_PED_ID();
    WEAPON::REMOVE_ALL_PED_WEAPONS(me, true);
    weapons_.clear();
    for (const auto& w : l.weapons) {
        WEAPON::GIVE_WEAPON_TO_PED(me, w.hash, w.ammo, false, false);
        WEAPON::SET_PED_AMMO(me, w.hash, w.ammo, false);
        weapons_[w.hash] = w.ammo;
    }
    serverWeapon_ = l.current;
    WEAPON::SET_CURRENT_PED_WEAPON(me, l.current, true);
}

void GameClient::onPutIntoVehicle(const PutIntoVehicle& p) {
    Ped me = PLAYER::PLAYER_PED_ID();
    enteringVehicle_ = kNoID;
    if (p.vehicleId == kNoID) {
        if (PED::IS_PED_IN_ANY_VEHICLE(me, false)) TASK::TASK_LEAVE_VEHICLE(me, PED::GET_VEHICLE_PED_IS_IN(me, false), 16);
        myVehicle_ = kNoID;
        return;
    }
    Vehicle veh = vehicleHandle(p.vehicleId);
    if (!veh) {  // not spawned yet: retried once the vehicle exists
        pendingPutVehicle_ = p.vehicleId;
        pendingPutSeat_ = p.seat;
        return;
    }
    PED::SET_PED_INTO_VEHICLE(me, veh, gtaSeat(p.seat));
    myVehicle_ = p.vehicleId;
    mySeat_ = p.seat;
}

void GameClient::onVehicleTask(const VehicleTask& t) {
    auto it = players_.find(t.playerId);
    if (it == players_.end() || !it->second.ped) return;
    RemotePlayer& r = it->second;
    Vehicle veh = vehicleHandle(t.vehicleId);
    switch (t.task) {
        case TaskKind::EnterStart:
            if (veh) TASK::TASK_ENTER_VEHICLE(r.ped, veh, 10000, gtaSeat(t.seat), 2.0f, 1, nullptr);
            break;
        case TaskKind::EnterWarp:
            r.vehicle = t.vehicleId;
            r.seat = t.seat;
            if (veh) PED::SET_PED_INTO_VEHICLE(r.ped, veh, gtaSeat(t.seat));
            break;
        case TaskKind::ExitStart:
            if (veh) TASK::TASK_LEAVE_VEHICLE(r.ped, veh, 0);
            break;
        case TaskKind::ExitWarp:
            r.vehicle = kNoID;
            if (PED::IS_PED_IN_ANY_VEHICLE(r.ped, false)) TASK::TASK_LEAVE_VEHICLE(r.ped, PED::GET_VEHICLE_PED_IS_IN(r.ped, false), 16);
            break;
    }
}

void GameClient::onShot(const WeaponShotOut& s) {
    auto it = players_.find(s.playerId);
    if (it == players_.end() || !it->second.ped) return;
    Ped shooter = it->second.ped;
    const WeaponShot& w = s.shot;
    // Visual and audible bullet with no damage: damage is decided by the server.
    WEAPON::GIVE_WEAPON_TO_PED(shooter, w.weapon, 9999, false, true);
    MISC::SHOOT_SINGLE_BULLET_BETWEEN_COORDS(w.origin.x, w.origin.y, w.origin.z, w.target.x, w.target.y, w.target.z, 0,
                                             true, w.weapon, shooter, true, false, -1.0f);
}

void GameClient::onScriptEvent(const ScriptEvent& e) {
    if (handleUiEvent(e) || handleVehicleEvent(e) || handlePlacesEvent(e) || handleHousesEvent(e) || handlePhoneEvent(e) || handleDealerEvent(e) ||
        handleOrgEvent(e) || handleAdminEvent(e))
        return;
    if (e.name == "__gomp:blipRoute" && !e.args.empty() && e.args[0].kind == Value::Kind::Entity) {
        auto it = world_.find({static_cast<uint8_t>(EntityType::Blip), e.args[0].e.id});
        bool on = e.args.size() > 1 && e.args[1].b;
        if (it != world_.end() && it->second.handle) {
            HUD::SET_BLIP_ROUTE(it->second.handle, on);
            if (on && e.args.size() > 2) HUD::SET_BLIP_ROUTE_COLOUR(it->second.handle, static_cast<int>(e.args[2].asInt()));
        }
        return;
    }
    // Client-side scripts (client_packages) arrive in phase 2.
}

void GameClient::onProcCall(const ProcCall& c) {
    // Without client scripts (phase 2) every procedure is unknown.
    ProcResult r;
    r.callId = c.callId;
    r.ok = false;
    r.error = "no client procedure " + c.name;
    send(r);
}

void GameClient::onInvoke(const Invoke& inv) {
    // player.invoke(hash, ...args): ints, floats, bools, strings and vectors.
    std::vector<std::string> strings;  // keep C strings alive during the call
    strings.reserve(inv.args.size());
    shv::api.nativeInit(inv.hash);
    for (const auto& a : inv.args) {
        switch (a.kind) {
            case Value::Kind::Int: shv::push(static_cast<int64_t>(a.i)); break;
            case Value::Kind::Float: shv::push(static_cast<float>(a.f)); break;
            case Value::Kind::Bool: shv::push(static_cast<int>(a.b)); break;
            case Value::Kind::String:
                strings.push_back(a.s);
                shv::push(strings.back().c_str());
                break;
            case Value::Kind::Vec3:
                shv::push(a.v.x);
                shv::push(a.v.y);
                shv::push(a.v.z);
                break;
            case Value::Kind::Entity: {
                int handle = 0;
                if (a.e.type == EntityType::Player) {
                    if (a.e.id == myId_) handle = PLAYER::PLAYER_PED_ID();
                    else if (auto it = players_.find(a.e.id); it != players_.end()) handle = it->second.ped;
                } else if (a.e.type == EntityType::Vehicle) {
                    handle = vehicleHandle(a.e.id);
                }
                shv::push(handle);
                break;
            }
            default: shv::push(0); break;
        }
    }
    shv::api.nativeCall();
}

void GameClient::onAnim(const PlayAnim& a) {
    Ped ped = 0;
    if (a.playerId == myId_) ped = PLAYER::PLAYER_PED_ID();
    else if (auto it = players_.find(a.playerId); it != players_.end()) ped = it->second.ped;
    if (!ped) return;
    // A newer animation (or a stop) replaces one still waiting for its dictionary.
    std::erase_if(pendingAnims_, [&](const PendingAnim& p) { return p.anim.playerId == a.playerId; });
    if (a.stop) {
        TASK::CLEAR_PED_TASKS(ped);
        return;
    }
    if (a.dict == "@scenario") {
        TASK::TASK_START_SCENARIO_IN_PLACE(ped, a.name.c_str(), 0, true);
        return;
    }
    // Played in the frame its dictionary is loaded: waiting here stopped the whole
    // client (network, HUD, other players) for up to 100 frames.
    STREAMING::REQUEST_ANIM_DICT(a.dict.c_str());
    pendingAnims_.push_back({a, Clock::now()});
    tickAnims();
}

void GameClient::tickAnims() {
    constexpr auto kAnimLoadTimeout = std::chrono::seconds(5);
    const auto now = Clock::now();
    std::erase_if(pendingAnims_, [&](const PendingAnim& p) {
        const PlayAnim& a = p.anim;
        Ped ped = 0;
        if (a.playerId == myId_) ped = PLAYER::PLAYER_PED_ID();
        else if (auto it = players_.find(a.playerId); it != players_.end()) ped = it->second.ped;
        if (!ped || now - p.since > kAnimLoadTimeout) return true;
        if (!STREAMING::HAS_ANIM_DICT_LOADED(a.dict.c_str())) return false;
        TASK::TASK_PLAY_ANIM(ped, a.dict.c_str(), a.name.c_str(), a.speed, -a.speed, -1, a.flag, 0, false, false, false);
        return true;
    });
}

}  // namespace gompgame
