/**
 * Host-half tests for dsh-ops-updater.
 *
 * They drive `apply()` against a fake Context and a fake dsh-ops checkout, so
 * the channel, its endpoints, and the files they read are all exercised without
 * the harness, without systemd, and without touching this machine's checkout.
 *
 * The one deliberate double: `bin/dsh-sync.sh` in the fake checkout prints a
 * canned report instead of fetching and building. That is the contract between
 * the two halves — the plugin parses the script's JSON and nothing else.
 *
 * run: node --test plugins/dsh-ops-updater/test/
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { ROUTE_PATH, apply } from '../index.mjs'

/** The check report the fake updater prints, in the shape the real one does. */
const REPORT = {
  ok: true,
  channel: 'stable',
  current: 'dsh-v9.9.9',
  currentVersion: '9.9.9',
  installedAt: '2026-01-02T03:04:05Z',
  target: 'dsh-v9.9.10',
  targetVersion: '9.9.10',
  updateAvailable: true,
  newerCount: 1,
  newer: ['dsh-v9.9.10'],
  checkedAt: '2026-01-02T03:04:06Z',
}

/** The plugin check report the fake dsh-plugins.sh prints. */
const PLUGIN_REPORT = {
  ok: true,
  pluginsDir: '/tmp/plugins',
  updateAvailable: true,
  unmanaged: 0,
  entries: [
    { name: 'dsh-ops-updater', url: 'https://example.invalid/dsh-ops-updater.git', ref: null, source: 'plugins.conf', directory: '/tmp/plugins/dsh-ops-updater', installed: true, current: 'cbe8093', latest: 'aaaaaaa', updateAvailable: true, note: null },
  ],
  checkedAt: '2026-01-02T03:04:06Z',
}

/** One endpoint call as the browser half makes it. */
let root
let logLines

/** Build a fake checkout the plugin can be pointed at. */
function fakeCheckout() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ops-updater-'))
  mkdirSync(join(dir, 'bin'), { recursive: true })
  mkdirSync(join(dir, 'harness', 'state'), { recursive: true })
  const pluginScript = join(dir, 'bin', 'dsh-plugins.sh')
  writeFileSync(pluginScript, `#!/usr/bin/env bash
if [ "\${1:-}" = "--check" ]; then
  printf '%s\\n' '${JSON.stringify(PLUGIN_REPORT)}'
  exit 0
fi
printf '%s\\n' "fake plugin updater ran" >> ${JSON.stringify(join(dir, 'harness', 'state', 'plugins.log'))}
`, 'utf8')
  chmodSync(pluginScript, 0o755)
  writeFileSync(join(dir, 'harness', 'state', 'plugins.json'), JSON.stringify({
    state: 'ok',
    phase: 'done',
    message: '2 plugin(s) already current',
    pid: 999999999,
    startedAt: '2026-01-02T02:00:00Z',
    finishedAt: '2026-01-02T02:00:03Z',
    updatedAt: '2026-01-02T02:00:03Z',
    entries: [{ name: 'dsh-ops-updater', url: 'https://example.invalid/x.git', action: 'keep', ok: true, detail: 'cbe8093' }],
  }), 'utf8')
  writeFileSync(join(dir, 'harness', 'state', 'plugins.log'), 'dsh-plugins: checking\ndsh-plugins: 1 plugin(s) already current\n', 'utf8')

  const script = join(dir, 'bin', 'dsh-sync.sh')
  writeFileSync(script, `#!/usr/bin/env bash
if [ "\${1:-}" = "--check" ]; then
  printf '%s\\n' '${JSON.stringify(REPORT)}'
  exit 0
fi
printf '%s\\n' "fake updater ran" >> ${JSON.stringify(join(dir, 'harness', 'state', 'update.log'))}
`, 'utf8')
  chmodSync(script, 0o755)
  writeFileSync(join(dir, 'harness', 'current-ref'), 'dsh-v9.9.9', 'utf8')
  writeFileSync(join(dir, 'harness', 'state', 'update.json'), JSON.stringify({
    state: 'running',
    phase: 'build',
    message: 'building dsh-v9.9.10',
    channel: 'stable',
    target: 'dsh-v9.9.10',
    previous: 'dsh-v9.9.9',
    pid: 999999999,
    startedAt: '2026-01-02T03:00:00Z',
    finishedAt: null,
    updatedAt: '2026-01-02T03:00:10Z',
  }), 'utf8')
  logLines = 'dsh-sync: installing deps\ndsh-sync: building\ndsh-sync: smoke test (boot on OS-assigned port)'
  writeFileSync(join(dir, 'harness', 'state', 'update.log'), `${logLines}\n`, 'utf8')
  writeFileSync(join(dir, 'dsh-ops.conf'), [
    '# machine-local settings',
    'DSH_PORT=3080',
    'DSH_UPDATE_CHANNEL=stable',
    'DSH_AUTO_UPDATE=1',
    '',
  ].join('\n'), 'utf8')
  return dir
}

