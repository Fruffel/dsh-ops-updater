/**
 * dsh-ops updater — the Host half of the GUI's Updates page.
 *
 * Why this exists
 * ---------------
 * The release flow already lives in `bin/dsh-sync.sh`: newest tag on a channel →
 * build → smoke test → swap `harness/current` → restart the services, and never
 * leave a broken build running. What this plugin adds is the *decision*, in the
 * browser: it reports what is installed, asks the script whether the channel has
 * something newer, and starts an update when asked. Nothing here re-implements
 * version resolution — the script stays the single source of truth, and this
 * half only runs it and reads back what it wrote.
 *
 * How the page reaches it
 * -----------------------
 * One exact route on the shared `/api` channel
 * (`ctx.connection.fetch.register`), not a route of our own on the webserver.
 * The difference is the fence: `/api` is served by dsh-client-connection, which
 * applies the deployment's Host/Origin trust (`trustedHosts`, loopback, every
 * bind-derived IPv4 literal) AND the signed browser cookie before dispatch. A
 * route registered directly on `ctx.webServer` gets neither, and "install a
 * release" is not an endpoint to leave open. Registering here also means the
 * page needs no transport of its own: it is one POST to `/api/...`, which is
 * why the browser half is a plain `fetch`.
 *
 * (A Connection RPC channel — `ctx.connection.rpc.handle` — looks like the
 * natural seam and is not usable from a plugin like this one: its registration
 * installs the physical route through `owner.webServer` on a context that
 * cannot see `webServer`, and the boot fails with `cannot get property
 * "webServer" without inject`. An exact `/api` Fetch route has no such
 * requirement.)
 *
 * Why an update goes through systemd
 * ----------------------------------
 * An update ends by restarting `dsh-web` — the very process this plugin runs
 * in. A child of that process sits in the same cgroup, and systemd's default
 * `KillMode=control-group` kills the whole group on restart, so the update would
 * die at the moment it needs to finish. `dsh-update.service` exists for exactly
 * that reason: the plugin asks systemd to run it in its own cgroup, and the
 * process outlives the restart it performs. The detached spawn below is only a
 * fallback for a harness that is not running under systemd at all.
 *
 * Reversibility
 * -------------
 * Remove this package's `insert` row from `~/.dsh/profiles/web/cordis.patch.yml`
 * (or set `disabled: true` on it): the Updates page disappears and nothing else
 * changes. The update itself is unaffected — `bin/dsh-sync.sh` works from a
 * terminal exactly as before.
 *
 * @module dsh-ops-updater
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Loader-visible plugin name (the loader prints it in boot diagnostics). */
export const name = 'dsh-ops-updater'

/**
 * The exact `/api` path this plugin owns; the browser half posts to it. It has
 * to sit below `/api` (that is what carries the fence) and to be one valid
 * endpoint segment.
 */
export const ROUTE_PATH = '/api/dsh-ops-updates'

/** The method that path answers. Anything else falls through to the carrier. */
export const ROUTE_METHOD = 'POST'

/** Largest request body accepted, in bytes; the payloads here are tiny. */
const MAX_BODY_BYTES = 64 * 1024

/** The systemd unit that runs one update in its own cgroup. */
export const UPDATE_UNIT = 'dsh-update.service'

/** The timer that makes updates automatic (03:00 daily). */
export const AUTO_UNIT = 'dsh-update.timer'

/**
 * The unit that updates the plugin checkouts. Same shape as the harness one:
 * it pulls each checkout, refreshes the profile layer, and restarts the harness
 * from its own cgroup.
 */
export const PLUGINS_UNIT = 'dsh-plugins.service'

/** How long one command may take before it is killed. */
const CHECK_TIMEOUT_MS = 120_000
const SYSTEMCTL_TIMEOUT_MS = 20_000

/**
 * Register the Updates route.
 * @param ctx - host context (the route registration belongs to this fiber).
 * @param config - the row's config; `opsPath` pins the checkout when discovery
 *   would guess wrong (an unusual WorkingDirectory, a hand-started `dsh web`).
 */
