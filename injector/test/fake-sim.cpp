// Stand-in for the sim process when testing injection: does nothing until closed.
// Run it, then point the host at it: COCKPIT_LINK_SIM_EXE=fake-sim.exe.
#include <windows.h>
#include <cstdio>

int main() {
    printf("fake-sim running, pid %lu. Ctrl+C to quit.\n", GetCurrentProcessId());
    fflush(stdout);
    for (;;) Sleep(1000);
}
