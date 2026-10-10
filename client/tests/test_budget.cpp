// Frame budgets of the game client (client/game/budget.hpp).
#include "doctest.h"

#include <set>

#include "../game/budget.hpp"
#include "gomp/transport.hpp"

using namespace gompgame::budget;

TEST_CASE("spawning: the nearest first, within the budget") {
    std::vector<std::pair<float, uint16_t>> cands = {{900, 1}, {4, 2}, {100, 3}, {1, 4}, {2500, 5}};
    CHECK(nearestFirst(cands, 3) == std::vector<uint16_t>{4, 2, 3});
    // Fewer candidates than the budget: all of them, in order.
    CHECK(nearestFirst(cands, 10) == std::vector<uint16_t>{4, 2, 3, 1, 5});
    CHECK(nearestFirst({}, 3).empty());
    CHECK(nearestFirst(cands, 0).empty());
    // Same distance: the lower id first, so the choice does not flicker between frames.
    CHECK(nearestFirst({{5, 9}, {5, 3}, {5, 7}}, 2) == std::vector<uint16_t>{3, 7});
}

TEST_CASE("spawning: a crowd streams in over a few frames, nobody is left out") {
    // 128 players waiting; each frame spawns the nearest kPedSpawnsPerFrame of those left.
    std::vector<std::pair<float, uint16_t>> waiting;
    for (uint16_t id = 0; id < 128; ++id) waiting.emplace_back(static_cast<float>((id * 37) % 128), id);
    std::set<uint16_t> spawned;
    int frames = 0;
    float lastNearest = -1;
    while (!waiting.empty()) {
        auto now = nearestFirst(waiting, kPedSpawnsPerFrame);
        REQUIRE(now.size() <= kPedSpawnsPerFrame);
        for (uint16_t id : now) {
            auto it = std::find_if(waiting.begin(), waiting.end(), [&](const auto& c) { return c.second == id; });
            REQUIRE(it != waiting.end());
            CHECK(it->first >= lastNearest);  // never a farther one before a nearer one
            lastNearest = it->first;
            spawned.insert(id);
            waiting.erase(it);
        }
        ++frames;
    }
    CHECK(spawned.size() == 128);
    CHECK(frames == (128 + kPedSpawnsPerFrame - 1) / kPedSpawnsPerFrame);
}

TEST_CASE("a crowd: only the nearest kMaxRemotePeds get a ped, nearer ones take the place of farther ones") {
    std::vector<std::pair<float, uint16_t>> spawned;
    for (uint16_t id = 0; id < kMaxRemotePeds; ++id) spawned.emplace_back(static_cast<float>(id * id), id);  // 0..99 m away
    // Room left: nobody is removed.
    CHECK(swapOut({{1, 1}}, 0, kMaxRemotePeds) == -1);
    // Full: someone at 10 m takes the place of the one at 99 m.
    CHECK(swapOut(spawned, 10 * 10, kMaxRemotePeds) == static_cast<int>(kMaxRemotePeds - 1));
    // Someone at 85 m is not nearer by kSwapMargin: no flicker at the edge.
    CHECK(swapOut(spawned, 85 * 85, kMaxRemotePeds) == -1);
    const float d = 99 - kSwapMargin - 1;
    CHECK(swapOut(spawned, d * d, kMaxRemotePeds) == static_cast<int>(kMaxRemotePeds - 1));
}

TEST_CASE("distant entities are updated every few frames, close ones every frame") {
    const float close = 100.0f * 100.0f, distant = 300.0f * 300.0f;
    CHECK(updateEvery(close) == 1);
    CHECK(updateEvery(kNearDistance * kNearDistance) == 1);
    CHECK(updateEvery(distant) == kFarEvery);
    for (uint64_t frame = 0; frame < 30; ++frame) CHECK(updateNow(close, frame, 7));
    // A distant entity: exactly one frame in kFarEvery.
    int updates = 0;
    for (uint64_t frame = 0; frame < 30; ++frame) updates += updateNow(distant, frame, 7) ? 1 : 0;
    CHECK(updates == 30 / kFarEvery);
    // Far entities take turns: in each frame about a third of them, not all at once.
    for (uint64_t frame = 0; frame < 6; ++frame) {
        int now = 0;
        for (uint16_t id = 0; id < 90; ++id) now += updateNow(distant, frame, id) ? 1 : 0;
        CHECK(now == 90 / kFarEvery);
    }
}

