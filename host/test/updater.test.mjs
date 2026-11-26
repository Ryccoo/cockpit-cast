// Versions and picking the release to offer (host/src/updater.mjs). The display app has the same rules
// (client/test/version_test.dart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newer, pickRelease } from '../src/updater.mjs';

test('newer: plain versions, number by number', () => {
  assert.equal(newer('0.2.5', '0.2.4'), true);
  assert.equal(newer('0.2.4', '0.2.5'), false);
  assert.equal(newer('0.10.0', '0.9.9'), true);
  assert.equal(newer('1.0.0', '1.0.0'), false);
});

test('newer: a beta is older than its release, betas compare part by part', () => {
  assert.equal(newer('0.2.5', '0.2.5-beta.3'), true);
  assert.equal(newer('0.2.5-beta.3', '0.2.5'), false);
  assert.equal(newer('0.2.5-beta.10', '0.2.5-beta.2'), true);
  assert.equal(newer('0.2.5-beta.1', '0.2.4'), true);
  assert.equal(newer('0.2.5-beta.2', '0.2.5-beta.2'), false);
});

const rel = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: tag.includes('-'), ...extra });

test('pickRelease: stable only unless beta is on', () => {
  const list = [rel('v0.2.5-beta.3'), rel('v0.2.4'), rel('v0.2.3')];
  assert.equal(pickRelease(list, false).tag_name, 'v0.2.4');
  assert.equal(pickRelease(list, true).tag_name, 'v0.2.5-beta.3');
});

test('pickRelease: the release wins over its betas; drafts and odd tags are skipped', () => {
  assert.equal(pickRelease([rel('v0.2.5-beta.3'), rel('v0.2.5')], true).tag_name, 'v0.2.5');
  assert.equal(pickRelease([rel('v0.3.0', { draft: true }), rel('nightly'), rel('v0.2.4')], true).tag_name, 'v0.2.4');
  assert.equal(pickRelease([], true), null);
});
