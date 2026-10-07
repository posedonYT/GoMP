// Minimal ScriptHookV binding. Exports are resolved at runtime from
// ScriptHookV.dll by their MSVC-mangled names, so no SDK files or import
// libraries are needed and any compiler (MSVC, clang-cl, MinGW) works.
#pragma once

#ifndef _WIN32
#error "client/game targets Windows (GTA V + ScriptHookV)"
#endif

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <cstdint>
#include <cstring>
#include <type_traits>

typedef DWORD Void;
typedef DWORD Any;
typedef DWORD Hash;
typedef int Entity;
typedef int Player;
typedef int FireId;
typedef int Ped;
typedef int Vehicle;
typedef int Cam;
typedef int CarGenerator;
typedef int Group;
typedef int Train;
typedef int Pickup;
typedef int Object;
typedef int Weapon;
typedef int Interior;
typedef int Blip;
typedef int Texture;
typedef int TextureDict;
typedef int CoverPoint;
typedef int Camera;
typedef int TaskSequence;
typedef int ColourIndex;
typedef int Sphere;
typedef int ScrHandle;

// Natives exchange vectors as three 8-byte slots (a float and 4 bytes of padding each).
struct Vector3 {
    float x;
    uint32_t padX_ = 0;
    float y;
    uint32_t padY_ = 0;
    float z;
    uint32_t padZ_ = 0;
};
static_assert(sizeof(Vector3) == 24, "Vector3 must match the native ABI");

namespace shv {

using KeyboardHandler = void (*)(DWORD key, WORD repeats, BYTE scanCode, BOOL isExtended, BOOL isWithAlt,
                                 BOOL wasDownBefore, BOOL isUpNow);

struct Api {
    void (*nativeInit)(uint64_t hash) = nullptr;
    void (*nativePush64)(uint64_t value) = nullptr;
    uint64_t* (*nativeCall)() = nullptr;
    void (*scriptRegister)(HMODULE module, void (*main)()) = nullptr;
    void (*scriptUnregister)(HMODULE module) = nullptr;
    void (*scriptWait)(DWORD ms) = nullptr;
    void (*keyboardHandlerRegister)(KeyboardHandler) = nullptr;
    void (*keyboardHandlerUnregister)(KeyboardHandler) = nullptr;
    int (*worldGetAllPeds)(int* arr, int size) = nullptr;
    int (*worldGetAllVehicles)(int* arr, int size) = nullptr;
    int (*worldGetAllObjects)(int* arr, int size) = nullptr;
};

extern Api api;

// Loads ScriptHookV.dll and resolves the exports; false if anything is missing.
bool load();

inline void wait(DWORD ms) { api.scriptWait(ms); }

template <typename T> inline void push(T v) {
    static_assert(sizeof(T) <= sizeof(uint64_t), "native arguments are at most 8 bytes");
    uint64_t slot = 0;
    std::memcpy(&slot, &v, sizeof(T));
    api.nativePush64(slot);
}

}  // namespace shv

// Calls a native by its original (Legacy) hash.
template <typename R, typename... Args> inline R invoke(uint64_t hash, Args... args) {
    shv::api.nativeInit(hash);
    (shv::push(args), ...);
    if constexpr (std::is_void_v<R>) {
        shv::api.nativeCall();
    } else {
        return *reinterpret_cast<R*>(shv::api.nativeCall());
    }
}
