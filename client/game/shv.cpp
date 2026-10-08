#include "shv.hpp"

namespace shv {

Api api;
HMODULE module = nullptr;

namespace {
template <typename F> bool resolve(HMODULE m, const char* mangled, F& out) {
    out = reinterpret_cast<F>(GetProcAddress(m, mangled));
    return out != nullptr;
}
}  // namespace

bool load() {
    HMODULE m = GetModuleHandleA("ScriptHookV.dll");
    if (!m) m = LoadLibraryA("ScriptHookV.dll");
    if (!m) return false;
    // MSVC x64 decorated names of the ScriptHookV SDK functions.
    bool ok = resolve(m, "?nativeInit@@YAX_K@Z", api.nativeInit) &&
              resolve(m, "?nativePush64@@YAX_K@Z", api.nativePush64) &&
              resolve(m, "?nativeCall@@YAPEA_KXZ", api.nativeCall) &&
              resolve(m, "?scriptRegister@@YAXPEAUHINSTANCE__@@P6AXXZ@Z", api.scriptRegister) &&
              resolve(m, "?scriptUnregister@@YAXPEAUHINSTANCE__@@@Z", api.scriptUnregister) &&
              resolve(m, "?scriptWait@@YAXK@Z", api.scriptWait) &&
              resolve(m, "?keyboardHandlerRegister@@YAXP6AXKGEHHHH@Z@Z", api.keyboardHandlerRegister) &&
              resolve(m, "?keyboardHandlerUnregister@@YAXP6AXKGEHHHH@Z@Z", api.keyboardHandlerUnregister) &&
              resolve(m, "?worldGetAllPeds@@YAHPEAHH@Z", api.worldGetAllPeds) &&
              resolve(m, "?worldGetAllVehicles@@YAHPEAHH@Z", api.worldGetAllVehicles) &&
              resolve(m, "?worldGetAllObjects@@YAHPEAHH@Z", api.worldGetAllObjects);
    resolve(m, "?createTexture@@YAHPEBD@Z", api.createTexture);
    resolve(m, "?drawTexture@@YAXHHHHMMMMMMMMMMMM@Z", api.drawTexture);
    return ok;
}

}  // namespace shv
