/**
 * Client-half tests for dsh-ops-updater.
 *
 * The browser half is a bundle, not a module: it registers a factory through
 * `window.__ModuleLoader__`. These tests stand in for that loader and for
 * React, so the page can be exercised in Node — its structure, the slot it
 * registers, the text it shows in each state, and the values the two halves
 * have to agree on: the `/api` route path and the channels the page offers.
 *
 * run: node --test plugins/dsh-ops-updater/test/
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CHANNELS, ROUTE_PATH } from '../index.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/**
 * Load the bundle the way the shell does: a global loader captures the
 * registration, and the factory materialises the plugin on demand.
 *
 * The import is memoized because ESM caches it: a second `import()` of the same
 * URL hands back the module without running the loader call again, exactly as a
 * browser would if the script tag were repeated.
 * @returns the registration `{ id, factory }`.
 */
let bundleRegistration
async function loadBundle() {
  bundleRegistration ??= (async () => {
    let captured
    globalThis.window = {
      __ModuleLoader__: {
        load: (registration) => { captured = registration },
      },
    }
    try {
      await import(new URL('../client.mjs', import.meta.url).href)
    } finally {
      delete globalThis.window
    }
    assert.ok(captured !== undefined, 'the bundle must call window.__ModuleLoader__.load')
    return captured
  })()
  return bundleRegistration
}

/**
 * Initial values a test queues for the page's `useState` calls, in hook order.
 * The real page fills its state from effects, which this stand-in does not run,
 * so a test that wants the loaded page seeds that state instead.
 */
let queuedState = [];

/** The smallest React that can run this page's render path. */
const react = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [
    queuedState.length > 0 ? queuedState.shift() : (typeof initial === 'function' ? initial() : initial),
    () => {},
  ],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}

/** Materialise the plugin from its bundle with the React stand-in. */
function materialise(registration, extraModules = {}) {
  return registration.factory((id) => {
    if (id === 'react') return react
    if (id in extraModules) return extraModules[id]
    throw new Error(`the bundle required an unexpected module: ${id}`)
  })
}

/**
 * Every string a rendered element tree contains.
 *
 * This is the one place the stand-in does real work: `createElement` only
 * builds a description, so a function component is invoked here, which is what
 * makes the page's own branch (`status === null`, loaded, updating…) observable.
 */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') {
    return textOf(node.type({ ...node.props, children: node.children }))
  }
  return textOf(node.children)
}

/** Every element node in a rendered tree, function components invoked. */
function elements(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out)
    return out
  }
  if (typeof node.type === 'function') {
    elements(node.type({ ...node.props, children: node.children }), out)
    return out
  }
  out.push(node)
  elements(node.children, out)
  return out
}
/**
 * Replace every function component in a tree with the element it returns, so
 * the result can be inspected after the state queue is gone.
 */
function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(expand) }
}

/**
 * Render the registered page once and return its tree and text. `state` seeds
 * the page's `useState` calls; with none, the page renders its first paint.
 */
function render(plugin, props = {}, state = []) {
  queuedState = state.slice()
  let registered
  const ctx = {
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => { registered = { options, component } },
    },
  }
  try {
    plugin.apply(ctx)
    assert.ok(registered !== undefined, 'apply must register the Updates section')
    const tree = expand(registered.component(props))
    return { options: registered.options, tree, text: textOf(tree) }
  } finally {
    queuedState = []
  }
}

describe('dsh-ops-updater client half', () => {
  it('registers itself under the package id', async () => {
    const registration = await loadBundle()
    assert.equal(registration.id, 'dsh-ops-updater')
    assert.equal(typeof registration.factory, 'function')
  })

  it('adds one page to the settings sections', async () => {
    const plugin = materialise(await loadBundle())
    assert.deepEqual(plugin.inject, ['slots'])
    const { options } = render(plugin)
    assert.deepEqual(options, { name: 'settings.section', id: 'updates', order: 25, label: 'Updates' })
  })

  it('shows a placeholder while the first status is in flight', async () => {
    const plugin = materialise(await loadBundle())
    const { text } = render(plugin)
    assert.match(text, /Reading the update state/)
  })

  it('agrees with the Host half about the route it calls', async () => {
    const source = readFileSync(join(HERE, '..', 'client.mjs'), 'utf8')
    const declared = /const ROUTE = "([^"]+)"/.exec(source)
    assert.ok(declared !== null, 'the client half must declare its route')
    assert.equal(declared[1], ROUTE_PATH)
  })

  it('agrees with the Host half about the channels it offers', async () => {
    const source = readFileSync(join(HERE, '..', 'client.mjs'), 'utf8')
    const declared = /const CHANNELS = (\[[^\]]+\])/.exec(source)
    assert.ok(declared !== null, 'the client half must declare its channels')
    assert.deepEqual(JSON.parse(declared[1]), CHANNELS)
  })

  it('offers every channel on the loaded page, with the current one selected', async () => {
    const plugin = materialise(await loadBundle())
    const status = {
      found: true,
      root: '/tmp/dsh-ops',
      current: 'dsh-v0.1.5-rc.2',
      installedAt: '2026-01-02T03:04:05Z',
      channel: 'rc',
      autoUpdate: false,
      timer: 'disabled',
      run: null,
      unit: 'dsh-update.service',
    }
    const { tree, text } = render(plugin, {}, [status])
    const select = elements(tree).find((element) => element.type === 'select')
    assert.ok(select !== undefined, 'the loaded page must draw a channel selector')
    assert.equal(select.props.value, 'rc')
    assert.deepEqual(
      elements(select).filter((element) => element.type === 'option').map((option) => option.props.value),
      CHANNELS,
    )
    assert.match(text, /alpha prereleases skipped/)
  })

  it('stays inert: one endpoint, no privileged module of its own', async () => {
    const source = readFileSync(join(HERE, '..', 'client.mjs'), 'utf8')
    // This bundle is served off /plugins, which carries no fence, so it must
    // stay a page: the only host contact is the single /api route the Host half
    // registers, and nothing here runs on the machine.
    assert.equal((source.match(/fetch\(/g) ?? []).length, 1, 'exactly one fetch call')
    assert.ok(!/require\(["']node:/.test(source), 'no Node modules in the browser half')
    assert.ok(!/child_process|execFile|spawn\(/.test(source), 'no process spawning in the browser half')
  })
})
