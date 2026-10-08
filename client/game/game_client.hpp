// GoMP game client: bridges the GoMP protocol and GTA V through ScriptHookV.
// Everything runs on the ScriptHookV script fiber (one call to tick() per frame).
#pragma once

#include <atomic>
#include <chrono>
#include <cstdio>
#include <deque>
#include <functional>
#include <array>
#include <map>
#include <set>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "gomp/messages.hpp"
#include "logic.hpp"
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
    std::string probe;  // diagnostics: "houses" checks the house interiors and doors (probe.cpp)
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
    int appliedDoors = -1;           // open-door mask (shared "doors") applied to the handle
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
    bool placed = false;  // a dropped item laid on the ground
};

class GameClient {
public:
    explicit GameClient(Config cfg);
    ~GameClient();
    void tick();                                  // once per frame
    void onKey(DWORD key, bool down, bool alt, bool repeat = false);  // keyboard handler (any thread)

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
    enum class Screen { None, Login, Characters, Creator, Menu, Layout, Inventory, VehMenu, Shop, Fuel, Tuning, House, Phone };
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
public:  // plain data, also used by the settings table in hud.cpp
    struct Settings {
        float mapDX = 0, mapDY = 0;          // minimap offset from its default place (screen units)
        bool infoAttached = true;            // the money/location block sticks to the minimap
        float infoX = 0, infoY = 0;          // its top-left corner when detached
        float topX = 0.985f, topY = 0.012f;  // online/name block (top-right anchor)
        float hotbarX = 0.5f, hotbarY = 0.985f;  // hotbar strip (bottom-centre anchor)
        bool hotbarVertical = false;
        float ammoX = 0.985f, ammoY = 0.80f;     // ammo block (top-right anchor)
        float speedoX = 0.985f, speedoY = 0.97f; // speedometer (bottom-right anchor)
        bool nametags = true, hud = true, perf = false;
        // crosshair (F2 → «Прицел»)
        bool crossOn = true, crossOutline = true, crossDot = false, crossDynamic = true;
        int crossStyle = 0, crossColor = 0, crossAlpha = 100;  // alpha in %
        int crossLen = 7, crossThick = 2, crossGap = 4;        // pixels at 1080p
        // phone (phone.cpp)
        int phoneWallpaper = 0;
        bool phoneSound = true;
    };
    struct Rect {
        float x = 0, y = 0, w = 0, h = 0;
        bool contains(float px, float py) const { return px >= x && px <= x + w && py >= y && py <= y + h; }
    };

private:
    void loadSettings();
    void saveSettings();
    Rect minimapRect() const;
    Rect infoRect() const;
    Rect topRect() const;
    Rect hotbarRect() const;
    Rect ammoRect() const;
    Rect speedoRect() const;
    void drawCrosshair(bool preview, float cx, float cy);
    void drawAmmo();
    void drawSpeedometer();
    DWORD crossActiveAt_ = 0, lastShotSeenAt_ = 0;  // crosshair visibility and dynamic spread
    float speedoAlpha_ = 0;                          // speedometer fade (from YASM)
    void startMinimapSearch();
    void applyMinimapPosition();
    void tickMinimap();
    void drawMenu();

    // vehicles: fuel, engine, seat belt, locks, doors and the G menu (vehicle_ui.cpp)
    struct RadialItem {
        std::string title, sub;
        bool enabled = true;
        std::function<void()> action;
    };
    void tickVehicles();
    bool handleVehicleEvent(const gomp::ScriptEvent& e);
    RemoteVehicle* myRemoteVehicle();
    uint16_t nearestVehicle(float range) const;
    float vehicleFuel(const RemoteVehicle& v, float* tank = nullptr) const;
    std::string vehicleName(Vehicle veh) const;
    void openVehicleMenu();
    void drawVehicleMenu();
    void toggleEngine(Vehicle veh);
    void setBelt(bool on);
    int itemCount(const std::string& key) const;

    // gas stations, 24/7 shops and items on the ground (places.cpp)
    enum class PlaceKind { Fuel, Shop, Tune };
    struct Place {
        PlaceKind kind = PlaceKind::Shop;
        Vec3 pos;
        float radius = 0;
        Vec3 bay;              // tuning shops: where the vehicle stands inside
        float bayHeading = 0;
    };
    void tickPlaces(bool interact, bool hintTaken);
    bool handlePlacesEvent(const gomp::ScriptEvent& e);
    void drawHint(const std::string& key, const std::string& text);
    void drawShop();
    void drawFuel();

