import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { manifestKey } from './manifest.mjs'
import { verifyRollback } from './rollback-verify.mjs'

const originBucket = 'ieee-hongik-frontend-015454941458'
const region = 'ap-northeast-2'
const distributionId = 'E3FJUV685123A4'
const cloudfrontDomain = 'dm3mb697l7lxs.cloudfront.net'
const parameterName = '/ieee/frontend/production/deploy-state'
const invalidationId = 'IDFDVBD632BHDS5'
const manifestOrder = ['index.html', 'icons.svg', 'favicon.svg']
const restoreOrder = ['favicon.svg', 'icons.svg', 'index.html']
const asset = 'assets/fonts/brand-Bv_Re-yv.woff2'
const secondAsset = 'assets/second-A1234567.js'
const sha = 'abcdef01'.repeat(5)
const versions = {
  'favicon.svg': 'fav&%2F+A/B=?',
  'icons.svg': 'ico?versionId=x',
  'index.html': 'idx+1/2=',
}
const allowedCommands = new Set([
  'ssm get-parameter',
  's3api head-object',
  's3api get-object',
  'cloudfront create-invalidation',
  'cloudfront wait invalidation-completed',
])

function defaultBodies() {
  return new Map([
    [
      'favicon.svg',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" id="favicon"></svg>',
      ),
    ],
    [
      'icons.svg',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" id="icons"></svg>'),
    ],
    [
      'index.html',
      Buffer.from(
        '<!doctype html><html><body><div id="root"></div></body></html>',
      ),
    ],
    [asset, Buffer.from('woff2-binary-content')],
    [secondAsset, Buffer.alloc(0)],
  ])
}

function manifest(bodies) {
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
    distributionId,
    restore: manifestOrder.map((key, index) => ({
      key,
      versionId: versions[key],
      contentType: key.endsWith('.svg')
        ? 'image/svg+xml'
        : 'text/html; charset=utf-8',
      cacheControl: 'no-cache, max-age=0',
      etag: `"etag-${index}"`,
      size: bodies.get(key).length,
    })),
    hashedAssets: [
      { key: asset, etag: 'asset-tag', size: bodies.get(asset).length },
      {
        key: secondAsset,
        etag: '"quoted-tag"',
        size: bodies.get(secondAsset).length,
      },
    ],
  }
}

function completed(value) {
  return {
    manifestKey: manifestKey(value),
    manifest: value,
    deployState: 'closed',
    restored: [...restoreOrder],
  }
}

function ok(value) {
  return { status: 0, stdout: JSON.stringify(value), stderr: '' }
}

function parameter(value, patch = {}) {
  return ok({
    Parameter: {
      Name: parameterName,
      Type: 'String',
      Value: value,
      Version: 7,
      ...patch,
    },
  })
}

function restoredHead(item, patch = {}) {
  return ok({
    ContentType: item.contentType,
    CacheControl: item.cacheControl,
    ContentLength: item.size,
    ETag: 'W/"copied-object"',
    VersionId: `copied-${item.key}`,
    ...patch,
  })
}

function assetHead(item, patch = {}) {
  return ok({
    ETag: item.etag,
    ContentLength: item.size,
    VersionId: `asset-${item.key}`,
    ...patch,
  })
}

function objectResponse(meta, body) {
  return { status: 0, stdout: JSON.stringify(meta), stderr: '', body }
}

function versionObject(item, body) {
  return objectResponse(
    {
      ContentLength: item.size,
      ContentType: item.contentType,
      CacheControl: item.cacheControl,
      ETag: item.etag,
      VersionId: item.versionId,
    },
    body,
  )
}

function currentObject(item, body) {
  // CopyObject gives restored files a new ETag. Hashed assets keep theirs.
  if (!Object.hasOwn(item, 'contentType')) {
    return objectResponse(
      {
        ContentLength: item.size,
        ETag: item.etag,
        VersionId: `asset-${item.key}`,
      },
      body,
    )
  }
  return objectResponse(
    {
      ContentLength: item.size,
      ContentType: item.contentType,
      CacheControl: item.cacheControl,
      ETag: 'W/"copied-object"',
      VersionId: `copied-${item.key}`,
    },
    body,
  )
}

function withMeta(response, patch, body = response.body) {
  return objectResponse({ ...JSON.parse(response.stdout), ...patch }, body)
}

function invalidation(patch = {}) {
  const body = {
    Location: `https://cloudfront.amazonaws.com/2020-05-31/distribution/${distributionId}/invalidation/${patch.Id ?? invalidationId}`,
    Invalidation: {
      Id: patch.Id ?? invalidationId,
      Status: 'InProgress',
      InvalidationBatch: {
        Paths: {
          Quantity: patch.Quantity ?? 1,
          Items: patch.Items ?? ['/*'],
        },
        CallerReference: 'cli',
      },
    },
  }
  if (patch.dropInvalidation) delete body.Invalidation
  if (patch.missingId) delete body.Invalidation.Id
  return ok(body)
}

function live(body, init = {}) {
  return new Response(body, { status: 200, ...init })
}

