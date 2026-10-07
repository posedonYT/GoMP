// GoMP game client: bridges the GoMP protocol and GTA V through ScriptHookV.
// Everything runs on the ScriptHookV script fiber (one call to tick() per frame).
#pragma once

#include <atomic>
#include <chrono>
#include <cstdio>
#include <deque>
#include <map>
#include <set>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "gomp/messages.hpp"
#include "gomp/transport.hpp"
#include "shv.hpp"
#include "ui.hpp"

namespace gompgame {

using gomp::Vec3;

struct Config {
    std::string host = "127.0.0.1";
    uint16_t port = 22005;
    std::string name = "Player";
    std::string serial;
    int interpolationDelayMs = 100;
};
Config loadConfig(const std::string& path);

// A sync sample of a remote entity, stamped with the local receive time.
struct Sample {
    gomp::TimePoint at;
    Vec3 pos, vel;
    gomp::Quat rot;
    float heading = 0;
    uint16_t flags = 0;
    gomp::MoveState move = gomp::MoveState::Idle;
};

struct RemotePlayer {
    uint16_t id = 0;
    std::string name;
    Hash model = 0;
    Ped ped = 0;
    Blip blip = 0;
    std::deque<Sample> samples;
    Vec3 aimPos;
    uint32_t weapon = 0;
    int health = 100, armour = 0;
    bool dead = false;
    uint16_t vehicle = gomp::kNoID;
    uint8_t seat = 0;
    uint16_t lastFlags = 0;
    Vec3 lastTaskTarget;
    gomp::TimePoint lastTaskAt;
    bool moveTask = false;      // a go-to task is running
    bool aimTask = false;       // an aim task is running
    Vec3 lastAimTarget;
    gomp::TimePoint lastAimAt;
    uint32_t pedWeapon = 0;     // weapon given to the ped
    gomp::TimePoint lastVehicleCheck;
    gomp::Props props;
    gomp::KV shared;
    Vec3 spawnPos;
    float spawnHeading = 0;
};

struct RemoteVehicle {
    uint16_t id = 0;
    Hash model = 0;
    Vehicle handle = 0;
    std::deque<Sample> samples;
    Vec3 spawnPos, spawnRot;
    gomp::Props props;
    gomp::KV shared;
    bool controlled = false;  // we send UnoccupiedSync for it
    uint16_t flags = 0;
    float steer = 0;
    float bodyHealth = 1000, engineHealth = 1000;
    uint16_t appliedFlags = 0xFFFF;  // flags already applied to the handle
};

// Static world entities (objects, peds, blips, markers, checkpoints, labels).
struct WorldEntity {
    gomp::EntityType type = gomp::EntityType::None;
    uint16_t id = 0;
    Hash model = 0;
    Vec3 pos, rot;
    gomp::Props props;
    gomp::KV shared;
    int handle = 0;  // game handle for objects, peds and blips
};

class GameClient {
public:
    explicit GameClient(Config cfg);
    ~GameClient();
    void tick();                                  // once per frame
    void onKey(DWORD key, bool down, bool alt);   // keyboard handler (any thread)

private:
    using Clock = std::chrono::steady_clock;

    // network
    void connect();
    void pump();
    void handle(const uint8_t* d, std::size_t n);
    template <typename M> void send(const M& m, gomp::Channel ch = gomp::Channel::Reliable) {
        net_->send(ch, gomp::marshal(m));
    }
    uint32_t clock() const;

    // entity messages
    void onCreate(const gomp::EntityCreate& c);
    void onDestroy(gomp::EntityType t, uint16_t id);
    void onProps(gomp::EntityType t, uint16_t id, const gomp::Props& p);
    void applySelfProps(const gomp::Props& p);
    void onSetPosition(const gomp::SetPosition& sp);
    void onLoadout(const gomp::Loadout& l);
    void onPutIntoVehicle(const gomp::PutIntoVehicle& p);
    void onVehicleTask(const gomp::VehicleTask& t);
    void onShot(const gomp::WeaponShotOut& s);
    void onInvoke(const gomp::Invoke& inv);
    void onAnim(const gomp::PlayAnim& a);
    void onScriptEvent(const gomp::ScriptEvent& e);
    void onProcCall(const gomp::ProcCall& c);

    // local player
    void syncLocal();
    void detectShots();
    void detectHits();
    void detectSelfDamage();
    void handleVehicleKeys();
    void sendVehicleSync(Vehicle veh);

