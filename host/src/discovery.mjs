// Announces the host on the LAN via mDNS / DNS-SD so client apps find it without an IP address.

import os from 'node:os';
import { Bonjour } from 'bonjour-service';
import { MDNS_TYPE, PROTOCOL_VERSION } from './protocol.mjs';
import { makeLog } from './log.mjs';

const log = makeLog('discovery');

export function advertise(port) {
  const bonjour = new Bonjour();
  const name = `Cockpit Link on ${os.hostname()}`;
  const service = bonjour.publish({
    name,
    type: MDNS_TYPE,
    port,
    txt: { protocol: String(PROTOCOL_VERSION), name: os.hostname() },
  });
  service.on('up', () => log.info(`advertised "${name}" as _${MDNS_TYPE}._tcp on port ${port}`));
  service.on('error', (err) => log.warn(`mDNS error: ${err.message}`));
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