function successParts(value, bodies) {
  const heads = []
  const objects = []
  const responses = []
  for (const key of restoreOrder) {
    const item = value.restore.find((entry) => entry.key === key)
    heads.push(restoredHead(item))
    objects.push(versionObject(item, bodies.get(key)))
    objects.push(currentObject(item, bodies.get(key)))
  }
  for (const key of ['index.html', 'index.html', 'favicon.svg', 'icons.svg'])
    responses.push(live(bodies.get(key)))
  for (const item of value.hashedAssets) {
    heads.push(assetHead(item))
    objects.push(currentObject(item, bodies.get(item.key)))
    responses.push(live(bodies.get(item.key)))
  }
  return {
    parameters: [parameter('closed')],
    heads,
    objects,
    invalidations: [invalidation()],
    waits: [{ status: 0, stdout: '', stderr: '' }],
    responses,
  }
}

function commandName(args) {
  if (args[0] === 'cloudfront' && args[1] === 'wait')
    return `cloudfront wait ${args[2]}`
  return `${args[0]} ${args[1]}`
}

function runner({
  parameters = [],
  heads = [],
  objects = [],
  invalidations = [],
  waits = [],
  responses = [],
}) {
  const calls = []
  const requests = []
  const trace = []
  const queues = {
    'ssm get-parameter': [...parameters],
    's3api head-object': [...heads],
    's3api get-object': [...objects],
    'cloudfront create-invalidation': [...invalidations],
    'cloudfront wait invalidation-completed': [...waits],
  }
  const run = (args) => {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
      throw new Error('aws arguments must be strings')
    calls.push([...args])
    const name = commandName(args)
    trace.push(['aws', name])
    const queue = queues[name]
    if (!queue) throw new Error(`unexpected command ${name}`)
    const response = queue.shift()
    if (!response) throw new Error(`unexpected extra ${name}`)
    if (name === 's3api get-object' && response.status === 0)
      writeFileSync(args.at(-1), response.body ?? Buffer.alloc(0))
    return {
      status: response.status,
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
    }
  }
  const fetch = async (url, init) => {
    requests.push({ url, init })
    trace.push(['http', url])
    const response = responses.shift()
    if (!response) throw new Error(`unexpected fetch ${url}`)
    if (typeof response === 'function') return response(url, init)
    return response
  }
  return { calls, requests, trace, run, fetch }
}

function attempt(overrides = {}) {
  const bodies = overrides.bodies ?? defaultBodies()
  const value = overrides.body ?? manifest(bodies)
  const parts = successParts(value, bodies)
  const fake = runner({
    parameters: overrides.parameters ?? parts.parameters,
    heads: overrides.heads ?? parts.heads,
    objects: overrides.objects ?? parts.objects,
    invalidations: overrides.invalidations ?? parts.invalidations,
    waits: overrides.waits ?? parts.waits,
    responses: overrides.responses ?? parts.responses,
  })
  const options = { run: fake.run, fetch: overrides.fetch ?? fake.fetch }
  if (overrides.timeoutMs !== undefined) options.timeoutMs = overrides.timeoutMs
  return {
    ...fake,
    value,
    bodies,
    parts,
    promise: verifyRollback(overrides.result ?? completed(value), options),
  }
}

function flag(args, name) {
  const index = args.indexOf(name)
  assert.notEqual(index, -1, `${name} in ${args.join(' ')}`)
  return args[index + 1]
}

function parameterArgs() {
  return [
    'ssm',
    'get-parameter',
    '--name',
    parameterName,
    '--region',
    region,
    '--output',
    'json',
  ]
}

function headArgs(key) {
  return [
    's3api',
    'head-object',
    '--bucket',
    originBucket,
    '--key',
    key,
    '--region',
    region,
    '--output',
    'json',
  ]
}

function assertGet(args, key, versionId) {
  const expected = [
    's3api',
    'get-object',
    '--bucket',
    originBucket,
    '--key',
    key,
  ]
  if (versionId !== undefined) expected.push('--version-id', versionId)
  expected.push('--region', region, '--output', 'json')
  assert.deepEqual(args.slice(0, -1), expected)
  assert.equal(dirname(args.at(-1)), tmpdir())
}

function createArgs() {
  return [
    'cloudfront',
    'create-invalidation',
    '--distribution-id',
    distributionId,
    '--paths',
    '/*',
    '--region',
    region,
    '--output',
    'json',
  ]
}

function waitArgs(id) {
  return [
    'cloudfront',
    'wait',
    'invalidation-completed',
    '--distribution-id',
    distributionId,
    '--id',
    id,
    '--region',
    region,
  ]
}

function assertNoMutation(calls) {
  for (const args of calls) {
    assert.equal(
      args.every((arg) => typeof arg === 'string'),
      true,
    )
    assert.ok(allowedCommands.has(commandName(args)), args.join(' '))
    assert.equal(args.includes('--value'), false)
    assert.equal(args[1] === 'put-parameter', false)
    assert.equal(args[1] === 'copy-object', false)
    assert.equal(args[1] === 'delete-object', false)
    assert.equal(args[1] === 'put-object', false)
  }
}