export function apply(ctx, config) {
  const located = locateOps(config?.opsPath)
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`dsh-ops-updater: ${message}`)
    } catch {
      // A logger that throws must never take the plugin down with it.
    }
  }
  if (located.root === undefined) {
    log('warn', `${located.error} — the Updates page will say so until it is fixed`)
  } else {
    log('info', `updates for ${located.root} (found via ${located.source})`)
  }

  // `connection` is injected rather than read straight off ctx: this row is a
  // plain file plugin, and a context that DECLARED a service is the one whose
  // effect can register against it.
  ctx.inject(['connection'], (routeCtx) => {
    routeCtx.connection.fetch.register({
      path: ROUTE_PATH,
      methods: [ROUTE_METHOD],
      requestBody: 'buffered',
      fetch: request => dispatch(request, located, log),
    })
  })
}

/**
 * Answer one authenticated request. By the time this runs the carrier has
 * already applied the `/api` trust fence and the browser cookie, so the only
 * remaining job is routing an endpoint to its handler and shaping the answer.
 * @param request - the decoded request.
 * @param located - the resolved dsh-ops checkout.
 * @param log - diagnostic sink.
 * @returns the JSON response.
 */
async function dispatch(request, located, log) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: { code: 'bad-request', message: 'body is not JSON' } }, 400)
  }
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : undefined
  if (endpoint === undefined) {
    return json({ ok: false, error: { code: 'bad-request', message: 'endpoint must be a string' } }, 400)
  }
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) {
    return json({ ok: false, error: { code: 'too-large', message: 'request body is too large' } }, 413)
  }
  try {
    switch (endpoint) {
      case 'status':
        return json(ok(await readStatus(located)))
      case 'check':
        return json(ok(await checkForUpdate(located)))
      case 'progress':
        return json(ok(await readProgress(located, body.payload)))
      case 'update':
        return json(ok(await startUpdate(located, log)))
      case 'auto':
        return json(ok(await setAutoUpdate(located, body.payload, log)))
      case 'plugins':
        return json(ok(await readPluginState(located, body.payload)))
      case 'pluginsCheck':
        return json(ok(await checkPlugins(located)))
      case 'pluginsUpdate':
        return json(ok(await startPluginsUpdate(located, log)))
      default:
        return json(fail('unknown-endpoint', `dsh-ops-updater: no endpoint named "${endpoint}"`))
    }
  } catch (error) {
    return json(fail('failed', error instanceof Error ? error.message : String(error)))
  }
}

/** One JSON response, always with the plugin's `ok`/`value`/`error` shape. */
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A successful answer. */
function ok(value) {
  return { ok: true, value }
}

/** A failed answer, in the shape the browser half unwraps. */
function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * Find the dsh-ops checkout this deployment runs from.
 *
 * The candidates are ordered by how much they can be trusted: an explicit
 * `opsPath` on the row, then `DSH_OPS_HOME`, then the working directory and its
 * parents (the service runs with `WorkingDirectory=<ops>/harness/current`), and
 * finally the path rendered into `dsh-web.service`, which is what remains true
 * when the harness was started some other way. Every candidate has to hold
 * `bin/dsh-sync.sh` to count.
 * @param configured - `opsPath` from the row's config, when it has one.
 * @returns the checkout root, or the reason none was found.
 */
function locateOps(configured) {
  const candidates = []
  if (typeof configured === 'string' && configured.trim().length > 0) {
    candidates.push({ path: configured.trim(), source: 'opsPath' })
  }
  const fromEnv = process.env.DSH_OPS_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    candidates.push({ path: fromEnv.trim(), source: 'DSH_OPS_HOME' })
  }
  let dir = process.cwd()
  for (let depth = 0; depth < 3; depth += 1) {
    candidates.push({ path: dir, source: 'working directory' })
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const fromUnit = opsFromUnit()
  if (fromUnit !== undefined) candidates.push({ path: fromUnit, source: 'dsh-web.service' })

  for (const candidate of candidates) {
    const root = resolve(candidate.path)
    if (looksLikeOps(root)) return { root, source: candidate.source }
  }
  const tried = candidates.map(candidate => `${candidate.source} (${resolve(candidate.path)})`).join(', ')
  return {
    root: undefined,
    error: `dsh-ops-updater: no dsh-ops checkout found (${tried}) — set opsPath on this plugin's row`,
  }
}

/** Whether a directory is a dsh-ops checkout: the updater is the test. */
function looksLikeOps(path) {
  return existsSync(join(path, 'bin', 'dsh-sync.sh'))
}

/**
 * Derive the checkout from the unit that starts this harness. The rendered
 * `WorkingDirectory` is `<ops>/harness/current`, so two levels up is the root.
 * @returns the candidate path, or undefined when the unit is absent or unreadable.
 */
