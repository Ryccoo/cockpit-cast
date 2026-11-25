// Per-device settings, kept with shared_preferences and edited on the Settings page. A device has one or
// more windows (outputs), each pinned to a monitor and showing one thing. Window 1 is the app itself; the
// app starts one more copy of itself per extra window (see desktop.dart), so nobody needs a command line.
//
// Command-line flags still work and override the saved settings for that run (one window):
//   --screen 1            follow the host's screen 1 (glass display or steam layout, chosen by the host)
//   --displays pfd,mfd    show these glass displays
//   --layout six-pack     show this gauge layout
//   --host 192.168.1.50   host address (omit to find the host on the network automatically)
//   --monitor 2           open on this monitor (number as listed in Settings, or its id)
//   --fullscreen / --windowed
//   --port 8800  --fps 30  --split auto|row|column  --name "Cockpit left"
//   --profile left        keep this copy's saved settings separate from other copies on the same box
// Internal (used when the app starts its extra windows): --child --output <n>

import 'dart:convert';
import 'dart:io';

import 'package:shared_preferences/shared_preferences.dart';

import 'protocol.dart';

enum SplitLayout { auto, row, column }

/// What a window shows.
enum ContentMode { screen, displays, layout }

/// One window: which monitor, full-screen or not, and what it shows.
class OutputConfig {
  OutputConfig({
    this.monitorId,
    this.monitorName,
    this.monitorIndex = 0,
    this.fullscreen = true,
    this.mode = ContentMode.screen,
    this.screen = '1',
    this.displays = const ['pfd'],
    this.layoutId = 'six-pack',
    this.split = SplitLayout.auto,
  });

  factory OutputConfig.fromJson(Map<String, dynamic> j) => OutputConfig(
        monitorId: j['monitorId'] as String?,
        monitorName: j['monitorName'] as String?,
        monitorIndex: (j['monitorIndex'] as num?)?.toInt() ?? 0,
        fullscreen: j['fullscreen'] != false,
        mode: ContentMode.values.asNameMap()[j['mode']] ?? ContentMode.screen,
        screen: '${j['screen'] ?? '1'}',
        displays: [for (final d in (j['displays'] as List? ?? const ['pfd'])) '$d'],
        layoutId: j['layoutId'] as String? ?? 'six-pack',
        split: SplitLayout.values.asNameMap()[j['split']] ?? SplitLayout.auto,
      );

  /// Monitor this window is pinned to: id as reported by the OS, plus name and position in the list as
  /// fallbacks (ids can change when monitors are re-plugged).
  String? monitorId;
  String? monitorName;
  int monitorIndex;
  bool fullscreen;
  ContentMode mode;
  String screen;
  List<String> displays;
  String layoutId;
  SplitLayout split;

  Map<String, dynamic> toJson() => {
        'monitorId': monitorId,
        'monitorName': monitorName,
        'monitorIndex': monitorIndex,
        'fullscreen': fullscreen,
        'mode': mode.name,
        'screen': screen,
        'displays': displays,
        'layoutId': layoutId,
        'split': split.name,
      };

  OutputConfig copy() => OutputConfig.fromJson(toJson());

  /// Compact description of the content, e.g. "screen:1", "displays:pfd,mfd", "layout:six-pack".
  String get contentKey => switch (mode) {
        ContentMode.screen => 'screen:$screen',
        ContentMode.displays => 'displays:${displays.join(',')}',
        ContentMode.layout => 'layout:$layoutId',
      };

  set contentKey(String key) {
    final i = key.indexOf(':');
    final kind = key.substring(0, i), value = key.substring(i + 1);
    switch (kind) {
      case 'screen':
        mode = ContentMode.screen;
        screen = value;
      case 'displays':
        mode = ContentMode.displays;
        displays = value.split(',').where((e) => e.isNotEmpty).toList();
      case 'layout':
        mode = ContentMode.layout;
        layoutId = value;
    }
  }
}

class Settings {
  Settings({
    this.host,
    this.port = defaultPort,
    this.maxFps = 30,
    this.autoStart = false,
    this.launchAtLogin = false,
    this.hideCursor = false,
    this.profile = '',
    required this.clientName,
    List<OutputConfig>? outputs,
  }) : outputs = outputs ?? [OutputConfig()];

  /// Fixed host address; null = find the host on the network.
  String? host;
  int port;
  int maxFps;

  /// Open the windows straight away when the app starts (instead of the Settings page).
  bool autoStart;

  /// Start the app when the user signs in to the computer.
  bool launchAtLogin;

  /// Hide the mouse pointer over the displays.
  bool hideCursor;

  /// Prefix for saved keys, so separate copies on one box keep separate settings.
  String profile;
  String clientName;
  List<OutputConfig> outputs;

  // ---- this run ----

  /// The command line chose what to show: one window, no Settings page first.
  bool fromCommandLine = false;

