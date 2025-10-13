#!/usr/bin/env node
'use strict';

if (
  process.env.ATLASPACK_REGISTER_USE_SRC === 'true' ||
  process.env.ATLASPACK_BUILD_ENV === 'test' ||
  process.env.ATLASPACK_SELF_BUILD
) {
  if (
    process.env.ATLASPACK_REGISTER_USE_SRC === 'true' &&
    process.env.BABEL_DISABLE_CACHE == null
  ) {
    process.env.BABEL_DISABLE_CACHE = '1';
  }

  require('@atlaspack/babel-register');
  require('../src/cli');
} else {
  require('../lib/cli');
}
