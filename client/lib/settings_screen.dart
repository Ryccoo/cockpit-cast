// Settings page: everything a device needs, without any command line.
//   Host: find automatically, or a fixed address.
//   Windows: one per monitor - which monitor, full screen, and what it shows (lists come from the host).
//   Startup: start at sign-in, open the windows straight away, hide the mouse pointer.
//   Other: device name, frame rate.
//   Updates: this version, whether a newer one exists, install it (see updater.dart).
// "Save and start" saves, then opens the windows (this one, plus one more app copy per extra window).

import 'dart:async';

import 'package:material_ui/material_ui.dart';

import 'package:url_launcher/url_launcher.dart';

import 'about.dart';
import 'desktop.dart';
import 'discovery.dart';
import 'displays_screen.dart';
import 'host_connection.dart';
import 'protocol.dart';
import 'settings.dart';
import 'updater.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, required this.settings, this.openOnStart = false});
  final Settings settings;

  /// Open the windows straight away (saved setting, or the command line said what to show).
  final bool openOnStart;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  Settings get s => widget.settings;

  late final TextEditingController hostCtl;
  late final TextEditingController nameCtl;
  late bool autoHost;
  List<FoundHost> found = const [];
  bool searching = false;
  String? searchError;
  HostConnection? conn; // to read the host's screens and layouts while editing
  List<MonitorInfo> monitors = const [];
  String? message;

  @override
  void initState() {
    super.initState();
    autoHost = s.discover;
    hostCtl = TextEditingController(text: s.discover ? '' : (s.port == defaultPort ? s.host : '${s.host}:${s.port}'));
    nameCtl = TextEditingController(text: s.clientName);
    restoreWindow();
    listMonitors().then((m) => mounted ? setState(() => monitors = m) : null);
    if (widget.openOnStart) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _open());
    } else {
      _search();
      if (!autoHost && hostCtl.text.isNotEmpty) _connectTo(hostCtl.text);
    }
  }

  @override
  void dispose() {
    conn?.dispose();
    hostCtl.dispose();
    nameCtl.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    setState(() {
      searching = true;
      searchError = null;
    });
    try {
      final hosts = await discoverHosts();
      if (!mounted) return;
      setState(() => found = hosts);
      if (autoHost && hosts.isNotEmpty) _connectTo('${hosts.first.address}:${hosts.first.port}');
    } catch (_) {
      if (mounted) setState(() => searchError = 'Network search is not available here; enter the address instead.');
    } finally {
      if (mounted) setState(() => searching = false);
    }
  }

  void _connectTo(String text) {
    final parts = text.trim().split(':');
    if (parts.first.isEmpty) return;
    final host = parts.first, port = parts.length > 1 ? (int.tryParse(parts[1]) ?? defaultPort) : defaultPort;
    if (conn != null && conn!.host == host && conn!.port == port) return;
    conn?.dispose();
    conn = HostConnection(host: host, port: port, clientName: '${s.clientName} (settings)')..start();
    conn!.addListener(() => mounted ? setState(() {}) : null);
    setState(() {});
  }

  // ---- what a window can show ----
  List<(String, String)> _contentOptions(OutputConfig o) {
    final c = conn;
    final screens = c?.screens ?? const <ScreenInfo>[];
    final layouts = c?.layouts ?? const <GaugeLayout>[];
    final displays = c?.displays ?? const <DisplayInfo>[];
    final opts = <(String, String)>[
      if (screens.isNotEmpty)
        for (final sc in screens) ('screen:${sc.id}', 'Host screen "${sc.name}" (glass or steam, chosen automatically)')
      else
        for (final id in const ['1', '2', '3', '4']) ('screen:$id', 'Host screen $id (glass or steam, chosen automatically)'),
      // Glass displays the host knows (it learns more as cockpits are flown).
      if (displays.isNotEmpty)
        for (final d in displays) ('displays:${d.id}', 'Glass display: ${d.name}')
      else ...[
        ('displays:pfd', 'Glass display: PFD'),
        ('displays:mfd', 'Glass display: MFD'),
      ],
      ('displays:pfd,mfd', 'Glass displays: PFD and MFD'),
      if (layouts.isNotEmpty)
        for (final l in layouts) ('layout:${l.id}', 'Gauge layout: ${l.name}')
      else ...[
        ('layout:six-pack', 'Gauge layout: Six-pack'),
        ('layout:engine-radios', 'Gauge layout: Engine and radios'),
      ],
    ];
    if (!opts.any((e) => e.$1 == o.contentKey)) opts.add((o.contentKey, o.contentKey));
    return opts;
  }

  Future<void> _saveAndStart() async {
    s.host = autoHost ? null : hostCtl.text.trim().split(':').first;
    if (!autoHost) {
      final parts = hostCtl.text.trim().split(':');
      s.port = parts.length > 1 ? (int.tryParse(parts[1]) ?? defaultPort) : defaultPort;
      if (s.host!.isEmpty) {
        setState(() => message = 'Enter the host address, or switch on "Find the host automatically".');
        return;
      }
    }
    s.clientName = nameCtl.text.trim().isEmpty ? s.clientName : nameCtl.text.trim();
    await s.save();
    final err = await setLaunchAtLogin(s.launchAtLogin, profile: s.profile);
    if (!mounted) return;
    setState(() => message = err);
    await _open();
  }

  /// Open the windows: this one on its monitor, plus one app copy per extra window.
  Future<void> _open() async {
    conn?.dispose();
    conn = null;
    s.outputIndex = 0;
    if (!s.fromCommandLine) await startExtraWindows(s);
    await placeWindow(s.output, title: 'CockpitCast · window 1');
    if (!mounted) return;
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => DisplaysScreen(settings: s)));
    // Back from the displays: settings again, as a normal window, extra windows closed.
    await stopExtraWindows();
    await restoreWindow();
    if (mounted) {
      setState(() {});
      if (autoHost) {
        _search();
      } else {
        _connectTo(hostCtl.text);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final c = conn;
    final hostStatus = c == null
        ? (autoHost ? (searching ? 'Searching the network...' : (found.isEmpty ? 'No host found yet. Is the host running on the sim PC?' : '')) : 'Not connected')
        : switch (c.state) {
            LinkState.connected => 'Connected to ${c.hostName ?? c.host} (${c.host}:${c.port})',
            LinkState.connecting => 'Connecting to ${c.host}...',
            LinkState.disconnected => '${c.lastError ?? 'Not connected'} - retrying',
          };

    Widget section(String title, List<Widget> children) => Card(
          margin: const EdgeInsets.only(bottom: 16),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: theme.textTheme.titleMedium),
              const SizedBox(height: 8),
              ...children,
            ]),
          ),
        );

    return Scaffold(
      appBar: AppBar(title: const Text('CockpitCast settings')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              section('Host (the sim PC)', [
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Find the host automatically'),
                  subtitle: const Text('Uses the first CockpitCast host on this network'),
                  value: autoHost,
                  onChanged: (v) {
                    setState(() => autoHost = v);
                    if (v) {
                      _search();
                    } else if (hostCtl.text.isNotEmpty) {
                      _connectTo(hostCtl.text);
                    }
                  },
                ),
                if (!autoHost)
                  TextField(
                    controller: hostCtl,
                    decoration: const InputDecoration(labelText: 'Host address', hintText: '192.168.1.50 or 192.168.1.50:8800', border: OutlineInputBorder()),
                    onSubmitted: _connectTo,
                  ),
                const SizedBox(height: 8),
                Row(children: [
                  Expanded(child: Text(hostStatus, style: TextStyle(color: c?.state == LinkState.connected ? Colors.green : null))),
                  if (searching)
                    const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  else
                    IconButton(icon: const Icon(Icons.refresh), tooltip: 'Search again', onPressed: _search),
                ]),
                if (searchError != null) Text(searchError!, style: TextStyle(color: theme.colorScheme.error)),
                if (!autoHost)
                  for (final h in found)
                    ListTile(
                      dense: true,
                      leading: const Icon(Icons.computer),
                      title: Text(h.name),
                      subtitle: Text('${h.address}:${h.port}'),
                      onTap: () {
                        hostCtl.text = h.port == defaultPort ? h.address : '${h.address}:${h.port}';
                        _connectTo(hostCtl.text);
                      },
                    ),
              ]),
              section('Windows on this device', [
                const Text('One window per monitor. Each window is pinned to its monitor and shows one thing.'),
                const SizedBox(height: 8),
                for (var i = 0; i < s.outputs.length; i++) _outputCard(i),
                Align(
                  alignment: Alignment.centerLeft,
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.add),
                    label: const Text('Add window'),
                    onPressed: () => setState(() {
                      final used = s.outputs.map((o) => o.monitorIndex).toSet();
                      final free = List.generate(monitors.length, (i) => i).firstWhere((i) => !used.contains(i), orElse: () => 0);
                      final next = '${s.outputs.length + 1}';
                      s.outputs.add(OutputConfig(monitorIndex: free, monitorId: monitors.isNotEmpty ? monitors[free].id : null, screen: next));
                    }),
                  ),
                ),
              ]),
              section('Startup', [
                if (isDesktop)
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Start CockpitCast when I sign in'),
                    value: s.launchAtLogin,
                    onChanged: (v) => setState(() => s.launchAtLogin = v),
                  ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Open the windows straight away'),
                  subtitle: const Text('Skip this page when the app starts. Tap a display to come back here.'),
                  value: s.autoStart,
                  onChanged: (v) => setState(() => s.autoStart = v),
                ),
                if (isDesktop)
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Hide the mouse pointer over the displays'),
                    value: s.hideCursor,
                    onChanged: (v) => setState(() => s.hideCursor = v),
                  ),
              ]),
              section('Other', [
                TextField(
                  controller: nameCtl,
                  decoration: const InputDecoration(labelText: 'Device name (shown on the host)', border: OutlineInputBorder()),
                ),
                const SizedBox(height: 12),
                Text('Max frame rate for glass displays: ${s.maxFps} fps'),
                Slider(value: s.maxFps.toDouble(), min: 5, max: 60, divisions: 11, label: '${s.maxFps}', onChanged: (v) => setState(() => s.maxFps = v.round())),
              ]),
              _updatesSection(section),
              if (message != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(message!, style: TextStyle(color: theme.colorScheme.error))),
              FilledButton.icon(icon: const Icon(Icons.play_arrow), label: const Text('Save and start'), onPressed: _saveAndStart),
              const SizedBox(height: 8),
              const Text('Advanced: every setting can also be given on the command line (see the README).', style: TextStyle(color: Colors.grey)),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  icon: const Icon(Icons.favorite, color: Colors.redAccent),
                  label: const Text('Support CockpitCast on Ko-fi'),
                  onPressed: () => launchUrl(Uri.parse(supportUrl), mode: LaunchMode.externalApplication),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _updatesSection(Widget Function(String, List<Widget>) section) {
    return ListenableBuilder(
      listenable: Updater.instance,
      builder: (context, _) {
        final u = Updater.instance;
        final theme = Theme.of(context);
        final status = u.busy
            ? 'Downloading version ${u.latest}...'
            : u.available
                ? 'Version ${u.latest} is available.'
                : u.checkedAt == null
                    ? 'Not checked yet.'
                    : 'Up to date.';
        return section('Updates', [
          Text('CockpitCast $appVersion. $status'),
          if (u.error != null) Text(u.error!, style: TextStyle(color: theme.colorScheme.error)),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: [
            if (u.available && u.canInstall)
              FilledButton.icon(icon: const Icon(Icons.system_update), label: const Text('Update now'), onPressed: u.busy ? null : u.install),
            if (u.available && !u.canInstall)
              FilledButton.icon(
                icon: const Icon(Icons.download),
                label: const Text('Download'),
                onPressed: () => launchUrl(Uri.parse(downloadUrl), mode: LaunchMode.externalApplication),
              ),
            if (u.available && u.releaseUrl != null)
              TextButton(onPressed: () => launchUrl(Uri.parse(u.releaseUrl!), mode: LaunchMode.externalApplication), child: const Text("What's new")),
            OutlinedButton(onPressed: u.busy ? null : u.check, child: const Text('Check now')),
          ]),
          if (u.canInstall)
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Update automatically'),
              subtitle: const Text('When the app starts, and when the sim PC installs an update'),
              value: s.autoUpdate,
              onChanged: (v) => setState(() => s.autoUpdate = v),
            ),
        ]);
      },
    );
  }

  Widget _outputCard(int i) {
    final o = s.outputs[i];
    final m = findMonitor(monitors, o);
    final opts = _contentOptions(o);
    return Card(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Text(i == 0 ? 'Window 1 (this window)' : 'Window ${i + 1}', style: const TextStyle(fontWeight: FontWeight.w600)),
            const Spacer(),
            if (s.outputs.length > 1)
              IconButton(icon: const Icon(Icons.delete_outline), tooltip: 'Remove this window', onPressed: () => setState(() => s.outputs.removeAt(i))),
          ]),
          if (isDesktop) ...[
            DropdownButtonFormField<int>(
              initialValue: m?.index,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Monitor', border: OutlineInputBorder()),
              items: [for (final mon in monitors) DropdownMenuItem(value: mon.index, child: Text(mon.label, overflow: TextOverflow.ellipsis))],
              onChanged: (v) => setState(() {
                if (v == null) return;
                o.monitorIndex = v;
                o.monitorId = monitors[v].id;
                o.monitorName = monitors[v].display.name;
              }),
            ),
            const SizedBox(height: 8),
          ],
          DropdownButtonFormField<String>(
            initialValue: o.contentKey,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Shows', border: OutlineInputBorder()),
            items: [for (final (k, label) in opts) DropdownMenuItem(value: k, child: Text(label, overflow: TextOverflow.ellipsis))],
            onChanged: (v) => setState(() => v == null ? null : o.contentKey = v),
          ),
          if (o.mode == ContentMode.displays && o.displays.length > 1) ...[
            const SizedBox(height: 8),
            SegmentedButton<SplitLayout>(
              segments: const [
                ButtonSegment(value: SplitLayout.auto, label: Text('Auto')),
                ButtonSegment(value: SplitLayout.row, label: Text('Side by side')),
                ButtonSegment(value: SplitLayout.column, label: Text('Stacked')),
              ],
              selected: {o.split},
              onSelectionChanged: (v) => setState(() => o.split = v.first),
            ),
          ],
          if (isDesktop)
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Full screen'),
              value: o.fullscreen,
              onChanged: (v) => setState(() => o.fullscreen = v),
            ),
        ]),
      ),
    );
  }
}
