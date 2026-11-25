// Finds Cockpit Link hosts on the LAN via mDNS / DNS-SD (_cockpit-link._tcp).

import 'dart:io';

import 'package:multicast_dns/multicast_dns.dart';

import 'protocol.dart';

class FoundHost {
  FoundHost(this.name, this.address, this.port);
  final String name;
  final String address;
  final int port;

  @override
  bool operator ==(Object other) => other is FoundHost && other.address == address && other.port == port;

  @override
  int get hashCode => Object.hash(address, port);
}

/// One browse pass. Returns the hosts that answered within [timeout].
/// Throws if mDNS can't be used on this device (the UI then offers manual entry only).
Future<List<FoundHost>> discoverHosts({Duration timeout = const Duration(seconds: 3)}) async {
  final client = MDnsClient(rawDatagramSocketFactory: (dynamic host, int port, {bool reuseAddress = true, bool reusePort = false, int ttl = 1}) {
    // reusePort is not supported on Windows (the default factory would throw there), but Linux and macOS
    // need it to share port 5353 with the system's own mDNS service (avahi, mDNSResponder).
    return RawDatagramSocket.bind(host, port, reuseAddress: true, reusePort: !Platform.isWindows, ttl: ttl);
  });
  // Only adapters with a real address: disconnected ones (169.254.x.x, e.g. unplugged Wi-Fi or
  // Bluetooth on Windows) make joining the multicast group fail with "network location cannot be reached".
  await client.start(
    interfacesFactory: (type) async => (await NetworkInterface.list(type: InternetAddressType.IPv4)).where((i) => i.addresses.any((a) => !a.isLinkLocal && !a.isLoopback)),
  );
  final found = <FoundHost>{};
  try {
    final ptrs = client.lookup<PtrResourceRecord>(ResourceRecordQuery.serverPointer('$mdnsService.local'), timeout: timeout);
    await for (final ptr in ptrs) {
      final instance = ptr.domainName;
      final name = instance.split('.$mdnsService').first;
      await for (final srv in client.lookup<SrvResourceRecord>(ResourceRecordQuery.service(instance), timeout: const Duration(seconds: 1))) {
        await for (final a in client.lookup<IPAddressResourceRecord>(ResourceRecordQuery.addressIPv4(srv.target), timeout: const Duration(seconds: 1))) {
          found.add(FoundHost(name, a.address.address, srv.port));
        }
      }
    }
  } finally {
    client.stop();
  }
  return found.toList()..sort((a, b) => a.name.compareTo(b.name));
}
