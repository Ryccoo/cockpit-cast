// ignore_for_file: avoid_print
// Command-line check of host discovery: dart run tool/discover.dart
import 'package:cockpit_link/discovery.dart';

Future<void> main() async {
  final hosts = await discoverHosts();
  print(hosts.isEmpty ? 'No hosts found' : hosts.map((h) => '${h.name}  ${h.address}:${h.port}').join('\n'));
}
