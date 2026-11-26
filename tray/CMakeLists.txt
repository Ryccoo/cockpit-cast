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
target_link_libraries(cockpitcast-tray PRIVATE gdiplus shell32 user32 ole32 advapi32 version)

# The app window (editor and monitor) uses Microsoft's WebView2: its SDK (BSD licence) is fetched at
# configure time from NuGet at a fixed version and checksum; the static loader means no extra DLL.
set(WEBVIEW2_VERSION 1.0.4314.35)
set(WEBVIEW2_SHA256 90778DEB1B77E36292828B4B5833C9255C27533F40E0DDD55891AE718944EDC4)
set(WEBVIEW2_DIR ${CMAKE_BINARY_DIR}/webview2-${WEBVIEW2_VERSION})
if(NOT EXISTS ${WEBVIEW2_DIR}/build/native/include/WebView2.h)
  file(DOWNLOAD https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WEBVIEW2_VERSION}/microsoft.web.webview2.${WEBVIEW2_VERSION}.nupkg
       ${CMAKE_BINARY_DIR}/webview2.zip EXPECTED_HASH SHA256=${WEBVIEW2_SHA256} TLS_VERIFY ON)
  file(ARCHIVE_EXTRACT INPUT ${CMAKE_BINARY_DIR}/webview2.zip DESTINATION ${WEBVIEW2_DIR})
endif()
target_include_directories(cockpitcast-tray PRIVATE ${WEBVIEW2_DIR}/build/native/include)
target_link_libraries(cockpitcast-tray PRIVATE ${WEBVIEW2_DIR}/build/native/x64/WebView2LoaderStatic.lib)