function assertNoHttp(trace) {
  assert.equal(
    trace.some((event) => event[0] === 'http'),
    false,
  )
}

function assertTempFilesRemoved(calls) {
  for (const args of calls) {
    if (args[1] !== 'get-object') continue
    assert.equal(dirname(args.at(-1)), tmpdir())
    assert.equal(existsSync(args.at(-1)), false)
  }
}

function assertRequest(entry, pathname) {
  const url = new URL(entry.url)
  assert.equal(url.protocol, 'https:')
  assert.equal(url.host, cloudfrontDomain)
  assert.equal(decodeURIComponent(url.pathname), pathname)
  assert.equal(url.search, '')
  assert.equal(url.hash, '')
  assert.equal(entry.init.method, 'GET')
  assert.equal(entry.init.redirect, 'manual')
  assert.equal(entry.init.cache, 'no-store')
  assert.equal(entry.init.headers['accept-encoding'], 'identity')
  assert.equal(typeof entry.init.signal, 'object')
  assert.equal(entry.init.signal.aborted, false)
}

function assertSuccessAws(calls, value) {
  let index = 0
  assert.deepEqual(calls[index], parameterArgs())
  index += 1
  for (const key of restoreOrder) {
    const item = value.restore.find((entry) => entry.key === key)
    assert.deepEqual(calls[index], headArgs(key), key)
    index += 1
    assertGet(calls[index], key, item.versionId)
    index += 1
    assertGet(calls[index], key)
    index += 1
  }
  assert.deepEqual(calls[index], createArgs())
  index += 1
  assert.deepEqual(calls[index], waitArgs(invalidationId))
  index += 1
  for (const item of value.hashedAssets) {
    assert.deepEqual(calls[index], headArgs(item.key), item.key)
    index += 1
    assertGet(calls[index], item.key)
    index += 1
  }
  assert.equal(calls.length, index)
  assert.equal(calls.filter((args) => args[1] === 'get-parameter').length, 1)
  assert.equal(
    calls.filter((args) => args[1] === 'create-invalidation').length,
    1,
  )
  assert.equal(calls.filter((args) => args[1] === 'wait').length, 1)
}

async function rejects(overrides, pattern, options = {}) {
  const fake = attempt(overrides)
  await assert.rejects(fake.promise, pattern)
  assertNoMutation(fake.calls)
  assertTempFilesRemoved(fake.calls)
  if (!options.http) assertNoHttp(fake.trace)
  return fake
}

test('rejects an incomplete rollback before calling AWS or CloudFront', async () => {
  const bodies = defaultBodies()
  const value = manifest(bodies)
  const done = completed(value)
  let called = false
  const run = () => {
    called = true
  }
  const fetch = () => {
    called = true
  }
  const cases = [
    [null, /rollback: expected an object/],
    [{ ...done, manifest: {} }, /missing field/],
    [{ ...done, manifestKey: 'manifests/wrong.json' }, /object key mismatch/],
    [{ ...done, deployState: 'open' }, /deploy-state: not closed/],
    [{ ...done, deployState: `allow:${sha}` }, /deploy-state: not closed/],
    [
      { ...done, restored: ['index.html', 'icons.svg', 'favicon.svg'] },
      /index\.html: unexpected restore key/,
    ],
    [
      { ...done, restored: ['favicon.svg', 'evil.svg', 'index.html'] },
      /evil\.svg: unexpected restore key/,
    ],
    [
      { ...done, restored: ['favicon.svg', 'icons.svg'] },
      /restore: unexpected restore key/,
    ],
    [
      { ...done, restored: [...restoreOrder, 'extra.js'] },
      /extra\.js: unexpected restore key/,
    ],
  ]
  for (const [input, pattern] of cases) {
    called = false
    await assert.rejects(() => verifyRollback(input, { run, fetch }), pattern)
    assert.equal(called, false)
  }

  const drifted = manifest(bodies)
  drifted.distributionId = 'EWRONGDISTRIBUTION'
  await assert.rejects(
    () => verifyRollback({ ...done, manifest: drifted }, { run, fetch }),
    /distributionId: unexpected value/,
  )
  const extra = manifest(bodies)
  extra.note = 'nope'
  await assert.rejects(
    () => verifyRollback({ ...done, manifest: extra }, { run, fetch }),
    /unknown field/,
  )
  const badAsset = manifest(bodies)
  badAsset.hashedAssets = [{ key: 'secret.txt', etag: 'x', size: 1 }]
  await assert.rejects(
    () => verifyRollback({ ...done, manifest: badAsset }, { run, fetch }),
    /invalid string/,
  )
  const duplicate = manifest(bodies)
  duplicate.restore = duplicate.restore.map((item) =>
    item.key === 'favicon.svg' ? { ...item, key: 'index.html' } : item,
  )
  await assert.rejects(
    () => verifyRollback({ ...done, manifest: duplicate }, { run, fetch }),
    /duplicate object key/,
  )
  assert.equal(called, false)
})

