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
  final (status, body) = await _fetch(url, accept: 'application/vnd.github+json', timeout: const Duration(seconds: 30));
  if (status == 404) throw _NoRelease();
  if (status != 200) throw 'GitHub answered $status';
  return (jsonDecode(utf8.decode(body)) as Map).cast<String, dynamic>();
}

Future<List<int>> _getBytes(String url) async {
  final (status, body) = await _fetch(url, timeout: const Duration(minutes: 5)); // follows GitHub's redirect to its file storage
  if (status != 200) throw 'download failed ($status)';
  return body;
}

/// GET [url]: (HTTP status, body). On Windows through the system's curl.exe: it checks certificates the
/// way Windows does, which fetches a missing root certificate by itself. Dart's own client only trusts
/// roots already on the PC, and a fresh Windows often lacks GitHub's (CERTIFICATE_VERIFY_FAILED).
Future<(int, List<int>)> _fetch(String url, {String? accept, required Duration timeout}) async {
  final curl = Platform.isWindows ? '${Platform.environment['SystemRoot'] ?? r'C:\Windows'}\\System32\\curl.exe' : null;
  if (curl != null && File(curl).existsSync()) {
    final dir = await Directory.systemTemp.createTemp('cockpitcast-get');
    try {
      final out = '${dir.path}\\body';
      final r = await Process.run(curl, [
        '-sSL', '--max-time', '${timeout.inSeconds}', '-A', 'cockpitcast-client/$appVersion',
        if (accept != null) ...['-H', 'Accept: $accept'],
        '-o', out, '-w', '%{http_code}', url,
      ]);
      if (r.exitCode != 0) throw 'download failed: ${'${r.stderr}'.trim()} (curl ${r.exitCode})';
      final status = int.tryParse('${r.stdout}'.trim()) ?? 0;
      return (status, File(out).existsSync() ? await File(out).readAsBytes() : <int>[]);
    } finally {
      dir.delete(recursive: true).catchError((_) => dir);
    }
  }
  final client = HttpClient()..userAgent = 'cockpitcast-client/$appVersion';
  try {
    final req = await client.getUrl(Uri.parse(url)).timeout(const Duration(seconds: 20));
    if (accept != null) req.headers.set('accept', accept);
    final res = await req.close().timeout(timeout);
    final b = BytesBuilder(copy: false);
    await for (final chunk in res.timeout(timeout)) {
      b.add(chunk);
    }
    return (res.statusCode, b.takeBytes());
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
