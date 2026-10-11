import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripVTControlCharacters } from 'node:util';
import ts from 'typescript';

const cliState = { verbose: false, json: false };
const module = { exports: {} };
const source = fs.readFileSync(new URL('../src/cli/ui.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(compiled, {
  module, exports: module.exports,
  require: (name) => {
    if (name === './context.js') return { cliState };
    if (name === 'node:util') return { stripVTControlCharacters };
    throw new Error(`unexpected import: ${name}`);
  },
});
const { C, formatTable, visualWidth, formatMessageLine } = module.exports;
const message = { category: 'sticker', senderLabel: '对方', text: '比心', stickerUrl: 'https://offline.invalid/image?signature=long', serverMsgId: '123' };

test('display width handles ANSI, Chinese, fullwidth characters, combining marks and emoji graphemes', () => {
  for (const [input, width] of [
    ['abc', 3], ['中文', 4], ['ＡＢ', 4], [`${C.red}中文${C.reset}`, 4],
    ['e\u0301', 1], ['👨‍👩‍👧‍👦', 2], ['🇨🇳', 2], ['1️⃣', 2], ['🙂', 2],
    ['\x1b]8;;https://offline.invalid\x07link\x1b]8;;\x07', 4],
  ]) assert.equal(visualWidth(input), width, input);
});

test('table columns align for colored unread counts, CJK names and emoji', () => {
  const lines = formatTable(['昵称', '未读', 'UID'], [
    ['用户9527', `${C.brightRed}1${C.reset}`, '123'], ['A🙂', '0', '456'], ['e\u0301', '10', '789'],
  ]).split('\n');
  const columns = lines.filter((line) => line.includes(' │ ')).map((line) =>
    line.split(' │ ').slice(0, -1).map(visualWidth));
  for (const widths of columns) assert.deepEqual(widths, columns[0]);
  assert.equal(visualWidth(lines[1]), visualWidth(lines[0]));
});

test('empty tables and multiline cells retain finite aligned widths', () => {
  const empty = formatTable(['昵称', 'UID'], []).split('\n');
  assert.equal(visualWidth(empty[0]), visualWidth(empty[1]));
  assert.equal(formatTable(['名字'], [['甲\n乙']]).split('\n').length, 3);
});

test('default media output omits URLs while verbose output retains details', () => {
  cliState.verbose = false;
  const concise = formatMessageLine(message);
  assert.ok(concise.includes('比心'));
  assert.ok(!concise.includes('signature='));
  assert.ok(concise.includes('[id:123]'));
  cliState.verbose = true;
  assert.ok(formatMessageLine(message).includes('signature=long'));
  cliState.verbose = false;
});

test('unknown message diagnostics and system placeholders stay out of default chat output', () => {
  const unknown = { ...message, category: 'unknown', text: '[未识别消息 msgType=110] content={"debug":"detail"}' };
  const system = { ...message, category: 'system_tip', text: '点亮火花 {{0}} {{1}}' };
  cliState.verbose = false;
  assert.ok(!formatMessageLine(unknown).includes('content='));
  assert.ok(!formatMessageLine(system).includes('{{'));
  cliState.verbose = true;
  assert.ok(formatMessageLine(unknown).includes('content='));
  assert.ok(formatMessageLine(system).includes('{{0}}'));
  cliState.verbose = false;
});