test('stops when the freeze cannot be confirmed closed', async () => {
  const cases = [
    [
      { status: 1, stdout: '', stderr: 'AccessDenied' },
      /deploy-state: confirm: get-parameter failed: AccessDenied/,
    ],
    [
      { status: 0, stdout: '{', stderr: '' },
      /deploy-state: confirm: invalid get-parameter response/,
    ],
    [parameter('open'), /deploy-state: confirm: not closed/],
    [parameter(`allow:${'b'.repeat(40)}`), /deploy-state: confirm: not closed/],
    [parameter('OPEN'), /deploy-state: confirm: unexpected state/],
    [parameter('closed '), /deploy-state: confirm: unexpected state/],
    [
      parameter('closed', { Type: 'SecureString' }),
      /deploy-state: confirm: unexpected type/,
    ],
    [
      parameter('closed', { Name: '/other' }),
      /deploy-state: confirm: unexpected parameter/,
    ],
  ]
  for (const [name, response, pattern] of cases.map((item, index) => [
    index,
    ...item,
  ])) {
    const fake = await rejects(
      {
        parameters: [response],
        heads: [],
        objects: [],
        invalidations: [],
        waits: [],
      },
      pattern,
    )
    assert.equal(fake.calls.length, 1, String(name))
    assert.deepEqual(fake.calls[0], parameterArgs(), String(name))
    assert.equal(
      fake.calls.some((args) => args[0] === 'cloudfront'),
      false,
    )
    assert.equal(
      fake.calls.some((args) => args[0] === 's3api'),
      false,
    )
  }
})

test('verifies restored bytes, invalidates once, then checks HTML, SVG, hashed, and empty assets', async () => {
  const bodies = defaultBodies()
  const value = manifest(bodies)
  assert.equal(value.hashedAssets[1].size, 0)
  assert.deepEqual(
    value.restore.map((item) => item.key),
    manifestOrder,
  )
  const fake = attempt({ body: value, bodies })
  const favicon = value.restore.find((item) => item.key === 'favicon.svg')
  const head = JSON.parse(fake.parts.heads[0].stdout)
  const current = JSON.parse(fake.parts.objects[1].stdout)
  assert.equal(fake.parts.heads[0] && head.ETag !== favicon.etag, true)
  assert.notEqual(head.VersionId, favicon.versionId)
  assert.notEqual(current.VersionId, favicon.versionId)
  assert.notEqual(current.ETag, favicon.etag)
  for (const [offset, item] of value.hashedAssets.entries()) {
    const meta = JSON.parse(fake.parts.objects[6 + offset].stdout)
    assert.equal(meta.ETag, item.etag, item.key)
    assert.equal(meta.ContentLength, item.size, item.key)
  }
  const result = await fake.promise
  assert.equal(result.deployState, 'closed')
  assert.equal(result.distributionId, distributionId)
  assert.equal(result.invalidationId, invalidationId)
  assert.equal(result.manifestKey, manifestKey(value))
  assert.deepEqual(result.verified, [
    '/index.html',
    '/',
    '/favicon.svg',
    '/icons.svg',
    `/${asset}`,
    `/${secondAsset}`,
  ])
  assertSuccessAws(fake.calls, value)
  assertNoMutation(fake.calls)
  assertTempFilesRemoved(fake.calls)
  const paths = [
    '/index.html',
    '/',
    '/favicon.svg',
    '/icons.svg',
    `/${asset}`,
    `/${secondAsset}`,
  ]
  assert.deepEqual(
    fake.requests.map((entry) =>
      decodeURIComponent(new URL(entry.url).pathname),
    ),
    paths,
  )
  for (const [index, pathname] of paths.entries())
    assertRequest(fake.requests[index], pathname)
  const expectedTrace = [['aws', 'ssm get-parameter']]
  for (const key of restoreOrder) {
    assert.ok(key)
    expectedTrace.push(
      ['aws', 's3api head-object'],
      ['aws', 's3api get-object'],
      ['aws', 's3api get-object'],
    )
  }
  expectedTrace.push(
    ['aws', 'cloudfront create-invalidation'],
    ['aws', 'cloudfront wait invalidation-completed'],
  )
  for (const pathname of paths.slice(0, 4))
    expectedTrace.push(['http', `https://${cloudfrontDomain}${pathname}`])
  for (const key of [asset, secondAsset]) {
    expectedTrace.push(
      ['aws', 's3api head-object'],
      ['aws', 's3api get-object'],
      ['http', `https://${cloudfrontDomain}/${key}`],
    )
  }
  assert.deepEqual(fake.trace, expectedTrace)
  const waitAt = fake.trace.findIndex(
    (event) => event[1] === 'cloudfront wait invalidation-completed',
  )
  assert.ok(waitAt > 0)
  for (const [index, event] of fake.trace.entries()) {
    if (event[0] === 'http') assert.ok(index > waitAt)
  }
})

