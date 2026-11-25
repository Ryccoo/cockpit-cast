// Updates for the client app, from the project's GitHub releases.
//
//   Windows, installed with the Setup program: downloads CockpitCast-Client-Setup.exe, checks it against
//   the release's SHA256SUMS.txt, runs it silently and quits; the installer starts the app again with
//   the same command line (installer/client.iss, /UPDATE=1 /ARGS=...).
//   Elsewhere (Linux, macOS, the zip): the Settings page shows that a new version exists, with a link.
//
// When: at start (installs straight away if "Update automatically" is on), every 6 hours (only noted),
// when the user taps "Update now", and when the host installs its own update (the host's "update"
// message: one click on the sim PC updates the display PCs too).

import 'dart:async';
import 'dart:convert';
import 'dart:io' hide BytesBuilder;
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:material_ui/material_ui.dart';

import 'about.dart';
import 'desktop.dart';

const _releaseApi = 'https://api.github.com/repos/Ryccoo/cockpit-cast/releases/latest';
const _asset = 'CockpitCast-Client-Setup.exe';
const _sums = 'SHA256SUMS.txt';

class Updater extends ChangeNotifier {
  Updater._();
  static final Updater instance = Updater._();

  /// Latest release: version, page, and download URL per file name.
  String? latest;
  String? releaseUrl;
  Map<String, String> _assets = const {};
  String? error;
  bool busy = false;
  DateTime? checkedAt;

  /// The command line this copy was started with (given back to it after an update).
  List<String> _args = const [];
  bool _enabled = false;
  Timer? _timer;

  bool get available => latest != null && newerVersion(latest!, appVersion);

  /// Installed with the Setup program on Windows (its uninstaller is next to the app).
  bool get canInstall {
    if (!Platform.isWindows) return false;
    final dir = File(Platform.resolvedExecutable).parent.path;
    return File('$dir\\unins000.exe').existsSync();
  }

  /// Window 1 only (extra windows are copies of the app that it starts and stops).
  void start({required List<String> args, required bool autoInstall}) {
    if (_enabled) return;
    _enabled = true;
    _args = args;
    Timer(const Duration(seconds: 10), () async {
      await check();
      if (autoInstall && available && canInstall) await install();
    });
    _timer = Timer.periodic(const Duration(hours: 6), (_) => check());
  }

  Future<void> check() async {
    try {
      final j = await _getJson(Platform.environment['COCKPITCAST_UPDATE_URL'] ?? _releaseApi); // override: testing
      final v = '${j['tag_name'] ?? ''}'.replaceFirst(RegExp('^v'), '');
      if (!RegExp(r'^\d+\.\d+\.\d+$').hasMatch(v)) throw 'unexpected release tag ${j['tag_name']}';
      latest = v;
      releaseUrl = j['html_url'] as String?;
      _assets = {for (final a in (j['assets'] as List? ?? const [])) '${a['name']}': '${a['browser_download_url']}'};
      error = null;
    } on _NoRelease {
      latest = null;
    } catch (e) {
      error = 'Update check failed: $e';
    }
    checkedAt = DateTime.now();
    notifyListeners();
  }

  /// The host is installing its update: install ours too (if this copy can).
  Future<void> updateFromHost() async {
    if (!_enabled || !canInstall || busy) return;
    await check();
    if (available) await install();
  }

  /// Download, check, run the installer silently, and quit (the installer starts the app again).
  Future<void> install() async {
    if (!canInstall || busy) return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      if (!available) await check();
      if (!available) throw 'no newer version';
      final setupUrl = _assets[_asset], sumsUrl = _assets[_sums];
      if (setupUrl == null || sumsUrl == null) throw 'the release has no $_asset or $_sums';
      final sums = utf8.decode(await _getBytes(sumsUrl));
      String? want;
      for (final line in const LineSplitter().convert(sums)) {
        final parts = line.trim().split(RegExp(r'\s+\*?'));
        if (parts.length == 2 && parts[1] == _asset) want = parts[0].toLowerCase();
      }
      if (want == null) throw '$_sums has no checksum for $_asset';
      final data = await _getBytes(setupUrl);
      if (sha256.convert(data).toString() != want) throw 'the download does not match its checksum';
      final dir = await Directory.systemTemp.createTemp('cockpitcast-update');
      final file = File('${dir.path}\\CockpitCast-Client-$latest-Setup.exe');
      await file.writeAsBytes(data, flush: true);
      final log = '${Platform.environment['LOCALAPPDATA'] ?? dir.path}\\CockpitCast\\client-update.log';
      await Process.start(
        file.path,
        [
          '/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/UPDATE=1', '/LOG=$log',
          // The installer starts the app again with these (arguments with quotes or spaces are left out).
          '/ARGS=${_args.where((a) => !a.contains('"') && !a.contains(' ')).join(' ')}',
        ],
        mode: ProcessStartMode.detached,
      );
      await stopExtraWindows();
      exit(0);
    } catch (e) {
      error = 'Update failed: $e';
      busy = false;
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}

class _NoRelease implements Exception {}

Future<Map<String, dynamic>> _getJson(String url) async {
  final client = HttpClient()..userAgent = 'cockpitcast-client/$appVersion';
  try {
    final req = await client.getUrl(Uri.parse(url)).timeout(const Duration(seconds: 20));
    req.headers.set('accept', 'application/vnd.github+json');
    final res = await req.close().timeout(const Duration(seconds: 20));
    if (res.statusCode == 404) throw _NoRelease();
    if (res.statusCode != 200) throw 'GitHub answered ${res.statusCode}';
    return (jsonDecode(await res.transform(utf8.decoder).join()) as Map).cast<String, dynamic>();
  } finally {
    client.close();
  }
}

Future<List<int>> _getBytes(String url) async {
  final client = HttpClient()..userAgent = 'cockpitcast-client/$appVersion';
  try {
    final req = await client.getUrl(Uri.parse(url)); // follows GitHub's redirect to its file storage
    final res = await req.close().timeout(const Duration(minutes: 5));
    if (res.statusCode != 200) throw 'download failed (${res.statusCode})';
    final b = BytesBuilder(copy: false);
    await for (final chunk in res.timeout(const Duration(minutes: 5))) {
      b.add(chunk);
    }
    return b.takeBytes();
  } finally {
    client.close();
  }
}

/// a > b for "x.y.z" versions.
bool newerVersion(String a, String b) {
  final pa = a.split('.').map((x) => int.tryParse(x) ?? 0).toList(), pb = b.split('.').map((x) => int.tryParse(x) ?? 0).toList();
  for (var i = 0; i < 3; i++) {
    final x = i < pa.length ? pa[i] : 0, y = i < pb.length ? pb[i] : 0;
    if (x != y) return x > y;
  }
  return false;
}
