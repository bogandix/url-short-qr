/** OpenAPI 3.1 description of the admin API, served at GET /_/api/openapi.json. */
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` })
const json = (schema: unknown, description = 'OK') => ({ description, content: { 'application/json': { schema } } })
const err = { description: 'Error', content: { 'application/json': { schema: ref('Error') } } }
const nsCode = [
  { name: 'namespace', in: 'path', required: true, schema: { type: 'string' }, example: 'vv1.eu' },
  { name: 'code', in: 'path', required: true, schema: { type: 'string' }, example: 'A7K2' },
]
const range = [
  { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
  { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
]

export function openapi(server: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Shortener API',
      version: '1.1.0',
      description:
        'Short links, QR codes and click tracking. Authenticate with `Authorization: Bearer sk_live_…`. ' +
        'Keys can be limited to namespaces and an owner prefix (e.g. `vrumvrum:`), which isolates one client service from another.',
    },
    servers: [{ url: server }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' }, detail: {} }, required: ['error'] },
        LinkInput: {
          type: 'object',
          required: ['namespace', 'target_url'],
          properties: {
            namespace: { type: 'string', description: 'Host the short link lives on (apex or namespace-mode subdomain)', example: 'vv1.eu' },
            target_url: { type: 'string', format: 'uri', example: 'https://vrumvrum.ro/anunt/123' },
            code: { type: 'string', description: 'Vanity code, 1–32 of 0-9 A-Z and "-"; normalized (O→0, I/L→1). Omit for a random code.' },
            code_length: { type: 'integer', minimum: 1, maximum: 8, description: 'Random code length (characters after the /). Exact when given (409 code_length_exhausted when that length is full); omitted = domain default (4), which grows automatically. 33^n codes: 1→33, 2→1,089, 3→35,937, 4→1.19M, 5→39M, 6→1.29B.' },
            title: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            owner: { type: 'string', description: 'Free-form tenant key, e.g. "vrumvrum:garage:42"' },
            utm: { type: 'object', additionalProperties: { type: 'string' } },
            append_utm: { type: 'boolean' },
            expires_at: { type: 'string', format: 'date-time' },
            fallback_url: { type: 'string', format: 'uri' },
            external_id: { type: 'string', description: 'Your id for this link. Unique per owner; re-POSTing returns the existing link with 200 and `existed: true`.' },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        Link: {
          allOf: [
            ref('LinkInput'),
            {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                code: { type: 'string' },
                status: { enum: ['active', 'paused', 'archived'] },
                version: { type: 'integer' },
                short_url: { type: 'string', example: 'HTTPS://VV1.EU/A7K2', description: 'All capitals on purpose: smallest QR symbol (alphanumeric mode). Works as typed.' },
                qr: { type: 'object', properties: { svg: { type: 'string' }, png: { type: 'string' }, payload: { type: 'string' } } },
                existed: { type: 'boolean' },
                created_at: { type: 'string', format: 'date-time' },
                updated_at: { type: 'string', format: 'date-time' },
              },
            },
          ],
        },
        Click: {
          type: 'object',
          properties: Object.fromEntries(
            ['id', 'ts', 'host', 'outcome', 'method', 'path', 'query', 'scheme', 'country', 'region', 'city', 'timezone', 'colo', 'as_org', 'ua', 'device', 'os', 'browser', 'browser_version', 'lang', 'referer', 'bot_name', 'source'].map((k) => [k, { type: ['string', 'null'] }]),
          ),
        },
      },
    },
    paths: {
      '/links': {
        post: { summary: 'Create a link (idempotent with external_id)', requestBody: { content: { 'application/json': { schema: ref('LinkInput') } } }, responses: { 201: json(ref('Link'), 'Created'), 200: json(ref('Link'), 'Already existed (same owner + external_id)'), 400: err, 403: err, 409: err } },
        get: {
          summary: 'List links (keyset pagination)',
          parameters: ['namespace', 'owner', 'tag', 'status', 'q', 'external_id', 'cursor', 'limit'].map((name) => ({ name, in: 'query', schema: { type: 'string' } })),
          responses: { 200: json({ type: 'object', properties: { items: { type: 'array', items: ref('Link') }, next_cursor: { type: ['string', 'null'] } } }) },
        },
      },
      '/links/bulk': { post: { summary: 'Create up to 500 links, all or nothing', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: ref('LinkInput'), maxItems: 500 } } } } } }, responses: { 201: json({ type: 'object', properties: { items: { type: 'array', items: ref('Link') } } }), 400: err, 409: err } } },
      '/links/by-external/{external_id}': {
        get: { summary: 'Find a link by your external_id', parameters: [{ name: 'external_id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'owner', in: 'query', schema: { type: 'string' } }], responses: { 200: json(ref('Link')), 404: err } },
      },
      '/links/{namespace}/{code}': {
        parameters: nsCode,
        get: { summary: 'Get a link with its audit history', responses: { 200: json(ref('Link')), 404: err } },
        patch: { summary: 'Update a link; status active|paused pauses/resumes (effective within ~60 s)', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 200: json(ref('Link')), 400: err, 404: err, 409: err } },
        delete: { summary: 'Archive a link (the code is never reused)', responses: { 200: json({ type: 'object' }), 404: err } },
      },
      '/links/{namespace}/{code}/stats': { parameters: nsCode, get: { summary: 'Daily rollups plus live rows for days not rolled up yet', parameters: [...range, { name: 'interval', in: 'query', schema: { enum: ['day', 'hour'] } }], responses: { 200: json({ type: 'object' }) } } },
      '/links/{namespace}/{code}/clicks': { parameters: nsCode, get: { summary: 'Raw click rows (no hashes)', parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500 } }], responses: { 200: json({ type: 'object', properties: { items: { type: 'array', items: ref('Click') }, next_cursor: { type: ['string', 'null'] } } }) } } },
      '/stats/overview': { get: { summary: 'Dashboard: series, totals, outcomes, top links, breakdowns', parameters: [...range, { name: 'namespace', in: 'query', schema: { type: 'string' } }, { name: 'owner', in: 'query', schema: { type: 'string' } }, { name: 'top', in: 'query', schema: { type: 'integer' } }], responses: { 200: json({ type: 'object' }) } } },
      '/keys': { post: { summary: 'Create an API key (returned once)', responses: { 201: json({ type: 'object' }) } }, get: { summary: 'List keys (no secrets)', responses: { 200: json({ type: 'object' }) } } },
      '/keys/{id}': { delete: { summary: 'Revoke a key', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }) } } },
      '/domains': { get: { summary: 'List domains', responses: { 200: json({ type: 'object' }) } } },
    },
    'x-qr': 'GET https://{host}/_/qr/{CODE}.svg|png?size=512&ecc=M&margin=4&fg=000000&bg=ffffff — public, edge-cached, not logged.',
  }
}