test('stops when restored bytes differ and does not write SSM or copy S3', async () => {
  const bodies = defaultBodies()
  const value = manifest(bodies)
  const parts = successParts(value, bodies)
  const flipped = Buffer.from(bodies.get('icons.svg'))
  flipped[0] ^= 0xff
  assert.equal(flipped.length, bodies.get('icons.svg').length)
  const objects = parts.objects.slice()
  const item = value.restore.find((entry) => entry.key === 'icons.svg')
  objects[3] = currentObject(item, flipped)
  const fake = await rejects(
    { body: value, bodies, objects },
    /icons\.svg: content mismatch/,
  )
  assert.deepEqual(fake.calls.map(commandName), [
    'ssm get-parameter',
    's3api head-object',
    's3api get-object',
    's3api get-object',
    's3api head-object',
    's3api get-object',
    's3api get-object',
  ])
  assert.equal(flag(fake.calls[5], '--version-id'), versions['icons.svg'])
  assert.equal(fake.calls[6].includes('--version-id'), false)
  assert.equal(
    fake.calls.some((args) => args.includes('index.html')),
    false,
  )
  assert.equal(
    fake.calls.some((args) => args[0] === 'cloudfront'),
    false,
  )
})

test('stops when restored metadata differs and does not invalidate', async () => {
  const bodies = defaultBodies()
  const value = manifest(bodies)
  const favicon = value.restore.find((item) => item.key === 'favicon.svg')
  const cases = [
    [{ ContentType: 'text/plain' }, /favicon\.svg\.ContentType: mismatch/],
    [{ CacheControl: 'no-store' }, /favicon\.svg\.CacheControl: mismatch/],
    [
      { ContentLength: favicon.size + 1 },
      /favicon\.svg\.ContentLength: mismatch/,
    ],
    [
      { ContentLength: String(favicon.size) },
      /favicon\.svg\.ContentLength: mismatch/,
    ],
    [{ CacheControl: undefined }, /favicon\.svg\.CacheControl: mismatch/],
  ]
  for (const [patch, pattern] of cases) {
    const fake = await rejects(
      {
        body: value,
        bodies,
        heads: [restoredHead(favicon, patch)],
        objects: [],
        invalidations: [],
        waits: [],
      },
      pattern,
    )
    assert.equal(fake.calls.length, 2)
    assert.deepEqual(fake.calls[1], headArgs('favicon.svg'))
    assert.equal(
      fake.calls.some((args) => args[0] === 'cloudfront'),
      false,
    )
    assert.equal(
      fake.calls.some((args) => args[1] === 'get-object'),
      false,
    )
  }
})

test('stops when a restored object or its source version cannot be read', async () => {
  const bodies = defaultBodies()
  const value = manifest(bodies)
  const parts = successParts(value, bodies)
  const missingHead = await rejects(
    {
      body: value,
      bodies,
      heads: [{ status: 1, stdout: '', stderr: 'NotFound' }],
      objects: [],
      invalidations: [],
      waits: [],
    },
    /favicon\.svg: head-object failed: NotFound/,
  )
  assert.equal(missingHead.calls.length, 2)

  const missingVersionObjects = parts.objects.slice()
  missingVersionObjects[0] = { status: 1, stdout: '', stderr: 'NoSuchVersion' }
  const missingVersion = await rejects(
    { body: value, bodies, objects: missingVersionObjects },
    /favicon\.svg: version: get-object failed: NoSuchVersion/,
  )
  assert.equal(missingVersion.calls.length, 3)
  assert.equal(
    flag(missingVersion.calls[2], '--version-id'),
    versions['favicon.svg'],
  )

  const badVersion = parts.objects.slice()
  const parsed = JSON.parse(badVersion[0].stdout)
  parsed.VersionId = 'other-version'
  badVersion[0] = { ...badVersion[0], stdout: JSON.stringify(parsed) }
  const unexpected = await rejects(
    { body: value, bodies, objects: badVersion },
    /favicon\.svg: unexpected version/,
  )
  assert.equal(unexpected.calls.length, 3)
  assert.equal(
    unexpected.calls.some((args) => args[0] === 'cloudfront'),
    false,
  )

  const missingCurrent = parts.objects.slice()
  missingCurrent[1] = { status: 1, stdout: '', stderr: 'NoSuchKey' }
  const current = await rejects(
    { body: value, bodies, objects: missingCurrent },
    /favicon\.svg: current: get-object failed: NoSuchKey/,
  )
  assert.equal(current.calls.length, 4)
  assert.equal(current.calls[3].includes('--version-id'), false)
})

test('stops when invalidation cannot be created and does not fetch', async () => {
  const fake = await rejects(
    {
      invalidations: [{ status: 1, stdout: '', stderr: 'AccessDenied' }],
      waits: [],
      responses: [],
    },
    /cloudfront: create-invalidation failed: AccessDenied/,
  )
  assert.deepEqual(fake.calls.at(-1), createArgs())
  assert.equal(fake.calls.filter((args) => args[1] === 'wait').length, 0)
  assert.equal(fake.requests.length, 0)
  const damaged = await rejects(
    {
      invalidations: [{ status: 0, stdout: '{', stderr: '' }],
      waits: [],
      responses: [],
    },
    /cloudfront: invalid create-invalidation response/,
  )
  assert.equal(damaged.calls.filter((args) => args[1] === 'wait').length, 0)
  assert.equal(damaged.requests.length, 0)
})

