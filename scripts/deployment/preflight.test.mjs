import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { manifestKey } from './manifest.mjs'
import { preflight } from './preflight.mjs'

const manifestBucket =
  'ieee-hongik-frontend-deployments-015454941458-ap-northeast-2-an'
const originBucket = 'ieee-hongik-frontend-015454941458'
const region = 'ap-northeast-2'
const keys = ['index.html', 'favicon.svg', 'icons.svg']
const asset = 'assets/fonts/brand-Bv_Re-yv.woff2'
const secondAsset = 'assets/second-A1234567.js'
const sha = 'abcdef01'.repeat(5)

function manifest(size = 1) {
  return {
    schemaVersion: 1,
    gitSha: sha,
    runId: '9007199254740993',
    runAttempt: 2,
    completedAt: '2024-02-29T23:59:59.123456Z',
    repository: 'ieee-hongik/frontend',
    ref: 'refs/heads/main',
    originBucket,
    awsRegion: region,
    distributionId: 'E3FJUV685123A4',
    restore: keys.map((key, index) => ({
      key,
      versionId: `version-${key}`,
      contentType: key.endsWith('.svg')
        ? 'image/svg+xml'
        : 'text/html; charset=utf-8',
      cacheControl: 'no-cache, max-age=0',
      etag: `"etag-${index}"`,
      size,
    })),
    hashedAssets: [{ key: asset, etag: 'asset-tag', size: 123 }],
  }
}

function inputFor(value = manifest()) {
  return {
    gitSha: value.gitSha,
    runId: value.runId,
    runAttempt: String(value.runAttempt),
  }
}

function objectKey(value) {
  return `manifests/${value.gitSha}/${value.runId}-${value.runAttempt}.json`
}

function ok(value) {
  return { status: 0, stdout: JSON.stringify(value), stderr: '' }
}

function restoreHead(item, patch = {}) {
  return {
    VersionId: item.versionId,
    ETag: item.etag,
    ContentLength: item.size,
    ContentType: item.contentType,
    CacheControl: item.cacheControl,
    ...patch,
  }
}

function assetHead(item, patch = {}) {
  return {
    ETag: item.etag,
    ContentLength: item.size,
    ContentType: 'application/octet-stream',
    CacheControl: 'public, max-age=31536000',
    VersionId: 'null',
    ...patch,
  }
}

function runner({
  body,
  bodyText,
  heads = [],
  getStatus = 0,
  getStdout = '{"RequestCharged":null}',
  getStderr = '',
}) {
  const calls = []
  const run = (args) => {
    calls.push([...args])
    if (args[1] === 'get-object') {
      if (getStatus === 0)
        writeFileSync(args.at(-1), bodyText ?? JSON.stringify(body))
      return { status: getStatus, stdout: getStdout, stderr: getStderr }
    }
    const head = heads.shift()
    if (!head) throw new Error('origin bucket was called')
    return head
  }
  return { calls, run }
}

async function runPreflight(options) {
  const fake = runner(options)
  const result = await preflight(inputFor(options.body), { run: fake.run })
  return { ...fake, result }
}

function assertNoOriginCall(calls) {
  assert.equal(calls.filter((args) => args[1] === 'head-object').length, 0)
}

function assertTempFileRemoved(calls) {
  const file = calls[0]?.at(-1)
  if (!file) return
  assert.equal(dirname(file), tmpdir())
  assert.equal(existsSync(file), false)
}

test('rejects missing and malformed rollback inputs before AWS', async () => {
  const valid = inputFor()
  for (const [patch, pattern] of [
    [{ gitSha: undefined }, /gitSha/],
    [{ gitSha: 'F'.repeat(40) }, /gitSha/],
    [{ gitSha: 'g'.repeat(40) }, /gitSha/],
    [{ gitSha: sha.slice(0, 39) }, /gitSha/],
    [{ gitSha: sha + '\n' }, /gitSha/],
    [{ runId: undefined }, /runId/],
    [{ runId: 12 }, /runId/],
    [{ runId: '01' }, /runId/],
    [{ runId: '0' }, /runId/],
    [{ runId: '-1' }, /runId/],
    [{ runAttempt: undefined }, /runAttempt/],
    [{ runAttempt: 2 }, /runAttempt/],
    [{ runAttempt: '02' }, /runAttempt/],
    [{ runAttempt: '2.0' }, /runAttempt/],
    [{ runAttempt: '2e1' }, /runAttempt/],
    [{ runAttempt: '2abc' }, /runAttempt/],
    [{ runAttempt: '0' }, /runAttempt/],
    [{ runAttempt: String(2 ** 53) }, /runAttempt/],
    [{ runAttempt: '9007199254740993' }, /runAttempt/],
  ]) {
    let called = false
    await assert.rejects(
      () =>
        preflight(
          { ...valid, ...patch },
          {
            run: () => {
              called = true
            },
          },
        ),
      pattern,
    )
    assert.equal(called, false)
  }
  await assert.rejects(() => preflight(null, { run: () => {} }), /input/)
  assert.notEqual(process.exitCode, 1)
})

