import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeProfileRef, profileLabel, profileURL } from '../src/profile.mjs';

test('normalizes Medium handles without changing publication URLs', () => {
  assert.equal(normalizeProfileRef('@writer'), 'writer');
  assert.equal(normalizeProfileRef('https://medium.com/@writer/'), 'writer');
  assert.equal(normalizeProfileRef('https://publication.example/'), 'https://publication.example');
});

test('builds the correct public profile destination', () => {
  assert.equal(profileURL('writer'), 'https://medium.com/@writer');
  assert.equal(profileURL('https://publication.example'), 'https://publication.example');
});

test('labels handles and publication URLs without a bogus @ prefix', () => {
  assert.equal(profileLabel('writer'), '@writer');
  assert.equal(profileLabel('https://publication.example/about/'), 'publication.example/about');
});
