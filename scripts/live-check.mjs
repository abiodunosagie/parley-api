// Live check of a deployed parley-api: makes a throwaway parley-test-* user, calls every mode, prints
// what each returned and what the limits table logged, then deletes the user.
// Run: SUPABASE_URL=https://<ref>.supabase.co SECRET=<service role key> PUBLISHABLE=<publishable key> \
//      [API=<base url>] node scripts/live-check.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const API = process.env.API ?? 'https://parley-api.vercel.app';
const URL = process.env.SUPABASE_URL;
if (!URL || !process.env.SECRET || !process.env.PUBLISHABLE) {
  throw new Error(
    'Set SUPABASE_URL, SECRET and PUBLISHABLE (see the comment at the top).',
  );
}
const dir = new globalThis.URL('./fixtures/', import.meta.url).pathname;
const admin = createClient(URL, process.env.SECRET, {
  auth: { persistSession: false },
});
const anon = createClient(URL, process.env.PUBLISHABLE, {
  auth: { persistSession: false },
});

const email = `parley-test-${Date.now()}@example.com`;
const password = `T${crypto.randomUUID()}!`;
const { data: created, error: createError } = await admin.auth.admin.createUser(
  { email, password, email_confirm: true },
);
if (createError) throw createError;
const userId = created.user.id;

const results = [];
try {
  const { data: session, error: signInError } =
    await anon.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  const token = session.session.access_token;
  const jpeg = readFileSync(`${dir}live.jpg`).toString('base64');
  const pdf = readFileSync(`${dir}live.pdf`).toString('base64');

  const cases = [
    [
      'chat (haiku, stream)',
      {
        mode: 'chat',
        model: 'claude-haiku-5-5',
        messages: [{ role: 'user', content: 'Say hi in three words.' }],
      },
    ],
    [
      'chat (sonnet, fallback beta)',
      {
        mode: 'chat',
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'Reply with the word ok.' }],
      },
    ],
    [
      'rewrite',
      {
        mode: 'rewrite',
        model: 'claude-haiku-5-5',
        messages: [
          { role: 'user', content: 'Make formal: hey, cant come today' },
        ],
      },
    ],
    [
      'vision',
      {
        mode: 'vision',
        model: 'claude-haiku-5-5',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: jpeg,
                },
              },
              { type: 'text', text: 'What text is in the photo?' },
            ],
          },
        ],
      },
    ],
    [
      'document',
      {
        mode: 'document',
        model: 'claude-haiku-5-5',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: pdf,
                },
              },
              { type: 'text', text: 'What colour is the sky here?' },
            ],
          },
        ],
      },
    ],
    [
      'extract',
      {
        mode: 'extract',
        model: 'claude-haiku-5-5',
        messages: [
          {
            role: 'user',
            content:
              'Acme Ltd is hiring a remote mid-level Flutter Developer, USD 2,000 a month.',
          },
        ],
      },
    ],
    [
      'receipt',
      {
        mode: 'receipt',
        model: 'claude-haiku-5-5',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: jpeg,
                },
              },
            ],
          },
        ],
      },
    ],
    [
      'agent',
      {
        mode: 'agent',
        model: 'claude-haiku-5-5',
        messages: [
          {
            role: 'user',
            content: 'Add a task: buy milk tomorrow, high priority.',
          },
        ],
      },
    ],
  ];

  for (const [label, body] of cases) {
    const started = Date.now();
    const res = await fetch(`${API}/v1/claude`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let summary;
    if (res.headers.get('content-type')?.includes('text/event-stream')) {
      const events = text
        .split('\n\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l.slice(6)));
      const reply = events
        .filter((e) => e.type === 'text')
        .map((e) => e.text)
        .join('');
      const last = events.at(-1);
      summary = `events=${events.length} last=${last.type}${last.stop_reason ? `/${last.stop_reason}` : ''} ${last.message ?? ''} reply="${reply.slice(0, 60).replace(/\n/g, ' ')}"`;
    } else {
      summary = text.slice(0, 160);
    }
    results.push(
      `${label}: ${res.status} ${Date.now() - started}ms ${summary}`,
    );
  }

  // The rows this user wrote, with what each spent.
  const { data: rows } = await admin
    .from('claude_requests')
    .select('mode, model, input_tokens, output_tokens, ip_hash')
    .eq('user_id', userId)
    .order('id');
  results.push(
    `logged rows: ${rows.length}; all with tokens: ${rows.every((r) => r.input_tokens > 0 && r.output_tokens > 0)}; ip_hash set: ${rows.every((r) => r.ip_hash?.length === 32)}`,
  );
} finally {
  const { error } = await admin.auth.admin.deleteUser(userId);
  results.push(
    error
      ? `DELETE FAILED for ${userId}: ${error.message}`
      : 'test user deleted',
  );
}
console.log(results.join('\n'));
