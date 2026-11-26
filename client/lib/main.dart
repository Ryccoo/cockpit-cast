// CockpitCast client: shows sim cockpit displays streamed by the CockpitCast host.
//
// Window 1 (the app as started) opens the Settings page, or the displays straight away when "Open the
// windows straight away" is on or the command line says what to show. Extra windows are further copies
// of the app started with --child --output <n>; they go straight to their display.

import 'dart:io';
import 'dart:ui' show PlatformDispatcher;

import 'package:material_ui/material_ui.dart';

import 'about.dart';
import 'desktop.dart';
import 'displays_screen.dart';
import 'legacy.dart';
import 'log.dart';
import 'settings.dart';
import 'settings_screen.dart';
import 'updater.dart';

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();
  await moveLegacySettings(); // settings saved under the project's former name (up to 0.1.1)
  final settings = await Settings.load(args);
  AppLog.init(['client', if (settings.profile.isNotEmpty) settings.profile, if (settings.isChild) 'window${settings.outputIndex + 1}'].join('-'));
  AppLog.info('app', 'CockpitCast $appVersion, ${settings.isChild ? 'window ${settings.outputIndex + 1}' : 'window 1'}, '
      '${Platform.operatingSystem} ${Platform.operatingSystemVersion}; command line: ${args.isEmpty ? '(none)' : args.join(' ')}');
  for (final d in PlatformDispatcher.instance.displays) {
    AppLog.info('app', 'display ${d.id}: ${d.size.width.round()}x${d.size.height.round()} px, scale ${d.devicePixelRatio}, ${d.refreshRate.round()} Hz');
  }
  WidgetsBinding.instance.addObserver(_LogObserver());
  await initDesktopWindow();
  // Every window ends its process when closed (see ExtraWindowsCloser: Flutter crashes tearing a window down).
  await ExtraWindowsCloser.instance.install();
  if (settings.isChild) {
    await placeWindow(settings.output, title: 'CockpitCast · window ${settings.outputIndex + 1}');
  } else {
    Updater.instance.start(args: args, autoInstall: settings.autoUpdate, beta: settings.betaUpdates);
    moveLegacyLaunchAtLogin(settings);
  }
  runApp(CockpitCastApp(settings: settings));
}

/// Logs what the system does to the app: sleep and wake, focus, window size and scale changes (a moved
/// or resized window, a monitor or DPI change), low memory.
class _LogObserver with WidgetsBindingObserver {
  String _metrics = '';
  DateTime _metricsAt = DateTime(0);

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => AppLog.info('app', 'lifecycle: ${state.name}');

  @override
  void didChangeMetrics() {
    final views = PlatformDispatcher.instance.views;
    if (views.isEmpty) return;
    final v = views.first;
    final now = '${(v.physicalSize.width).round()}x${(v.physicalSize.height).round()} px, scale ${v.devicePixelRatio}';
    // While a window is dragged or resized this fires many times a second: log changes, at most every 2 s.
    if (now == _metrics || DateTime.now().difference(_metricsAt).inSeconds < 2) return;
    _metrics = now;
    _metricsAt = DateTime.now();
    AppLog.info('app', 'window size: $now');
  }

  @override
  void didHaveMemoryPressure() => AppLog.warn('app', 'the system is low on memory');
}

class CockpitCastApp extends StatelessWidget {
  const CockpitCastApp({super.key, required this.settings});
  final Settings settings;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'CockpitCast',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: const Color(0xFF2E7D32), brightness: Brightness.dark),
      home: settings.isChild
          ? DisplaysScreen(settings: settings)
          : SettingsScreen(settings: settings, openOnStart: settings.autoStart || settings.fromCommandLine),
    );
  }
}
