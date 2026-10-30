// End-to-end checks of POST /v1/claude through the real Nest app: guards, body reading, validation,
// the rate-limit RPC, streaming, usage logging and error wording. Supabase and Anthropic are the
// only fakes, so everything this repo owns runs for real.
import { Anthropic } from '@anthropic-ai/sdk';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

const SUPABASE_URL = 'https://testref.supabase.co';
const USER_ID = '00000000-0000-0000-0000-000000000001';

// What the fake database saw and will answer, reset before each test.
const db = {
  rpcCalls: [] as Record<string, unknown>[],
  updates: [] as { values: Record<string, unknown>; id: unknown }[],
  claim: { request_id: 41, refusal: null } as {
    request_id: number | null;
    refusal: string | null;
  },
  searchRows: [] as { web_searches: number }[],
};

// The select chain the search budget uses (select().eq().eq().gt().gt()): a real Promise of the
// search rows, with the builder methods returning itself.
function selectChain() {
  type Chain = Promise<{ data: unknown; error: null }> &
    Record<'select' | 'eq' | 'gt', () => Chain>;
  const chain = Promise.resolve({ data: db.searchRows, error: null }) as Chain;
  chain.select = chain.eq = chain.gt = () => chain;
  return chain;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: async (token: string) =>
        token === 'good-token'
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: 'invalid JWT' } },
    },
    rpc: async (_name: string, args: Record<string, unknown>) => {
      db.rpcCalls.push(args);
      return { data: [db.claim], error: null };
    },
    from: () => ({
      select: () => selectChain(),
      update: (values: Record<string, unknown>) => ({
        eq: async (_column: string, id: unknown) => {
          db.updates.push({ values, id });
          return { error: null };
        },
      }),
    }),
  }),
}));

// The fake Claude: [script] decides what the next call does.
const claude = {
  script: 'text' as 'text' | 'rate-limit' | 'slow',
  structuredFields: { title: 'Flutter Developer' } as Record<string, unknown>,
};

function fakeStream(signal: AbortSignal) {
  const usage = { input_tokens: 12, output_tokens: 3 };
  return {
    async *[Symbol.asyncIterator]() {
      if (claude.script === 'rate-limit') {
        throw new Anthropic.RateLimitError(
          429,
          {},
          'rate limited',
          new Headers(),
        );
      }
      yield { type: 'message_start', message: { usage: { input_tokens: 12 } } };
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text' },
      };
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hel' },
      };
      if (claude.script === 'slow') {
        // Waits until the app leaves, the way a long reply would.
        await new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () =>
            reject(new Anthropic.APIUserAbortError()),
          ),
        );
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'lo' },
      };
      yield { type: 'message_delta', usage: { output_tokens: 3 } };
    },
    finalMessage: async () => ({
      usage,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hello' }],
    }),
  };
}

const fakeClient = {
  beta: {
    messages: {
      stream: (_params: unknown, options: { signal: AbortSignal }) =>
        fakeStream(options.signal),
      create: async () => {
        if (claude.script === 'rate-limit') {
          throw new Anthropic.RateLimitError(
            429,
            {},
            'rate limited',
            new Headers(),
          );
        }
        return {
          usage: { input_tokens: 20, output_tokens: 8 },
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: JSON.stringify(claude.structuredFields) },
          ],
        };
      },
      countTokens: async () => ({ input_tokens: 100 }),
    },
  },
};

vi.mock('../src/claude/anthropic.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/claude/anthropic.js')>()),
  clientFor: () => fakeClient,
}));

// The app's HTTP server on a real port, for tests that need a raw socket.
async function listening(app: INestApplication): Promise<AddressInfo> {
  const server = app.getHttpServer() as http.Server;
  if (!server.listening)
    await new Promise<void>((resolve) => server.listen(0, resolve));
  return server.address() as AddressInfo;
}

const chatBody = {
  mode: 'chat',
  model: 'claude-opus-5-5',
  messages: [{ role: 'user', content: 'Hi' }],
};

