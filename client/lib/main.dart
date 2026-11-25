// Cockpit Link client: shows sim cockpit displays streamed by the Cockpit Link host.
//
// Window 1 (the app as started) opens the Settings page, or the displays straight away when "Open the
// windows straight away" is on or the command line says what to show. Extra windows are further copies
// of the app started with --child --output <n>; they go straight to their display.

import 'package:material_ui/material_ui.dart';

import 'desktop.dart';
import 'displays_screen.dart';
import 'settings.dart';
import 'settings_screen.dart';

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();
  final settings = await Settings.load(args);
  await initDesktopWindow();
  if (settings.isChild) {
    await placeWindow(settings.output, title: 'Cockpit Link · window ${settings.outputIndex + 1}');
  } else {
    await ExtraWindowsCloser.instance.install();
  }
  runApp(CockpitLinkApp(settings: settings));
}

class CockpitLinkApp extends StatelessWidget {
  const CockpitLinkApp({super.key, required this.settings});
  final Settings settings;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Cockpit Link',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: const Color(0xFF2E7D32), brightness: Brightness.dark),
      home: settings.isChild
          ? DisplaysScreen(settings: settings)
          : SettingsScreen(settings: settings, openOnStart: settings.autoStart || settings.fromCommandLine),
    );
  }
}
