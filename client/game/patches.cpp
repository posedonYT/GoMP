// In-memory patches of GTA5.exe applied when the plugin loads (before the game
// starts its front end). Every patch locates its code by a byte signature and
// checks the surrounding instructions; when anything does not match (another
// game build) the patch is skipped and the game runs unmodified.
//
// Signatures and patch ideas:
//  - landing page: the "should show the landing page" check is made to return
//    false, as in StraightToStoryMode (Chiheb-Bacha, alloc8or);
//  - weapon/radio wheel slow motion and vignette: RAGECOOP / CamxxCore
//    GTAVWeaponWheelMod.
#include "patches.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <optional>
#include <string>
#include <vector>

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

namespace gompgame::patches {
namespace {

std::vector<std::string> g_log;

struct Pattern {
    std::vector<uint8_t> bytes;
    std::vector<bool> mask;  // true = must match
};

// "E8 ? ? ? ? 84 C0" style signatures.
Pattern parse(const char* sig) {
    Pattern p;
    for (const char* s = sig; *s;) {
        if (*s == ' ') {
            ++s;
        } else if (*s == '?') {
            p.bytes.push_back(0);
            p.mask.push_back(false);
            while (*s == '?') ++s;
        } else {
            p.bytes.push_back(static_cast<uint8_t>(std::strtoul(std::string(s, 2).c_str(), nullptr, 16)));
            p.mask.push_back(true);
            s += 2;
        }
    }
    return p;
}

// Searches the executable sections of the main module; returns the first match and the match count.
std::optional<uint8_t*> find(const char* sig, int* count = nullptr) {
    const Pattern p = parse(sig);
    auto* base = reinterpret_cast<uint8_t*>(GetModuleHandleA(nullptr));
    auto* dos = reinterpret_cast<IMAGE_DOS_HEADER*>(base);
    auto* nt = reinterpret_cast<IMAGE_NT_HEADERS*>(base + dos->e_lfanew);
    auto* section = IMAGE_FIRST_SECTION(nt);
    std::optional<uint8_t*> first;
    int matches = 0;
    for (int i = 0; i < nt->FileHeader.NumberOfSections; ++i, ++section) {
        if (!(section->Characteristics & IMAGE_SCN_MEM_EXECUTE)) continue;
        uint8_t* begin = base + section->VirtualAddress;
        uint8_t* end = begin + section->Misc.VirtualSize;
        // Walk committed, readable regions only.
        for (uint8_t* region = begin; region < end;) {
            MEMORY_BASIC_INFORMATION mbi{};
            if (!VirtualQuery(region, &mbi, sizeof(mbi))) break;
            uint8_t* rEnd = std::min(end, static_cast<uint8_t*>(mbi.BaseAddress) + mbi.RegionSize);
            const DWORD readable = PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY | PAGE_READONLY | PAGE_READWRITE;
            if (mbi.State == MEM_COMMIT && (mbi.Protect & readable) && !(mbi.Protect & PAGE_GUARD)) {
                for (uint8_t* at = region; at + p.bytes.size() <= rEnd; ++at) {
                    bool ok = true;
                    for (std::size_t k = 0; k < p.bytes.size(); ++k)
                        if (p.mask[k] && at[k] != p.bytes[k]) {
                            ok = false;
                            break;
                        }
                    if (ok) {
                        if (!first) first = at;
                        ++matches;
                    }
                }
            }
            region = rEnd;
        }
    }
    if (count) *count = matches;
    return first;
}

uint8_t* relTarget(uint8_t* rel32) { return rel32 + 4 + *reinterpret_cast<int32_t*>(rel32); }

void write(uint8_t* at, const void* data, std::size_t n) {
    DWORD old;
    VirtualProtect(at, n, PAGE_EXECUTE_READWRITE, &old);
    std::memcpy(at, data, n);
    VirtualProtect(at, n, old, &old);
    FlushInstructionCache(GetCurrentProcess(), at, n);
}

void skipLandingPage() {
    int n = 0;
    auto hit = find("E8 ? ? ? ? 84 C0 8B 05 ? ? ? ? 74 ? 83 C0", &n);
    if (!hit) {
        g_log.push_back("patch landing page: signature not found, skipped");
        return;
    }
    uint8_t* fn = relTarget(*hit + 1);
    static const uint8_t kReturnFalse[] = {0x31, 0xC0, 0xC3};  // xor eax, eax; ret
    write(fn, kReturnFalse, sizeof(kReturnFalse));
    g_log.push_back("patch landing page: applied (" + std::to_string(n) + " match)");
}

void removeWheelSlowMotion() {
    int n = 0;
    auto hit = find("38 51 64 74 19", &n);
    if (!hit) {
        g_log.push_back("patch weapon wheel slow-mo: signature not found, skipped");
        return;
    }
    uint8_t* r = *hit;
    if (r[8] != 0xE8 || r[25] != 0xE8) {  // both must be call instructions
        g_log.push_back("patch weapon wheel slow-mo: unexpected code, skipped");
        return;
    }
    static const uint8_t kRet[] = {0xC3, 0x90, 0x90, 0x90, 0x90};
    static const uint8_t kNop5[] = {0x90, 0x90, 0x90, 0x90, 0x90};
    static const uint8_t kXorEdx[] = {0x31, 0xD2};  // time scale argument = 0 (no slow-down)
    write(relTarget(r + 26), kRet, sizeof(kRet));    // vignette effect
    write(r + 8, kNop5, sizeof(kNop5));              // its call
    write(r + 34, kXorEdx, sizeof(kXorEdx));         // time scale
    g_log.push_back("patch weapon wheel slow-mo: applied (" + std::to_string(n) + " match)");
}

}  // namespace

void apply() {
    skipLandingPage();
    removeWheelSlowMotion();
    // The client log starts only once the game has loaded: a crash while loading
    // would hide the patch results, so they are written at once as well.
    if (FILE* f = std::fopen("gomp-boot.log", "w")) {
        for (const auto& line : g_log) {
            std::fputs(line.c_str(), f);
            std::fputc('\n', f);
        }
        std::fclose(f);
    }
}

const std::vector<std::string>& log() { return g_log; }

}  // namespace gompgame::patches