    // remote entities
    void updateRemotes();
    void updateRemotePlayer(RemotePlayer& r);
    void updateRemoteVehicle(RemoteVehicle& v);
    void sendControlledVehicles();
    bool ensureModel(Hash model);
    Ped spawnRemotePed(RemotePlayer& r);
    Vehicle spawnRemoteVehicle(RemoteVehicle& v);
    void applyAppearance(Ped ped, const gomp::Props& p);
    void applyVehicleProps(Vehicle veh, const gomp::Props& p, RemoteVehicle* rv);
    void despawnPlayer(RemotePlayer& r);
    void despawnVehicle(RemoteVehicle& v);
    Vehicle vehicleHandle(uint16_t id) const;

    // world entities & UI
    void spawnWorldEntity(WorldEntity& e);
    void despawnWorldEntity(WorldEntity& e);
    void drawWorld();
    void drawUi();
    void notify(const std::string& text);
    void suppressPopulation();
    void clearAmbient();
    void killStoryScripts();
    std::vector<std::pair<int, std::string>> runningScripts() const;
    void logScripts();
    void removeForeignBlips();
    void restorePlayerState();
    void handlePauseMenu();
    bool uiBlocksPause();

    // login, character selection, character creator and the HUD (screens.cpp)
    enum class Screen { None, Login, Characters, Creator, Menu, Layout };
    bool lobbyScreen() const { return screen_ == Screen::Login || screen_ == Screen::Characters || screen_ == Screen::Creator; }
    struct CharInfo {
        int id = 0, statik = 0;
        std::string first, last;
        bool female = false;
        long long cash = 0, bank = 0;
    };
    struct Creator {
        bool female = false;
        std::string first, last;
        int father = 0, mother = 21;
        float shapeMix = 0.5f, skinMix = 0.5f;
        int hair = 0, hairColor = 0, eyeColor = 0, brows = 0, beard = -1;
        int top = 0, topTex = 0, torso = 0, undershirt = 15, legs = 0, legsTex = 0, shoes = 0, shoesTex = 0;
        int outfit = 0, kit = 0;
        bool dirty = true, needDefaults = true;
    };
    struct UiKey {
        DWORD key;
        std::string text;
        std::string latin;  // the same key in the US layout
    };
    bool handleUiEvent(const gomp::ScriptEvent& e);
    void openScreen(Screen s);
    void closeScreens();
    void tickScreens();
    void drawLogin();
    void drawCharacters();
    void drawCreator();
    void applyCreatorPreview();
    void dumpClothes();
    void dressOutfit(Ped ped, Creator& c);
    void submitLogin();
    void submitCreator();
    void drawHud();

    // HUD layout, settings, F2 menu, layout editor and the movable minimap (hud.cpp)
    struct Settings {
        float mapDX = 0, mapDY = 0;          // minimap offset from its default place (screen units)
        bool infoAttached = true;            // the money/location block sticks to the minimap
        float infoX = 0, infoY = 0;          // its top-left corner when detached
        float topX = 0.985f, topY = 0.012f;  // online/name block (top-right anchor)
        bool nametags = true, hud = true, perf = false;
    };
    struct Rect {
        float x = 0, y = 0, w = 0, h = 0;
        bool contains(float px, float py) const { return px >= x && px <= x + w && py >= y && py <= y + h; }
    };
    void loadSettings();
    void saveSettings();
    Rect minimapRect() const;
    Rect infoRect() const;
    Rect topRect() const;
    void startMinimapSearch();
    void applyMinimapPosition();
    void tickMinimap();
    void drawMenu();
    void drawLayout();
    void cancelLayout();
    bool uiButton(float x, float y, float w, float h, const std::string& text, bool primary = false, bool enabled = true);
    void uiTextField(float x, float y, float w, const std::string& label, std::string& value, bool password);
    int uiStepper(float x, float y, float w, const std::string& label, const std::string& value);
    void drawNameTags();

    // admin console (` key) and diagnostics
    void drawConsole();
    void runConsole(const std::string& line);
    void consolePrint(const std::string& text);
    void samplePerf(Clock::time_point frameStart);
    void drawPerf();
    void log(const std::string& text);

