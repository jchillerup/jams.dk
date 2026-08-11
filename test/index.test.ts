import test from 'node:test';
import assert from 'node:assert/strict';

import { checkBasicAuth, escapeHtml, normalizeYouTubeIdentifier } from '../src/index.js';

const fakeDb = {
  prepare(_query: string) {
    throw new Error('not used');
  },
  batch() {
    throw new Error('not used');
  },
};

test('escapeHtml escapes the obvious stuff', () => {
  assert.equal(escapeHtml(`<tag attr="x">O'Hara & co</tag>`), '&lt;tag attr=&quot;x&quot;&gt;O&#39;Hara &amp; co&lt;/tag&gt;');
});

test('normalizeYouTubeIdentifier accepts a raw video id', () => {
  assert.equal(normalizeYouTubeIdentifier('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('normalizeYouTubeIdentifier extracts ids from youtube urls', () => {
  assert.equal(normalizeYouTubeIdentifier('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(normalizeYouTubeIdentifier('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('checkBasicAuth accepts matching credentials', () => {
  const request = new Request('https://example.com/kustode', {
    headers: {
      authorization: `Basic ${btoa('admin:secret')}`,
    },
  });

  assert.equal(
    checkBasicAuth(request, {
      BASIC_AUTH_USER: 'admin',
      BASIC_AUTH_PASSWORD: 'secret',
      DB: fakeDb as unknown as D1Database,
    }),
    true,
  );
});

test('checkBasicAuth rejects wrong credentials', () => {
  const request = new Request('https://example.com/kustode', {
    headers: {
      authorization: `Basic ${btoa('admin:nope')}`,
    },
  });

  assert.equal(
    checkBasicAuth(request, {
      BASIC_AUTH_USER: 'admin',
      BASIC_AUTH_PASSWORD: 'secret',
      DB: fakeDb as unknown as D1Database,
    }),
    false,
  );
});
