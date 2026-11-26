// Version order for updates (lib/updater.dart), including betas: the same cases as the host's updater.

import 'package:cockpitcast/updater.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('newerVersion orders releases and betas', () {
    const cases = [
      ('0.2.5', '0.2.4', true),
      ('0.2.10', '0.2.9', true),
      ('0.2.4', '0.2.4', false),
      ('0.2.5-beta.1', '0.2.4', true),
      ('0.2.5', '0.2.5-beta.1', true), // a release is newer than its betas
      ('0.2.5-beta.1', '0.2.5', false),
      ('0.2.5-beta.2', '0.2.5-beta.1', true),
      ('0.2.5-beta.10', '0.2.5-beta.2', true), // numbers as numbers
      ('0.2.5-beta.1', '0.2.5-beta.1', false),
      ('0.2.5-rc.1', '0.2.5-beta.3', true),
      ('0.3.0-beta.1', '0.2.9', true),
    ];
    for (final (a, b, want) in cases) {
      expect(newerVersion(a, b), want, reason: '$a > $b');
    }
  });
}
