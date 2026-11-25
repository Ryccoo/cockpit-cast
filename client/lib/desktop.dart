// Desktop-only features (Windows, Linux, macOS): monitors, window placement and full screen, the extra
// windows (one more copy of the app per extra output) and starting at sign-in.
// On phones and tablets these do nothing.

import 'dart:io';

import 'package:material_ui/material_ui.dart';
import 'package:screen_retriever/screen_retriever.dart';
import 'package:window_manager/window_manager.dart';

import 'settings.dart';

bool get isDesktop => Platform.isWindows || Platform.isLinux || Platform.isMacOS;

/// A monitor as shown in Settings.
class MonitorInfo {
  MonitorInfo(this.index, this.display, this.primary);
  final int index;
  final Display display;
  final bool primary;

  String get id => display.id;
  String get label {
    final w = display.size.width.round(), h = display.size.height.round();
    final name = (display.name ?? '').trim();
    return 'Monitor ${index + 1}${name.isNotEmpty ? ' · $name' : ''} · $w × $h${primary ? ' · main' : ''}';
  }
}

Future<void> initDesktopWindow() async {
  if (!isDesktop) return;
  await windowManager.ensureInitialized();
}

Future<List<MonitorInfo>> listMonitors() async {
  if (!isDesktop) return const [];
  try {
    final all = await screenRetriever.getAllDisplays();
    final primary = await screenRetriever.getPrimaryDisplay();
    return [for (var i = 0; i < all.length; i++) MonitorInfo(i, all[i], all[i].id == primary.id)];
  } catch (_) {
    return const [];
  }
}

/// The monitor an output is pinned to: by id, else by name, else by position in the list, else the first.
MonitorInfo? findMonitor(List<MonitorInfo> monitors, OutputConfig o) {
  if (monitors.isEmpty) return null;
  for (final m in monitors) {
    if (o.monitorId != null && m.id == o.monitorId) return m;
  }
  for (final m in monitors) {
    if (o.monitorName != null && o.monitorName!.isNotEmpty && m.display.name == o.monitorName) return m;
  }
  if (o.monitorIndex >= 0 && o.monitorIndex < monitors.length) return monitors[o.monitorIndex];
  return monitors.first;
}

/// Put this window on its monitor and make it full-screen (or a normal window there).
Future<void> placeWindow(OutputConfig o, {String? title}) async {
  if (!isDesktop) return;
  try {
    if (title != null) await windowManager.setTitle(title);
    final monitors = await listMonitors();
    final m = findMonitor(monitors, o);
    if (await windowManager.isFullScreen()) await windowManager.setFullScreen(false);
    if (m != null) {
      final pos = m.display.visiblePosition ?? Offset.zero;
      final area = m.display.visibleSize ?? m.display.size;
      final w = (area.width * 0.7).clamp(480.0, area.width), h = (area.height * 0.7).clamp(320.0, area.height);
      await windowManager.setBounds(Rect.fromLTWH(pos.dx + (area.width - w) / 2, pos.dy + (area.height - h) / 2, w, h));
    }
    if (o.fullscreen) await windowManager.setFullScreen(true);
    await windowManager.show();
    await windowManager.focus();
  } catch (_) {
    // Placement is a nicety: if the platform refuses, the window simply stays where it is.
  }
}

/// Leave full screen and come back as a normal window (for the Settings page).
Future<void> restoreWindow() async {
  if (!isDesktop) return;
  try {
    if (await windowManager.isFullScreen()) await windowManager.setFullScreen(false);
    await windowManager.setTitle('Cockpit Link');
  } catch (_) {}
}

// ---------------- extra windows ----------------

final List<Process> _children = [];

/// Start one more copy of the app for every output after the first.
Future<void> startExtraWindows(Settings s) async {
  await stopExtraWindows();
  if (!isDesktop || s.isChild || s.outputs.length < 2) return;
  for (var i = 1; i < s.outputs.length; i++) {
    final args = ['--child', '--output', '$i', if (s.profile.isNotEmpty) ...['--profile', s.profile]];
    try {
      _children.add(await Process.start(Platform.resolvedExecutable, args, mode: ProcessStartMode.detachedWithStdio));
    } catch (_) {}
  }
}

Future<void> stopExtraWindows() async {
  for (final p in _children) {
    p.kill();
  }
  _children.clear();
}

/// Close the extra windows when window 1 closes.
class ExtraWindowsCloser with WindowListener {
  static final ExtraWindowsCloser instance = ExtraWindowsCloser._();
  ExtraWindowsCloser._();

  Future<void> install() async {
    if (!isDesktop) return;
    windowManager.addListener(this);
    await windowManager.setPreventClose(true);
  }

  @override
  void onWindowClose() async {
    await stopExtraWindows();
    await windowManager.destroy();
  }
}

// ---------------- start at sign-in ----------------

const _runKey = r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run';

String _valueName(String profile) => profile.isEmpty ? 'CockpitLink' : 'CockpitLink-$profile';

/// Register (or remove) the app to start when the user signs in.
Future<String?> setLaunchAtLogin(bool on, {String profile = ''}) async {
  if (!isDesktop) return null;
  final exe = Platform.resolvedExecutable;
  final extra = profile.isEmpty ? '' : ' --profile $profile';
  try {
    if (Platform.isWindows) {
      final r = on
          ? await Process.run('reg', ['add', _runKey, '/v', _valueName(profile), '/t', 'REG_SZ', '/d', '"$exe"$extra', '/f'])
          : await Process.run('reg', ['delete', _runKey, '/v', _valueName(profile), '/f']);
      if (on && r.exitCode != 0) return 'Could not register: ${r.stderr}'.trim();
    } else if (Platform.isLinux) {
      final dir = Directory('${Platform.environment['HOME']}/.config/autostart');
      final file = File('${dir.path}/cockpit-link${profile.isEmpty ? '' : '-$profile'}.desktop');
      if (on) {
        await dir.create(recursive: true);
        await file.writeAsString('[Desktop Entry]\nType=Application\nName=Cockpit Link\nExec="$exe"$extra\nX-GNOME-Autostart-enabled=true\n');
      } else if (await file.exists()) {
        await file.delete();
      }
    } else if (Platform.isMacOS) {
      final label = 'dev.cockpitlink.client${profile.isEmpty ? '' : '.$profile'}';
      final file = File('${Platform.environment['HOME']}/Library/LaunchAgents/$label.plist');
      if (on) {
        await file.parent.create(recursive: true);
        final profileArgs = profile.isEmpty ? '' : '<string>--profile</string><string>$profile</string>';
        await file.writeAsString('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
            '<plist version="1.0"><dict><key>Label</key><string>$label</string>'
            '<key>ProgramArguments</key><array><string>$exe</string>$profileArgs</array>'
            '<key>RunAtLoad</key><true/></dict></plist>\n');
      } else if (await file.exists()) {
        await file.delete();
      }
    }
  } catch (e) {
    return 'Could not change start at sign-in: $e';
  }
  return null;
}