    // Los Santos Customs (tuning_ui.cpp)
    struct TuneState {
        std::map<int, int> mods;  // type -> index, -1 = stock (toggles: 0 on, -1 off)
        int primary = 0, secondary = 0, pearl = 0, wheelColor = 0, wheelType = 0, windowTint = 0, plateType = 0, livery = -1;
        bool neonOn = false;
        int neonR = 255, neonG = 255, neonB = 255;
    };
    enum class TuneKind { Mod, Toggle, Primary, Secondary, Pearl, WheelColor, WheelType, Tint, Neon, Plate, Livery };
    struct TuneCategory {
        std::string name;
        TuneKind kind = TuneKind::Mod;
        int modType = -1;
    };
    void enterTuning(uint16_t vehicle, const Place& shop);
    void tickTuningTransition();
    void openTuning(uint16_t vehicle);
    void setTuneView(int preset);
    void toggleTuneDoor(int door);
    void drawTuning();
    void endTuning();
    void tickTuningResync();
    TuneState readTuning(Vehicle veh) const;
    void previewTuning(Vehicle veh, const TuneState& s);
    int tuningPrice() const;
    gomp::Value tuningOrder() const;

    // houses and garages (houses.cpp)
    struct House {
        int id = 0;
        std::string name, cls;
        long long price = 0;
        Vec3 door;
        int owner = -1;  // static of the owner, -1 for sale
        std::string ownerName;
        bool locked = true;
        Blip blip = 0;
        float ground = 0;  // the ground under the door, for its marker
        bool grounded = false;
    };
    struct HouseClass {
        std::string name, interiorName;
        int garage = 0;
        Vec3 interior;
    };
    struct GarageCar {
        Hash model = 0;
        float fuel = 0;
        std::string plate;
        bool out = false;
    };
    struct HouseInfo {
        int id = -1;
        bool mine = false;
        long long sellPrice = 0;
        int cap = 0;
        std::vector<GarageCar> garage;
    };
    bool handleHousesEvent(const gomp::ScriptEvent& e);
    bool tickHouses(bool interact);  // true when it showed a hint (and took the E key)
    void drawHouse();
    void refreshHouseBlips();
    void clearHouseBlips();
    const House* houseById(int id) const;
    const House* myHouse() const;
    int myStatic() const;
    bool roadSpot(Vec3 around, Vec3& spot, float& heading) const;
    void garageTake(int house, int slot, bool release);
    void tickHouseFade();
    void tickProbe();
    struct ProbeTarget {
        std::string name;
        Vec3 pos;
        bool interior = false;
    };
    std::vector<ProbeTarget> probeTargets_;
    int probeIndex_ = -1;  // -1 not started
    DWORD probeAt_ = 0;
    bool probing_ = false;

    // the phone (phone.cpp)
    struct PhoneContact {
        std::string name, number;
    };
    struct PhoneSms {
        std::string number, text;
        bool out = false, read = true;
        long long at = 0;
    };
    struct PhoneBankEntry {
        long long at = 0, sum = 0;
        std::string text;
    };
    enum class PhoneApp { Home, Contacts, Contact, ContactEdit, Messages, Thread, NewMessage, Bank, Transfer, House, Gps, Settings };
    bool handlePhoneEvent(const gomp::ScriptEvent& e);
    void openPhone();
    void closePhone();
    void tickPhone();
    void drawPhone(bool submit);
    void phoneGo(PhoneApp app);
    std::string contactName(const std::string& number) const;
    int unreadSms() const;

    // inventory (inventory.cpp)
    struct ItemDef {
        std::string name, type, icon, desc;
        int stack = 1;
    };
    struct Slot {
        std::string key, label;
        int count = 0;
        long long uid = 0;
        bool empty() const { return key.empty(); }
    };
    struct InvRef {
        int container = -1, index = -1;  // 0 pockets, 1 hotbar, 2 equipment
        bool valid() const { return container >= 0; }
        bool operator==(const InvRef&) const = default;
    };
    void onInventoryDefs(const gomp::Value& defs);
    void onInventorySync(const gomp::Value& inv);
    void drawInventory();
    void drawHotbar();
    void drawSlot(InvRef ref, float x, float y, float w, float h, const char* caption);
    void drawIcon(const std::string& icon, float x, float y, float w, float h, ui::Rgba tint, int level = 0);
    Slot* slotAt(InvRef ref);
    void tickWeaponControls();
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
    std::pair<int, int> lastTopFix_{-1, -1};  // last arms/undershirt reported for our top

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

    // inventory.cpp
    std::unordered_map<std::string, ItemDef> itemDefs_;
    std::array<Slot, 24> pockets_;  // 6 x 4
    std::array<Slot, 9> hotbar_;
    std::array<Slot, 3> equip_;
    int heldSlot_ = -1;
    InvRef invSelected_, invPress_, invHover_;
    float invPressX_ = 0, invPressY_ = 0;
    bool invDragging_ = false;
    DWORD dropConfirmAt_ = 0;
    std::atomic<bool> inventoryRequested_{false};  // Tab (keyboard thread)
    std::atomic<int> hotkeyRequested_{0};          // 1-9 (keyboard thread)
    std::unordered_map<std::string, int> textures_;  // icon -> texture id, -1 when missing
    std::unordered_map<int, int> textureUses_;        // texture id -> instances drawn this frame

