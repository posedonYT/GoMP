// Pure game-client logic (client/game/logic.hpp).
#include "doctest.h"

#include "../game/logic.hpp"

using namespace gompgame::logic;

TEST_CASE("radial menu: the item under the cursor") {
    // Four items: top, right, bottom, left.
    CHECK(radialHover(0.0f, -0.2f, 4, 0.05f) == 0);
    CHECK(radialHover(0.2f, 0.0f, 4, 0.05f) == 1);
    CHECK(radialHover(0.0f, 0.2f, 4, 0.05f) == 2);
    CHECK(radialHover(-0.2f, 0.0f, 4, 0.05f) == 3);
    // Just left of the top still selects the top item (wraps around).
    CHECK(radialHover(-0.01f, -0.2f, 4, 0.05f) == 0);
    // Inside the dead zone (the centre disc) and without items: nothing.
    CHECK(radialHover(0.01f, 0.01f, 4, 0.05f) == -1);
    CHECK(radialHover(0.0f, -0.2f, 0, 0.05f) == -1);
    // Eight items: 45 degrees each.
    CHECK(radialHover(0.2f, -0.2f, 8, 0.05f) == 1);
    CHECK(radialHover(-0.2f, -0.2f, 8, 0.05f) == 7);
}

TEST_CASE("Mk II weapons are recognised by their key") {
    CHECK(isMk2("weapon_pistol_mk2"));
    CHECK(isMk2("weapon_heavysniper_mk2"));
    CHECK_FALSE(isMk2("weapon_pistol"));
    CHECK_FALSE(isMk2("_mk2"));
}

TEST_CASE("tuning prices follow the server's formula") {
    TunePrices p;
    p.levelStep = 0.5;
    p.mods = {{0, 1500}, {11, 6000}};
    p.otherMod = 700;
    p.toggles = {{18, 15000}, {22, 2500}};
    p.fields = {{"primary", 1000}, {"neon", 3500}};

    CHECK(tuneModPrice(p, 0, 0) == 1500);    // the first spoiler
    CHECK(tuneModPrice(p, 11, 2) == 12000);  // engine level 3: 6000 * (1 + 2 * 0.5)
    CHECK(tuneModPrice(p, 30, 1) == 1050);   // a type without its own price: 700 * 1.5
    CHECK(tuneModPrice(p, 11, -1) == 0);     // back to stock is free
    CHECK(tuneModPrice(p, 18, 0) == 15000);  // turbo: a toggle has one price
    CHECK(tuneModPrice(p, 18, 5) == 15000);
    CHECK(tuneModPrice(p, 20, 0) == 0);      // a toggle without a price
    CHECK(isToggleMod(22));
    CHECK_FALSE(isToggleMod(23));
    CHECK(tuneFieldPrice(p, "primary") == 1000);
    CHECK(tuneFieldPrice(p, "livery") == 0);
}

TEST_CASE("tuning camera: orbit points around a vehicle") {
    OrbitView v;
    v.yaw = 0, v.pitch = 0, v.dist = 4, v.right = 0, v.forward = 0, v.up = 0;
    V3 target, cam;
    // A vehicle facing north (+y): yaw 0 puts the camera 4 m in front of it.
    orbitPoints(v, 0.0f, 1.0f, target, cam);
    CHECK(cam.x == doctest::Approx(0.0f).epsilon(0.001));
    CHECK(cam.y == doctest::Approx(4.0f));
    // Yaw 90 is on its right: east for a vehicle facing north.
    v.yaw = 90;
    orbitPoints(v, 0.0f, 1.0f, target, cam);
    CHECK(cam.x == doctest::Approx(4.0f));
    CHECK(std::fabs(cam.y) < 0.001f);
    // Pitch lifts the camera; the target offset is in vehicle space.
    v.yaw = 180, v.pitch = 90, v.forward = 1.5f, v.up = 0.5f;
    orbitPoints(v, 1.0f, 0.0f, target, cam);  // facing east
    CHECK(target.x == doctest::Approx(1.5f));
    CHECK(target.z == doctest::Approx(0.5f));
    CHECK(cam.z == doctest::Approx(4.5f));
}

TEST_CASE("tuning camera: views blend the short way round") {
    OrbitView a, b;
    a.yaw = 350, b.yaw = 10, a.dist = 2, b.dist = 6;
    OrbitView half = blend(a, b, 0.5f);
    CHECK((half.yaw < 1.0f || half.yaw > 359.0f));  // through 0, not through 180
    CHECK(half.dist == doctest::Approx(4.0f));
    CHECK(blend(a, b, 1.0f).yaw == doctest::Approx(10.0f));
}

TEST_CASE("tuning camera: the view follows the part being chosen") {
    CHECK(presetForMod(0) == ViewRear);     // spoiler
    CHECK(presetForMod(1) == ViewFront);    // front bumper
    CHECK(presetForMod(4) == ViewExhaust);
    CHECK(presetForMod(11) == ViewEngine);
    CHECK(presetForMod(23) == ViewWheels);
    CHECK(presetForMod(33) == ViewCabin);   // steering wheel
    CHECK(presetForMod(10) == ViewTop);     // roof
    CHECK(presetForMod(48) == ViewOverview);
    // The cabin view is close; the others look from outside.
    CHECK(tunePreset(ViewCabin).dist < 1.2f);
    for (int p = 0; p < ViewCount; ++p)
        if (p != ViewCabin) CHECK(tunePreset(p).dist >= 1.8f);
}

TEST_CASE("phone numbers are typed in any way and kept as 123-4567") {
    CHECK(phoneNumber("5551234") == "555-1234");
    CHECK(phoneNumber("555 12 34") == "555-1234");
    CHECK(phoneNumber("555-1234") == "555-1234");
    CHECK(phoneNumber("12345") == "12345");
    CHECK(validPhoneNumber("555-1234"));
    CHECK_FALSE(validPhoneNumber("5551234"));
    CHECK_FALSE(validPhoneNumber("555-12a4"));
    CHECK_FALSE(validPhoneNumber("55-51234"));
}

TEST_CASE("contacts show the first letter, Cyrillic too") {
    CHECK(firstLetter("Ivan") == "I");
    CHECK(firstLetter("Анна") == "А");
    CHECK(firstLetter("") == "?");
}

TEST_CASE("messages are grouped into conversations, the latest first") {
    struct Msg {
        std::string number;
    };
    const std::vector<Msg> msgs = {{"111-1111"}, {"222-2222"}, {"111-1111"}, {"333-3333"}};
    CHECK(conversations(msgs) == std::vector<std::size_t>{3, 2, 1});
    CHECK(conversations(std::vector<Msg>{}).empty());
}
