// Frame budgets of the game client, as plain logic (no natives) so they can be
// tested: everything runs on the one script fiber, so work that grows with the
// number of players, vehicles or blips is spread over frames instead of being
// done all at once.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

#include "gomp/messages.hpp"

namespace gompgame::budget {

// Peds and vehicles created per frame. Creating one costs 25+ natives (a ped
// with its clothes more); a crowd streaming in at once froze the frame.
constexpr std::size_t kPedSpawnsPerFrame = 3;
constexpr std::size_t kVehicleSpawnsPerFrame = 4;

// The ids to spawn this frame: the nearest `budget` of the candidates
// (squared distance, id). Ties keep the lower id first, so the choice is stable.
inline std::vector<uint16_t> nearestFirst(std::vector<std::pair<float, uint16_t>> cands, std::size_t budget) {
    auto less = [](const auto& a, const auto& b) { return a.first < b.first || (a.first == b.first && a.second < b.second); };
    if (cands.size() > budget) {
        std::nth_element(cands.begin(), cands.begin() + static_cast<std::ptrdiff_t>(budget), cands.end(), less);
        cands.resize(budget);
    }
    std::sort(cands.begin(), cands.end(), less);
    std::vector<uint16_t> ids;
    ids.reserve(cands.size());
    for (const auto& c : cands) ids.push_back(c.second);
    return ids;
}

// Peds made for remote players at most: GTA V crashed with a crowd of 200 players in
// one spot (128 streamed peds plus their vehicles; 100 ran at 75 fps). The nearest
// ones get a ped; a farther ped gives its place up to one who came nearer by more
// than kSwapMargin (no flicker at the edge).
constexpr std::size_t kMaxRemotePeds = 100;
constexpr float kSwapMargin = 20.0f;  // metres

// The spawned ped to remove so that the nearest one without a ped can have one:
// spawned holds (squared distance, id) of the peds there are; -1 when there is room
// or nobody is nearer enough.
inline int swapOut(const std::vector<std::pair<float, uint16_t>>& spawned, float nearestMissingSq, std::size_t cap) {
    if (spawned.size() < cap || spawned.empty()) return -1;
    const auto farthest = std::max_element(spawned.begin(), spawned.end(),
                                      [](const auto& a, const auto& b) { return a.first < b.first || (a.first == b.first && a.second < b.second); });
    const float margin = std::sqrt(nearestMissingSq) + kSwapMargin;
    return margin * margin < farthest->first ? farthest->second : -1;
}

// Remote entities far away are updated every few frames: nobody sees a ped
// 200 m away move a frame late, but 128 of them cost 10+ natives each per frame.
constexpr float kNearDistance = 150.0f;
constexpr int kFarEvery = 3;

inline int updateEvery(float distSq) { return distSq <= kNearDistance * kNearDistance ? 1 : kFarEvery; }

// Whether an entity is updated in this frame: far ones take turns by id, so
// the work is even from frame to frame.
inline bool updateNow(float distSq, uint64_t frame, uint16_t id) {
    const int every = updateEvery(distSq);
    return every == 1 || (frame + id) % static_cast<uint64_t>(every) == 0;
}

// A walk over a long range in slices: `next(per)` gives the next [from, to) of
// `total`, wrapping around; `total` slices of `per` cover everything.
struct Sweep {
    int total = 0;
    int at = 0;

    std::pair<int, int> next(int per) {
        if (total <= 0) return {0, 0};
        if (at >= total) at = 0;
        const int from = at;
        const int to = std::min(total, at + per);
        at = to >= total ? 0 : to;
        return {from, to};
    }

    // Frames for one full round.
    static int frames(int total, int per) { return per <= 0 ? 0 : (total + per - 1) / per; }
};

// Object properties applied to the existing object (moved, turned, faded,
// shown or hidden); any other change (a new model...) recreates the object.
inline bool appliesInPlace(const std::vector<uint8_t>& changed) {
    for (uint8_t k : changed)
        if (k != gomp::prop::Position && k != gomp::prop::Rotation && k != gomp::prop::Alpha && k != gomp::prop::Visible)
            return false;
    return true;
}

// Line of sight for the soft correction of a remote ped. The raycast is
// synchronous (asynchronous probes left unread with 100+ peds around filled the
// game's probe pool and crashed it) but rationed: one per ped at most every
// kLosEveryMs and kLosPerFrame for all peds together, the peds that waited longest
// first (oldestFirst). The answer is reused only for a target close to the one it
// was asked for and while fresh.
constexpr int64_t kLosEveryMs = 250;
constexpr int64_t kLosMaxAgeMs = 500;
constexpr int kLosPerFrame = 4;
constexpr float kLosReuse = 1.0f;  // metres

struct Los {
    int64_t askedAt = -kLosEveryMs;
    bool known = false, clear = false;
    float ansX = 0, ansY = 0;  // target of the last answer

    bool shouldAsk(int64_t nowMs) const { return nowMs - askedAt >= kLosEveryMs; }
    void answered(int64_t nowMs, float x, float y, bool isClear) {
        askedAt = nowMs;
        known = true;
        clear = isClear;
        ansX = x;
        ansY = y;
    }
    bool clearFor(float x, float y, int64_t nowMs) const {
        const float dx = x - ansX, dy = y - ansY;
        return known && clear && nowMs - askedAt <= kLosMaxAgeMs && dx * dx + dy * dy <= kLosReuse * kLosReuse;
    }
};

// A raycast a ped asked for this frame (made after the peds are updated).
struct LosRequest {
    uint16_t id = 0;
    int64_t askedAt = 0;  // its previous raycast
    float from[3] = {}, to[3] = {};
};

// Keeps the n requests whose peds had their last raycast longest ago (ties: lower
// id), so with more lagging peds than raycasts every one gets its turn.
inline void oldestFirst(std::vector<LosRequest>& reqs, std::size_t n) {
    auto older = [](const LosRequest& a, const LosRequest& b) { return a.askedAt < b.askedAt || (a.askedAt == b.askedAt && a.id < b.id); };
    if (reqs.size() > n) {
        std::nth_element(reqs.begin(), reqs.begin() + static_cast<std::ptrdiff_t>(n), reqs.end(), older);
        reqs.resize(n);
    }
    std::sort(reqs.begin(), reqs.end(), older);
}

}  // namespace gompgame::budget