    // vehicle_ui.cpp
    bool belted_ = false;
    uint16_t classSentFor_ = gomp::kNoID;   // vehicle whose class went to the server
    uint16_t fuelEmptyFor_ = gomp::kNoID;    // vehicle whose empty tank keeps its engine off
    DWORD fobRequestedAt_ = 0;               // key fob animation waiting for its dictionary
    uint16_t menuVehicle_ = gomp::kNoID;    // the vehicle of the G menu
    std::vector<RadialItem> radial_;
    std::vector<std::pair<Vehicle, DWORD>> lockBlinks_;  // indicators flashing after lock/unlock
    std::atomic<bool> vehMenuRequested_{false}, lockRequested_{false}, beltRequested_{false}, interactRequested_{false};

    // tuning_ui.cpp
    uint16_t tuneVehicle_ = gomp::kNoID, tuneResyncVehicle_ = gomp::kNoID;
    TuneState tuneOrig_, tune_;
    std::vector<TuneCategory> tuneCats_;
    int tuneCat_ = 0, tuneCatScroll_ = 0, tuneOptScroll_ = 0;
    float tuneCamAngle_ = 0, tuneLastMouseX_ = -1;
    bool tuneBought_ = false;
    DWORD tuneResyncAt_ = 0;
    logic::TunePrices tunePrices_;
    // Driving into the workshop and back: 0 none, 1 fading out to go in, 2 loading the
    // interior, 3 in the menu, 4 fading out to leave.
    int tuneStage_ = 0;
    DWORD tuneStageAt_ = 0;
    uint16_t tuneEnterVehicle_ = gomp::kNoID;
    Vec3 tuneBay_, tuneReturnPos_;
    float tuneBayHeading_ = 0, tuneReturnHeading_ = 0;
    int tuneInterior_ = 0;
    logic::OrbitView tuneView_, tuneViewGoal_;
    float tuneLastMouseY_ = -1;
    bool tuneDoors_[6] = {};

    // houses.cpp
    std::vector<House> houses_;
    std::map<std::string, HouseClass> houseClasses_;
    HouseInfo houseInfo_;
    int houseMenu_ = -1;            // the house of the open window
    bool housePayByCard_ = false;
    DWORD houseSellConfirmAt_ = 0, releaseConfirmAt_ = 0;
    int releaseConfirmSlot_ = -1;
    int insideHouse_ = -1;          // the house the player is in, -1 outside
    int blipsStatic_ = -2;          // own static the house blips were coloured for
    Vec3 houseExit_;
    // Into a house and out: 1 faded out, waiting for the server; 2 there, waiting for the interior.
    int houseFade_ = 0;
    DWORD houseFadeAt_ = 0;
    Vec3 houseFadeTarget_;
    std::string houseFadeEvent_;    // sent once the screen is dark
    int houseFadeArg_ = 0;
    void startHouseFade(const std::string& event, int house);

    // phone.cpp
    std::atomic<bool> phoneRequested_{false};  // the up arrow (keyboard thread)
    PhoneApp phoneApp_ = PhoneApp::Home;
    std::vector<PhoneApp> phoneBack_;
    std::string phoneNumber_;
    std::vector<PhoneContact> contacts_;
    std::vector<PhoneSms> sms_;
    std::vector<PhoneBankEntry> bankLog_;
    std::string phoneThread_;               // the number of the open conversation or contact
    std::string phoneText_, phoneField1_, phoneField2_;
    int phoneScroll_ = 0;
    DWORD phoneOpenedAt_ = 0, phoneClosedAt_ = 0;
    bool phoneTask_ = false;                // the ped holds the phone
    DWORD phoneConfirmAt_ = 0;              // "delete the contact?" asked at

    // places.cpp
    std::vector<Place> places_;
    int fuelPrice_ = 2;
    std::vector<std::pair<std::string, int>> catalog_;  // item key, price
    int shopIndex_ = -1;
    std::map<std::string, int> shopQty_;
    bool payByCard_ = false;
    uint16_t fuelVehicle_ = gomp::kNoID;
    float fuelLitres_ = 0;

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

// Arms (3) or undershirt (8) the game forces for a top (screens.cpp).
int topForcedDrawable(Ped ped, int drawable, int texture, int type, int fallback);

// Seat mapping: GoMP/RAGE seat 0 is the driver, GTA's driver seat index is -1.
inline int gtaSeat(uint8_t seat) { return static_cast<int>(seat) - 1; }

}  // namespace gompgame
