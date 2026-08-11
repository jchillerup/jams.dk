import test from 'node:test';
import assert from 'node:assert/strict';

import { checkBasicAuth, escapeHtml } from '../src/index.js';

const fakeDb = {
  prepare(_query: string) {
    throw new Error('not used');
  },
};

test('escapeHtml escapes the obvious stuff', () => {
  assert.equal(escapeHtml(`<tag attr="x">O'Hara & co</tag>`), '&lt;tag attr=&quot;x&quot;&gt;O&#39;Hara &amp; co&lt;/tag&gt;');
});

test('checkBasicAuth accepts matching credentials', () => {
  const request = new Request('https://example.com/', {
    headers: {
      authorization: `Basic ${btoa('admin:secret')}`,
    },
  });

  assert.equal(
    checkBasicAuth(request, {
      BASIC_AUTH_USER: 'admin',
      BASIC_AUTH_PASSWORD: 'secret',
      DB: fakeDb,
    }),
    true,
  );
});

test('checkBasicAuth rejects missing credentials', () => {
  const request = new Request('https://example.com/');

  assert.equal(
    checkBasicAuth(request, {
      BASIC_AUTH_USER: 'admin',
      BASIC_AUTH_PASSWORD: 'secret',
      DB: fakeDb,
    }),
    false,
  );
});
