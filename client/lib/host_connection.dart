// Connection to one Cockpit Link host: WebSocket, subscriptions, frame decoding, reconnect.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:material_ui/material_ui.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'gauges/gauge_values.dart';
import 'protocol.dart';
import 'updater.dart';

enum LinkState { connecting, connected, disconnected }

/// Latest picture of one display. Decodes only the newest frame: if frames arrive
/// faster than they decode, the ones in between are dropped (never queued).
class DisplayFeed extends ChangeNotifier {
  DisplayFeed(this.id);
  final String id;

  ui.Image? image;
  int width = 0;
  int height = 0;
  DateTime? lastFrameAt;
  double fps = 0;

  Frame? _pending;
  bool _decoding = false;
  bool _disposed = false;
  int _framesInWindow = 0;
  DateTime _windowStart = DateTime.now();

  void push(Frame f) {
    _pending = f;
    if (!_decoding) _decodeLatest();
  }

  Future<void> _decodeLatest() async {
    _decoding = true;
    while (_pending != null && !_disposed) {
      final f = _pending!;
      _pending = null;
      try {
        final codec = await ui.instantiateImageCodec(f.jpeg);
        final frame = await codec.getNextFrame();
        codec.dispose();
        if (_disposed) {
          frame.image.dispose();
          break;
        }
        image?.dispose();
        image = frame.image;
        width = f.width;
        height = f.height;
        _countFrame();
        notifyListeners();
      } catch (_) {
        // A corrupt frame is skipped; the next one replaces it.
      }
    }
    _decoding = false;
  }

  void _countFrame() {
    final now = DateTime.now();
    lastFrameAt = now;
    _framesInWindow++;
    final ms = now.difference(_windowStart).inMilliseconds;
    if (ms >= 1000) {
      fps = _framesInWindow * 1000 / ms;
      _framesInWindow = 0;
      _windowStart = now;
    }
  }

  /// True when no frame has arrived for 2 s (same rule the host uses for "live").
  bool get stale => lastFrameAt == null || DateTime.now().difference(lastFrameAt!).inMilliseconds > 2000;

  @override
  void dispose() {
    _disposed = true;
    image?.dispose();
    image = null;
    super.dispose();
  }
}

class HostConnection extends ChangeNotifier {
  HostConnection({required this.host, required this.port, required this.clientName, this.maxFps = 30});

  final String host;
  final int port;
  final String clientName;
  int maxFps;

  LinkState state = LinkState.disconnected;
  String? hostName;
  String? lastError;
  List<DisplayInfo> displays = const [];
  HostStatus status = const HostStatus();
  List<GaugeLayout> layouts = const [];
  List<ScreenInfo> screens = const [];

  /// Gauge data (smoothed); filled while [wantData] is on.
  final GaugeValues gaugeValues = GaugeValues();
  bool _wantData = false;
  int dataHz = 60;

  final Map<String, DisplayFeed> _feeds = {};
  final Set<String> _wanted = {};
  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _retry;
  Timer? _staleTick;
  int _retryDelayMs = 500;
  bool _closed = false;

  Uri get uri => Uri(scheme: 'ws', host: host, port: port, path: '/ws');

  /// Feed for a display; created on first use. Call [want] to actually receive frames.
  DisplayFeed feed(String id) => _feeds.putIfAbsent(id, () => DisplayFeed(id));

  /// Sets which displays this client wants frames for.
  void want(Iterable<String> ids) {
    final next = ids.toSet();
    for (final id in _wanted.difference(next)) {
      _send(unsubscribeMessage(id));
    }
    for (final id in next.difference(_wanted)) {
      _send(subscribeMessage(id, maxFps));
    }
    _wanted
      ..clear()
      ..addAll(next);
  }

  /// Turn the gauge data stream on or off.
  void wantData(bool on) {
    if (on == _wantData) return;
    _wantData = on;
    _send(on ? subscribeDataMessage(dataHz) : unsubscribeDataMessage());
  }

  GaugeLayout? layout(String id) {
    for (final l in layouts) {
      if (l.id == id) return l;
    }
    return null;
  }

  ScreenInfo? screen(String id) {
    for (final s in screens) {
      if (s.id == id) return s;
    }
    return null;
  }