    Config cfg_;
    std::unique_ptr<gomp::Client> net_ = std::make_unique<gomp::Client>();
    std::vector<gomp::Message> inbox_;
    Clock::time_point epoch_ = Clock::now();
    Clock::time_point lastSync_{}, lastAmbientSweep_{}, lastConnectTry_{};
    std::string status_ = "connecting";
    bool populationInit_ = false;
    Clock::time_point lastScriptKill_{};
    std::set<std::string> knownScripts_;
    std::set<std::string> terminatedScripts_;  // already logged
    Hash pendingSelfModel_ = 0;  // player model waiting for streaming
    gomp::Props selfProps_;      // own appearance, re-applied after a model change

    // own state
    uint16_t myId_ = gomp::kNoID;
    bool readySent_ = false, spawned_ = false, dead_ = false;
    int serverHealth_ = 100, serverArmour_ = 0;
    uint32_t serverWeapon_ = 0;
    std::map<uint32_t, uint16_t> weapons_;
    uint16_t pendingTeleportSeq_ = 0;
    bool teleportPending_ = false;
    uint16_t myVehicle_ = gomp::kNoID;
    uint8_t mySeat_ = 0;
    uint16_t enteringVehicle_ = gomp::kNoID;
    uint8_t enteringSeat_ = 0;
    Clock::time_point enterStarted_{};
    bool exiting_ = false;
    uint16_t pendingPutVehicle_ = gomp::kNoID;
    uint8_t pendingPutSeat_ = 0;
    uint16_t shotSeq_ = 0;
    Clock::time_point lastShotAt_{};
    int lastLocalHealth_ = -1;

    std::unordered_map<uint16_t, RemotePlayer> players_;
    std::unordered_map<uint16_t, RemoteVehicle> vehicles_;
    std::map<std::pair<uint8_t, uint16_t>, WorldEntity> world_;

    // chat
    std::deque<std::string> chatLines_;
    bool chatOpen_ = false;
    std::string chatInput_;
    std::vector<std::string> pendingChat_;  // filled by the keyboard thread
    CRITICAL_SECTION chatLock_;

    // admin console: the input is written by the keyboard thread under chatLock_
    bool consoleOpen_ = false;
    std::string consoleInput_;
    std::vector<std::string> pendingConsole_;
    std::vector<std::string> consoleHistory_;
    std::size_t historyPos_ = 0;
    std::deque<std::string> consoleLines_;  // script thread only

    // diagnostics: real vs game frame time, own tick cost
    struct Perf {
        Clock::time_point lastFrame{}, windowStart{};
        double realSum = 0, gameSum = 0, tickSum = 0, tickMax = 0;
        int frames = 0;
        double fps = 0, timeScale = 1, tickAvgMs = 0, tickMaxMs = 0;
    } perf_;
    std::atomic<DWORD> escHandledAt_{0};  // Esc consumed by the chat/console (keyboard thread)
    std::atomic<ui::Lang> lang_{ui::Lang::En};  // input language for chat, console and fields
    std::string langTag() const { return lang_.load() == ui::Lang::Ru ? "[RU]" : "[EN]"; }

    // screens
    Screen screen_ = Screen::None;
    std::atomic<bool> screenActive_{false};  // read by the keyboard thread
    std::vector<UiKey> uiKeys_;               // under chatLock_
    std::string* focus_ = nullptr;
    std::vector<std::string*> focusOrder_, focusDrawn_;
    float mouseX_ = 0, mouseY_ = 0;
    bool mouseClick_ = false;
    std::string loginName_, loginPassword_, uiError_;
    bool registerMode_ = false, uiBusy_ = false;
    std::vector<CharInfo> chars_;
    int maxChars_ = 3;
    Creator creator_;
    Cam uiCam_ = 0;
    float creatorHeading_ = 0;
    int onlineCount_ = 0;
    gomp::KV selfShared_;  // own shared and own-only variables (cash, bank, static)

    // hud.cpp
    Settings settings_, layoutBackup_;
    int menuTab_ = 0;
    std::atomic<bool> menuRequested_{false};  // F2 (keyboard thread)
    float* minimapParts_[3] = {};               // minimap, minimap_mask, minimap_blur frontend data
    std::atomic<int> minimapSearch_{0};         // 0 idle, 1 running, 2 found, 3 not found
    int bigmapRefresh_ = 0;
    int dragging_ = -1;
    float dragDX_ = 0, dragDY_ = 0;
    FILE* log_ = nullptr;
};

// Seat mapping: GoMP/RAGE seat 0 is the driver, GTA's driver seat index is -1.
inline int gtaSeat(uint8_t seat) { return static_cast<int>(seat) - 1; }

}  // namespace gompgame