  /// This process is an extra window started by window 1.
  bool isChild = false;

  /// Which output this process shows.
  int outputIndex = 0;

  OutputConfig get output => outputs[outputIndex.clamp(0, outputs.length - 1)];

  /// Find the host on the network instead of using [host] (kiosk boxes).
  bool get discover => host == null || host!.isEmpty;

  static Future<Settings> load(List<String> args) async {
    String? value(String flag) {
      final i = args.indexOf(flag);
      return (i >= 0 && i + 1 < args.length) ? args[i + 1] : null;
    }

    final profile = value('--profile') ?? '';
    final p = await SharedPreferences.getInstance();
    await p.reload(); // another copy of the app may have saved since this one started
    String k(String name) => profile.isEmpty ? name : '$profile.$name';

    List<OutputConfig>? outputs;
    final saved = p.getString(k('outputs'));
    if (saved != null) {
      try {
        outputs = [for (final o in jsonDecode(saved) as List) OutputConfig.fromJson((o as Map).cast<String, dynamic>())];
      } catch (_) {}
    }
    // Settings saved by earlier versions (one window, fields at the top level).
    outputs ??= [
      OutputConfig(
        mode: ContentMode.values.asNameMap()[p.getString(k('mode'))] ?? ContentMode.screen,
        screen: p.getString(k('screen')) ?? '1',
        displays: p.getStringList(k('displays')) ?? const ['pfd'],
        layoutId: p.getString(k('layoutId')) ?? 'six-pack',
        split: SplitLayout.values.asNameMap()[p.getString(k('split'))] ?? SplitLayout.auto,
        fullscreen: false,
      ),
    ];
    if (outputs.isEmpty) outputs = [OutputConfig()];

    final s = Settings(
      host: p.getString(k('host')),
      port: p.getInt(k('port')) ?? defaultPort,
      maxFps: p.getInt(k('maxFps')) ?? 30,
      autoStart: p.getBool(k('autoStart')) ?? false,
      launchAtLogin: p.getBool(k('launchAtLogin')) ?? false,
      hideCursor: p.getBool(k('hideCursor')) ?? false,
      profile: profile,
      clientName: p.getString(k('clientName')) ?? _defaultName(),
      outputs: outputs,
    );

    // Extra window started by window 1.
    if (args.contains('--child')) {
      s.isChild = true;
      s.outputIndex = (int.tryParse(value('--output') ?? '') ?? 1).clamp(0, s.outputs.length - 1);
      return s;
    }

    // Command-line overrides: one window, showing what the flags say.
    final o = s.outputs.first;
    final h = value('--host');
    if (h != null) s.host = h;
    s.port = int.tryParse(value('--port') ?? '') ?? s.port;
    final scr = value('--screen');
    if (scr != null) {
      o.mode = ContentMode.screen;
      o.screen = scr;
      if (h == null) s.host = null; // kiosk: find the host on the network
    }
    final d = value('--displays');
    if (d != null) {
      o.mode = ContentMode.displays;
      o.displays = d.split(',').map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
    }
    final l = value('--layout');
    if (l != null) {
      o.mode = ContentMode.layout;
      o.layoutId = l;
    }
    final mon = value('--monitor');
    if (mon != null) {
      final n = int.tryParse(mon);
      o.monitorId = n == null ? mon : null;
      o.monitorName = null;
      o.monitorIndex = n != null ? n - 1 : 0;
    }
    if (args.contains('--fullscreen')) o.fullscreen = true;
    if (args.contains('--windowed')) o.fullscreen = false;
    o.split = SplitLayout.values.asNameMap()[value('--split')] ?? o.split;
    s.maxFps = (int.tryParse(value('--fps') ?? '') ?? s.maxFps).clamp(1, 60);
    s.clientName = value('--name') ?? (profile.isEmpty ? s.clientName : '${s.clientName} ($profile)');
    s.fromCommandLine = scr != null || d != null || l != null || h != null || mon != null;
    if (s.fromCommandLine) s.outputs = [o];
    return s;
  }

  Future<void> save() async {
    final p = await SharedPreferences.getInstance();
    String k(String name) => profile.isEmpty ? name : '$profile.$name';
    if (host != null && host!.isNotEmpty) {
      await p.setString(k('host'), host!);
    } else {
      await p.remove(k('host'));
    }
    await p.setInt(k('port'), port);
    await p.setInt(k('maxFps'), maxFps);
    await p.setBool(k('autoStart'), autoStart);
    await p.setBool(k('launchAtLogin'), launchAtLogin);
    await p.setBool(k('hideCursor'), hideCursor);
    await p.setString(k('clientName'), clientName);
    await p.setString(k('outputs'), jsonEncode([for (final o in outputs) o.toJson()]));
  }

  static String _defaultName() {
    try {
      return Platform.localHostname;
    } catch (_) {
      return 'Cockpit Link client';
    }
  }
}
