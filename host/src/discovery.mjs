// Announces the host on the LAN via mDNS / DNS-SD so client apps find it without an IP address.

import os from 'node:os';
import { Bonjour } from 'bonjour-service';
import { MDNS_TYPE, PROTOCOL_VERSION } from './protocol.mjs';

const LEGACY_MDNS_TYPE = 'cockpit-link';
import { makeLog } from './log.mjs';

const log = makeLog('discovery');

export function advertise(port) {
  const bonjour = new Bonjour();
  const name = `CockpitCast on ${os.hostname()}`;
  const service = bonjour.publish({
    name,
    type: MDNS_TYPE,
    port,
    txt: { protocol: String(PROTOCOL_VERSION), name: os.hostname() },
  });
  service.on('up', () => log.info(`advertised "${name}" as _${MDNS_TYPE}._tcp on port ${port}`));
  service.on('error', (err) => log.warn(`mDNS error: ${err.message}`));
  // Clients up to 0.1.1, from before the project was renamed, look for the old service name.
  // Announced too, so they keep finding the host until they are updated.
  const legacy = bonjour.publish({ name, type: LEGACY_MDNS_TYPE, port, txt: { protocol: String(PROTOCOL_VERSION), name: os.hostname() } });
  legacy.on('error', (err) => log.warn(`mDNS error (${LEGACY_MDNS_TYPE}): ${err.message}`));
  return {
    close: () =>
      new Promise((resolve) => {
        bonjour.unpublishAll(() => {
          bonjour.destroy();
          resolve();
        });
      }),
  };
}
