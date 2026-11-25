// Up to version 0.1.1 the project was called "Cockpit Link" (app id dev.cockpitlink.cockpit_link).
// This moves what that version left behind to the new name, once, on the first start of this version:
// the saved settings and the start-at-sign-in entry. With nothing old around it does nothing.

import 'dart:io';

import 'desktop.dart';
import 'settings.dart';

/// Before the settings are loaded: copy the old settings file to where this version looks for it.
Future<void> moveLegacySettings() async {
  try {
    String? oldPath, newPath;
    if (Platform.isWindows) {
      final appData = Platform.environment['APPDATA'];
      if (appData == null) return;
      oldPath = '$appData\\dev.cockpitlink\\cockpit_link\\shared_preferences.json';
      newPath = '$appData\\dev.cockpitcast\\cockpitcast\\shared_preferences.json';
    } else if (Platform.isLinux) {
      final base = Platform.environment['XDG_DATA_HOME'] ?? '${Platform.environment['HOME']}/.local/share';
      oldPath = '$base/dev.cockpitlink.cockpit_link/shared_preferences.json';
      newPath = '$base/dev.cockpitcast.cockpitcast/shared_preferences.json';
    }
    if (oldPath == null || newPath == null) return;
    final oldFile = File(oldPath), newFile = File(newPath);
    if (!newFile.existsSync() && oldFile.existsSync()) {
      await newFile.parent.create(recursive: true);
      await oldFile.copy(newFile.path);
    }
  } catch (_) {} // start with default settings rather than fail
}

/// Window 1, after loading the settings: remove the old start-at-sign-in entry and, if starting at
/// sign-in is on, register this app under the new name.
Future<void> moveLegacyLaunchAtLogin(Settings s) async {
  if (!isDesktop) return;
  final suffix = s.profile.isEmpty ? '' : '-${s.profile}';
  var found = false;
  try {
    if (Platform.isWindows) {
      const key = r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run';
      final name = 'CockpitLink$suffix';
      if ((await Process.run('reg', ['query', key, '/v', name])).exitCode == 0) {
        found = true;
        await Process.run('reg', ['delete', key, '/v', name, '/f']);
      }
    } else if (Platform.isLinux) {
      final f = File('${Platform.environment['HOME']}/.config/autostart/cockpit-link$suffix.desktop');
      if (f.existsSync()) {
        found = true;
        await f.delete();
      }
    } else if (Platform.isMacOS) {
      final label = 'dev.cockpitlink.client${s.profile.isEmpty ? '' : '.${s.profile}'}';
      final f = File('${Platform.environment['HOME']}/Library/LaunchAgents/$label.plist');
      if (f.existsSync()) {
        found = true;
        await f.delete();
      }
    }
  } catch (_) {}
  if (found && s.launchAtLogin) await setLaunchAtLogin(true, profile: s.profile);
}
