# dsh-ops-updater

The **Settings → Updates** page for a [dsh-ops](https://github.com/Fruffel/dsh-ops)
deployment: what release is installed, one button to ask the channel whether
there is something newer, one to install it, and a switch for a nightly sync.

It is a DSH plugin with both halves — a Host half that runs the deployment's own
updaters and a browser half that draws the page — and it lives in its own
repository because it is the *page*; the pipelines it drives belong to dsh-ops
(`bin/dsh-sync.sh`, `bin/dsh-plugins.sh`, and the two systemd units).

## Install

dsh-ops discovers every package under its `plugins/` directory, so a plugin is
installed by putting it there:

```sh
cd /path/to/dsh-ops
git clone https://github.com/<you>/dsh-ops-updater plugins/dsh-ops-updater
./bin/dsh-install-assets.sh     # copies the package into the profile layer
systemctl --user restart dsh-web # mounts its row (rows mount at boot)
```

Then reload the GUI and open **Settings → Updates**. The row that mounts it lives
in dsh-ops' `harness/cordis.patch.web.yml`; it is the only thing dsh-ops needs to
know about this package.

Requirements: a dsh-ops checkout whose `bin/dsh-sync.sh` and
`bin/dsh-plugins.sh` understand `--check`, plus `dsh-update.service` and
`dsh-plugins.service` installed (both come from `bin/dsh-install-assets.sh`).

## What the page does

* **Installed** — the release `harness/current-ref` names, and when it landed.
* **Channel** — `DSH_UPDATE_CHANNEL` from `dsh-ops.conf` (`rc`, `stable`, `latest`).
* **Check for updates** — runs `bin/dsh-sync.sh --check --json`. It fetches tags
  and compares; it builds and restarts nothing.
* **Install `<tag>`** — starts `dsh-update.service`: build → smoke test on an
  OS-assigned port → swap → restart. The page follows the run's phase, message
  and log, and the harness reconnects on its own afterwards.
* **Update automatically every night (03:00)** — writes `DSH_AUTO_UPDATE` in
  `dsh-ops.conf` and enables/disables `dsh-update.timer`, so the choice survives
  later updates instead of being reverted by the next one.

### The Plugins card

dsh-ops installs its plugins from a manifest, not from code in the repository:
`plugins.conf` (plus the machine-local `plugins.local.conf`) names plugin
repositories, and `bin/dsh-plugins.sh` checks them out into the git-ignored
`plugins/`. That card drives the same script:

* **Check plugins** — asks each checkout's remote whether it is behind
  (`git ls-remote`; nothing is fetched, cloned or pulled).
* **Update plugins** — starts `dsh-plugins.service`: fast-forward each checkout,
  refresh the profile layer, restart the harness. A checkout with local changes
  is reported and left alone, and a run that changes nothing does not restart
  anything.
* Each entry shows the manifest it came from, the commit it is on, and where its
  remote is, so an unmanaged checkout (no origin) says so instead of looking
  current.

## How the halves talk

One exact `/api` route (`ctx.connection.fetch.register`), POSTed to as
`{ "endpoint": "...", "payload": {...} }`. Registering it on `/api` is the whole
point: that path is served by dsh-client-connection, so the deployment's
Host/Origin fence (loopback, every bind-derived IP literal, `trustedHosts`) and
the signed browser cookie are applied **before** the handler runs. A route
registered directly on `ctx.webServer` gets neither, which is not something to
put in front of "install a release".

Endpoints: `status`, `check`, `progress`, `update`, `auto` for the harness, and
`plugins`, `pluginsCheck`, `pluginsUpdate` for the manifest.

## Where the checkout is

The Host half finds the dsh-ops checkout by itself: `opsPath` on its row, then
`DSH_OPS_HOME`, then the working directory and its parents (the service runs with
`WorkingDirectory=<ops>/harness/current`), then the `WorkingDirectory` rendered
into `dsh-web.service`. Pin it on the row when none of those fit:

```yaml
- insert:
    - id: dsh-ops-updater
      name: ./dsh-ops-updater/index.mjs
      config:
        opsPath: /path/to/dsh-ops
```

## Tests

```sh
npm test
```

The suites drive the real Host half against a fake checkout and render the
browser half through a stand-in loader and React. They never reach the machine:
`systemctl` is stubbed on `PATH`, so running them cannot start the real
`dsh-update.service` (which would restart the harness running the tests).

## Layout

| Path | What |
| --- | --- |
| `index.mjs` | Host half: the `/api` route, the updater calls, `dsh-ops.conf` edits |
| `client.mjs` | Browser half: the settings page (a `window.__ModuleLoader__` bundle) |
| `test/host.test.mjs` | Host endpoints against a fake dsh-ops checkout |
| `test/client.test.mjs` | Bundle load, slot registration, first render, route agreement |
