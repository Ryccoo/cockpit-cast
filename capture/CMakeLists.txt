cmake_minimum_required(VERSION 3.20)
project(cockpit_link_capture CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static runtime: nothing extra to install on the sim PC.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
# /EHa: hook bodies run under __try/__except; make C++ unwinding work with it.
add_compile_options(/W4 /utf-8 /EHa)
string(REPLACE "/EHsc" "" CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}")
add_compile_definitions(UNICODE _UNICODE)

add_library(capture SHARED
  src/dllmain.cpp
  src/hooks.cpp
  src/capture.cpp
  src/encoder.cpp
  src/pipe.cpp
  src/log.cpp
)
set_target_properties(capture PROPERTIES OUTPUT_NAME cockpit-link-capture)
target_link_libraries(capture PRIVATE d3d12 dxgi windowscodecs shlwapi ole32 shell32)
# Keep a .pdb next to the DLL in Release too, for readable crash stacks.
target_link_options(capture PRIVATE $<$<CONFIG:Release>:/DEBUG /OPT:REF /OPT:ICF>)
target_compile_options(capture PRIVATE $<$<CONFIG:Release>:/Zi>)

# Test program: renders two fake panel textures with marker pixels, like the sim's G1000 pages.
add_executable(panel-sim test/panel-sim.cpp)
target_link_libraries(panel-sim PRIVATE d3d12 dxgi)
