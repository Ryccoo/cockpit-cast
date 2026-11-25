cmake_minimum_required(VERSION 3.20)
project(cockpitcast_tray CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static runtime: no Visual C++ redistributable needed on the sim PC.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_compile_options(/W4 /utf-8)
add_compile_definitions(UNICODE _UNICODE)

# Tray icon for the host (started by the host on Windows). WIN32: no console window.
add_executable(cockpitcast-tray WIN32 src/tray.cpp)
target_link_libraries(cockpitcast-tray PRIVATE gdiplus shell32 user32)
