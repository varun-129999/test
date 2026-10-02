import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitKey, isTyping, keyAction, onKey } from './keys';

const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra });

test('keyAction: the shortcuts', () => {
  const body = el('BODY');
  const k = (key: string) => keyAction({ key, target: body });
  assert.equal(k('n'), 'add');
  assert.equal(k('/'), 'search');
  assert.equal(k('?'), 'help');
  assert.equal(k('c'), 'composer');
  assert.deepEqual(['t', 'w', 'i', 'u'].map(k), ['today', 'week', 'inbox', 'usage']);
  assert.equal(k('['), 'prev-week');
  assert.equal(k(']'), 'next-week');
  assert.equal(k('e'), 'done');
  assert.equal(k('x'), 'delete');
  assert.equal(k('Escape'), 'escape');
  assert.equal(k('N'), 'add');
  assert.equal(k('q'), null);
  assert.equal(k('Enter'), null);
  assert.equal(k('ArrowDown'), null);
});

test('keyAction: never with a modifier or mid-composition', () => {
  const body = el('BODY');
  assert.equal(keyAction({ key: 'r', metaKey: true, target: body }), null);
  assert.equal(keyAction({ key: 'n', metaKey: true, target: body }), null);
  assert.equal(keyAction({ key: 'w', ctrlKey: true, target: body }), null);
  assert.equal(keyAction({ key: 'e', altKey: true, target: body }), null);
  assert.equal(keyAction({ key: 'n', isComposing: true, target: body }), null);
});

test('keyAction: ignored while typing; Esc leaves the field', () => {
  for (const t of [el('INPUT'), el('INPUT', { type: 'text' }), el('INPUT', { type: 'search' }), el('INPUT', { type: 'date' }), el('input', { type: 'number' }), el('TEXTAREA'), el('SELECT'), el('DIV', { isContentEditable: true })]) {
    for (const key of ['n', '/', 't', 'e', 'x', '?', '[']) assert.equal(keyAction({ key, target: t }), null, `${key} in ${JSON.stringify(t)}`);
    assert.equal(keyAction({ key: 'Escape', target: t }), 'blur');
  }
  // A checkbox, a slider or a button is not typing.
  for (const t of [el('INPUT', { type: 'checkbox' }), el('INPUT', { type: 'range' }), el('BUTTON'), el('DIV', { isContentEditable: false }), null, undefined]) {
    assert.equal(keyAction({ key: 't', target: t }), 'today', JSON.stringify(t));
  }
  assert.equal(isTyping(el('INPUT', { type: '' })), true);
});

test('emitKey: newest listener first, stops at the first that handles it', () => {
  const got: string[] = [];
  const off1 = onKey(a => { got.push('1:' + a); return a === 'done'; });
  const off2 = onKey(a => { got.push('2:' + a); return a === 'escape'; });
  assert.equal(emitKey('escape'), true);
  assert.equal(emitKey('done'), true);
  assert.equal(emitKey('delete'), false);
  assert.deepEqual(got, ['2:escape', '2:done', '1:done', '2:delete', '1:delete']);
  off1(); off2();
  assert.equal(emitKey('done'), false);
});
