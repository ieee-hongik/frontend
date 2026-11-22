import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { manifestKey } from './manifest.mjs'
import { rollback } from './rollback.mjs'

const manifestBucket =
  'ieee-hongik-frontend-deployments-015454941458-ap-northeast-2-an'
const originBucket = 'ieee-hongik-frontend-015454941458'
const region = 'ap-northeast-2'
const parameterName = '/ieee/frontend/production/deploy-state'
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
  's3api get-object',
  's3api head-object',
  'ssm get-parameter',
  'ssm put-parameter',
  's3api copy-object',
])

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
    restore: manifestOrder.map((key, index) => ({
      key,
      versionId: versions[key],
      contentType: key.endsWith('.svg')
        ? 'image/svg+xml'
        : 'text/html; charset=utf-8',
      cacheControl: 'no-cache, max-age=0',
      etag: `"etag-${index}"`,
      size,
    })),
    hashedAssets: [
      { key: asset, etag: 'asset-tag', size: 123 },
      { key: secondAsset, etag: '"quoted-tag"', size: 0 },
    ],
  }
}

function inputFor(value = manifest()) {
  return {
    gitSha: value.gitSha,
    runId: value.runId,
    runAttempt: String(value.runAttempt),
  }
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
    ...patch,
  }
}

function parameter(value, patch = {}) {
  return ok({
    Parameter: {
      Name: parameterName,
      Type: 'String',
      Value: value,
      Version: 3,
      ...patch,
    },
  })
}

function putResult(patch = {}) {
  return ok({ Version: 4, Tier: 'Standard', ...patch })
}

function copyResult(key) {
  return ok({
    CopyObjectResult: { ETag: '"copied"' },
    CopySourceVersionId: versions[key],
    VersionId: 'new-target-version',
  })
}

function headsFor(value) {
  return [
    ...value.restore.map((item) => ok(restoreHead(item))),
    ...value.hashedAssets.map((item) => ok(assetHead(item))),
  ]
}

function runner({
  body,
  heads = [],
  parameters = [],
  puts = [],
  copies = [],
  getStatus = 0,
  getStdout = '{"RequestCharged":null}',
  getStderr = '',
}) {
  const calls = []
  const queues = {
    'head-object': [...heads],
    'get-parameter': [...parameters],
    'put-parameter': [...puts],
    'copy-object': [...copies],
  }
  const run = (args) => {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
      throw new Error('aws arguments must be strings')
    calls.push([...args])
    if (args[1] === 'get-object') {
      if (getStatus === 0) writeFileSync(args.at(-1), JSON.stringify(body))
      return { status: getStatus, stdout: getStdout, stderr: getStderr }
    }
    const queue = queues[args[1]]
    if (!queue) throw new Error(`unexpected command ${args[0]} ${args[1]}`)
    const response = queue.shift()
    if (!response) throw new Error(`unexpected extra ${args[1]}`)
    return response
  }
  return { calls, run }
}

function attempt(options = {}) {
  const value = options.body ?? manifest()
  const fake = runner({
    body: value,
    heads: options.heads ?? headsFor(value),
    parameters: options.parameters ?? [],
    puts: options.puts ?? [],
    copies: options.copies ?? [],
    getStatus: options.getStatus,
    getStdout: options.getStdout,
    getStderr: options.getStderr,
  })
  return {
    ...fake,
    value,
    promise: rollback(options.input ?? inputFor(value), { run: fake.run }),
  }
}

function flag(args, name) {
  const index = args.indexOf(name)
  assert.notEqual(index, -1, name)
  return args[index + 1]
}

function selected(calls, command) {
  return calls.filter((args) => args[1] === command)
}

function putValues(calls) {
  return selected(calls, 'put-parameter').map((args) => flag(args, '--value'))
}

function copyKeys(calls) {
  return selected(calls, 'copy-object').map((args) => flag(args, '--key'))
}

function assertAllowed(calls) {
  for (const args of calls) {
    assert.equal(Array.isArray(args), true)
    assert.equal(
      args.every((arg) => typeof arg === 'string'),
      true,
    )
    assert.ok(allowedCommands.has(`${args[0]} ${args[1]}`), args.join(' '))
  }
}

