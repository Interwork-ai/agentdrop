import { describeError, ERROR_CODES, type ErrorCode } from '@agentdrop/contracts';
import { expect, it } from 'vitest';
import { ApiFailure } from './api.js';
import { humanError, humanInviteError, LocalError } from './error-text.js';

const CJK = /[一-鿿]/;

it('gives people a sentence for every server error in both languages, English by default, never the model hint', () => {
  for (const code of Object.keys(ERROR_CODES) as ErrorCode[]) {
    const body = describeError(code, 'english detail for programs');
    const failure = new ApiFailure(400, body);
    const en = humanError(failure);
    const zh = humanError(failure, 'zh');
    expect(en.text, code).not.toMatch(CJK);
    expect(zh.text, code).toMatch(CJK);
    for (const { text } of [en, zh]) {
      expect(text, code).not.toContain(body.next_action);
      expect(text, code).not.toMatch(/request_id|directory_lookup|list_drops|agentdrop /);
    }
    // The server text survives only as the debugging detail.
    expect(en.detail, code).toBe(`${code}: english detail for programs`);
  }
});

it('handles specific cases, library codes, the local fallback and errors the dashboard raises itself', () => {
  const taken = describeError('VALIDATION_FAILED', 'handle already taken', { field: 'handle' });
  expect(humanError(new ApiFailure(400, taken)).text).toContain('username');
  expect(humanError(new ApiFailure(400, taken), 'zh').text).toContain('用户名');
  const email = describeError('VALIDATION_FAILED', 'invalid email address', { field: 'public_email' });
  expect(humanError(new ApiFailure(400, email)).text).toBe('This email address is not valid.');
  expect(humanError(new ApiFailure(400, email), 'zh').text).toBe('邮箱格式不正确。');
  const registered = describeError('VALIDATION_FAILED', 'email already registered', {
    field: 'email',
    reason: 'already_registered',
  });
  expect(humanError(new ApiFailure(400, registered)).text).toBe(
    'This email is already registered. Sign in instead.',
  );
  expect(humanError(new ApiFailure(400, registered), 'zh').text).toBe('这个邮箱已经注册过了，请直接登录。');
  const library = {
    code: 'USER_ALREADY_EXISTS',
    message: 'User already exists',
    next_action: '',
    retryable: false,
  };
  expect(humanError(new ApiFailure(422, library as never), 'zh').text).toContain('已经注册过');
  const unknown = { code: 'SOMETHING_NEW', message: 'x', next_action: 'y', retryable: false };
  expect(humanError(new ApiFailure(500, unknown as never)).text).toBe(
    'That did not work. Please try again later.',
  );
  const local = describeError('INTERNAL', 'The server sent an unexpected response (HTTP 502).');
  expect(humanError(new ApiFailure(502, local, true)).text).toBe(
    'The server sent an unexpected response (HTTP 502).',
  );
  const own = new LocalError({ en: 'Wrong email or password.', zh: '邮箱或密码不正确' });
  expect(humanError(own).text).toBe('Wrong email or password.');
  expect(humanError(own, 'zh').text).toBe('邮箱或密码不正确');
  expect(humanError(new TypeError('Failed to fetch')).text).toContain('connection');
  expect(humanError(new Error('boom'), 'zh').text).toBe('操作没有完成，请稍后再试。');
});

it('says how full a group is when its file space refuses a send', () => {
  const MiB = 1024 * 1024;
  const full = describeError('GROUP_STORAGE_FULL', 'group storage full', {
    group_id: 'g-1',
    used: 480 * MiB,
    limit: 512 * MiB,
    bytes: 40 * MiB,
  });
  expect(humanError(new ApiFailure(409, full)).text).toBe(
    "This group's file space is full (480 MB of 512 MB). A group admin can remove old files on the group page, or send it without files.",
  );
  expect(humanError(new ApiFailure(409, full), 'zh').text).toContain('已用 480 MB，上限 512 MB');
  // without the numbers (an older or a different server) the plain sentence still says what to do
  const bare = describeError('GROUP_STORAGE_FULL', 'group storage full');
  expect(humanError(new ApiFailure(409, bare)).text).toContain('A group admin can remove old files');
  expect(humanError(new ApiFailure(413, describeError('QUOTA_EXCEEDED', 'quota'))).text).toContain(
    'My space',
  );
});

it('names the username that is the problem when inviting people', () => {
  const unknown = describeError('NOT_FOUND', 'no user with that handle', { handles: ['wang', 'li'] });
  expect(humanError(new ApiFailure(404, unknown)).text).toBe(
    'Nobody on this server has the username @wang, @li. Check the spelling; nobody was invited.',
  );
  expect(humanError(new ApiFailure(404, unknown), 'zh').text).toContain('@wang、@li');
  const self = describeError('VALIDATION_FAILED', 'you are already in this group', { field: 'handles' });
  expect(humanError(new ApiFailure(400, self)).text).toContain('already in this group');
  const bot = describeError('VALIDATION_FAILED', 'assistant', { field: 'handles', handle: 'agentdrop' });
  expect(humanError(new ApiFailure(400, bot)).text).toContain('@agentdrop cannot join groups');
  const many = describeError('VALIDATION_FAILED', 'too many', { field: 'handles', limit: 20 });
  expect(humanError(new ApiFailure(400, many), 'zh').text).toContain('20');

  // one person by @handle on Contacts: the server says "not found", the page names who
  const missing = new ApiFailure(404, describeError('NOT_FOUND', 'no user with that handle'));
  expect(humanInviteError(missing, '@nobody').text).toContain('@nobody');
  expect(humanInviteError(missing, 'nobody', 'zh').text).toContain('@nobody');
  const blocked = new ApiFailure(403, describeError('BLOCKED', 'invitation not possible'));
  expect(humanInviteError(blocked, 'wang').text).toContain('cannot invite @wang');
  const yourself = new ApiFailure(400, describeError('VALIDATION_FAILED', 'you cannot invite yourself'));
  expect(humanInviteError(yourself, 'me').text).toBe('That is your own username. Enter someone else’s.');
  // anything else falls back to the general sentence
  const limited = new ApiFailure(429, describeError('RATE_LIMITED', 'slow down'));
  expect(humanInviteError(limited, 'wang').text).toBe(humanError(limited).text);
});