function opsFromUnit() {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  const unit = join(configHome, 'systemd', 'user', 'dsh-web.service')
  try {
    const text = readFileSync(unit, 'utf8')
    const match = /^WorkingDirectory=(.+)$/m.exec(text)
    if (match === null) return undefined
    return resolve(match[1].trim(), '..', '..')
  } catch {
    return undefined
  }
}

/**
 * Everything the page shows before it asks for anything: what is installed,
 * which channel this machine follows, whether the daily timer is on, and the
 * state of the last (or current) update run.
 * @param located - resolved checkout.
 * @returns the status payload.
 */
async function readStatus(located) {
  if (located.root === undefined) {
    return { found: false, error: located.error, timer: await timerState() }
  }
  const refFile = join(located.root, 'harness', 'current-ref')
  const conf = await readConf(located.root)
  const install = await installInfo(refFile)
  return {
    found: true,
    root: located.root,
    current: install.ref,
    installedAt: install.installedAt,
    channel: typeof conf.DSH_UPDATE_CHANNEL === 'string' ? conf.DSH_UPDATE_CHANNEL : 'rc',
    autoUpdate: conf.DSH_AUTO_UPDATE === '1' || conf.DSH_AUTO_UPDATE === 'true',
    timer: await timerState(),
    run: await readRun(located.root),
    unit: UPDATE_UNIT,
  }
}

/**
 * Ask the updater whether this channel has something newer. This is the same
 * `--check` a terminal runs: it fetches, resolves the newest tag, compares it
 * with `harness/current-ref`, and builds nothing.
 * @param located - resolved checkout.
 * @returns the script's own report, plus the raw exit status.
 */
async function checkForUpdate(located) {
  if (located.root === undefined) throw new Error(located.error)
  const result = await runCommand(join(located.root, 'bin', 'dsh-sync.sh'), ['--check', '--json'], CHECK_TIMEOUT_MS)
  const report = parseJson(result.stdout)
  if (report === undefined) {
    const detail = firstLine(result.stderr) || `exit ${result.code}`
    throw new Error(`the update check produced no report (${detail})`)
  }
  return { ...report, exitCode: result.code }
}

/**
 * The live view of a run: its progress record and the tail of its log.
 * @param located - resolved checkout.
 * @param payload - `{ lines }` to bound the log tail.
 * @returns the run record and log tail.
 */
async function readProgress(located, payload) {
  if (located.root === undefined) return { run: null, log: '' }
  return {
    run: await readRun(located.root),
    log: await tail(join(located.root, 'harness', 'state', 'update.log'), tailLines(payload, 40)),
  }
}

/**
 * The plugin side of the page: what the manifest declares, and the last (or
 * currently running) plugin update. Reading this touches no network and no
 * remote — the check below is the part that asks.
 * @param located - resolved checkout.
 * @param payload - `{ lines }` to bound the log tail.
 * @returns the last run record and log tail, plus the manifest's own report
 *   when a check has already been made in this process.
 */

/**
 * A run record that still says "running" while its process is gone is a run
 * that never got to write its own ending: `dsh-plugins.service` restarts this
 * harness as its final phase, and that restart kills the writer before it can
 * record `finishedAt`. Such a record is reported as `interrupted` instead of
 * `running`, because the browser disables both card buttons while a run looks
 * live — a record that can never finish would otherwise disable the Plugins
 * card for good.
 * @param run - the parsed state file, or null when there is none.
 * @returns the record with a dead "running" claim settled, otherwise as-is.
 */
function settleRun(run) {
  if (run === null || typeof run !== 'object') return run
  if (run.state !== 'running' || isAlive(run.pid)) return run
  return { ...run, state: 'interrupted', interrupted: true }
}

async function readPluginState(located, payload) {
  if (located.root === undefined) {
    return { found: false, error: located.error, unit: PLUGINS_UNIT, run: null, log: '' }
  }
  const lines = tailLines(payload, 80)
  return {
    found: true,
    script: join(located.root, 'bin', 'dsh-plugins.sh'),
    manifest: join(located.root, 'plugins.conf'),
    unit: PLUGINS_UNIT,
    run: settleRun(await readJsonFile(join(located.root, 'harness', 'state', 'plugins.json'))),
    log: await tail(join(located.root, 'harness', 'state', 'plugins.log'), lines),
  }
}