/**
 * Mount the plugin against a fake Context and return a caller for its route.
 * The fake mirrors what Cordis does for the row: `inject` hands the callback a
 * context once the named service exists, and the registration publishes one
 * exact `/api` Fetch route whose handler answers a real `Request`.
 */
function mount(opsPath) {
  let route
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['connection'])
      callback(ctx)
    },
    connection: {
      fetch: {
        register: (registered) => {
          assert.equal(registered.path, ROUTE_PATH)
          assert.deepEqual(registered.methods, ['POST'])
          assert.equal(registered.requestBody, 'buffered')
          route = registered
          return async () => {}
        },
      },
    },
  }
  apply(ctx, opsPath === undefined ? {} : { opsPath })
  assert.equal(typeof route, 'object', 'apply must register the fetch route')
  return async (endpoint, payload) => {
    const response = await route.fetch(new Request(`http://harness.test${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
    }))
    assert.equal(response.status, 200, `expected HTTP 200 for ${endpoint}`)
    return response.json()
  }
}

/** Unwrap a successful channel answer, failing loudly otherwise. */
function value(answer) {
  assert.equal(answer.ok, true, answer.ok === false ? answer.error.message : 'expected success')
  return answer.value
}

let stubDir
let originalPath

/**
 * Put a `systemctl` stub in front of the real one for the whole file.
 *
 * The Host half runs `systemctl --user ...` by name, and the unit names it
 * passes (`dsh-update.service`, `dsh-update.timer`) are the REAL ones: without
 * this stub, running these tests on a live machine starts the actual update
 * unit, which restarts the harness the tests are running inside. The stub
 * records every call and reports failure, so the code under test takes its
 * documented fallback paths instead.
 */
before(() => {
  root = fakeCheckout()
  stubDir = mkdtempSync(join(tmpdir(), 'dsh-ops-stub-bin-'))
  const stub = join(stubDir, 'systemctl')
  writeFileSync(stub, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(join(stubDir, 'systemctl.log'))}
exit 1
`, 'utf8')
  chmodSync(stub, 0o755)
  originalPath = process.env.PATH
  process.env.PATH = `${stubDir}:${originalPath ?? ''}`
})

after(() => {
  process.env.PATH = originalPath
  // tmpdirs are left to the OS; nothing machine-local is touched.
})

/** Every systemctl invocation the plugin made during these tests. */
function systemctlCalls() {
  try {
    return readFileSync(join(stubDir, 'systemctl.log'), 'utf8').trim().split('\n')
  } catch {
    return []
  }
}

