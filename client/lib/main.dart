// CockpitCast client: shows sim cockpit displays streamed by the CockpitCast host.
//
// Window 1 (the app as started) opens the Settings page, or the displays straight away when "Open the
// windows straight away" is on or the command line says what to show. Extra windows are further copies
// of the app started with --child --output <n>; they go straight to their display.

import 'package:material_ui/material_ui.dart';

import 'desktop.dart';
import 'displays_screen.dart';
import 'legacy.dart';
import 'settings.dart';
import 'settings_screen.dart';
import 'updater.dart';

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();
  await moveLegacySettings(); // settings saved under the project's former name (up to 0.1.1)
  final settings = await Settings.load(args);
  await initDesktopWindow();
  if (settings.isChild) {
    await placeWindow(settings.output, title: 'CockpitCast · window ${settings.outputIndex + 1}');
  } else {
    await ExtraWindowsCloser.instance.install();
    Updater.instance.start(args: args, autoInstall: settings.autoUpdate);
    moveLegacyLaunchAtLogin(settings);
  }
  runApp(CockpitCastApp(settings: settings));
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
