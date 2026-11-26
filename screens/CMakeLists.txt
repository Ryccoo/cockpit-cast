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
target_link_libraries(cockpitcast-screens PRIVATE d3d11 dxgi d3dcompiler d2d1 dwrite user32 winmm ole32 advapi32 version)

# Layouts on local screens are shown in a WebView2 browser view: the same SDK (BSD licence) as the tray
# (tray/CMakeLists.txt), fetched at configure time and checked against its hash; the loader is linked
# statically (the runtime is part of Windows 11).
set(WEBVIEW2_VERSION 1.0.4314.35)
set(WEBVIEW2_SHA256 90778DEB1B77E36292828B4B5833C9255C27533F40E0DDD55891AE718944EDC4)
set(WEBVIEW2_DIR ${CMAKE_BINARY_DIR}/webview2-${WEBVIEW2_VERSION})
if(NOT EXISTS ${WEBVIEW2_DIR}/build/native/include/WebView2.h)
  file(DOWNLOAD https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WEBVIEW2_VERSION}/microsoft.web.webview2.${WEBVIEW2_VERSION}.nupkg
       ${CMAKE_BINARY_DIR}/webview2.zip EXPECTED_HASH SHA256=${WEBVIEW2_SHA256} TLS_VERIFY ON)
  file(ARCHIVE_EXTRACT INPUT ${CMAKE_BINARY_DIR}/webview2.zip DESTINATION ${WEBVIEW2_DIR})
endif()
target_include_directories(cockpitcast-screens PRIVATE ${WEBVIEW2_DIR}/build/native/include)
target_link_libraries(cockpitcast-screens PRIVATE ${WEBVIEW2_DIR}/build/native/x64/WebView2LoaderStatic.lib)
target_link_options(cockpitcast-screens PRIVATE $<$<CONFIG:Release>:/DEBUG /OPT:REF /OPT:ICF>)
target_compile_options(cockpitcast-screens PRIVATE $<$<CONFIG:Release>:/Zi>)
