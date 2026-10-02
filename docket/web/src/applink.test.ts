import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appLink } from './applink';

test('appLink: claude.ai pages open in the app at the same path', () => {
  assert.equal(appLink('https://claude.ai/chat/0199-abc'), 'claude://claude.ai/chat/0199-abc');
  assert.equal(appLink('https://claude.ai/project/0199-abc?q=hi%20there'), 'claude://claude.ai/project/0199-abc?q=hi%20there');
  assert.equal(appLink('https://claude.ai/new?q=Plan'), 'claude://claude.ai/new?q=Plan');
  assert.equal(appLink('https://claude.ai/settings/usage'), 'claude://claude.ai/settings/usage');
});

test('appLink: a Cowork or Claude Code session opens in the app by the same path', () => {
  assert.equal(appLink('https://claude.ai/code/session_01Lo4Fi2wxedZs5xtWgNx8Qr'), 'claude://claude.ai/code/session_01Lo4Fi2wxedZs5xtWgNx8Qr');
});

test('appLink: nothing for links outside claude.ai or not https', () => {
  for (const u of ['https://claude.com/x', 'https://mail.google.com/mail/u/0/#drafts', 'http://claude.ai/chat/x', 'javascript:alert(1)', 'claude.ai/chat/x', '']) assert.equal(appLink(u), null, u);
});
