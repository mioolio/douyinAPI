import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, setLogVerbose, redactLogText } from '../dist/utils/logger.js';
import { createBrowserDiagnostics } from '../dist/utils/browser-diagnostics.js';

function capture(action) {
  const write = process.stderr.write;
  let output = '';
  process.stderr.write = (chunk) => { output += chunk; return true; };
  const level = process.env.SPRR_LOG_LEVEL;
  const scope = process.env.SPRR_LOG_SCOPE;
  delete process.env.SPRR_LOG_LEVEL;
  delete process.env.SPRR_LOG_SCOPE;
  setLogVerbose(false);
  try { action(); return output; }
  finally {
    process.stderr.write = write;
    if (level === undefined) delete process.env.SPRR_LOG_LEVEL;
    else process.env.SPRR_LOG_LEVEL = level;
    if (scope === undefined) delete process.env.SPRR_LOG_SCOPE;
    else process.env.SPRR_LOG_SCOPE = scope;
    setLogVerbose(false);
  }
}

test('normal output starts at INFO; verbose changes already created loggers', () => {
  const output = capture(() => {
    const log = createLogger('test');
    log.debug('hidden-debug'); log.info('visible-info');
    setLogVerbose(true); log.debug('visible-debug');
    setLogVerbose(false); log.debug('hidden-again');
  });
  assert.match(output, /visible-info/);
  assert.match(output, /visible-debug/);
  assert.doesNotMatch(output, /hidden-debug|hidden-again/);
});

test('explicit log levels remain effective when verbose is enabled', () => {
  const output = capture(() => {
    process.env.SPRR_LOG_LEVEL = 'error';
    setLogVerbose(true);
    const log = createLogger('test');
    log.debug('hidden'); log.warn('also-hidden'); log.error('send-failed');
  });
  assert.match(output, /send-failed/);
  assert.doesNotMatch(output, /hidden/);
});

test('background browser diagnostics are quiet normally and deduplicated in verbose mode', () => {
  const output = capture(() => {
    const diagnostics = createBrowserDiagnostics(createLogger('browser-send'));
    diagnostics('error', 'background CSP');
    setLogVerbose(true);
    diagnostics('pageerror', 'request access_key=secret-a&token=secret-b failed');
    diagnostics('pageerror', 'request access_key=other-a&token=other-b failed');
    createLogger('cmd-message').error('本次发送失败');
  });
  assert.doesNotMatch(output, /background CSP|secret-a|secret-b|other-a|other-b/);
  assert.equal((output.match(/\[browser:pageerror\]/g) ?? []).length, 1);
  assert.match(output, /本次发送失败/);
});

test('credentials in URLs and JSON-like diagnostic text are redacted', () => {
  const text = redactLogText('https://example.test/?msToken=sensitive&a_bogus=signed&access_key=key token="abc" {"identity_security_token":"def"}');
  assert.doesNotMatch(text, /sensitive|signed|=key|abc|def/);
  assert.equal((text.match(/\[redacted\]/g) ?? []).length, 5);
});
