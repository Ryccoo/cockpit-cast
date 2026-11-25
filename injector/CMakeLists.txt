cmake_minimum_required(VERSION 3.20)
project(cockpitcast_injector CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static runtime: no Visual C++ redistributable needed on the sim PC.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_compile_options(/W4 /utf-8)
add_compile_definitions(UNICODE _UNICODE)

add_executable(cockpitcast-injector src/injector.cpp)

# Test pieces: a stand-in sim process and a DLL that only talks to the host's pipe.
add_executable(fake-sim test/fake-sim.cpp)
add_library(test-dll SHARED test/test-dll.cpp)
set_target_properties(test-dll PROPERTIES OUTPUT_NAME cockpitcast-capture RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/test)
