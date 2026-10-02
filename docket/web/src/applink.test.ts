import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appLink, isSessionLink } from './applink';

test('appLink: claude.ai pages open in the app at the same path', () => {
  assert.equal(appLink('https://claude.ai/chat/0199-abc'), 'claude://claude.ai/chat/0199-abc');
  assert.equal(appLink('https://claude.ai/project/0199-abc?q=hi%20there'), 'claude://claude.ai/project/0199-abc?q=hi%20there');
  assert.equal(appLink('https://claude.ai/new?q=Plan'), 'claude://claude.ai/new?q=Plan');
  assert.equal(appLink('https://claude.ai/settings/usage'), 'claude://claude.ai/settings/usage');
});

test('appLink: a session link opens a new Cowork or Claude Code composer with the prompt', () => {
  const s = 'https://claude.ai/code/session_01Lo4Fi2wxedZs5xtWgNx8Qr';
  assert.ok(isSessionLink(s));
  assert.equal(appLink(s, 'cowork', 'Do task a1'), 'claude://cowork/new?q=Do%20task%20a1');
  assert.equal(appLink(s, 'claude_code', 'Do task a1'), 'claude://code/new?q=Do%20task%20a1');
  assert.equal(appLink(s, null, 'x & y'), 'claude://code/new?q=x%20%26%20y', 'no kind: Claude Code');
  assert.equal(appLink(s, 'cowork'), 'claude://cowork/new', 'no prompt: just the app');
  assert.ok(!isSessionLink('https://claude.ai/chat/x'));
});

test('appLink: nothing for links outside claude.ai or not https', () => {
  for (const u of ['https://claude.com/x', 'https://mail.google.com/mail/u/0/#drafts', 'http://claude.ai/chat/x', 'javascript:alert(1)', 'claude.ai/chat/x', '']) assert.equal(appLink(u), null, u);
});
