// The app's log file: what it did, so problems (and the seconds before a crash) can be looked at later.
//
//   Windows  %LOCALAPPDATA%\CockpitCast\logs\client.log   (next to the host's logs on the sim PC)
//   Linux    ~/.local/share/cockpitcast/logs/client.log
//   macOS    ~/Library/Logs/CockpitCast/client.log
//   others   the app's temp folder
//
// Extra windows are their own copies of the app and log to client-window2.log and so on; a profile
// (--profile) is added to the name. The previous run's file is kept as <name>.1.log, and a file stops
// growing at 5 MB. Every line is written and flushed straight away: a crash inside the engine or a
// graphics driver ends the program without warning, and the lines before it must already be on disk.
// Settings > Logs opens the folder, or saves the logs (with Windows' crash records) to the desktop.

import 'dart:io';

import 'package:flutter/foundation.dart';

class AppLog {
  AppLog._();

  static RandomAccessFile? _file;
  static int _bytes = 0;
  static const _maxBytes = 5 * 1024 * 1024;

  /// The folder the logs are in (null before [init], or if it cannot be written).
  static String? folder;

  /// This copy's log file.
  static String? file;

  static String _folderFor() {
    final env = Platform.environment;
    final sep = Platform.pathSeparator;
    if (Platform.isWindows) return '${env['LOCALAPPDATA'] ?? Directory.systemTemp.path}${sep}CockpitCast${sep}logs';
    if (Platform.isMacOS && env['HOME'] != null) return '${env['HOME']}/Library/Logs/CockpitCast';
    if (Platform.isLinux) {
      final data = env['XDG_DATA_HOME'] ?? (env['HOME'] != null ? '${env['HOME']}/.local/share' : null);
      if (data != null) return '$data/cockpitcast/logs';
    }
    return '${Directory.systemTemp.path}${sep}cockpitcast-logs';
  }

  /// Opens the log as [name] ("client", "client-window2", ...) and records uncaught errors from now on.
  static void init(String name) {
    try {
      final dir = Directory(_folderFor())..createSync(recursive: true);
      final path = '${dir.path}${Platform.pathSeparator}$name.log';
      final f = File(path);
      if (f.existsSync()) {
        final old = File('${dir.path}${Platform.pathSeparator}$name.1.log');
        if (old.existsSync()) old.deleteSync();
        f.renameSync(old.path);
      }
      _file = File(path).openSync(mode: FileMode.append);
      folder = dir.path;
      file = path;
    } catch (_) {
      _file = null; // no log file (read-only or missing folder): the app works without one
    }
    final previous = FlutterError.onError;
    FlutterError.onError = (details) {
      error('flutter', '${details.exceptionAsString()}${details.context != null ? ' (${details.context})' : ''}\n${details.stack ?? ''}');
      previous?.call(details);
    };
    PlatformDispatcher.instance.onError = (e, stack) {
      error('uncaught', '$e\n$stack');
      return true; // logged; keep running
    };
  }

  static void info(String tag, String message) => _write('INFO', tag, message);
  static void warn(String tag, String message) => _write('WARN', tag, message);
  static void error(String tag, String message) => _write('ERR ', tag, message);

  static String _stamp() {
    final t = DateTime.now();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${t.year}-${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}:${two(t.second)}.${t.millisecond.toString().padLeft(3, '0')}';
  }

  static void _write(String level, String tag, String message) {
    final f = _file;
    if (f == null || _bytes > _maxBytes) return;
    final line = '${_stamp()} $level [$tag] $message\n';
    try {
      f.writeStringSync(line);
      f.flushSync();
      _bytes += line.length;
      if (_bytes > _maxBytes) {
        f.writeStringSync('${_stamp()} INFO [log] size limit reached; nothing more is written this run\n');
        f.flushSync();
      }
    } catch (_) {}
  }
}
