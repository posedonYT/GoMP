// An empty world: no ambient peds, traffic, police or story-mode scripts.
// Only entities created for the server's entities (and the local player) exist.
#include <set>
#include <string>
#include <unordered_set>

#include "game_client.hpp"
#include "natives.hpp"
#include "props.hpp"

namespace gompgame {

namespace {

constexpr int kInputCharacterWheel = 19;
constexpr int kInputSpecialAbility = 28;
constexpr int kInputSpecialAbilitySecondary = 29;
constexpr int kInputSelectCharacterMichael = 166;  // F5..F8 character switch
constexpr int kInputSelectCharacterMultiplayer = 169;
constexpr int kMaxSweep = 1024;

// Game scripts that survive in GoMP; every other script (the whole story mode:
// mission flow, phone calls, texts and e-mails, character switching, shops,
// random characters, autosave...) is terminated as soon as it shows up.
// ScriptHookV runs our plugin in a game thread named "AudioTest".
bool keepScript(const std::string& name) {
    static const std::set<std::string> keep = {"AudioTest", "InGameHud", "error_listener"};
    return keep.count(name) || name.rfind("pausemenu", 0) == 0 || name.rfind("PauseMenu", 0) == 0;
}

constexpr int kInputPhone = 27;
constexpr int kInputFrontendPause = 199, kInputFrontendPauseAlternate = 200;
constexpr int kMaxBlipSprite = 900;
// HUD components: 1 wanted stars, 2 weapon icon, 3 cash, 4 MP cash, 5 MP message, 6 vehicle name,
// 7 area name, 8 vehicle class, 9 street name, 10 help text, 11-12 floating help, 13 cash change,
// 15 subtitles, 17 saving, 18 game stream, 20 weapon wheel stats, 21 HUD components, 22 HUD weapons.
constexpr int kHiddenHud[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17, 18, 20, 21, 22};

}  // namespace

void GameClient::suppressPopulation() {
    Player player = PLAYER::PLAYER_ID();
    if (!populationInit_) {
        populationInit_ = true;
        VEHICLE::SET_GARBAGE_TRUCKS(false);
        VEHICLE::SET_RANDOM_BOATS(false);
        VEHICLE::SET_RANDOM_TRAINS(false);
        VEHICLE::DELETE_ALL_TRAINS();
        VEHICLE::SET_DISTANT_CARS_ENABLED(false);
        VEHICLE::SET_NUMBER_OF_PARKED_VEHICLES(-1);
        VEHICLE::SET_ALL_LOW_PRIORITY_VEHICLE_GENERATORS_ACTIVE(false);
        VEHICLE::SET_ALL_VEHICLE_GENERATORS_ACTIVE_IN_AREA(-10000.0f, -10000.0f, -1000.0f, 10000.0f, 10000.0f, 1000.0f, false, false);
        GRAPHICS::DISABLE_VEHICLE_DISTANTLIGHTS(true);
        PED::SET_CREATE_RANDOM_COPS(false);
        PED::SET_CREATE_RANDOM_COPS_NOT_ON_SCENARIOS(false);
        PED::SET_CREATE_RANDOM_COPS_ON_SCENARIOS(false);
        for (int i = 1; i <= 15; ++i) MISC::ENABLE_DISPATCH_SERVICE(i, false);
        STREAMING::SET_PED_POPULATION_BUDGET(0);
        STREAMING::SET_VEHICLE_POPULATION_BUDGET(0);
        MISC::SET_FADE_OUT_AFTER_DEATH(false);
        MISC::SET_FADE_IN_AFTER_DEATH_ARREST(false);
        PLAYER::SET_PLAYER_CAN_BE_HASSLED_BY_GANGS(player, false);
        PLAYER::SET_DISPATCH_COPS_FOR_PLAYER(player, false);
        PLAYER::SET_POLICE_IGNORE_PLAYER(player, true);
        PLAYER::ENABLE_SPECIAL_ABILITY(player, false, 0);  // no story-mode bullet time / driving slow-mo
        killStoryScripts();
    }
    PED::SET_PED_DENSITY_MULTIPLIER_THIS_FRAME(0.0f);
    PED::SET_SCENARIO_PED_DENSITY_MULTIPLIER_THIS_FRAME(0.0f, 0.0f);
    VEHICLE::SET_VEHICLE_DENSITY_MULTIPLIER_THIS_FRAME(0.0f);
    VEHICLE::SET_RANDOM_VEHICLE_DENSITY_MULTIPLIER_THIS_FRAME(0.0f);
    VEHICLE::SET_PARKED_VEHICLE_DENSITY_MULTIPLIER_THIS_FRAME(0.0f);
    PLAYER::SET_MAX_WANTED_LEVEL(0);
    PLAYER::CLEAR_PLAYER_WANTED_LEVEL(player);
    // Death is handled by the server (respawn via SetPosition), not by the story mode.
    MISC::PAUSE_DEATH_ARREST_RESTART(true);
    MISC::IGNORE_NEXT_RESTART(true);
    PAD::DISABLE_CONTROL_ACTION(0, kInputCharacterWheel, true);
    // Story-mode special abilities slow the game down; GoMP never runs in slow motion.
    PAD::DISABLE_CONTROL_ACTION(0, kInputSpecialAbility, true);
    PAD::DISABLE_CONTROL_ACTION(0, kInputSpecialAbilitySecondary, true);
    if (PLAYER::IS_SPECIAL_ABILITY_ACTIVE(player, 0)) PLAYER::SPECIAL_ABILITY_DEACTIVATE_FAST(player, 0);
    MISC::SET_TIME_SCALE(1.0f);
    for (int c = kInputSelectCharacterMichael; c <= kInputSelectCharacterMultiplayer; ++c) PAD::DISABLE_CONTROL_ACTION(0, c, true);
    PAD::DISABLE_CONTROL_ACTION(0, kInputPhone, true);
    handlePauseMenu();
    // Only the minimap stays of the game HUD (plus the aiming reticle and the weapon/radio wheels,
    // which are controls rather than information); GoMP draws its own HUD.
    for (int c : kHiddenHud) HUD::HIDE_HUD_COMPONENT_THIS_FRAME(c);
    HUD::SET_MINIMAP_HIDE_FOW(true);  // the whole map is revealed

    auto now = Clock::now();
    if (now - lastScriptKill_ > std::chrono::seconds(1)) {
        lastScriptKill_ = now;
        killStoryScripts();
    }
    // The player model is applied once it has streamed in.
    if (pendingSelfModel_ && ensureModel(pendingSelfModel_)) {
        PLAYER::SET_PLAYER_MODEL(player, pendingSelfModel_);
        Ped me = PLAYER::PLAYER_PED_ID();
        PED::SET_PED_DEFAULT_COMPONENT_VARIATION(me);
        STREAMING::SET_MODEL_AS_NO_LONGER_NEEDED(pendingSelfModel_);
        if (!props::find(selfProps_, gomp::prop::HeadBlend))
            PED::SET_PED_HEAD_BLEND_DATA(me, 0, 0, 0, 0, 0, 0, 0.5f, 0.5f, 0.0f, false);
        applyAppearance(me, selfProps_);
        for (auto& [hash, ammo] : weapons_) WEAPON::GIVE_WEAPON_TO_PED(me, hash, ammo, false, false);
        if (serverWeapon_) WEAPON::SET_CURRENT_PED_WEAPON(me, serverWeapon_, true);
        pendingSelfModel_ = 0;
        ENTITY::SET_ENTITY_HEALTH(me, 100 + serverHealth_, 0, 0);
        PED::SET_PED_ARMOUR(me, serverArmour_);
        lastLocalHealth_ = ENTITY::GET_ENTITY_HEALTH(me);
    }
}

// The story-mode pause menu stops the whole game. Like GTA Online (and RAGECOOP),
// Esc opens the same menu without pausing: the world, the network and other
// players keep running.
void GameClient::handlePauseMenu() {
    for (int group : {0, 2}) {
        PAD::DISABLE_CONTROL_ACTION(group, kInputFrontendPause, true);
        PAD::DISABLE_CONTROL_ACTION(group, kInputFrontendPauseAlternate, true);
    }
    const bool pressed = PAD::IS_DISABLED_CONTROL_JUST_PRESSED(2, kInputFrontendPause) ||
                         PAD::IS_DISABLED_CONTROL_JUST_PRESSED(2, kInputFrontendPauseAlternate);
    if (!pressed || HUD::IS_PAUSE_MENU_ACTIVE() || uiBlocksPause()) return;
    HUD::ACTIVATE_FRONTEND_MENU(MISC::GET_HASH_KEY("FE_MENU_VERSION_SP_PAUSE"), false, -1);
}

void GameClient::killStoryScripts() {
    const int self = SCRIPT::GET_ID_OF_THIS_THREAD();
    for (auto& [id, name] : runningScripts()) {
        if (id == self || keepScript(name)) continue;
        SCRIPT::TERMINATE_THREAD(id);
        if (terminatedScripts_.insert(name).second) log("terminated story script: " + name);
    }
    logScripts();
    // Whatever the story scripts left behind: phone, conversations, map blips.
    restorePlayerState();
    GTA::DESTROY_MOBILE_PHONE();
    if (AUDIO::IS_SCRIPTED_CONVERSATION_ONGOING()) AUDIO::STOP_SCRIPTED_CONVERSATION(false);
    removeForeignBlips();
}

// Story scenes (player_timetable_scene, startup_positioning, cutscenes...) take the
// player's control away and restore it when they finish; when such a script is
// terminated mid-scene the player is left frozen. Undo everything they may leave behind.
void GameClient::restorePlayerState() {
    if (!spawned_ || dead_ || lobbyScreen()) return;
    Player player = PLAYER::PLAYER_ID();
    Ped me = PLAYER::PLAYER_PED_ID();
    if (CUTSCENE::IS_CUTSCENE_ACTIVE()) CUTSCENE::STOP_CUTSCENE_IMMEDIATELY();
    // Our own camera (the tuning shop) and fades (driving into the workshop, going
    // into a house) are left alone: switching script cameras off every second froze
    // the tuning view.
    const bool ownCamera = uiCam_ != 0 || tuneStage_ != 0 || houseFade_ != 0;
    if (!ownCamera) CAMERA::RENDER_SCRIPT_CAMS(false, false, 0, true, false, 0);
    if (!PLAYER::IS_PLAYER_CONTROL_ON(player)) {
        PLAYER::SET_PLAYER_CONTROL(player, true, 0);
        log("player control restored");
    }
    ENTITY::FREEZE_ENTITY_POSITION(me, false);
    ENTITY::SET_ENTITY_COLLISION(me, true, true);
    if (!ENTITY::IS_ENTITY_VISIBLE(me)) ENTITY::SET_ENTITY_VISIBLE(me, true, false);
    if (!ownCamera && CAMERA::IS_SCREEN_FADED_OUT() && !CAMERA::IS_SCREEN_FADING_OUT()) CAMERA::DO_SCREEN_FADE_IN(500);
    HUD::DISPLAY_HUD(true);
    HUD::DISPLAY_RADAR(true);
}

// Removes map blips that GoMP did not create (shops, story missions, safehouses...).
void GameClient::removeForeignBlips() {
    std::unordered_set<int> ours{HUD::GET_MAIN_PLAYER_BLIP_ID()};
    for (auto& [id, r] : players_)
        if (r.blip) ours.insert(r.blip);
    for (auto& [k, e] : world_)
        if (e.type == gomp::EntityType::Blip && e.handle) ours.insert(e.handle);
    for (const House& h : houses_)
        if (h.blip) ours.insert(h.blip);
    std::vector<Blip> foreign;
    for (int sprite = 0; sprite < kMaxBlipSprite; ++sprite)
        for (Blip b = HUD::GET_FIRST_BLIP_INFO_ID(sprite); HUD::DOES_BLIP_EXIST(b); b = HUD::GET_NEXT_BLIP_INFO_ID(sprite))
            if (!ours.count(b)) foreign.push_back(b);
    for (Blip b : foreign) HUD::REMOVE_BLIP(&b);
}

std::vector<std::pair<int, std::string>> GameClient::runningScripts() const {
    std::vector<std::pair<int, std::string>> out;
    SCRIPT::SCRIPT_THREAD_ITERATOR_RESET();
    for (int id = SCRIPT::SCRIPT_THREAD_ITERATOR_GET_NEXT_THREAD_ID(); id != 0; id = SCRIPT::SCRIPT_THREAD_ITERATOR_GET_NEXT_THREAD_ID()) {
        const char* name = SCRIPT::GET_NAME_OF_SCRIPT_WITH_THIS_ID(id);
        out.emplace_back(id, name ? name : "");
    }
    return out;
}

// Logs game scripts as they start and stop (used to tune the story-mode cleanup).
void GameClient::logScripts() {
    if (knownScripts_.empty()) {
        int self = SCRIPT::GET_ID_OF_THIS_THREAD();
        const char* name = SCRIPT::GET_NAME_OF_SCRIPT_WITH_THIS_ID(self);
        log("own script thread: id " + std::to_string(self) + " name \"" + (name ? name : "") + "\"");
    }
    std::set<std::string> now;
    for (auto& [id, name] : runningScripts()) now.insert(name);
    for (auto& n : now)
        if (!knownScripts_.count(n)) log("script running: " + n);
    for (auto& n : knownScripts_)
        if (!now.count(n)) log("script stopped: " + n);
    knownScripts_ = std::move(now);
}

void GameClient::clearAmbient() {
    Ped me = PLAYER::PLAYER_PED_ID();
    Vehicle myVeh = PED::GET_VEHICLE_PED_IS_IN(me, false);
    std::unordered_set<int> keep{me};
    if (myVeh) keep.insert(myVeh);
    for (auto& [id, r] : players_)
        if (r.ped) keep.insert(r.ped);
    for (auto& [id, v] : vehicles_)
        if (v.handle) keep.insert(v.handle);
    for (auto& [k, e] : world_)
        if (e.handle && e.type != gomp::EntityType::Blip) keep.insert(e.handle);

    static int buf[kMaxSweep];
    auto sweep = [&](int count) {
        for (int i = 0; i < count; ++i) {
            Entity e = buf[i];
            if (keep.count(e) || !ENTITY::DOES_ENTITY_EXIST(e)) continue;
            if (ENTITY::IS_ENTITY_A_PED(e) && PED::IS_PED_A_PLAYER(e)) continue;
            ENTITY::SET_ENTITY_AS_MISSION_ENTITY(e, true, true);
            ENTITY::DELETE_ENTITY(&e);
        }
    };
    sweep(shv::api.worldGetAllPeds(buf, kMaxSweep));
    sweep(shv::api.worldGetAllVehicles(buf, kMaxSweep));
}

}  // namespace gompgame
