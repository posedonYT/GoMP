// Memory patches of GTA5.exe (landing page skip, no weapon wheel slow motion).
#pragma once

#include <string>
#include <vector>

namespace gompgame::patches {

// Applies all patches; called once from DllMain before the game shows its front end.
void apply();
// What was applied or skipped (written to gomp.log by the client).
const std::vector<std::string>& log();

}  // namespace gompgame::patches
