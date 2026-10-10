# GoMP client: protocol/transport core, its tests, the headless client and,
# on Windows, the GTA V ASI plugin (gomp.asi).
#
#   MSVC:         cmake -B build -S . -G "Visual Studio 17 2022" -A x64
#                 cmake --build build --config Release
#   llvm-mingw:   cmake -B build -S . -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_COMPILER=clang
#                 cmake --build build
cmake_minimum_required(VERSION 3.20)
project(gomp_client LANGUAGES C CXX)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Static runtime so the plugin does not need vcredist / MinGW DLLs.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

get_filename_component(GOMP_REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)

function(gomp_warnings target)
  if(MSVC)
    target_compile_options(${target} PRIVATE $<$<COMPILE_LANGUAGE:CXX>:/W4 /utf-8 /permissive->)
    target_compile_definitions(${target} PRIVATE _CRT_SECURE_NO_WARNINGS)
  else()
    target_compile_options(${target} PRIVATE $<$<COMPILE_LANGUAGE:CXX>:-Wall -Wextra>)
  endif()
endfunction()

function(gomp_static_runtime target)
  if(MINGW)
    target_link_options(${target} PRIVATE -static -static-libgcc -static-libstdc++)
  endif()
endfunction()

add_library(gomp_core STATIC
  core/src/client.cpp
  core/src/crypto.cpp
  core/src/endpoint.cpp
  core/src/fastdl.cpp
  core/src/json.cpp
  core/src/messages.cpp
  core/src/socket.cpp
  third_party/monocypher/monocypher.c)
target_include_directories(gomp_core PUBLIC core/include third_party/monocypher)
target_compile_features(gomp_core PUBLIC cxx_std_20)
gomp_warnings(gomp_core)
if(WIN32)
  target_link_libraries(gomp_core PUBLIC ws2_32 bcrypt)
endif()

add_executable(gomp-tests tests/test_core.cpp tests/test_game_logic.cpp tests/test_budget.cpp tests/test_fastdl.cpp)
target_include_directories(gomp-tests PRIVATE third_party/doctest)
target_compile_definitions(gomp-tests PRIVATE GOMP_REPO_ROOT="${GOMP_REPO_ROOT}")
target_link_libraries(gomp-tests PRIVATE gomp_core)
gomp_static_runtime(gomp-tests)

add_executable(gomp-headless headless/main.cpp)
target_link_libraries(gomp-headless PRIVATE gomp_core)
gomp_static_runtime(gomp-headless)

if(WIN32)
  file(GLOB GOMP_GAME_SOURCES CONFIGURE_DEPENDS game/*.cpp)
  add_library(gomp SHARED ${GOMP_GAME_SOURCES})
  set_target_properties(gomp PROPERTIES PREFIX "" SUFFIX ".asi")
  target_link_libraries(gomp PRIVATE gomp_core)
  gomp_warnings(gomp)
  gomp_static_runtime(gomp)
endif()