test('stops when the invalidation id or path is invalid and does not wait or fetch', async () => {
  const cases = [
    [
      invalidation({ dropInvalidation: true }),
      /cloudfront: invalid create-invalidation response/,
    ],
    [invalidation({ missingId: true }), /cloudfront: invalid invalidation id/],
    [invalidation({ Id: '' }), /cloudfront: invalid invalidation id/],
    [invalidation({ Id: 'I123' }), /cloudfront: invalid invalidation id/],
    [
      invalidation({ Id: 'idfdvbd632bhds5' }),
      /cloudfront: invalid invalidation id/,
    ],
    [
      invalidation({ Id: 'IDFDVBD632BHDS5/../x' }),
      /cloudfront: invalid invalidation id/,
    ],
    [
      invalidation({ Items: ['/index.html'] }),
      /cloudfront: unexpected invalidation path/,
    ],
    [
      invalidation({ Items: ['*'] }),
      /cloudfront: unexpected invalidation path/,
    ],
    [
      invalidation({ Items: ['/*', '/index.html'], Quantity: 2 }),
      /cloudfront: unexpected invalidation path/,
    ],
  ]
  for (const [response, pattern] of cases) {
    const fake = await rejects(
      {
        invalidations: [response],
        waits: [{ status: 0, stdout: '', stderr: '' }],
      },
      pattern,
    )
    assert.equal(fake.calls.filter((args) => args[1] === 'wait').length, 0)
    assert.equal(fake.requests.length, 0)
    assert.equal(
      fake.trace.some(
        (event) => event[1] === 'cloudfront wait invalidation-completed',
      ),
      false,
    )
  }
})

test('stops when invalidation does not complete and does not fetch', async () => {
  const fake = await rejects(
    { waits: [{ status: 1, stdout: '', stderr: 'Max attempts exceeded' }] },
    /cloudfront: invalidation-completed failed: Max attempts exceeded/,
  )
  assert.deepEqual(fake.calls.at(-1), waitArgs(invalidationId))
  assert.equal(fake.requests.length, 0)
  const waitAt = fake.trace.findIndex(
    (event) => event[1] === 'cloudfront wait invalidation-completed',
  )
  assert.ok(
    waitAt >
      fake.trace.findIndex(
        (event) => event[1] === 'cloudfront create-invalidation',
      ),
  )
  assert.equal(fake.trace.slice(waitAt + 1).length, 0)
  assertNoHttp(fake.trace)
})

test('rejects redirects and non-200 responses before the next file', async () => {
  const bodies = defaultBodies()
  const value = manifest(bodies)
  const parts = successParts(value, bodies)
  for (const status of [301, 302, 404, 500]) {
    const responses = parts.responses.slice()
    responses[0] = new Response(bodies.get('index.html'), {
      status,
      headers: { location: `https://${cloudfrontDomain}/` },
    })
    const fake = await rejects(
      { body: value, bodies, responses },
      new RegExp(`/index\\.html: HTTP ${status}`),
      { http: true },
    )
    assert.equal(fake.requests.length, 1)
    assertRequest(fake.requests[0], '/index.html')
    assert.equal(
      fake.calls.some((args) => args.includes(asset)),
      false,
    )
  }

  const opaque = parts.responses.slice()
  opaque[0] = {
    status: 0,
    type: 'opaqueredirect',
    redirected: false,
    headers: new Headers(),
    body: null,
  }
  const hidden = await rejects(
    { body: value, bodies, responses: opaque },
    /\/index\.html: redirect/,
    { http: true },
  )
  assert.equal(hidden.requests.length, 1)

  const followed = parts.responses.slice()
  followed[0] = {
    status: 200,
    type: 'default',
    redirected: true,
    headers: new Headers(),
    body: null,
  }
  const redirected = await rejects(
    { body: value, bodies, responses: followed },
    /\/index\.html: redirect/,
    { http: true },
  )
  assert.equal(redirected.requests.length, 1)
  assert.equal(redirected.requests[0].init.redirect, 'manual')
})

test('rejects an HTTP 200 asset whose body is index.html', async () => {
  const bodies = defaultBodies()
  const value = manifest(bodies)
  const parts = successParts(value, bodies)
  const responses = parts.responses.slice()
  responses[4] = live(bodies.get('index.html'))
  const fake = await rejects(
    { body: value, bodies, responses },
    /\/assets\/fonts\/brand-Bv_Re-yv\.woff2: content mismatch/,
    { http: true },
  )
  assert.deepEqual(
    fake.requests.map((entry) => new URL(entry.url).pathname),
    ['/index.html', '/', '/favicon.svg', '/icons.svg', `/${asset}`],
  )
  assert.equal(
    fake.calls.some((args) => args.includes(secondAsset)),
    false,
  )
  assert.equal(
    fake.calls.filter((args) => args[1] === 'create-invalidation').length,
    1,
  )
  assert.equal(fake.calls.filter((args) => args[1] === 'wait').length, 1)
})

