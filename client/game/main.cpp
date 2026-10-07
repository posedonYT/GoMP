// gomp.asi entry point: loaded by ScriptHookV's ASI loader into GTA V (Legacy, story mode).
#include <memory>

#include "game_client.hpp"
#include "shv.hpp"

namespace {

std::unique_ptr<gompgame::GameClient> g_client;
HMODULE g_module = nullptr;

void ScriptMain() {
    gompgame::Config cfg = gompgame::loadConfig("gomp.json");
    g_client = std::make_unique<gompgame::GameClient>(cfg);
    for (;;) {
        g_client->tick();
        shv::wait(0);
    }
}

void OnKeyboard(DWORD key, WORD, BYTE, BOOL, BOOL isWithAlt, BOOL, BOOL isUpNow) {
    if (g_client) g_client->onKey(key, !isUpNow, isWithAlt != FALSE);
}

}  // namespace

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
    switch (reason) {
        case DLL_PROCESS_ATTACH:
            g_module = module;
            if (!shv::load()) {
                MessageBoxA(nullptr, "GoMP: ScriptHookV.dll was not found or is incompatible.", "GoMP", MB_ICONERROR);
                return FALSE;
            }
            shv::api.scriptRegister(module, ScriptMain);
            shv::api.keyboardHandlerRegister(OnKeyboard);
            break;
        case DLL_PROCESS_DETACH:
            if (shv::api.scriptUnregister) {
                shv::api.scriptUnregister(module);
                shv::api.keyboardHandlerUnregister(OnKeyboard);
            }
            break;
    }
    return TRUE;
}
