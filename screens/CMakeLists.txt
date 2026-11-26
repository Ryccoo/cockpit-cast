cmake_minimum_required(VERSION 3.20)
project(cockpitcast_screens CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static runtime: nothing extra to install on the sim PC.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_compile_options(/W4 /utf-8)
add_compile_definitions(UNICODE _UNICODE)

# Local screens on the sim PC (started by the host): borderless windows that draw the sim's glass displays
# straight from shared GPU textures. WIN32: no console window; the host talks to it over stdin/stdout.
add_executable(cockpitcast-screens WIN32 src/screens.cpp)
target_link_libraries(cockpitcast-screens PRIVATE d3d11 dxgi d3dcompiler d2d1 dwrite user32 winmm)
target_link_options(cockpitcast-screens PRIVATE $<$<CONFIG:Release>:/DEBUG /OPT:REF /OPT:ICF>)
target_compile_options(cockpitcast-screens PRIVATE $<$<CONFIG:Release>:/Zi>)