describe('POST /v1/claude', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-project-key';
    process.env.MAX_BODY_BYTES = '4400000';
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    db.rpcCalls = [];
    db.updates = [];
    db.claim = { request_id: 41, refusal: null };
    db.searchRows = [];
    claude.script = 'text';
  });

  const post = () => request(app.getHttpServer()).post('/v1/claude');
  const signedIn = () => post().set('Authorization', 'Bearer good-token');

  it('serves the health check', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { ok: true });
  });

  it('refuses a request with no sign-in', async () => {
    const res = await post().send(chatBody).expect(401);
    expect(res.body).toEqual({ error: 'Sign in first.' });
  });

  it('refuses an expired or forged token', async () => {
    const res = await post()
      .set('Authorization', 'Bearer bad-token')
      .send(chatBody)
      .expect(401);
    expect(res.body).toEqual({ error: 'Your session ended. Sign in again.' });
  });

  it('refuses a body larger than the limit before reading it, even with no sign-in', async () => {
    // Declares a body over the limit and sends only a few bytes: the 413 must come back without
    // the server waiting for (or reading) the rest.
    const { port } = await listening(app);
    const reply = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            port,
            method: 'POST',
            path: '/v1/claude',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': 4_400_001,
            },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
              req.destroy();
              resolve({ status: res.statusCode ?? 0, body });
            });
          },
        );
        req.on('error', reject);
        req.write('{"mode":');
      },
    );
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body)).toEqual({
      error: 'That request is too large.',
    });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('refuses a body that is not JSON', async () => {
    const res = await signedIn()
      .set('Content-Type', 'application/json')
      .send('{not json')
      .expect(400);
    expect(res.body).toEqual({ error: 'Body must be JSON.' });
  });

  it('refuses an invalid request before claiming a slot', async () => {
    const res = await signedIn()
      .send({ ...chatBody, mode: 'admin' })
      .expect(400);
    expect(res.body).toEqual({ error: 'Unknown mode.' });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('refuses an own key that is not shaped like a Claude key', async () => {
    const res = await signedIn()
      .send({ ...chatBody, api_key: 'sk-proj-abc' })
      .expect(400);
    expect(res.body.error).toMatch(/does not look like a Claude key/);
  });

  it('turns a rate-limit refusal into the words the app shows', async () => {
    db.claim = { request_id: null, refusal: 'user_minute' };
    const res = await signedIn().send(chatBody).expect(429);
    expect(res.body).toEqual({
      error: 'Slow down a little. Try again in a minute.',
    });
  });

  it('stops at the daily web search budget', async () => {
    db.searchRows = [{ web_searches: 20 }, { web_searches: 10 }];
    const res = await signedIn()
      .send({ ...chatBody, options: { web_search: true } })
      .expect(429);
    expect(res.body.error).toMatch(/web search limit/);
    // Refused before a slot is claimed, so it does not use up a request.
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('hashes the network from the trusted header only, matching the edge function', async () => {
    await signedIn()
      .set('x-vercel-forwarded-for', '203.0.113.7')
      .set('x-forwarded-for', '198.51.100.1')
      .send(chatBody)
      .expect(200);
    const expected = createHash('sha256')
      .update(`${SUPABASE_URL}|203.0.113.7`)
      .digest()
      .subarray(0, 16)
      .toString('hex');
    expect(db.rpcCalls[0]).toMatchObject({
      p_user: USER_ID,
      p_ip_hash: expected,
      p_own_key: false,
    });
  });

  it('streams a chat reply as server-sent events and logs what it spent', async () => {
    const res = await signedIn()
      .send(chatBody)
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);
    const events = res.text
      .split('\n\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line.replace(/^data: /, '')));
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => e.text)
        .join(''),
    ).toBe('Hello');
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      stop_reason: 'end_turn',
    });
    expect(db.updates).toEqual([
      {
        id: 41,
        values: { input_tokens: 12, output_tokens: 3, web_searches: 0 },
      },
    ]);
  });

  it('returns structured fields as one JSON answer', async () => {
    const res = await signedIn()
      .send({
        mode: 'extract',
        model: 'claude-opus-5-5',
        messages: [{ role: 'user', content: 'A job post' }],
      })
      .expect(200);
    expect(res.body).toEqual({
      fields: { title: 'Flutter Developer' },
      stop_reason: 'end_turn',
    });
    expect(db.updates[0].values).toMatchObject({
      input_tokens: 20,
      output_tokens: 8,
    });
  });

  it('sends Claude errors to the app as an error event with safe words', async () => {
    claude.script = 'rate-limit';
    const res = await signedIn().send(chatBody).expect(200);
    expect(res.text).toContain('"type":"error"');
    expect(res.text).toContain(
      'Claude is busy right now. Try again in a moment.',
    );
    expect(db.updates).toHaveLength(1);
  });

  it('answers other methods with 405, like the edge function', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/claude')
      .expect(405);
    expect(res.body).toEqual({ error: 'Use POST.' });
  });

  it('answers unknown routes with a plain 404', async () => {
    const res = await request(app.getHttpServer()).get('/nope').expect(404);
    expect(res.body).toEqual({ error: 'Not found.' });
  });

  it('maps a Claude error on a JSON mode to safe words and still logs usage first', async () => {
    claude.script = 'rate-limit';
    const res = await signedIn()
      .send({
        mode: 'extract',
        model: 'claude-opus-5-5',
        messages: [{ role: 'user', content: 'A job post' }],
      })
      .expect(503);
    expect(res.body).toEqual({
      error: 'Claude is busy right now. Try again in a moment.',
    });
    expect(db.updates).toHaveLength(1);
  });

  it('still logs usage when the app disconnects mid-reply', async () => {
    claude.script = 'slow';
    const { port } = await listening(app);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          port,
          method: 'POST',
          path: '/v1/claude',
          headers: {
            Authorization: 'Bearer good-token',
            'Content-Type': 'application/json',
          },
        },
        (res) => res.once('data', () => req.destroy()),
      );
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.on('timeout', reject);
      req.end(JSON.stringify(chatBody));
    });
    await vi.waitFor(() => expect(db.updates).toHaveLength(1));
    // The stream counted what it had sent before the app left, so the abort was not free.
    expect(db.updates[0].values.input_tokens).toBe(12);
    expect(db.updates[0].values.output_tokens as number).toBeGreaterThan(0);
  });
});
