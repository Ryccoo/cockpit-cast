// Full-screen viewer. Shows, depending on Settings.mode:
//   screen:   whatever the host assigns to this screen (glass display or steam-gauge layout), switching
//             automatically when the aircraft changes;
//   displays: the chosen glass displays side by side;
//   layout:   one gauge layout.
// Without a host address it finds the host on the network (kiosk boxes need no keyboard).
// Tap anywhere for the overlay (status, back).

import 'dart:async';

import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import 'discovery.dart';
import 'display_view.dart';
import 'host_connection.dart';
import 'layout_view.dart';
import 'protocol.dart';
import 'settings.dart';

class DisplaysScreen extends StatefulWidget {
  const DisplaysScreen({super.key, required this.settings});
  final Settings settings;

  @override
  State<DisplaysScreen> createState() => _DisplaysScreenState();
}

class _DisplaysScreenState extends State<DisplaysScreen> {
  HostConnection? conn;
  bool overlay = false;
  Timer? _hideOverlay;
  Timer? _discoverRetry;
  String _discoverText = 'Looking for the CockpitCast host on the network...';

  Settings get s => widget.settings;
  OutputConfig get o => s.output;

  @override
  void initState() {
    super.initState();
    WakelockPlus.enable().catchError((_) {});
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky).catchError((_) {});
    if (s.discover) {
      _discover();
    } else {
      _connect(s.host!, s.port);
    }
  }

  Future<void> _discover() async {
    try {
      final hosts = await discoverHosts();
      if (!mounted) return;
      if (hosts.isNotEmpty) {
        if (hosts.length > 1) _discoverText = 'Several hosts found; using ${hosts.first.name}';
        _connect(hosts.first.address, hosts.first.port);
        return;
      }
      setState(() => _discoverText = 'No CockpitCast host found yet. Is the host running on the sim PC?\nSearching again...');
    } catch (_) {
      if (!mounted) return;
      setState(() => _discoverText = 'Network search is not available on this device.\nStart the app with --host <address>.');
    }
    _discoverRetry = Timer(const Duration(seconds: 3), _discover);
  }

  void _connect(String host, int port) {
    setState(() {
      conn = HostConnection(host: host, port: port, clientName: s.clientName, maxFps: s.maxFps)..start();
    });
  }

  @override
  void dispose() {
    _hideOverlay?.cancel();
    _discoverRetry?.cancel();
    conn?.dispose();
    WakelockPlus.disable().catchError((_) {});
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge).catchError((_) {});
    super.dispose();
  }

  void _toggleOverlay() {
    setState(() => overlay = !overlay);
    _hideOverlay?.cancel();
    if (overlay) _hideOverlay = Timer(const Duration(seconds: 8), () => mounted ? setState(() => overlay = false) : null);
  }

  /// The host's name for a display (e.g. "KX155A 1"), or null when the host does not list it.
  String? _nameOf(HostConnection c, String id) {
    for (final d in c.displays) {
      if (d.id == id) return d.name;
    }
    return null;
  }

  String _waitingText(HostConnection c, {bool forGlass = true}) {
    switch (c.state) {
      case LinkState.connecting:
        return 'Connecting to ${c.host}...';
      case LinkState.disconnected:
        return '${c.lastError ?? 'Disconnected'}\nRetrying...';
      case LinkState.connected:
        final st = c.status;
        if (!st.simConnected) return 'Waiting for the sim';
        if (!st.inFlight) return 'Waiting for a flight';
        if (!forGlass) return 'Waiting for gauge data';
        if (!st.captureConnected) {
          return switch (st.injector) {
            'stabilizing' => 'Starting capture shortly',
            'failed' => 'Capture could not start (see host log)',
            'no-dll' || 'no-injector' => 'Capture is not installed on the host',
            _ => 'Waiting for capture',
          };
        }
        return 'Waiting for frames';
    }
  }

  bool _useRow(BoxConstraints c, int n) {
    switch (o.split) {
      case SplitLayout.row:
        return true;
      case SplitLayout.column:
        return false;
      case SplitLayout.auto:
        // Pick whichever split gives each display more area for a 4:3 picture.
        double area(double w, double h) {
          final scale = (w / 4 < h / 3) ? w / 4 : h / 3;
          return scale * scale;
        }

        return area(c.maxWidth / n, c.maxHeight) >= area(c.maxWidth, c.maxHeight / n);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = conn;
    return Scaffold(
      backgroundColor: Colors.black,
      body: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: _toggleOverlay,
        child: c == null
            ? Stack(fit: StackFit.expand, children: [_message(_discoverText), if (overlay) _overlayBar(context, null)])
            : ListenableBuilder(listenable: c, builder: (context, _) => _content(context, c)),
      ),
    );
  }

  Widget _content(BuildContext context, HostConnection c) {
    // Decide what to show, then keep the host subscriptions in line with it.
    List<String> displays = const [];
    GaugeLayout? layout;
    String? missing;
    String? waiting;
    switch (o.mode) {
      case ContentMode.displays:
        displays = o.displays;
      case ContentMode.layout:
        layout = c.layout(o.layoutId);
        if (layout == null && c.state == LinkState.connected) missing = 'Layout "${o.layoutId}" is not on the host';
      case ContentMode.screen:
        final info = c.screen(o.screen);
        if (info == null) {
          waiting = c.state == LinkState.connected ? 'The host has no screen "${o.screen}"' : _waitingText(c);
        } else if (info.kind == 'display' && info.target != null) {
          displays = [info.target!];
        } else if (info.kind == 'layout' && info.target != null) {
          layout = c.layout(info.target!);
          if (layout == null) missing = 'Layout "${info.target}" is not on the host';
        } else {
          waiting = c.state == LinkState.connected ? '${_waitingText(c)}\n(${info.name}: deciding glass or steam)' : _waitingText(c);
        }
    }
    // Glass items in a layout need their displays' frames too.
    final glassIds = [
      for (final g in layout?.gauges ?? const <LayoutGauge>[])
        if (g.type == 'glass' && '${g.options['display'] ?? ''}'.isNotEmpty) '${g.options['display']}',
    ];
    c.want({...displays, ...glassIds});
    c.wantData(layout != null && layout.gauges.any((g) => g.type != 'glass'));

    Widget body;
    if (layout != null) {
      body = LayoutView(key: ValueKey(layout.id), layout: layout, values: c.gaugeValues, feedFor: c.feed, nameFor: (id) => _nameOf(c, id));
    } else if (displays.isNotEmpty) {
      body = LayoutBuilder(builder: (context, box) {
        final views = [
          for (final id in displays) Expanded(child: DisplayView(feed: c.feed(id), waitingText: _waitingText(c), showStats: overlay, name: _nameOf(c, id))),
        ];
        return _useRow(box, displays.length) ? Row(children: views) : Column(children: views);
      });
    } else {
      body = _message(missing ?? waiting ?? _waitingText(c));
    }
    if (s.hideCursor) body = MouseRegion(cursor: SystemMouseCursors.none, child: body);
    return Stack(fit: StackFit.expand, children: [body, if (overlay) _overlayBar(context, c)]);
  }

  Widget _message(String text) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(text, textAlign: TextAlign.center, style: const TextStyle(color: Color(0xFFB0B0B0), fontSize: 18)),
        ),
      );

  Widget _overlayBar(BuildContext context, HostConnection? c) {
    String text;
    if (c == null) {
      text = 'Searching for the host';
    } else {
      final st = c.status;
      final sim = !st.simConnected ? 'sim not running' : (st.inFlight ? 'in flight${st.paused ? ' (paused)' : ''}${st.aircraft != null ? ': ${st.aircraft}' : ''}' : 'in menus');
      final what = switch (o.mode) {
        ContentMode.screen => 'screen ${o.screen}${c.screen(o.screen) != null ? ' (${c.screen(o.screen)!.mode})' : ''}',
        ContentMode.displays => o.displays.join('+'),
        ContentMode.layout => 'layout ${o.layoutId}',
      };
      text = '${c.hostName ?? c.host}  ·  ${c.state.name}  ·  $what  ·  $sim';
    }
    return Positioned(
      left: 0,
      right: 0,
      bottom: 0,
      child: Container(
        color: const Color(0xDD101010),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        child: Row(
          children: [
            if (s.isChild)
              Text('Window ${s.outputIndex + 1} · settings are in window 1', style: const TextStyle(color: Colors.white70))
            else
              TextButton.icon(
                icon: const Icon(Icons.settings, color: Colors.white),
                label: const Text('Settings', style: TextStyle(color: Colors.white)),
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            const SizedBox(width: 12),
            Expanded(child: Text(text, style: const TextStyle(color: Colors.white70), overflow: TextOverflow.ellipsis)),
          ],
        ),
      ),
    );
  }
}