test('restores nothing until the exact manifest and every current object agree', async () => {
  const value = manifest()
  value.hashedAssets = [
    { key: asset, etag: 'asset-tag', size: 0 },
    { key: secondAsset, etag: '"quoted-tag"', size: 8 },
  ]
  const heads = [
    ...value.restore.map((item) => ok(restoreHead(item))),
    ...value.hashedAssets.map((item) => ok(assetHead(item))),
  ]
  const { calls, result } = await runPreflight({ body: value, heads })
  const expectedKey = objectKey(value)
  assert.deepEqual(result, { manifestKey: expectedKey, manifest: value })
  assert.equal(manifestKey(result.manifest), expectedKey)
  assert.equal(
    calls.length,
    1 + value.restore.length + value.hashedAssets.length,
  )
  assert.deepEqual(calls[0].slice(0, -1), [
    's3api',
    'get-object',
    '--bucket',
    manifestBucket,
    '--key',
    expectedKey,
    '--region',
    region,
    '--output',
    'json',
  ])
  for (const [index, item] of value.restore.entries()) {
    assert.deepEqual(calls[1 + index], [
      's3api',
      'head-object',
      '--bucket',
      originBucket,
      '--key',
      item.key,
      '--version-id',
      item.versionId,
      '--region',
      region,
      '--output',
      'json',
    ])
  }
  for (const [index, item] of value.hashedAssets.entries()) {
    assert.deepEqual(calls[1 + value.restore.length + index], [
      's3api',
      'head-object',
      '--bucket',
      originBucket,
      '--key',
      item.key,
      '--region',
      region,
      '--output',
      'json',
    ])
  }
  assertTempFileRemoved(calls)
})

test('stops before the origin bucket when the manifest cannot be read or does not match', async () => {
  const value = manifest()
  const cases = [
    {
      name: 'get-object failure',
      options: {
        body: value,
        getStatus: 1,
        getStdout: '{',
        getStderr: ' AccessDenied ',
      },
      pattern: { message: 'manifest: get-object failed: AccessDenied' },
    },
    {
      name: 'command failure without stderr',
      options: { body: value, getStatus: 1, getStdout: '{', getStderr: '  ' },
      pattern: { message: 'manifest: get-object failed' },
    },
    {
      name: 'valid JSON with the wrong shape',
      options: { body: value, getStdout: '[]' },
      pattern: { message: 'manifest: invalid get-object response' },
    },
    {
      name: 'damaged stdout',
      options: { body: value, getStdout: 'not-json' },
      pattern: /invalid get-object response/,
    },
    {
      name: 'damaged body',
      options: { body: value, bodyText: '{' },
      pattern: /invalid manifest JSON/,
    },
    {
      name: 'schema failure',
      options: { body: {} },
      pattern: /missing field/,
    },
    {
      name: 'gitSha mismatch',
      options: { body: { ...value, gitSha: 'b'.repeat(40) } },
      pattern: /gitSha: manifest mismatch/,
    },
    {
      name: 'runId mismatch',
      options: { body: { ...value, runId: '99' } },
      pattern: /runId: manifest mismatch/,
    },
    {
      name: 'runAttempt mismatch',
      options: { body: { ...value, runAttempt: 3 } },
      pattern: /runAttempt: manifest mismatch/,
    },
  ]
  for (const { name, options, pattern } of cases) {
    const fake = runner(options)
    await assert.rejects(
      () => preflight(inputFor(value), { run: fake.run }),
      pattern,
      name,
    )
    assert.equal(fake.calls.length, 1, name)
    assert.equal(fake.calls[0][1], 'get-object', name)
    assertNoOriginCall(fake.calls)
    assertTempFileRemoved(fake.calls)
  }
})