/**
 * Ask the manifest whether any plugin checkout is behind its remote. This is
 * `bin/dsh-plugins.sh --check`, which only queries remotes: it clones nothing
 * and pulls nothing.
 * @param located - resolved checkout.
 * @returns the script's own report, plus the raw exit status.
 */
async function checkPlugins(located) {
  if (located.root === undefined) throw new Error(located.error)
  const result = await runCommand(join(located.root, 'bin', 'dsh-plugins.sh'), ['--check', '--json'], CHECK_TIMEOUT_MS)
  const report = parseJson(result.stdout)
  if (report === undefined) {
    const detail = firstLine(result.stderr) || `exit ${result.code}`
    throw new Error(`the plugin check produced no report (${detail})`)
  }
  return { ...report, exitCode: result.code }
}

/**
 * Start one plugin update, for the same reason the harness update needs a unit:
 * it ends by restarting this process.
 * @param located - resolved checkout.
 * @param log - diagnostic sink.
 * @returns how the update was started, or that one was already running.
 */
async function startPluginsUpdate(located, log) {
  if (located.root === undefined) throw new Error(located.error)
  const running = await readJsonFile(join(located.root, 'harness', 'state', 'plugins.json'))
  if (running !== null && running.state === 'running' && isAlive(running.pid)) {
    return { started: false, alreadyRunning: true, run: running }
  }

  const unit = await runCommand('systemctl', ['--user', 'start', '--no-block', PLUGINS_UNIT], SYSTEMCTL_TIMEOUT_MS)
  if (unit.ok) return { started: true, via: 'systemd', unit: PLUGINS_UNIT }

  const script = join(located.root, 'bin', 'dsh-plugins.sh')
  const child = spawn(script, ['--update'], { detached: true, stdio: 'ignore', cwd: located.root })
  child.on('error', (error) => {
    log('warn', `detached plugin update failed to start: ${error.message}`)
  })
  child.unref()
  const reason = firstLine(unit.stderr) || `exit ${unit.code}`
  log('warn', `systemd would not start ${PLUGINS_UNIT} (${reason}); ran the plugin updater detached instead`)
  return {
    started: true,
    via: 'detached',
    warning: `systemd would not run ${PLUGINS_UNIT} (${reason}). The plugin update is running detached: it pulls and deploys, but the restart at the end may need to be done by hand.`,
  }
}

/**
 * Start one update, in the only place it can finish: outside this process's
 * cgroup.
 * @param located - resolved checkout.
 * @param log - diagnostic sink.
 * @returns how the update was started, or that one was already running.
 */
async function startUpdate(located, log) {
  if (located.root === undefined) throw new Error(located.error)
  const running = await readRun(located.root)
  if (running !== null && running.state === 'running' && isAlive(running.pid)) {
    return { started: false, alreadyRunning: true, run: running }
  }

  const unit = await runCommand('systemctl', ['--user', 'start', '--no-block', UPDATE_UNIT], SYSTEMCTL_TIMEOUT_MS)
  if (unit.ok) return { started: true, via: 'systemd', unit: UPDATE_UNIT }

  // No systemd (or no unit installed): run the script detached. It still
  // builds, smoke-tests and swaps; only the restart at the end may need a hand,
  // because nothing outside this process can restart a harness that systemd
  // does not own.
  const script = join(located.root, 'bin', 'dsh-sync.sh')
  const child = spawn(script, [], { detached: true, stdio: 'ignore', cwd: located.root })
  child.on('error', (error) => {
    log('warn', `detached update failed to start: ${error.message}`)
  })
  child.unref()
  const reason = firstLine(unit.stderr) || `exit ${unit.code}`
  log('warn', `systemd would not start ${UPDATE_UNIT} (${reason}); ran the updater detached instead`)
  return {
    started: true,
    via: 'detached',
    warning: `systemd would not run ${UPDATE_UNIT} (${reason}). The update is running detached: it builds and deploys, but the restart at the end may need to be done by hand.`,
  }
}

/**
 * Turn the daily timer on or off, and record the choice where every other
 * dsh-ops entry point reads it (`DSH_AUTO_UPDATE` in dsh-ops.conf). Writing the
 * conf is what keeps the answer stable: `dsh-install-assets.sh` applies that
 * value on every later run, so a GUI toggle would otherwise be undone by the
 * next update.
 * @param located - resolved checkout.
 * @param payload - `{ enabled }`.
 * @param log - diagnostic sink.
 * @returns the resulting switch position and timer state.
 */
