// k6 run -e HOSTS=short.example,go.other.example,acme.tenant.example -e CODES=A7K2,B8M3 scripts/load/k6.js
// §13: 200 rps for 2 minutes across two domains and one wildcard host, mixed traffic.
// Afterwards: rows in shortener.clicks for the window == requests sent (k6 prints http_reqs),
// and the next reconcile shows diff 0. Note the in-Worker rate limit (120/min per IP by default):
// run from several IPs or raise the RATE_LIMIT binding for the test, or 429s are expected (and logged).
import http from 'k6/http'
import { check } from 'k6'

const hosts = (__ENV.HOSTS || '').split(',').filter(Boolean)
const codes = (__ENV.CODES || '').split(',').filter(Boolean)

export const options = {
  scenarios: {
    mixed: { executor: 'constant-arrival-rate', rate: 200, timeUnit: '1s', duration: '2m', preAllocatedVUs: 100, maxVUs: 400 },
  },
  thresholds: { http_req_failed: ['rate<0.001'], 'http_req_duration{kind:hit}': ['p(50)<120'] },
}

const BOTS = ['Slackbot-LinkExpanding 1.0', 'facebookexternalhit/1.1', 'curl/8.4.0']
const pick = (a) => a[Math.floor(Math.random() * a.length)]

export default function () {
  const host = pick(hosts)
  const code = pick(codes)
  const r = Math.random()
  let url = `https://${host}/${code}`
  let kind = 'hit'
  let ua = 'Mozilla/5.0 (k6 load test)'
  if (r < 0.15) (url = `https://${host}/MISS${Math.floor(Math.random() * 1e6)}`), (kind = 'miss')
  else if (r < 0.25) (ua = pick(BOTS)), (kind = 'bot')
  else if (r < 0.32) (url = `http://${host}/${code}`), (kind = 'http')
  else if (r < 0.4) (url = `https://${host}/${code.toLowerCase()}`), (kind = 'lower')
  else if (r < 0.45) (url = `https://${host}/${code.replace(/0/g, 'O')}`), (kind = 'typo')
  else if (r < 0.5) (url = `https://unknown-${Math.floor(Math.random() * 100)}.${hosts[0]}/${code}`), (kind = 'unknown_host')
  const res = http.get(url, { redirects: 0, headers: { 'user-agent': ua }, tags: { kind } })
  check(res, {
    'no 301': (x) => x.status !== 301,
    'no-store': (x) => x.headers['Cache-Control'] === 'private, no-store, max-age=0',
  })
}