function assertClosedOnly(calls) {
  const values = putValues(calls)
  assert.ok(values.every((value) => value === 'closed'))
  for (const args of selected(calls, 'put-parameter')) {
    assert.equal(flag(args, '--type'), 'String')
    assert.ok(args.includes('--overwrite'))
    assert.equal(args.includes('--no-overwrite'), false)
    assert.equal(flag(args, '--name'), parameterName)
    assert.equal(flag(args, '--region'), region)
  }
}

function assertNoAssetWrite(calls, value) {
  const assetKeys = value.hashedAssets.map((item) => item.key)
  for (const args of calls) {
    if (args[1] === 'head-object') continue
    for (const key of assetKeys) assert.equal(args.includes(key), false)
    if (args[1] !== 'copy-object') continue
    for (const key of assetKeys)
      assert.equal(flag(args, '--copy-source').includes(key), false)
  }
  for (const key of assetKeys) {
    const reads = selected(calls, 'head-object').filter(
      (args) => flag(args, '--key') === key,
    )
    assert.equal(reads.length, 1)
    assert.equal(reads[0].includes('--version-id'), false)
  }
}

function assertTempFileRemoved(calls) {
  const file = calls[0]?.at(-1)
  if (!file || calls[0][1] !== 'get-object') return
  assert.equal(dirname(file), tmpdir())
  assert.equal(existsSync(file), false)
}

