// The user's own key: which header values are accepted, and the words a rejected key turns into.
import { Anthropic } from '@anthropic-ai/sdk';
import { publicError } from './anthropic.js';
import { OWN_KEY_PATTERN } from './config.js';

const expectEqual = (actual: unknown, expected: unknown) =>
  expect(actual).toEqual(expected);
const expectTrue = (value: boolean) => expect(value).toBe(true);
const expectFalse = (value: boolean, label: string) =>
  expect(value, label).toBe(false);

const headers = new Headers();

it('own key: accepts the shape of an Anthropic key', () => {
  expectTrue(OWN_KEY_PATTERN.test('sk-ant-api03-' + 'a'.repeat(40)));
});

it('own key: refuses anything else', () => {
  for (const value of [
    '',
    'sk-ant-short',
    'sk-proj-' + 'a'.repeat(40),
    'sk-ant-' + 'a'.repeat(40) + '\nx',
    'sk-ant-' + 'a'.repeat(300),
  ]) {
    expectFalse(OWN_KEY_PATTERN.test(value), value);
  }
});

it('own key: a rejected key is a 403 the user can fix, never a 401', () => {
  const error = new Anthropic.AuthenticationError(
    401,
    {},
    'invalid x-api-key',
    headers,
  );
  expectEqual(publicError(error, true), {
    message: 'Claude did not accept your API key. Check it under Account.',
    status: 403,
  });
});

it('own key: an empty balance says so', () => {
  // The body as the API sends it; the SDK puts it into the error's message.
  const body = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'Your credit balance is too low to access the Anthropic API.',
    },
  };
  const error = new Anthropic.BadRequestError(400, body, undefined, headers);
  expectEqual(publicError(error, true).status, 402);
});

it('project key: a rejected key stays a server problem', () => {
  const error = new Anthropic.AuthenticationError(
    401,
    {},
    'invalid x-api-key',
    headers,
  );
  expectEqual(publicError(error).status, 503);
});
