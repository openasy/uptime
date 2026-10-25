# uptime

[![CI](https://github.com/openasy/uptime/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/uptime/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Uptime product: **HTTP, TCP, DNS and TLS checks, their outages, and a public
status page** (ADR 0047). Uptime itself probes nothing. A **runner**, one script with no dependencies, runs the checks
from wherever you start it (a CI cron, a server in another network, several places at once) and sends what it saw.

```
CI cron / any machine: node uptime-runner.mjs ──GET /api/v1/checks/runnable──▶  uptime
                                               ──POST /api/v1/results────────▶    ├── state, outages, uptime, latency
                                                                                  ├── /status, for anyone
                                                                                  └── /metrics, to alert on
```

## Checks

| Type | Target | Passes when |
| --- | --- | --- |
| `http` | a web address | the status is below 400 (or the one you set), and the page has your text if you set one |
| `tcp` | `host:port` | a connection opens |
| `dns` | a host name | it resolves, to your record among the answers if you set one (A, AAAA, CNAME, TXT) |
| `tls` | a host name, with `:port` if not 443 | the certificate is trusted and is not yet critical: 7 days left by default, from `OPENASY_CERT_WARN_DAYS` (or the days you set) |

Each check has an **interval** (`every`, 300 seconds by default), how often a runner is expected to run it, and the
number of **failures in a row** before it is down (`failures`, 2 by default).

### From a file

Checks come from a file the install keeps, the same file Certificates reads, and from nowhere else (ADR 0052): there is
no form and no API route that adds or changes one. Mount it and set
`OPENASY_ENDPOINTS`; Uptime reads it at start and again within a minute of a change.

```yaml
endpoints:
  - name: Website
    url: https://www.example.com      # https:// or http:// is http, tcp://host:port, dns://name, tls://host:port
    group: Public
    server: web-1                     # the server it runs on, by its name in the hosts file
    public: true                      # on the status page
    every: 1m                         # 30s to 24h; 5m by default
    failures: 3                       # in a row before it is down; 2 by default
    expect: { status: 200, text: Welcome }
  - name: Mail
    url: tls://mail.example.com:465
```

A check is changed and removed in the file: the API answers 409 to a delete, while pause and resume still work.
Checks added in the UI before 0.5.0 keep running, and the Checks page shows the lines to copy into the file; once an
entry has the same name, it takes the check over with its results and outages. An entry removed from the file removes its
check and its results; a renamed entry is a new check. A file with a mistake is not applied at all: the checks from
its last good version stay, and the Checks page and the log say what to fix.

## State and outages

- One failure makes a check **degraded**. The set number of failures in a row make it **down** and open an **outage**.
  One pass makes it **up** again and ends the outage.
- A check with no result for three intervals is **stale**: the page says the runner stopped rather than showing the
  last state as current. A check nobody has run is **unknown**, never up.
- A result older than the newest one of its check is kept but does not move its state, so a slow runner cannot undo a
  fast one.
- **Uptime** for 24 hours, 7, 30 and 90 days is the time not spent in an outage, from the first result. Latency
  percentiles (p50, p95, p99) cover the passing results of the last day.
- An editor can **pause** a check: runners skip it and the status page shows it as maintenance.
- Passwords in addresses are removed from what a runner sends.

## Incidents

With `UPTIME_INCIDENTS_TOKEN`, each outage opens an incident in [OpenAsy Incidents](https://github.com/openasy/incidents)
at `UPTIME_INCIDENTS_SEVERITY` (high by default), with a link back to the check as its evidence, and its end is noted
on the incident's timeline with how long it lasted (ADR 0041). Resolving the incident stays with people. Make the token
in Incidents under Settings, API tokens, with the editor role: it opens and updates incidents and does nothing else.
uptime calls Incidents at `UPTIME_INCIDENTS_URL`, such as `http://incidents:8080` next to it, or where
`OPENASY_PRODUCTS` says people open it.

- One outage is one incident; a check that goes down again later opens a new one. The incident never names the
  check's target.
- Results are answered before Incidents is called, so a slow or stopped Incidents never holds them back. An outage
  whose incident or end could not be sent says why under Outages, and is tried again every minute for a day.

## The runner

```bash
curl -sf https://uptime.example.com/uptime-runner.mjs -o uptime-runner.mjs
UPTIME_URL=https://uptime.example.com UPTIME_INGEST_TOKEN=... UPTIME_LOCATION=github node uptime-runner.mjs
```

It needs Node 20 or later. It runs ten checks at a time with a 10-second timeout each, and exits with 0 when it ran
and reported, even when checks failed: a failing site is a result, not a runner error. `UPTIME_LOCATION` names where it
ran, shown next to each result. From GitHub Actions, every 5 minutes:

```yaml
on:
  schedule: [{ cron: "*/5 * * * *" }]
jobs:
  uptime:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v7
        with: { node-version: 24 }
      - run: curl -sf https://uptime.example.com/uptime-runner.mjs -o uptime-runner.mjs && node uptime-runner.mjs
        env:
          UPTIME_URL: https://uptime.example.com
          UPTIME_INGEST_TOKEN: ${{ secrets.UPTIME_INGEST_TOKEN }}
          UPTIME_LOCATION: github
```

## The status page

`/status` is plain HTML with no script, for anyone, and `/api/v1/status/public` gives the same as data. It shows only
the checks an admin marked public, by name, group and state, with 90 days of history and recent incidents. Targets and
the other checks are never shown. Set its title with `UPTIME_STATUS_TITLE`.

## Run

```bash
openssl rand -hex 32 > openasy-kek
export UPTIME_INGEST_TOKEN=$(openssl rand -hex 32)
docker compose up -d
docker compose logs uptime | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080, the API reference at http://localhost:8080/api/docs/.

`openasy-kek` encrypts sign-in secrets in the database (ADR 0021). Keep it apart from the volume and with your backups.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `UPTIME_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher. Give every product the same value |
| `UPTIME_INGEST_TOKEN` | | Lets runners fetch the checks and send results, and nothing else. An API token with the editor role works too |
| `UPTIME_STATUS_TITLE` | `Status` | The title of the public status page |
| `UPTIME_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `UPTIME_DB` | `/data/uptime.db` | SQLite file (WAL), on the `/data` volume |
| `UPTIME_RETENTION_DAYS` | `30` | Results older than this are deleted. Ended outages are kept for 400 days |
| `UPTIME_INCIDENTS_TOKEN` | | An Incidents API token with the editor role: outages open incidents |
| `UPTIME_INCIDENTS_URL` | the `incidents` entry of `OPENASY_PRODUCTS` | Where uptime calls Incidents, such as `http://incidents:8080` |
| `UPTIME_INCIDENTS_SEVERITY` | `high` | The severity of an outage's incident: critical, high, medium or low |
| `UPTIME_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `UPTIME_HEADLESS` | `false` | `true` serves only the API |
| `OPENASY_ENDPOINTS` | | A YAML file of endpoints to check, shared with Certificates; see [From a file](#from-a-file) |
| `OPENASY_CERT_WARN_DAYS` | `30,14,7,1` | Days before a certificate ends that Certificates warns at. A TLS check fails at the critical one, 7 or the largest if less. Give both products the same value |
| `UPTIME_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

`/metrics` has `openasy_uptime_check_up{check}` (absent while a check's state is unknown) and
`openasy_uptime_check_stale{check}`, to alert on in your own Prometheus.

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.

## Roles

Viewers see everything; editors also pause and resume checks; admins also delete checks added before the file, and manage
members and API tokens (ADR 0003).

## Develop

```bash
npm install
npm test        # each check type in the runner, state and outages as results arrive, the status page, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

## Licence

AGPL-3.0 (ADR 0008).