describe('dsh-ops-updater host half', () => {
  it('registers its channel and reports what is installed', async () => {
    const call = mount(root)
    const status = value(await call('status', {}))
    assert.equal(status.found, true)
    assert.equal(status.root, root)
    assert.equal(status.current, 'dsh-v9.9.9')
    assert.equal(status.channel, 'stable')
    assert.equal(status.autoUpdate, true)
    assert.equal(status.run.state, 'running')
    assert.match(status.installedAt, /^\d{4}-\d{2}-\d{2}T/)
  })

  it('answers the check from the script it runs, verbatim', async () => {
    const call = mount(root)
    const report = value(await call('check', {}))
    for (const [key, expected] of Object.entries(REPORT)) assert.deepEqual(report[key], expected, key)
    assert.equal(report.exitCode, 0)
  })

  it('reports the run record and the log tail', async () => {
    const call = mount(root)
    const progress = value(await call('progress', { lines: 2 }))
    assert.equal(progress.run.phase, 'build')
    assert.equal(progress.log, 'dsh-sync: building\ndsh-sync: smoke test (boot on OS-assigned port)')
  })

  it('starts an update when the recorded run is no longer alive', async () => {
    const call = mount(root)
    const started = value(await call('update', {}))
    assert.equal(started.started, true)
    // systemd is unreachable here, so this exercises the detached fallback.
    assert.ok(started.via === 'systemd' || started.via === 'detached')
  })

  it('refuses to start a second update while one is running', async () => {
    const record = JSON.parse(readFileSync(join(root, 'harness', 'state', 'update.json'), 'utf8'))
    writeFileSync(
      join(root, 'harness', 'state', 'update.json'),
      JSON.stringify({ ...record, pid: process.pid }),
      'utf8',
    )
    const call = mount(root)
    const answer = value(await call('update', {}))
    assert.equal(answer.started, false)
    assert.equal(answer.alreadyRunning, true)
  })

  it('records the automatic-update choice in dsh-ops.conf', async () => {
    const call = mount(root)
    const off = value(await call('auto', { enabled: false }))
    assert.equal(off.enabled, false)
    const conf = readFileSync(join(root, 'dsh-ops.conf'), 'utf8')
    assert.match(conf, /^DSH_AUTO_UPDATE=0$/m)
    // Everything else in the file survives the edit.
    assert.match(conf, /^DSH_PORT=3080$/m)
    assert.match(conf, /^# machine-local settings$/m)

    value(await call('auto', { enabled: true }))
    assert.match(readFileSync(join(root, 'dsh-ops.conf'), 'utf8'), /^DSH_AUTO_UPDATE=1$/m)
  })

  it('appends the setting when the conf does not carry it yet', async () => {
    writeFileSync(join(root, 'dsh-ops.conf'), 'DSH_PORT=3080\n', 'utf8')
    const call = mount(root)
    value(await call('auto', { enabled: true }))
    assert.match(readFileSync(join(root, 'dsh-ops.conf'), 'utf8'), /^DSH_AUTO_UPDATE=1$/m)
  })

  it('follows the channel the page selects, through dsh-ops.conf', async () => {
    writeFileSync(join(root, 'dsh-ops.conf'), '# machine-local settings\nDSH_PORT=3080\nDSH_UPDATE_CHANNEL=rc\n', 'utf8')
    const call = mount(root)
    const switched = value(await call('channel', { channel: 'alpha' }))
    assert.equal(switched.channel, 'alpha')
    const conf = readFileSync(join(root, 'dsh-ops.conf'), 'utf8')
    assert.match(conf, /^DSH_UPDATE_CHANNEL=alpha$/m)
    // Everything else in the file survives the edit, comments included.
    assert.match(conf, /^# machine-local settings$/m)
    assert.match(conf, /^DSH_PORT=3080$/m)
    // The next status read reports the channel now in effect.
    assert.equal(value(await call('status', {})).channel, 'alpha')
    // Leave the fixture as later tests expect it.
    value(await call('channel', { channel: 'stable' }))
    assert.match(readFileSync(join(root, 'dsh-ops.conf'), 'utf8'), /^DSH_UPDATE_CHANNEL=stable$/m)
  })

  it('appends the channel when the conf does not carry it yet', async () => {
    writeFileSync(join(root, 'dsh-ops.conf'), 'DSH_PORT=3080\n', 'utf8')
    const call = mount(root)
    value(await call('channel', { channel: 'alpha' }))
    assert.match(readFileSync(join(root, 'dsh-ops.conf'), 'utf8'), /^DSH_UPDATE_CHANNEL=alpha$/m)
  })

  it('refuses a channel the updater does not know, and writes nothing', async () => {
    writeFileSync(join(root, 'dsh-ops.conf'), 'DSH_UPDATE_CHANNEL=rc\n', 'utf8')
    const call = mount(root)
    for (const bogus of ['nonsense', '', 'rc\nalpha', undefined]) {
      const answer = await call('channel', { channel: bogus })
      assert.equal(answer.ok, false, `expected ${String(bogus)} to be refused`)
      assert.match(answer.error.message, /unknown channel/)
    }
    assert.match(readFileSync(join(root, 'dsh-ops.conf'), 'utf8'), /^DSH_UPDATE_CHANNEL=rc$/m)
  })

  it('fails loudly for an unknown endpoint', async () => {
    const call = mount(root)
    const answer = await call('nonsense', {})
    assert.equal(answer.ok, false)
    assert.equal(answer.error.code, 'unknown-endpoint')
  })

  it('reports the plugin run record and log tail', async () => {
    const call = mount(root)
    const state = value(await call('plugins', { lines: 1 }))
    assert.equal(state.found, true)
    assert.equal(state.unit, 'dsh-plugins.service')
    assert.equal(state.run.message, '2 plugin(s) already current')
    assert.equal(state.log, 'dsh-plugins: 1 plugin(s) already current')
  })

  it('reports a run whose process is gone as interrupted, not running', async () => {
    const file = join(root, 'harness', 'state', 'plugins.json')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    // The shape dsh-plugins.service leaves behind when its own final phase
    // restarts the harness: still "running", with the writer now dead.
    writeFileSync(file, JSON.stringify({ ...record, state: 'running', pid: 999999999, finishedAt: null }), 'utf8')
    const call = mount(root)
    const state = value(await call('plugins', { lines: 1 }))
    assert.equal(state.run.state, 'interrupted')
    assert.equal(state.run.interrupted, true)
    writeFileSync(file, JSON.stringify(record), 'utf8')
  })

  it('leaves a genuinely running run reported as running', async () => {
    const file = join(root, 'harness', 'state', 'plugins.json')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...record, state: 'running', pid: process.pid }), 'utf8')
    const call = mount(root)
    const state = value(await call('plugins', { lines: 1 }))
    assert.equal(state.run.state, 'running')
    assert.equal(state.run.interrupted, undefined)
    writeFileSync(file, JSON.stringify(record), 'utf8')
  })
  it('answers the plugin check from the script it runs, verbatim', async () => {
    const call = mount(root)
    const report = value(await call('pluginsCheck', {}))
    for (const [key, expected] of Object.entries(PLUGIN_REPORT)) assert.deepEqual(report[key], expected, key)
    assert.equal(report.exitCode, 0)
  })

  it('starts a plugin update when the recorded run is no longer alive', async () => {
    const call = mount(root)
    const started = value(await call('pluginsUpdate', {}))
    assert.equal(started.started, true)
    assert.ok(started.via === 'systemd' || started.via === 'detached')
  })

  it('refuses a second plugin update while one is running', async () => {
    const file = join(root, 'harness', 'state', 'plugins.json')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...record, state: 'running', pid: process.pid }), 'utf8')
    const call = mount(root)
    const answer = value(await call('pluginsUpdate', {}))
    assert.equal(answer.started, false)
    assert.equal(answer.alreadyRunning, true)
    writeFileSync(file, JSON.stringify(record), 'utf8')
  })

  it('asks systemd through the stub, never the live user manager', async () => {
    const calls = systemctlCalls()
    assert.ok(calls.length > 0, 'the Host half must reach for systemctl')
    assert.ok(calls.some(call => call.includes('dsh-update.service')), 'the harness unit is named')
    assert.ok(calls.some(call => call.includes('dsh-plugins.service')), 'the plugin unit is named')
    assert.ok(calls.every(call => call.startsWith('--user ')), 'every call is a user-manager call')
    // The whole point of the stub: this file must not be able to restart the
    // harness it is running in, whatever the real systemd would have done.
    assert.ok(calls.every(call => !call.includes('restart')), 'these tests never restart a service')
  })

  it('tries opsPath first, then discovery', async () => {
    const call = mount('/nonexistent/ops')
    // The bogus opsPath holds no updater, so discovery continues: the working
    // directory of these tests IS a dsh-ops checkout.
    const status = value(await call('status', {}))
    assert.equal(status.found, true)
    assert.ok(status.root.startsWith('/'))
    assert.ok(!status.root.startsWith('/nonexistent'))
  })

  it('reports a missing checkout instead of throwing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'dsh-ops-nowhere-'))
    const previousCwd = process.cwd()
    const previousConfig = process.env.XDG_CONFIG_HOME
    process.chdir(empty)
    process.env.XDG_CONFIG_HOME = join(empty, 'no-config')
    try {
      const call = mount(undefined)
      const status = value(await call('status', {}))
      assert.equal(status.found, false)
      assert.match(status.error, /no dsh-ops checkout found/)
      assert.match(status.error, /opsPath/)
    } finally {
      process.chdir(previousCwd)
      if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousConfig
    }
  })
})

/** The fake script is the contract: it must be runnable as the real one is. */
describe('fake checkout sanity', () => {
  it('prints the canned report for --check --json', () => {
    const out = execFileSync(join(root, 'bin', 'dsh-sync.sh'), ['--check', '--json'], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(out), REPORT)
  })
})
