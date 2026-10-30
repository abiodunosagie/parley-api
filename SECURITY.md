# Security

Please report a vulnerability privately through GitHub's "Report a vulnerability" button on the
Security tab of this repository, not in a public issue. Include the steps to reproduce it.

What this API protects: the project's Anthropic key and Supabase service-role key (only ever in the
host's environment), users' own Anthropic keys (used for one request, never stored or logged), and
the shared daily budget (rate limits enforced in one locked Postgres call).
