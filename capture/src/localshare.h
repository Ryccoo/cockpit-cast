// Local screens: how cockpitcast-capture.dll (inside the sim) hands glass displays to the local screen
// viewer (screens/, cockpitcast-screens.exe) on the same PC without any copying through the CPU.
//
// For every display the host wants shown locally, the DLL keeps kSlots shared GPU textures (created on the
// sim's own D3D12 device, shareable by name). It copies the display's area into a free slot on the sim's
// queue, and once the GPU has finished that copy (checked, never waited for) it publishes the slot as the
// newest frame in this shared memory block. The viewer opens the textures by name on the same graphics
// card and draws the newest one. No readback, no JPEG, no pipe, no WebSocket.
//
// Sync: the DLL publishes a slot only after its copy has completed, never writes the slot the viewer says
// it is reading, nor the newest one; with 3 slots that leaves one to write while the viewer draws another.
// All counters are 32-bit and changed with Interlocked* calls.
#pragma once

#include <cstdint>

namespace localshare {

constexpr const wchar_t* kMapName = L"Local\\CockpitCast-LocalScreens";
constexpr uint32_t kMagic = 0x53434343;  // "CCCS"
constexpr uint32_t kVersion = 1;
constexpr int kMaxDisplays = 16;
constexpr int kSlots = 3;
constexpr int kNameLen = 96;

struct Display {
    char id[32];                // display id ("pfd"); empty = unused entry
    volatile long gen;          // bumped whenever the textures are created again (size or format changed)
    uint32_t width, height;     // texture size = the display's area in the sim's texture
    uint32_t dxgiFormat;        // a *_TYPELESS 8-bit RGBA/BGRA format; the viewer reads it as *_UNORM
    volatile long latest;       // slot with the newest finished frame, -1 = none yet
    volatile long seq;          // finished frames so far
    volatile long reading;      // written by the viewer: the slot it is drawing from, -1 = none
    volatile long active;       // 1 while the DLL produces this display
    wchar_t names[kSlots][kNameLen];  // shared-handle names of the slot textures (for OpenSharedResourceByName)
};

struct Header {
    uint32_t magic;             // kMagic once the DLL has set the block up
    uint32_t version;           // kVersion
    uint32_t simPid;            // the sim's process id
    volatile long heartbeat;    // GetTickCount() of the DLL's last frame; the viewer treats >3 s old as gone
    uint32_t adapterLuidLow;    // the graphics card the textures live on: the viewer must use the same one
    int32_t adapterLuidHigh;
    uint32_t reserved[2];
    Display displays[kMaxDisplays];
};

}  // namespace localshare