test('stops on the first restore object whose stored version metadata differs', async () => {
  const value = manifest()
  const first = value.restore[0]
  const cases = [
    ['ETag', { ETag: first.etag.slice(1, -1) }, /\.ETag: mismatch/],
    ['ContentLength', { ContentLength: 0 }, /\.ContentLength: mismatch/],
    ['ContentType', { ContentType: 'text/plain' }, /\.ContentType: mismatch/],
    ['CacheControl', { CacheControl: 'no-store' }, /\.CacheControl: mismatch/],
    ['VersionId', { VersionId: 'other-version' }, /\.VersionId: mismatch/],
    ['VersionId null', { VersionId: 'null' }, /\.VersionId: mismatch/],
    ['ContentLength type', { ContentLength: '1' }, /\.ContentLength: mismatch/],
  ]
  for (const [name, patch, pattern] of cases) {
    const fake = runner({
      body: value,
      heads: [ok(restoreHead(first, patch))],
    })
    await assert.rejects(
      () => preflight(inputFor(value), { run: fake.run }),
      pattern,
      name,
    )
    assert.equal(fake.calls.length, 2, name)
    assert.equal(fake.calls[1][1], 'head-object')
    assert.ok(fake.calls[1].includes('--version-id'))
    assert.equal(
      fake.calls[1][fake.calls[1].indexOf('--key') + 1],
      'index.html',
    )
  }
  const missingCache = restoreHead(first)
  delete missingCache.CacheControl
  const fake = runner({ body: value, heads: [ok(missingCache)] })
  await assert.rejects(
    () => preflight(inputFor(value), { run: fake.run }),
    /index\.html\.CacheControl: mismatch/,
  )
  assert.equal(fake.calls.length, 2)
})

test('does not inspect later restore objects after an earlier mismatch', async () => {
  const value = manifest()
  const fake = runner({
    body: value,
    heads: [
      ok(restoreHead(value.restore[0])),
      ok(restoreHead(value.restore[1], { ETag: 'different' })),
    ],
  })
  await assert.rejects(
    () => preflight(inputFor(value), { run: fake.run }),
    /favicon\.svg\.ETag: mismatch/,
  )
  assert.equal(fake.calls.length, 3)
  assert.equal(fake.calls[2][fake.calls[2].indexOf('--key') + 1], 'favicon.svg')
})

test('checks hashed assets without a version id and stops on the first mismatch', async () => {
  const value = manifest()
  value.hashedAssets.push({ key: secondAsset, etag: 'second', size: 4 })
  for (const [name, patch, pattern] of [
    ['etag', { ETag: '"asset-tag"' }, /brand-Bv_Re-yv\.woff2\.ETag: mismatch/],
    ['size', { ContentLength: 1 }, /\.ContentLength: mismatch/],
  ]) {
    const fake = runner({
      body: value,
      heads: [
        ...value.restore.map((item) => ok(restoreHead(item))),
        ok(assetHead(value.hashedAssets[0], patch)),
      ],
    })
    await assert.rejects(
      () => preflight(inputFor(value), { run: fake.run }),
      pattern,
      name,
    )
    const headCalls = fake.calls.filter((args) => args[1] === 'head-object')
    assert.equal(headCalls.length, 4, name)
    assert.equal(headCalls.at(-1).includes('--version-id'), false)
    assert.equal(headCalls.at(-1)[headCalls.at(-1).indexOf('--key') + 1], asset)
  }
})

test('a failed head-object does not continue', async () => {
  const value = manifest()
  const fake = runner({
    body: value,
    heads: [{ status: 1, stdout: '', stderr: 'NotFound' }],
  })
  await assert.rejects(
    () => preflight(inputFor(value), { run: fake.run }),
    /index\.html: head-object failed: NotFound/,
  )
  assert.equal(fake.calls.length, 2)
})

test('CLI rejects missing arguments without calling AWS', () => {
  const cli = fileURLToPath(new URL('./preflight.mjs', import.meta.url))
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
  const missing = run()
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /Usage:/)
  assert.equal(missing.stdout, '')
  const invalid = run('not-a-sha', '01', '2.0')
  assert.equal(invalid.status, 2)
  assert.match(invalid.stderr, /gitSha/)
  assert.equal(invalid.stdout, '')
  const partial = run(sha)
  assert.equal(partial.status, 2)
  assert.match(partial.stderr, /Usage:/)
})