test('rejects a hashed asset whose etag, size, or bytes differ', async () => {
  const bodies = defaultBodies()
  const value = manifest(bodies)
  const parts = successParts(value, bodies)
  const etagHeads = parts.heads.slice()
  etagHeads[3] = assetHead(value.hashedAssets[0], { ETag: '"asset-tag"' })
  const etag = await rejects(
    { body: value, bodies, heads: etagHeads },
    /brand-Bv_Re-yv\.woff2\.ETag: mismatch/,
    { http: true },
  )
  assert.equal(etag.requests.length, 4)
  assert.equal(
    etag.calls.some((args) => args[1] === 'get-object' && args.includes(asset)),
    false,
  )
  assert.equal(
    etag.calls.some((args) => args.includes(secondAsset)),
    false,
  )
  assert.equal(etag.calls.at(-1).includes('--version-id'), false)

  const sizeHeads = parts.heads.slice()
  sizeHeads[3] = assetHead(value.hashedAssets[0], {
    ContentLength: value.hashedAssets[0].size + 5,
  })
  const size = await rejects(
    { body: value, bodies, heads: sizeHeads },
    /brand-Bv_Re-yv\.woff2\.ContentLength: mismatch/,
    { http: true },
  )
  assert.equal(size.requests.length, 4)
  assert.equal(
    size.calls.some((args) => args.includes(secondAsset)),
    false,
  )

  const missing = parts.heads.slice()
  missing[3] = { status: 1, stdout: '', stderr: 'NotFound' }
  const absent = await rejects(
    { body: value, bodies, heads: missing },
    /brand-Bv_Re-yv\.woff2: head-object failed: NotFound/,
    { http: true },
  )
  assert.equal(absent.requests.length, 4)

  const objects = parts.objects.slice()
  objects[6] = currentObject(value.hashedAssets[0], Buffer.from('x'))
  const shortened = await rejects(
    { body: value, bodies, objects },
    /brand-Bv_Re-yv\.woff2: current: content mismatch/,
    { http: true },
  )
  assert.equal(shortened.requests.length, 4)
  assert.equal(
    shortened.calls.some((args) => args.includes(secondAsset)),
    false,
  )

  const responses = parts.responses.slice()
  const flipped = Buffer.from(bodies.get(asset))
  flipped[0] ^= 0xff
  assert.equal(flipped.length, bodies.get(asset).length)
  responses[4] = live(flipped)
  const remote = await rejects(
    { body: value, bodies, responses },
    /\/assets\/fonts\/brand-Bv_Re-yv\.woff2: content mismatch/,
    { http: true },
  )
  assert.equal(remote.requests.length, 5)
  assert.equal(
    remote.calls.some((args) => args.includes(secondAsset)),
    false,
  )
  assertNoMutation(remote.calls)
})

test('stops when downloaded restore metadata differs and does not write or copy', async () => {
  const bodies = defaultBodies()
  const value = manifest(bodies)
  const parts = successParts(value, bodies)
  const cases = [
    [{ ContentType: 'text/plain' }, /favicon\.svg\.ContentType: mismatch/],
    [
      { CacheControl: 'public, max-age=31536000' },
      /favicon\.svg\.CacheControl: mismatch/,
    ],
  ]
  for (const [patch, pattern] of cases) {
    const objects = parts.objects.slice()
    objects[1] = withMeta(parts.objects[1], patch)
    const fake = await rejects({ body: value, bodies, objects }, pattern)
    assert.deepEqual(fake.calls.map(commandName), [
      'ssm get-parameter',
      's3api head-object',
      's3api get-object',
      's3api get-object',
    ])
    assert.deepEqual(fake.calls[1], headArgs('favicon.svg'))
    assert.equal(flag(fake.calls[2], '--version-id'), versions['favicon.svg'])
    assert.equal(fake.calls[3].includes('--version-id'), false)
    assert.equal(
      fake.calls.filter((args) => args[1] === 'get-parameter').length,
      1,
    )
    assert.equal(
      fake.calls.some((args) => args[0] === 'cloudfront'),
      false,
    )
    assert.equal(fake.requests.length, 0)
    assertNoMutation(fake.calls)
  }
})

test('stops when the downloaded hashed asset etag differs', async () => {
  const bodies = defaultBodies()
  const value = manifest(bodies)
  const parts = successParts(value, bodies)
  const objects = parts.objects.slice()
  objects[6] = withMeta(parts.objects[6], { ETag: '"swapped-tag"' })
  const fake = await rejects(
    { body: value, bodies, objects },
    /brand-Bv_Re-yv\.woff2\.ETag: mismatch/,
    { http: true },
  )
  assert.equal(fake.requests.length, 4)
  assert.deepEqual(fake.calls.at(-2), headArgs(asset))
  assertGet(fake.calls.at(-1), asset)
  assert.equal(
    fake.calls.some((args) => args.includes(secondAsset)),
    false,
  )
  assert.equal(
    fake.calls.filter((args) => args[1] === 'get-parameter').length,
    1,
  )
  assert.equal(
    fake.calls.filter((args) => args[1] === 'create-invalidation').length,
    1,
  )
  assertNoMutation(fake.calls)
})

