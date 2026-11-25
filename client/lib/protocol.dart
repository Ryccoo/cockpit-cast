// CockpitCast client protocol (version 1). Spec: docs/protocol.md.

import 'dart:convert';
import 'dart:typed_data';

const int protocolVersion = 1;
const int defaultPort = 8800;
const String mdnsService = '_cockpitcast._tcp';

/// One frame as received from the host.
class Frame {
  Frame(this.display, this.seq, this.hostTimeMs, this.width, this.height, this.jpeg);
  final String display;
  final int seq;
  final double hostTimeMs;
  final int width;
  final int height;
  final Uint8List jpeg;
}

/// A display the host offers.
class DisplayInfo {
  DisplayInfo({required this.id, required this.name, required this.width, required this.height, required this.live, required this.fps});

  factory DisplayInfo.fromJson(Map<String, dynamic> j) => DisplayInfo(
        id: j['id'] as String,
        name: (j['name'] as String?) ?? (j['id'] as String).toUpperCase(),
        width: (j['width'] as num?)?.toInt() ?? 0,
        height: (j['height'] as num?)?.toInt() ?? 0,
        live: j['live'] == true,
        fps: (j['fps'] as num?)?.toDouble() ?? 0,
      );

  final String id;
  final String name;
  final int width;
  final int height;
  final bool live;
  final double fps;
}

/// Sim and capture state as reported by the host.
class HostStatus {
  const HostStatus(
      {this.simConnected = false,
      this.inFlight = false,
      this.paused = false,
      this.aircraft,
      this.captureConnected = false,
      this.injector,
      this.hookConnected = false,
      this.vfe,
      this.vno,
      this.profile});

  factory HostStatus.fromJson(Map<String, dynamic> j) {
    final sim = (j['sim'] as Map?)?.cast<String, dynamic>() ?? const {};
    final cap = (j['capture'] as Map?)?.cast<String, dynamic>() ?? const {};
    final hook = (j['hook'] as Map?)?.cast<String, dynamic>() ?? const {};
    return HostStatus(
      simConnected: sim['connected'] == true,
      inFlight: sim['inFlight'] == true,
      paused: sim['paused'] == true,
      aircraft: sim['aircraft'] as String?,
      captureConnected: cap['connected'] == true,
      injector: cap['injector'] as String?,
      hookConnected: hook['connected'] == true,
      vfe: ((sim['speeds'] as Map?)?['vfe'] as num?)?.toDouble(),
      vno: ((sim['speeds'] as Map?)?['vno'] as num?)?.toDouble(),
      profile: (sim['speeds'] as Map?)?['profile'] as String?,
    );
  }

  final bool simConnected;
  final bool inFlight;
  final bool paused;
  final String? aircraft;
  final bool captureConnected;

  /// Host's injector state, e.g. stabilizing, connected, failed (see host/src/injector.mjs).
  final String? injector;

  /// The Community hook in the cockpit pages is talking to the host (cockpit loaded, hook installed).
  final bool hookConnected;

  /// Speeds the sim does not provide, from the host's aircraft profile (null: estimate them).
  final double? vfe;
  final double? vno;
  final String? profile;
}

/// Parses a binary "CLF1" frame message. Returns null if it is not one.
Frame? parseFrame(Uint8List b) {
  if (b.length < 21 || b[0] != 0x43 || b[1] != 0x4C || b[2] != 0x46 || b[3] != 0x31) return null;
  final v = ByteData.sublistView(b);
  final seq = v.getUint32(4, Endian.little);
  final hostTimeMs = v.getFloat64(8, Endian.little);
  final width = v.getUint16(16, Endian.little);
  final height = v.getUint16(18, Endian.little);
  final idLen = b[20];
  if (b.length < 21 + idLen) return null;
  final id = ascii.decode(b.sublist(21, 21 + idLen));
  return Frame(id, seq, hostTimeMs, width, height, Uint8List.sublistView(b, 21 + idLen));
}

String helloMessage(String clientName) => jsonEncode({'type': 'hello', 'client': clientName, 'protocol': protocolVersion});

String subscribeMessage(String display, int maxFps) => jsonEncode({'type': 'subscribe', 'display': display, 'maxFps': maxFps});

String unsubscribeMessage(String display) => jsonEncode({'type': 'unsubscribe', 'display': display});

// ---- gauge layouts and screens ----

String subscribeDataMessage(int maxHz) => jsonEncode({'type': 'subscribeData', 'maxHz': maxHz});
String unsubscribeDataMessage() => jsonEncode({'type': 'unsubscribeData'});
String saveLayoutMessage(GaugeLayout l) => jsonEncode({'type': 'saveLayout', 'layout': l.toJson()});
String deleteLayoutMessage(String id) => jsonEncode({'type': 'deleteLayout', 'id': id});

class LayoutGauge {
  LayoutGauge({required this.id, required this.type, required this.x, required this.y, required this.w, required this.h, Map<String, dynamic>? options})
      : options = options ?? {};

  factory LayoutGauge.fromJson(Map<String, dynamic> j) => LayoutGauge(
        id: j['id'] as String? ?? '',
        type: j['type'] as String? ?? '',
        x: (j['x'] as num?)?.toDouble() ?? 0,
        y: (j['y'] as num?)?.toDouble() ?? 0,
        w: (j['w'] as num?)?.toDouble() ?? 100,
        h: (j['h'] as num?)?.toDouble() ?? 100,
        options: (j['options'] as Map?)?.cast<String, dynamic>(),
      );

  String id;
  String type;
  double x, y, w, h;
  Map<String, dynamic> options;

  Map<String, dynamic> toJson() => {'id': id, 'type': type, 'x': x, 'y': y, 'w': w, 'h': h, 'options': options};
}

class GaugeLayout {
  GaugeLayout({required this.id, required this.name, required this.width, required this.height, required this.gauges});

  factory GaugeLayout.fromJson(Map<String, dynamic> j) => GaugeLayout(
        id: j['id'] as String? ?? '',
        name: j['name'] as String? ?? '',
        width: (j['width'] as num?)?.toDouble() ?? 1200,
        height: (j['height'] as num?)?.toDouble() ?? 800,
        gauges: [for (final g in (j['gauges'] as List? ?? const [])) LayoutGauge.fromJson((g as Map).cast<String, dynamic>())],
      );

  String id;
  String name;
  double width, height;
  List<LayoutGauge> gauges;

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'width': width, 'height': height, 'gauges': [for (final g in gauges) g.toJson()]};
}

/// What the host wants a screen to show: a glass display, a gauge layout, or nothing yet.
class ScreenInfo {
  ScreenInfo({required this.id, required this.name, required this.mode, required this.kind, this.target});

  factory ScreenInfo.fromJson(Map<String, dynamic> j) {
    final show = (j['show'] as Map?)?.cast<String, dynamic>() ?? const {};
    return ScreenInfo(
      id: '${j['id']}',
      name: j['name'] as String? ?? '',
      mode: j['mode'] as String? ?? 'waiting',
      kind: show['kind'] as String? ?? 'waiting',
      target: show['id'] as String?,
    );
  }

  final String id;
  final String name;
  final String mode; // glass, steam, waiting
  final String kind; // display, layout, waiting
  final String? target;
}