async function setAutoUpdate(located, payload, log) {
  if (located.root === undefined) throw new Error(located.error)
  const enabled = payload?.enabled === true
  await writeConfKey(located.root, 'DSH_AUTO_UPDATE', enabled ? '1' : '0')
  const verb = enabled ? 'enable' : 'disable'
  const result = await runCommand('systemctl', ['--user', verb, '--now', AUTO_UNIT], SYSTEMCTL_TIMEOUT_MS)
  if (!result.ok) {
    const reason = firstLine(result.stderr) || `exit ${result.code}`
    log('warn', `could not ${verb} ${AUTO_UNIT}: ${reason}`)
    return {
      enabled,
      timer: await timerState(),
      error: `dsh-ops.conf now says DSH_AUTO_UPDATE=${enabled ? 1 : 0}, but systemd would not ${verb} ${AUTO_UNIT} (${reason})`,
    }
  }
  return { enabled, timer: await timerState(), error: null }
}

/** What is installed, read from the ref file the updater writes. */
async function installInfo(refFile) {
  try {
    const [text, info] = await Promise.all([readFile(refFile, 'utf8'), stat(refFile)])
    const ref = text.trim()
    return { ref: ref.length > 0 ? ref : null, installedAt: info.mtime.toISOString() }
  } catch {
    return { ref: null, installedAt: null }
  }
}

/** The progress record `dsh-sync.sh` leaves behind, or null when there is none. */
async function readRun(root) {
  return readJsonFile(join(root, 'harness', 'state', 'update.json'))
}

/** One JSON file, or null when it is missing or malformed. */
async function readJsonFile(path) {
  try {
    return parseJson(await readFile(path, 'utf8')) ?? null
  } catch {
    return null
  }
}

/** How many log lines a caller asked for, clamped. */
function tailLines(payload, fallback) {
  const lines = payload === null || payload === undefined ? undefined : payload.lines
  if (typeof lines !== 'number' || !Number.isFinite(lines) || lines <= 0) return fallback
  return Math.min(lines, 500)
}

/**
 * Read `dsh-ops.conf` without executing it: this plugin runs inside the harness
 * process, and the file is operator-owned shell.
 * @param root - checkout root.
 * @returns the keys this plugin cares about, as strings.
 */
async function readConf(root) {
  const conf = {}
  let text
  try {
    text = await readFile(join(root, 'dsh-ops.conf'), 'utf8')
  } catch {
    return conf
  }
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?(DSH_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (match === null) continue
    conf[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return conf
}

/**
 * Replace one `KEY=value` line in dsh-ops.conf, or append it. Everything else
 * in the file — comments included — is left exactly as it was.
 * @param root - checkout root.
 * @param key - the variable to set.
 * @param value - its new value.
 */
async function writeConfKey(root, key, value) {
  const path = join(root, 'dsh-ops.conf')
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch {
    text = ''
  }
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}=.*$`, 'm')
  if (pattern.test(text)) {
    text = text.replace(pattern, `${key}=${value}`)
  } else {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n'
    text += `# Written by the GUI's Updates page (Settings -> Updates).\n${key}=${value}\n`
  }
  const tmp = `${path}.dsh-ops-tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/** Whether the daily timer is enabled, as systemd reports it right now. */
async function timerState() {
  const result = await runCommand('systemctl', ['--user', 'is-enabled', AUTO_UNIT], SYSTEMCTL_TIMEOUT_MS / 2)
  const value = result.stdout.trim().split('\n')[0]
  if (value === 'enabled' || value === 'disabled') return value
  if (value.length > 0) return value
  return result.ok ? 'unknown' : 'unavailable'
}

/** The last `lines` lines of a file, or an empty string when it is not there. */
async function tail(path, lines) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return ''
  }
  const all = text.split('\n')
  if (all.length > 0 && all[all.length - 1] === '') all.pop()
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

/**
 * Run one command and collect its output. Never rejects: a missing binary, a
 * timeout and a non-zero exit are all answers this plugin reports rather than
 * throws.
 * @param file - executable to run.
 * @param args - its arguments.
 * @param timeout - milliseconds before the child is killed.
 * @returns `{ ok, code, stdout, stderr }`.
 */
function runCommand(file, args, timeout) {
  return new Promise((settle) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      settle({
        ok: error === null,
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      })
    })
  })
}

/** Parse JSON text, or undefined when it is not JSON. */
function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The first non-empty line of a diagnostic, trimmed. */
function firstLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

/** Whether a process id is still running. */
function isAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}