TEST_CASE("the blip sweep covers every sprite in slices and starts over") {
    Sweep s{900, 0};
    std::vector<bool> seen(900, false);
    const int frames = Sweep::frames(900, 60);
    CHECK(frames == 15);
    for (int f = 0; f < frames; ++f) {
        auto [from, to] = s.next(60);
        CHECK(to - from <= 60);
        for (int i = from; i < to; ++i) seen[i] = true;
        if (f == frames - 1) CHECK(to == 900);  // the last slice ends the round
    }
    CHECK(std::all_of(seen.begin(), seen.end(), [](bool b) { return b; }));
    CHECK(s.next(60) == std::pair<int, int>{0, 60});  // the next round starts at the beginning
    // A total that is not a multiple of the slice.
    Sweep odd{10, 0};
    CHECK(odd.next(4) == std::pair<int, int>{0, 4});
    CHECK(odd.next(4) == std::pair<int, int>{4, 8});
    CHECK(odd.next(4) == std::pair<int, int>{8, 10});
    CHECK(odd.next(4) == std::pair<int, int>{0, 4});
    CHECK(Sweep{}.next(4) == std::pair<int, int>{0, 0});
}

TEST_CASE("world objects: moves, turns and fades are applied in place") {
    using namespace gomp::prop;
    CHECK(appliesInPlace({Position}));
    CHECK(appliesInPlace({Position, Rotation}));
    CHECK(appliesInPlace({Alpha, Visible}));
    CHECK(appliesInPlace({}));
    // A new model (or anything the object is made with) recreates it.
    CHECK_FALSE(appliesInPlace({Model}));
    CHECK_FALSE(appliesInPlace({Position, Model}));
    CHECK_FALSE(appliesInPlace({Frozen}));
}

TEST_CASE("line of sight: rationed raycasts, answers reused only while fresh and near") {
    Los los;
    CHECK(los.shouldAsk(0));
    CHECK_FALSE(los.clearFor(1, 1, 0));  // nothing known yet: no correction through walls
    los.answered(0, 10, 10, true);
    CHECK(los.clearFor(10, 10, 100));
    CHECK(los.clearFor(10.5f, 10, 100));    // the target moved a little
    CHECK_FALSE(los.clearFor(12, 10, 100));  // moved too far: the answer is for another line
    CHECK_FALSE(los.clearFor(10, 10, kLosMaxAgeMs + 1));  // too old
    // The next raycast for this ped only after kLosEveryMs.
    CHECK_FALSE(los.shouldAsk(kLosEveryMs - 1));
    CHECK(los.shouldAsk(kLosEveryMs));
    los.answered(kLosEveryMs, 20, 20, false);
    CHECK_FALSE(los.clearFor(20, 20, kLosEveryMs + 10));  // blocked

    // 128 lagging peds, kLosPerFrame raycasts per frame for all of them, the peds
    // that waited longest first: every ped gets its turn, none is left out.
    std::vector<Los> peds(128);
    std::vector<int> served(peds.size(), 0);
    std::vector<LosRequest> reqs;
    const int frames = 120;  // two seconds at 60 fps
    for (int f = 0; f < frames; ++f) {
        const int64_t now = 1000 + f * 16;
        for (uint16_t id = 0; id < peds.size(); ++id)
            if (peds[id].shouldAsk(now)) reqs.push_back({id, peds[id].askedAt, {}, {}});
        oldestFirst(reqs, kLosPerFrame);
        REQUIRE(reqs.size() <= static_cast<std::size_t>(kLosPerFrame));
        for (const LosRequest& q : reqs) {
            peds[q.id].answered(now, 0, 0, true);
            ++served[q.id];
        }
        reqs.clear();
        if (f == 128 / kLosPerFrame - 1) CHECK(std::all_of(peds.begin(), peds.end(), [](const Los& l) { return l.known; }));
    }
    const auto [lo, hi] = std::minmax_element(served.begin(), served.end());
    CHECK(*lo >= 3);        // 480 raycasts over 128 peds: everyone had 3 or 4
    CHECK(*hi - *lo <= 1);  // and fairly
}

TEST_CASE("the network takes a bounded number of datagrams per frame") {
    CHECK(gomp::Client::kMaxDatagramsPerUpdate == 512);
}