function assertNoMutation(calls) {
  assert.equal(selected(calls, 'put-parameter').length, 0)
  assert.equal(selected(calls, 'copy-object').length, 0)
  assert.equal(selected(calls, 'get-parameter').length, 0)
  assertAllowed(calls)
  assertTempFileRemoved(calls)
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

function closedArgs() {
  return [
    'ssm',
    'put-parameter',
    '--name',
    parameterName,
    '--value',
    'closed',
    '--type',
    'String',
    '--overwrite',
    '--region',
    region,
    '--output',
    'json',
  ]
}

function copySource(key) {
  const encoded = {
    'favicon.svg': 'fav%26%252F%2BA%2FB%3D%3F',
    'icons.svg': 'ico%3FversionId%3Dx',
    'index.html': 'idx%2B1%2F2%3D',
  }
  return `${originBucket}/${key}?versionId=${encoded[key]}`
}

function copyArgs(key) {
  return [
    's3api',
    'copy-object',
    '--bucket',
    originBucket,
    '--key',
    key,
    '--copy-source',
    copySource(key),
    '--metadata-directive',
    'COPY',
    '--region',
    region,
    '--output',
    'json',
  ]
}

function headArgs(item, versioned) {
  const args = [
    's3api',
    'head-object',
    '--bucket',
    originBucket,
    '--key',
    item.key,
  ]
  if (versioned) args.push('--version-id', item.versionId)
  args.push('--region', region, '--output', 'json')
  return args
}

test('does not write SSM or restore S3 when preflight fails', async () => {
  let called = false
  await assert.rejects(
    () =>
      rollback(null, {
        run: () => {
          called = true
        },
      }),
    /input/,
  )
  assert.equal(called, false)
  await assert.rejects(
    () =>
      rollback(
        { ...inputFor(), gitSha: 'F'.repeat(40) },
        {
          run: () => {
            called = true
          },
        },
      ),
    /gitSha/,
  )
  assert.equal(called, false)

  const denied = attempt({
    getStatus: 1,
    getStderr: 'AccessDenied',
    heads: [],
  })
  await assert.rejects(denied.promise, /get-object failed: AccessDenied/)
  assert.equal(denied.calls.length, 1)
  assertNoMutation(denied.calls)

  const mismatch = attempt({
    heads: [ok(restoreHead(manifest().restore[0], { ETag: 'different' }))],
  })
  await assert.rejects(mismatch.promise, /index\.html\.ETag: mismatch/)
  assert.equal(mismatch.calls.length, 2)
  assertNoMutation(mismatch.calls)

  const drifted = manifest()
  drifted.gitSha = 'b'.repeat(40)
  const disagreed = attempt({ body: drifted, input: inputFor(), heads: [] })
  await assert.rejects(disagreed.promise, /gitSha: manifest mismatch/)
  assert.equal(disagreed.calls.length, 1)
  assertNoMutation(disagreed.calls)
})

test('rejects a failed freeze read or an unexpected state before writing', async () => {
  const value = manifest()
  const cases = [
    [
      'missing parameter',
      { status: 1, stdout: '', stderr: 'ParameterNotFound' },
      /deploy-state: read: get-parameter failed: ParameterNotFound/,
    ],
    [
      'unreadable response',
      { status: 0, stdout: '{', stderr: '' },
      /deploy-state: read: invalid get-parameter response/,
    ],
    [
      'missing parameter object',
      ok({}),
      /deploy-state: read: invalid get-parameter response/,
    ],
    [
      'wrong parameter name',
      parameter('open', { Name: '/other' }),
      /deploy-state: read: unexpected parameter/,
    ],
    [
      'wrong type',
      parameter('open', { Type: 'SecureString' }),
      /deploy-state: read: unexpected type/,
    ],
    ['uppercase', parameter('OPEN'), /deploy-state: read: unexpected state/],
    ['blank', parameter(''), /deploy-state: read: unexpected state/],
    ['padded', parameter('closed '), /deploy-state: read: unexpected state/],
    [
      'short allow',
      parameter('allow:'),
      /deploy-state: read: unexpected state/,
    ],
    [
      'short sha',
      parameter(`allow:${'a'.repeat(39)}`),
      /deploy-state: read: unexpected state/,
    ],
    [
      'long sha',
      parameter(`allow:${sha}x`),
      /deploy-state: read: unexpected state/,
    ],
    [
      'uppercase sha',
      parameter(`allow:${'A'.repeat(40)}`),
      /deploy-state: read: unexpected state/,
    ],
  ]
  for (const [name, response, pattern] of cases) {
    const fake = attempt({
      body: value,
      parameters: [response],
    })
    await assert.rejects(fake.promise, pattern, name)
    assert.equal(selected(fake.calls, 'put-parameter').length, 0, name)
    assert.equal(selected(fake.calls, 'copy-object').length, 0, name)
    assert.equal(selected(fake.calls, 'get-parameter').length, 1, name)
    assertAllowed(fake.calls)
    assertTempFileRemoved(fake.calls)
  }
})

test('does not restore when freeze cannot be set to closed', async () => {
  const value = manifest()
  const cases = [
    [
      'put denied from open',
      parameter('open'),
      { status: 1, stdout: '', stderr: 'AccessDenied' },
      /deploy-state: put-parameter failed: AccessDenied/,
    ],
    [
      'put denied while already closed',
      parameter('closed'),
      { status: 1, stdout: '', stderr: 'AccessDenied' },
      /deploy-state: put-parameter failed: AccessDenied/,
    ],
    [
      'put response is not json',
      parameter('open'),
      { status: 0, stdout: '{', stderr: '' },
      /deploy-state: invalid put-parameter response/,
    ],
    [
      'put response has no version',
      parameter('open'),
      ok({}),
      /deploy-state: invalid put-parameter response/,
    ],
    [
      'put version is zero',
      parameter('open'),
      putResult({ Version: 0 }),
      /deploy-state: invalid put-parameter response/,
    ],
  ]
  for (const [name, current, response, pattern] of cases) {
    const fake = attempt({
      body: value,
      parameters: [current],
      puts: [response],
    })
    await assert.rejects(fake.promise, pattern, name)
    assert.equal(selected(fake.calls, 'copy-object').length, 0, name)
    assert.equal(selected(fake.calls, 'get-parameter').length, 1, name)
    assert.equal(selected(fake.calls, 'put-parameter').length, 1, name)
    assert.deepEqual(selected(fake.calls, 'put-parameter')[0], closedArgs())
    assertClosedOnly(fake.calls)
    assertAllowed(fake.calls)
  }
})

test('does not restore unless the reread is exactly closed', async () => {
  const value = manifest()
  const cases = [
    [
      'confirm read failed',
      { status: 1, stdout: '', stderr: 'AccessDenied' },
      /deploy-state: confirm: get-parameter failed: AccessDenied/,
    ],
    ['confirm is open', parameter('open'), /deploy-state: confirm: not closed/],
    [
      'confirm is allow',
      parameter(`allow:${'b'.repeat(40)}`),
      /deploy-state: confirm: not closed/,
    ],
    [
      'confirm type changed',
      parameter('closed', { Type: 'SecureString' }),
      /deploy-state: confirm: unexpected type/,
    ],
    [
      'confirm is damaged',
      { status: 0, stdout: 'not-json', stderr: '' },
      /deploy-state: confirm: invalid get-parameter response/,
    ],
  ]
  for (const [name, response, pattern] of cases) {
    const fake = attempt({
      body: value,
      parameters: [parameter('open'), response],
      puts: [putResult()],
    })
    await assert.rejects(fake.promise, pattern, name)
    assert.equal(selected(fake.calls, 'copy-object').length, 0, name)
    assert.deepEqual(putValues(fake.calls), ['closed'], name)
    assert.equal(selected(fake.calls, 'put-parameter').length, 1, name)
    assert.deepEqual(
      selected(fake.calls, 'get-parameter').at(-1),
      parameterArgs(),
    )
    assertAllowed(fake.calls)
    assertClosedOnly(fake.calls)
  }
})

test('open, allow, and an already closed freeze restore in order and stay closed', async () => {
  const value = manifest()
  const allow = `allow:${'b'.repeat(40)}`
  for (const initial of ['open', 'closed', allow]) {
    const fake = attempt({
      body: value,
      parameters: [
        parameter(initial),
        parameter('closed'),
        parameter('closed'),
      ],
      puts: [putResult()],
      copies: restoreOrder.map(copyResult),
    })
    const result = await fake.promise
    assert.deepEqual(result.restored, restoreOrder, initial)
    assert.equal(result.deployState, 'closed', initial)
    assert.equal(result.manifestKey, manifestKey(value), initial)
    assert.equal(result.manifest.distributionId, 'E3FJUV685123A4', initial)
    assert.deepEqual(
      result.manifest.restore.map((item) => item.key),
      manifestOrder,
      initial,
    )
    assert.deepEqual(fake.calls[0].slice(0, -1), [
      's3api',
      'get-object',
      '--bucket',
      manifestBucket,
      '--key',
      manifestKey(value),
      '--region',
      region,
      '--output',
      'json',
    ])
    for (const [index, item] of value.restore.entries())
      assert.deepEqual(fake.calls[1 + index], headArgs(item, true), initial)
    for (const [index, item] of value.hashedAssets.entries()) {
      assert.deepEqual(
        fake.calls[1 + value.restore.length + index],
        headArgs(item, false),
        initial,
      )
    }
    const freezeAt = 1 + value.restore.length + value.hashedAssets.length
    assert.deepEqual(fake.calls[freezeAt], parameterArgs(), initial)
    assert.deepEqual(fake.calls[freezeAt + 1], closedArgs(), initial)
    assert.deepEqual(fake.calls[freezeAt + 2], parameterArgs(), initial)
    assert.deepEqual(fake.calls[freezeAt + 3], copyArgs('favicon.svg'), initial)
    assert.deepEqual(fake.calls[freezeAt + 4], copyArgs('icons.svg'), initial)
    assert.deepEqual(fake.calls[freezeAt + 5], parameterArgs(), initial)
    assert.deepEqual(fake.calls[freezeAt + 6], copyArgs('index.html'), initial)
    assert.equal(fake.calls.length, freezeAt + 7, initial)
    assert.deepEqual(copyKeys(fake.calls), restoreOrder, initial)
    assert.deepEqual(putValues(fake.calls), ['closed'], initial)
    assertNoAssetWrite(fake.calls, value)
    assertClosedOnly(fake.calls)
    assertAllowed(fake.calls)
    assertTempFileRemoved(fake.calls)
  }
})

test('stops on the first or second copy and leaves freeze closed', async () => {
  const value = manifest()
  const cases = [
    [
      'favicon command failed',
      [{ status: 1, stdout: '', stderr: 'NoSuchVersion' }],
      /favicon\.svg: copy-object failed: NoSuchVersion/,
      ['favicon.svg'],
      2,
    ],
    [
      'favicon response damaged',
      [{ status: 0, stdout: 'not-json', stderr: '' }],
      /favicon\.svg: invalid copy-object response/,
      ['favicon.svg'],
      2,
    ],
    [
      'icons command failed',
      [
        copyResult('favicon.svg'),
        { status: 1, stdout: '', stderr: 'AccessDenied' },
      ],
      /icons\.svg: copy-object failed: AccessDenied/,
      ['favicon.svg', 'icons.svg'],
      2,
    ],
  ]
  for (const [name, copies, pattern, keys, reads] of cases) {
    const fake = attempt({
      body: value,
      parameters: [parameter('closed'), parameter('closed')],
      puts: [putResult()],
      copies,
    })
    await assert.rejects(fake.promise, pattern, name)
    assert.deepEqual(copyKeys(fake.calls), keys, name)
    assert.equal(selected(fake.calls, 'get-parameter').length, reads, name)
    assert.deepEqual(putValues(fake.calls), ['closed'], name)
    assert.equal(selected(fake.calls, 'put-parameter').length, 1, name)
    assert.equal(copyKeys(fake.calls).includes('index.html'), false, name)
    assertNoAssetWrite(fake.calls, value)
    assertClosedOnly(fake.calls)
    assertAllowed(fake.calls)
  }
})

test('an index.html failure or a failed recheck stops without another SSM write', async () => {
  const value = manifest()
  const ready = [parameter('open'), parameter('closed')]
  const cases = [
    [
      'recheck is open',
      [...ready, parameter('open')],
      restoreOrder.map(copyResult),
      /index\.html: before-copy: not closed/,
      ['favicon.svg', 'icons.svg'],
    ],
    [
      'recheck failed',
      [...ready, { status: 1, stdout: '', stderr: 'Throttling' }],
      restoreOrder.slice(0, 2).map(copyResult),
      /index\.html: before-copy: get-parameter failed: Throttling/,
      ['favicon.svg', 'icons.svg'],
    ],
    [
      'index copy failed',
      [...ready, parameter('closed')],
      [
        copyResult('favicon.svg'),
        copyResult('icons.svg'),
        { status: 1, stdout: '', stderr: 'InternalError' },
      ],
      /index\.html: copy-object failed: InternalError/,
      restoreOrder,
    ],
  ]
  for (const [name, parameters, copies, pattern, keys] of cases) {
    const fake = attempt({
      body: value,
      parameters,
      puts: [putResult()],
      copies,
    })
    await assert.rejects(fake.promise, pattern, name)
    assert.deepEqual(copyKeys(fake.calls), keys, name)
    assert.deepEqual(putValues(fake.calls), ['closed'], name)
    assert.equal(selected(fake.calls, 'put-parameter').length, 1, name)
    assertNoAssetWrite(fake.calls, value)
    assertClosedOnly(fake.calls)
    assertAllowed(fake.calls)
  }
})

test('invalid copy acknowledgements stop at the affected file without another SSM write', async () => {
  for (const [index, key] of restoreOrder.slice(0, 2).entries()) {
    const base = {
      CopySourceVersionId: versions[key],
      VersionId: versions[key],
      CopyObjectResult: { ETag: '"copied"' },
    }
    for (const [body, field] of [
      [{}, 'CopyObjectResult'],
      [{ ...base, CopyObjectResult: [] }, 'CopyObjectResult'],
      [{ ...base, CopyObjectResult: {} }, 'ETag'],
      [{ ...base, CopyObjectResult: { ETag: '' } }, 'ETag'],
      [{ ...base, CopyObjectResult: { ETag: '  ' } }, 'ETag'],
      [{ ...base, CopyObjectResult: { ETag: 123 } }, 'ETag'],
      [{ ...base, CopySourceVersionId: undefined }, 'CopySourceVersionId'],
      [{ ...base, CopySourceVersionId: 'other' }, 'CopySourceVersionId'],
    ]) {
      const fake = attempt({
        parameters: [parameter('open'), parameter('closed')],
        puts: [putResult()],
        copies: [...restoreOrder.slice(0, index).map(copyResult), ok(body)],
      })
      await assert.rejects(fake.promise, {
        message: `${key}: copy-object: ${field === 'CopySourceVersionId' ? 'unexpected' : 'invalid'} ${field}`,
      })
      assert.deepEqual(copyKeys(fake.calls), restoreOrder.slice(0, index + 1))
      assert.deepEqual(putValues(fake.calls), ['closed'])
    }
  }
})