  void saveLayout(GaugeLayout l) => _send(saveLayoutMessage(l));
  void deleteLayout(String id) => _send(deleteLayoutMessage(id));

  void setMaxFps(int fps) {
    maxFps = fps.clamp(1, 60);
    for (final id in _wanted) {
      _send(subscribeMessage(id, maxFps));
    }
  }

  void start() {
    _closed = false;
    _staleTick ??= Timer.periodic(const Duration(milliseconds: 500), (_) => notifyListeners());
    _connect();
  }

  Future<void> _connect() async {
    if (_closed) return;
    state = LinkState.connecting;
    notifyListeners();
    final ch = WebSocketChannel.connect(uri);
    _channel = ch;
    try {
      await ch.ready.timeout(const Duration(seconds: 5));
    } catch (e) {
      _onDown('Cannot reach $host:$port');
      return;
    }
    if (_closed || _channel != ch) return;
    state = LinkState.connected;
    lastError = null;
    _retryDelayMs = 500;
    notifyListeners();
    _sub = ch.stream.listen(_onMessage, onDone: () => _onDown('Connection closed'), onError: (e) => _onDown('Connection lost'));
    _send(helloMessage(clientName));
    for (final id in _wanted) {
      _send(subscribeMessage(id, maxFps));
    }
    if (_wantData) _send(subscribeDataMessage(dataHz));
  }

  void _onMessage(dynamic data) {
    if (data is Uint8List) {
      final f = parseFrame(data);
      if (f != null) feed(f.display).push(f);
      return;
    }
    if (data is List<int>) {
      _onMessage(Uint8List.fromList(data));
      return;
    }
    if (data is! String) return;
    final Map<String, dynamic> msg;
    try {
      msg = (jsonDecode(data) as Map).cast<String, dynamic>();
    } catch (_) {
      return;
    }
    switch (msg['type']) {
      case 'welcome':
        hostName = msg['host'] as String?;
      case 'displays':
        displays = [for (final d in (msg['displays'] as List? ?? const [])) DisplayInfo.fromJson((d as Map).cast<String, dynamic>())];
      case 'status':
        status = HostStatus.fromJson(msg);
        gaugeValues.setRefs({if (status.vfe != null) 'vfe': status.vfe!, if (status.vno != null) 'vno': status.vno!});
      case 'error':
        lastError = msg['message'] as String?;
      case 'update': // the host is installing its update: the display PCs update too
        Updater.instance.updateFromHost();
        return;
      case 'layouts':
        layouts = [for (final l in (msg['layouts'] as List? ?? const [])) GaugeLayout.fromJson((l as Map).cast<String, dynamic>())];
      case 'screens':
        screens = [for (final s in (msg['screens'] as List? ?? const [])) ScreenInfo.fromJson((s as Map).cast<String, dynamic>())];
      case 'dataVars':
        gaugeValues.setVars([for (final v in (msg['vars'] as List? ?? const [])) '$v']);
        return;
      case 'data':
        gaugeValues.push([for (final v in (msg['v'] as List? ?? const [])) (v as num).toDouble()]);
        return; // gauges repaint on their own ticker; no rebuild needed
    }
    notifyListeners();
  }

  void _onDown(String why) {
    _sub?.cancel();
    _sub = null;
    _channel = null;
    if (_closed) return;
    state = LinkState.disconnected;
    lastError = why;
    notifyListeners();
    _retry?.cancel();
    _retry = Timer(Duration(milliseconds: _retryDelayMs), _connect);
    _retryDelayMs = (_retryDelayMs * 2).clamp(500, 5000);
  }

  void _send(String text) {
    if (state == LinkState.connected) _channel?.sink.add(text);
  }

  void close() {
    _closed = true;
    _retry?.cancel();
    _staleTick?.cancel();
    _staleTick = null;
    _sub?.cancel();
    _channel?.sink.close();
    _channel = null;
    state = LinkState.disconnected;
  }

  @override
  void dispose() {
    close();
    for (final f in _feeds.values) {
      f.dispose();
    }
    gaugeValues.dispose();
    super.dispose();
  }
}