test('rejects a hashed asset replaced by different bytes of the same size', async () => {
  const bodies = defaultBodies()
  const value = manifest(bodies)
  const parts = successParts(value, bodies)
  const flipped = Buffer.from(bodies.get(asset))
  flipped[0] ^= 0xff
  assert.equal(flipped.length, bodies.get(asset).length)
  const cases = [
    {
      meta: { ETag: '"swapped-tag"' },
      response: live(flipped),
      pattern: /brand-Bv_Re-yv\.woff2\.ETag: mismatch/,
      requests: 4,
    },
    {
      meta: {},
      response: live(bodies.get(asset)),
      pattern: /\/assets\/fonts\/brand-Bv_Re-yv\.woff2: content mismatch/,
      requests: 5,
    },
  ]
  for (const entry of cases) {
    const objects = parts.objects.slice()
    objects[6] = withMeta(parts.objects[6], entry.meta, flipped)
    const responses = [
      live(bodies.get('index.html')),
      live(bodies.get('index.html')),
      live(bodies.get('favicon.svg')),
      live(bodies.get('icons.svg')),
      entry.response,
      live(bodies.get(secondAsset)),
    ]
    const fake = await rejects(
      { body: value, bodies, objects, responses },
      entry.pattern,
      { http: true },
    )
    assert.equal(fake.requests.length, entry.requests)
    assert.equal(
      fake.calls.some((args) => args.includes(secondAsset)),
      false,
    )
    assert.equal(
      fake.calls.filter((args) => args[1] === 'get-parameter').length,
      1,
    )
    assertNoMutation(fake.calls)
  }
})

test('accepts already decoded bodies when content-encoding is still set', async () => {
  const bodies = defaultBodies()
  const value = manifest(bodies)
  const encodings = ['gzip', 'x-gzip', 'deflate', 'br', 'gzip', 'gzip']
  const encoded = [
    bodies.get('index.html'),
    bodies.get('index.html'),
    bodies.get('favicon.svg'),
    bodies.get('icons.svg'),
    bodies.get(asset),
    bodies.get(secondAsset),
  ].map((body, index) =>
    live(body, { headers: { 'content-encoding': encodings[index] } }),
  )
  const fake = attempt({ body: value, bodies, responses: encoded })
  const result = await fake.promise
  assert.deepEqual(result.verified, [
    '/index.html',
    '/',
    '/favicon.svg',
    '/icons.svg',
    `/${asset}`,
    `/${secondAsset}`,
  ])
  assert.equal(result.verified.at(-1), `/${secondAsset}`)
  assert.equal(value.hashedAssets[1].size, 0)
  for (const entry of fake.requests)
    assert.equal(entry.init.headers['accept-encoding'], 'identity')
  assertNoMutation(fake.calls)
})

test('rejects content-encoding responses whose bytes do not match', async () => {
  const bodies = defaultBodies()
  const value = manifest(bodies)
  const parts = successParts(value, bodies)
  const cases = [
    live(Buffer.from('<!doctype html><html><body>other</body></html>'), {
      headers: { 'content-encoding': 'gzip' },
    }),
    live(gzipSync(bodies.get('index.html')), {
      headers: { 'content-encoding': 'gzip' },
    }),
  ]
  for (const response of cases) {
    const responses = parts.responses.slice()
    responses[0] = response
    const fake = await rejects(
      { body: value, bodies, responses },
      /\/index\.html: content mismatch/,
      { http: true },
    )
    assert.equal(fake.requests.length, 1)
    assertRequest(fake.requests[0], '/index.html')
    assert.equal(
      fake.calls.some((args) => args.includes(asset)),
      false,
    )
    assert.equal(
      fake.calls.filter((args) => args[1] === 'get-parameter').length,
      1,
    )
    assertNoMutation(fake.calls)
  }
})

test('aborts a hung CloudFront read before the next file', async () => {
  const bodies = defaultBodies()
  const value = manifest(bodies)
  const seen = []
  const fake = attempt({
    body: value,
    bodies,
    timeoutMs: 20,
    fetch(url, init) {
      seen.push(url)
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(init.signal.reason ?? new Error('aborted'))
        })
      })
    },
  })
  let timer
  const backup = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('timeout did not abort the request')),
      500,
    )
  })
  try {
    await assert.rejects(
      Promise.race([fake.promise, backup]),
      /\/index\.html: request failed/,
    )
  } finally {
    clearTimeout(timer)
  }
  assert.deepEqual(seen, [`https://${cloudfrontDomain}/index.html`])
  assertNoMutation(fake.calls)
  assert.equal(
    fake.calls.some((args) => args.includes(asset)),
    false,
  )
  assert.equal(fake.calls.filter((args) => args[1] === 'wait').length, 1)
  assertTempFilesRemoved(fake.calls)
})
