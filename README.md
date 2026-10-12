# dsh-ops-updater

The **Settings → Updates** page for a [dsh-ops](https://github.com/Fruffel/dsh-ops)
deployment: what release is installed, one button to ask the channel whether
there is something newer, one to install it, and a switch for a nightly sync.

It is a DSH plugin with both halves — a Host half that runs the deployment's
updater and a browser half that draws the page — and it lives in its own
repository because it is the *page*; the pipeline it drives belongs to dsh-ops
(`bin/dsh-sync.sh` and `dsh-update.service`).

## Install

dsh-ops mounts exactly the plugin checkouts its `plugins.conf` declares, and the
updater is one of them, so installation is the manifest plus the standard asset
step:

```sh
cd /path/to/dsh-ops
./bin/dsh-plugins.sh --install   # clones plugins.conf's checkouts, this one included
./bin/dsh-install-assets.sh      # copies the package into the profile layer
systemctl --user restart dsh-web # mounts its row (rows mount at boot)
```

Then reload the GUI and open **Settings → Updates**. The row that mounts it is
generated from this package's own `package.json`; that and the manifest line are
the only things dsh-ops needs to know about this package.

Requirements: a dsh-ops checkout whose `bin/dsh-sync.sh` understands `--check`,
plus `dsh-update.service` installed (both come from
`bin/dsh-install-assets.sh`). Plugins other than this page are the harness's own
plugin manager's business, not dsh-ops'.

## What the page does

* **Installed** — the release `harness/current-ref` names, and when it landed.
* **Channel** — a selector for what this machine follows, written to
  `DSH_UPDATE_CHANNEL` in `dsh-ops.conf` so the page, the nightly timer and a
  terminal cannot disagree. `rc` skips alpha prereleases, `alpha` follows the
  newest `x.y.z-alpha.n`, `stable` takes plain `x.y.z`, and `latest` takes the
  newest tag of any kind. Switching re-runs the check immediately. The
  `alpha` choice needs a dsh-ops whose `bin/dsh-sync.sh` knows that channel;
  an older checkout answers the next check with `unknown channel: alpha`.
* **Check for updates** — runs `bin/dsh-sync.sh --check --json`. It fetches tags
  and compares; it builds and restarts nothing.
* **Install `<tag>`** — starts `dsh-update.service`: build → smoke test on an
  OS-assigned port → swap → restart. The page follows the run's phase, message
  and log, and the harness reconnects on its own afterwards.
* **Update automatically every night (03:00)** — writes `DSH_AUTO_UPDATE` in
  `dsh-ops.conf` and enables/disables `dsh-update.timer`, so the choice survives
  later updates instead of being reverted by the next one.

## How the halves talk

One exact `/api` route (`ctx.connection.fetch.register`), POSTed to as
`{ "endpoint": "...", "payload": {...} }`. Registering it on `/api` is the whole
point: that path is served by dsh-client-connection, so the deployment's
Host/Origin fence (loopback, every bind-derived IP literal, `trustedHosts`) and
the signed browser cookie are applied **before** the handler runs. A route
registered directly on `ctx.webServer` gets neither, which is not something to
put in front of "install a release".

Endpoints: `status`, `check`, `progress`, `update`, `auto`, `channel`.

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
