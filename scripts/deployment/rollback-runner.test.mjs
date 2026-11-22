import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { manifestKey } from './manifest.mjs'
import { runCli } from './rollback-runner.mjs'

const liveFetch = globalThis.fetch
globalThis.fetch = async () => {
  throw new Error('unexpected live fetch')
}
after(() => {
  globalThis.fetch = liveFetch
})

const manifestBucket =
  'ieee-hongik-frontend-deployments-015454941458-ap-northeast-2-an'
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
const runId = '9007199254740993'
const versions = {
  'favicon.svg': 'fav&%2F+A/B=?',
  'icons.svg': 'ico?versionId=x',
  'index.html': 'idx+1/2=',
}
const encodedVersion = {
  'favicon.svg': 'fav%26%252F%2BA%2FB%3D%3F',
  'icons.svg': 'ico%3FversionId%3Dx',
  'index.html': 'idx%2B1%2F2%3D',
}
const verifiedPaths = [
  '/index.html',
  '/',
  '/favicon.svg',
  '/icons.svg',
  `/${asset}`,
  `/${secondAsset}`,
]
const usage =
  'Usage: node scripts/deployment/rollback-runner.mjs <gitSha> <runId> <runAttempt>'
const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/frontend-rollback.yml', import.meta.url),
)
const cliPath = fileURLToPath(new URL('./rollback-runner.mjs', import.meta.url))

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
    runId,
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

function ok(value) {
  return { status: 0, stdout: JSON.stringify(value), stderr: '' }
}

function parameter(value) {
  return ok({
    Parameter: {
      Name: parameterName,
      Type: 'String',
      Value: value,
      Version: 4,
    },
  })
}

function preflightRestoreHead(item) {
  return ok({
    VersionId: item.versionId,
    ETag: item.etag,
    ContentLength: item.size,
    ContentType: item.contentType,
    CacheControl: item.cacheControl,
  })
}

function preflightAssetHead(item) {
  return ok({
    ETag: item.etag,
    ContentLength: item.size,
    VersionId: 'null',
  })
}

function verifyRestoreHead(item) {
  return ok({
    ContentType: item.contentType,
    CacheControl: item.cacheControl,
    ContentLength: item.size,
    ETag: 'W/"copied-object"',
    VersionId: `copied-${item.key}`,
  })
}

function verifyAssetHead(item) {
  return ok({
    ETag: item.etag,
    ContentLength: item.size,
    VersionId: `asset-${item.key}`,
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

function currentRestoreObject(item, body) {
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

function currentAssetObject(item, body) {
  return objectResponse(
    {
      ContentLength: item.size,
      ETag: item.etag,
      VersionId: `asset-${item.key}`,
    },
    body,
  )
}

function copyResult(key) {
  return ok({
    CopyObjectResult: { ETag: '"copied"' },
    CopySourceVersionId: versions[key],
    VersionId: `copied-${key}`,
  })
}

function invalidation() {
  return ok({
    Invalidation: {
      Id: invalidationId,
      Status: 'InProgress',
      InvalidationBatch: {
        Paths: { Quantity: 1, Items: ['/*'] },
        CallerReference: 'cli',
      },
    },
  })
}

function live(body) {
  return new Response(body)
}

function successScript(value, bodies) {
  const heads = [
    ...value.restore.map((item) => preflightRestoreHead(item)),
    ...value.hashedAssets.map((item) => preflightAssetHead(item)),
    ...restoreOrder.map((key) =>
      verifyRestoreHead(value.restore.find((item) => item.key === key)),
    ),
    ...value.hashedAssets.map((item) => verifyAssetHead(item)),
  ]
  const objects = []
  for (const key of restoreOrder) {
    const item = value.restore.find((entry) => entry.key === key)
    objects.push(versionObject(item, bodies.get(key)))
    objects.push(currentRestoreObject(item, bodies.get(key)))
  }
  for (const item of value.hashedAssets)
    objects.push(currentAssetObject(item, bodies.get(item.key)))
  const responses = []
  for (const key of ['index.html', 'index.html', 'favicon.svg', 'icons.svg'])
    responses.push(live(bodies.get(key)))
  for (const item of value.hashedAssets)
    responses.push(live(bodies.get(item.key)))
  return {
    manifestGets: [
      { status: 0, stdout: '{"RequestCharged":null}', stderr: '' },
    ],
    heads,
    objects,
    parameters: [
      parameter('open'),
      parameter('closed'),
      parameter('closed'),
      parameter('closed'),
    ],
    puts: [ok({ Version: 5 })],
    copies: restoreOrder.map((key) => copyResult(key)),
    invalidations: [invalidation()],
    waits: [{ status: 0, stdout: '', stderr: '' }],
    responses,
  }
}

function flag(args, name) {
  const index = args.indexOf(name)
  assert.notEqual(index, -1, `${name} in ${args.join(' ')}`)
  return args[index + 1]
}

function commandName(args) {
  if (args[0] === 'cloudfront' && args[1] === 'wait')
    return `cloudfront wait ${args[2]}`
  return `${args[0]} ${args[1]}`
}

function describe(args) {
  if (args[0] === 'cloudfront' && args[1] === 'create-invalidation')
    return `cloudfront create-invalidation ${flag(args, '--paths')}`
  if (args[0] === 'cloudfront' && args[1] === 'wait')
    return `cloudfront wait ${args[2]}`
  if (args[0] === 'ssm' && args[1] === 'get-parameter')
    return 'ssm get-parameter'
  if (args[0] === 'ssm' && args[1] === 'put-parameter')
    return `ssm put-parameter ${flag(args, '--value')}`
  if (args[0] === 's3api') {
    const version = args.includes('--version-id')
      ? ` ${flag(args, '--version-id')}`
      : ''
    return `s3api ${args[1]} ${flag(args, '--bucket')} ${flag(args, '--key')}${version}`
  }
  return args.join(' ')
}

function expectedTrace(value) {
  const key = manifestKey(value)
  const trace = [`s3api get-object ${manifestBucket} ${key}`]
  for (const item of value.restore)
    trace.push(
      `s3api head-object ${originBucket} ${item.key} ${item.versionId}`,
    )
  for (const item of value.hashedAssets)
    trace.push(`s3api head-object ${originBucket} ${item.key}`)
  trace.push(
    'ssm get-parameter',
    'ssm put-parameter closed',
    'ssm get-parameter',
    `s3api copy-object ${originBucket} favicon.svg`,
    `s3api copy-object ${originBucket} icons.svg`,
    'ssm get-parameter',
    `s3api copy-object ${originBucket} index.html`,
    'ssm get-parameter',
  )
  for (const objectKey of restoreOrder) {
    trace.push(
      `s3api head-object ${originBucket} ${objectKey}`,
      `s3api get-object ${originBucket} ${objectKey} ${versions[objectKey]}`,
      `s3api get-object ${originBucket} ${objectKey}`,
    )
  }
  trace.push(
    'cloudfront create-invalidation /*',
    'cloudfront wait invalidation-completed',
  )
  for (const pathname of verifiedPaths.slice(0, 4))
    trace.push(`http ${pathname}`)
  for (const objectKey of [asset, secondAsset]) {
    trace.push(
      `s3api head-object ${originBucket} ${objectKey}`,
      `s3api get-object ${originBucket} ${objectKey}`,
      `http /${objectKey}`,
    )
  }
  return trace
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
    `${originBucket}/${key}?versionId=${encodedVersion[key]}`,
    '--metadata-directive',
    'COPY',
    '--region',
    region,
    '--output',
    'json',
  ]
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

function assertNoRelease(calls) {
  for (const args of calls) {
    assert.equal(
      args.every((arg) => typeof arg === 'string'),
      true,
    )
    assert.equal(args[1] === 'delete-object', false, args.join(' '))
    assert.equal(args[1] === 'put-object', false, args.join(' '))
    assert.equal(args[1] === 'delete-parameter', false, args.join(' '))
    if (args[1] === 'put-parameter') {
      assert.equal(flag(args, '--value'), 'closed')
      assert.equal(flag(args, '--name'), parameterName)
      assert.equal(flag(args, '--type'), 'String')
      assert.equal(args.includes('--overwrite'), true)
    }
  }
}

function assertTempFilesRemoved(calls) {
  for (const args of calls) {
    if (args[1] !== 'get-object') continue
    assert.equal(dirname(args.at(-1)), tmpdir())
    assert.equal(existsSync(args.at(-1)), false)
  }
}

function createFake(value, bodies, overrides = {}) {
  const script = successScript(value, bodies)
  const lists = {
    manifestGets: [...(overrides.manifestGets ?? script.manifestGets)],
    heads: [...(overrides.heads ?? script.heads)],
    objects: [...(overrides.objects ?? script.objects)],
    parameters: [...(overrides.parameters ?? script.parameters)],
    puts: [...(overrides.puts ?? script.puts)],
    copies: [...(overrides.copies ?? script.copies)],
    invalidations: [...(overrides.invalidations ?? script.invalidations)],
    waits: [...(overrides.waits ?? script.waits)],
    responses: [...(overrides.responses ?? script.responses)],
  }
  const calls = []
  const requests = []
  const trace = []
  const queues = {
    's3api head-object': lists.heads,
    'ssm get-parameter': lists.parameters,
    'ssm put-parameter': lists.puts,
    's3api copy-object': lists.copies,
    'cloudfront create-invalidation': lists.invalidations,
    'cloudfront wait invalidation-completed': lists.waits,
  }
  const run = (args) => {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
      throw new Error('aws arguments must be strings')
    calls.push([...args])
    trace.push(describe(args))
    const name = commandName(args)
    if (name === 's3api get-object') {
      const bucket = flag(args, '--bucket')
      const queue =
        bucket === manifestBucket ? lists.manifestGets : lists.objects
      const response = queue.shift()
      if (!response) throw new Error(`unexpected extra ${name}`)
      if (response.status === 0) {
        const body =
          bucket === manifestBucket
            ? JSON.stringify(value)
            : (response.body ?? Buffer.alloc(0))
        writeFileSync(args.at(-1), body)
      }
      return {
        status: response.status,
        stdout: response.stdout ?? '',
        stderr: response.stderr ?? '',
      }
    }
    const queue = queues[name]
    if (!queue) throw new Error(`unexpected command ${name}`)
    const response = queue.shift()
    if (!response) throw new Error(`unexpected extra ${name}`)
    return {
      status: response.status,
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
    }
  }
  const fetch = async (url, init) => {
    const pathname = decodeURIComponent(new URL(url).pathname)
    requests.push({ url, init })
    trace.push(`http ${pathname}`)
    const response = lists.responses.shift()
    if (!response) throw new Error(`unexpected fetch ${pathname}`)
    return response
  }
  return { calls, requests, trace, run, fetch }
}

async function runScenario(overrides = {}) {
  const bodies = overrides.bodies ?? defaultBodies()
  const value = overrides.body ?? manifest(bodies)
  const fake = createFake(value, bodies, overrides)
  const stdout = []
  const stderr = []
  const summaryFile =
    overrides.summaryFile === undefined
      ? join(tmpdir(), `rollback-summary-${randomUUID()}.md`)
      : overrides.summaryFile
  const result = await runCli(overrides.argv ?? [sha, runId, '2'], {
    run: fake.run,
    fetch: fake.fetch,
    log: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    summaryFile,
  })
  return {
    ...fake,
    stdout,
    stderr,
    summaryFile,
    result,
    value,
    bodies,
  }
}

function summaryText(file) {
  assert.equal(existsSync(file), true)
  return readFileSync(file, 'utf8')
}

function assertSuccessReport(report, value) {
  const key = manifestKey(value)
  assert.match(report, /## Frontend rollback 성공/)
  assert.equal(report.includes('실패'), false)
  assert.equal(report.includes('allow:'), false)
  assert.equal(report.includes('AWS_SECRET'), false)
  assert.equal(report.includes('AWS_SESSION_TOKEN'), false)
  assert.match(report, new RegExp(`요청한 Git SHA: \`${sha}\``))
  assert.match(report, new RegExp(`Run ID: \`${runId}\``))
  assert.match(report, /Run Attempt: `2`/)
  assert.match(report, new RegExp(`매니페스트 키: \`${key}\``))
  assert.match(
    report,
    /S3 복원: 성공 \(`favicon\.svg`, `icons\.svg`, `index\.html`\)/,
  )
  assert.match(
    report,
    new RegExp(`CloudFront invalidation ID: \`${invalidationId}\``),
  )
  assert.match(
    report,
    new RegExp(
      `검증된 CloudFront 경로: ${verifiedPaths.map((path) => `\`${path}\``).join(', ')}`,
    ),
  )
  assert.match(report, /`rollback\(\)` 반환 `deployState`: `closed`/)
  assert.match(
    report,
    /SSM에 `closed`를 기록한 뒤, `index\.html` 복사 직전에 다시 읽었습니다/,
  )
  assert.match(
    report,
    /`index\.html` 복사 이후의 SSM 재조회는 이 반환값에 포함되지 않습니다/,
  )
  assert.match(report, /`verifyRollback\(\)` 반환 `deployState`: `closed`/)
  assert.match(
    report,
    /복원된 객체 바이트 비교와 CloudFront invalidation 전에 SSM을 읽어 `closed`인지 확인했습니다/,
  )
  assert.match(
    report,
    /CloudFront 경로 검증 이후의 SSM 재조회는 하지 않았습니다/,
  )
  assert.match(report, /검증이 성공해도 `closed`를 유지합니다/)
}

function assertFailureReport(report, stage, cause) {
  assert.match(report, /## Frontend rollback 실패/)
  assert.equal(report.includes('## Frontend rollback 성공'), false)
  assert.equal(report.includes('S3 복원: 성공'), false)
  assert.match(report, new RegExp(`단계: \`${stage}\``))
  assert.match(report, new RegExp(`원인: \`${cause}\``))
  assert.match(report, /Freeze를 해제하지 않습니다/)
  assert.match(report, /추가 복원과 재시도는 없습니다/)
}

test('rejects the wrong number of CLI arguments before AWS', async () => {
  const cases = [[], [sha], [sha, runId], [sha, runId, '2', 'extra']]
  for (const argv of cases) {
    let called = false
    const stderr = []
    const stdout = []
    const summaryFile = join(tmpdir(), `rollback-summary-${randomUUID()}.md`)
    const result = await runCli(argv, {
      run: () => {
        called = true
      },
      fetch: async () => {
        called = true
      },
      log: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      summaryFile,
    })
    assert.equal(result.exitCode, 1, argv.join(','))
    assert.equal(called, false, argv.join(','))
    assert.deepEqual(stdout, [], argv.join(','))
    assert.deepEqual(stderr, [`::error::${usage}`], argv.join(','))
    assert.equal(existsSync(summaryFile), false, argv.join(','))
  }
})

test('process entry rejects missing, partial, and invalid arguments', () => {
  const env = { ...process.env }
  delete env.GITHUB_STEP_SUMMARY
  delete env.AWS_ACCESS_KEY_ID
  delete env.AWS_SECRET_ACCESS_KEY
  delete env.AWS_SESSION_TOKEN
  env.AWS_EC2_METADATA_DISABLED = 'true'
  env.AWS_PROFILE = 'rollback-runner-test-does-not-exist'
  env.AWS_CONFIG_FILE = join(tmpdir(), 'rollback-runner-no-aws-config')
  env.AWS_SHARED_CREDENTIALS_FILE = join(
    tmpdir(),
    'rollback-runner-no-aws-credentials',
  )
  const run = (...args) =>
    spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env })
  const missing = run()
  assert.equal(missing.status, 1)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, new RegExp(`::error::${usage}\\n$`))
  const partial = run(sha, runId)
  assert.equal(partial.status, 1)
  assert.equal(partial.stdout, '')
  assert.match(partial.stderr, /Usage:/)
  const invalidSha = run('not-a-sha', runId, '2')
  assert.equal(invalidSha.status, 2)
  assert.equal(invalidSha.stdout, '')
  assert.match(
    invalidSha.stderr,
    /::error::rollback: gitSha: invalid string\n$/,
  )
  const invalidRun = run(sha, '01', '2')
  assert.equal(invalidRun.status, 2)
  assert.equal(invalidRun.stdout, '')
  assert.match(invalidRun.stderr, /::error::rollback: runId: invalid string\n$/)
})

test('runs preflight once inside rollback, then verify, and reports closed', async () => {
  const scenario = await runScenario()
  const { calls, requests, trace, result, value } = scenario
  const full = expectedTrace(value)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(trace, full)
  assert.equal(
    calls.filter(
      (args) =>
        args[1] === 'get-object' && flag(args, '--bucket') === manifestBucket,
    ).length,
    1,
  )
  const manifestAt = trace.findIndex((line) =>
    line.startsWith('s3api get-object'),
  )
  const freezeAt = trace.indexOf('ssm put-parameter closed')
  const verifyAt = trace.lastIndexOf('ssm get-parameter')
  assert.equal(manifestAt, 0)
  assert.equal(trace.indexOf('ssm put-parameter closed', freezeAt + 1), -1)
  assert.ok(freezeAt > manifestAt)
  assert.equal(
    trace[verifyAt - 1],
    `s3api copy-object ${originBucket} index.html`,
  )
  assert.equal(trace.filter((line) => line === 'ssm get-parameter').length, 4)
  for (const key of restoreOrder)
    assert.deepEqual(
      calls.find(
        (args) => args[1] === 'copy-object' && flag(args, '--key') === key,
      ),
      copyArgs(key),
    )
  assert.deepEqual(
    calls.find((args) => args[1] === 'create-invalidation'),
    createArgs(),
  )
  assert.equal(calls.filter((args) => args[1] === 'put-parameter').length, 1)
  assert.equal(calls.filter((args) => args[1] === 'copy-object').length, 3)
  assertNoRelease(calls)
  assertTempFilesRemoved(calls)
  assert.deepEqual(
    requests.map((entry) => decodeURIComponent(new URL(entry.url).pathname)),
    verifiedPaths,
  )
  assert.equal(result.restored.deployState, 'closed')
  assert.deepEqual(result.restored.restored, restoreOrder)
  assert.equal(result.restored.manifestKey, manifestKey(value))
  assert.equal(result.verified.deployState, 'closed')
  assert.equal(result.verified.invalidationId, invalidationId)
  assert.equal(result.verified.distributionId, distributionId)
  assert.deepEqual(result.verified.verified, verifiedPaths)
  assert.deepEqual(scenario.stdout, [result.report])
  assert.deepEqual(scenario.stderr, [])
  assert.equal(summaryText(scenario.summaryFile), result.report)
  assertSuccessReport(result.report, value)
  rmSync(scenario.summaryFile, { force: true })
})

test('does not write the freeze or restore S3 when preflight fails', async () => {
  const denied = await runScenario({
    manifestGets: [{ status: 1, stdout: '', stderr: 'AccessDenied' }],
    heads: [],
    parameters: [],
    puts: [],
    copies: [],
  })
  assert.equal(denied.result.exitCode, 2)
  assert.deepEqual(denied.trace, [
    `s3api get-object ${manifestBucket} ${manifestKey(denied.value)}`,
  ])
  assert.deepEqual(denied.stdout, [])
  assert.deepEqual(denied.requests, [])
  assert.equal(
    denied.calls.some((args) => args[1] === 'put-parameter'),
    false,
  )
  assert.equal(
    denied.calls.some((args) => args[1] === 'copy-object'),
    false,
  )
  assertNoRelease(denied.calls)
  assert.deepEqual(denied.stderr, [
    '::error::rollback: manifest: get-object failed: AccessDenied',
  ])
  const deniedSummary = summaryText(denied.summaryFile)
  assertFailureReport(
    deniedSummary,
    'rollback',
    'rollback: manifest: get-object failed: AccessDenied',
  )
  assert.match(deniedSummary, /성공 값을 반환하기 전에 중단되었습니다/)
  assert.match(deniedSummary, /중단 이후의 SSM 조회 결과가 아닙니다/)
  assert.equal(deniedSummary.includes('deployState'), false)
  rmSync(denied.summaryFile, { force: true })

  const bodies = defaultBodies()
  const value = manifest(bodies)
  const mismatched = await runScenario({
    bodies,
    body: value,
    heads: [preflightRestoreHead({ ...value.restore[0], etag: '"different"' })],
    parameters: [],
    puts: [],
    copies: [],
    objects: [],
    invalidations: [],
    waits: [],
    responses: [],
  })
  assert.equal(mismatched.result.exitCode, 2)
  assert.deepEqual(mismatched.trace, expectedTrace(value).slice(0, 2))
  assert.equal(
    mismatched.calls.some((args) => args[1] === 'put-parameter'),
    false,
  )
  assert.equal(
    mismatched.calls.some((args) => args[1] === 'copy-object'),
    false,
  )
  assert.deepEqual(mismatched.requests, [])
  assert.match(
    mismatched.stderr[0],
    /::error::rollback: index\.html\.ETag: mismatch/,
  )
  assert.equal(
    summaryText(mismatched.summaryFile).includes('deployState'),
    false,
  )
  rmSync(mismatched.summaryFile, { force: true })
})

test('does not call verify when S3 restore fails and does not release the freeze', async () => {
  const scenario = await runScenario({
    parameters: [parameter('open'), parameter('closed')],
    puts: [ok({ Version: 5 })],
    copies: [{ status: 1, stdout: '', stderr: 'NoSuchVersion' }],
    objects: [],
    invalidations: [],
    waits: [],
    responses: [],
  })
  const cause = 'rollback: favicon.svg: copy-object failed: NoSuchVersion'
  assert.equal(scenario.result.exitCode, 2)
  const copied = expectedTrace(scenario.value)
  const copyAt = copied.indexOf(`s3api copy-object ${originBucket} favicon.svg`)
  assert.deepEqual(scenario.trace, copied.slice(0, copyAt + 1))
  assert.equal(
    scenario.calls.filter((args) => args[1] === 'put-parameter').length,
    1,
  )
  assert.equal(
    scenario.calls.filter((args) => args[1] === 'copy-object').length,
    1,
  )
  assert.equal(
    scenario.calls.some((args) => args[0] === 'cloudfront'),
    false,
  )
  assert.deepEqual(scenario.requests, [])
  assert.deepEqual(scenario.stdout, [])
  assertNoRelease(scenario.calls)
  assert.deepEqual(scenario.stderr, [`::error::${cause}`])
  const report = summaryText(scenario.summaryFile)
  assertFailureReport(report, 'rollback', cause)
  assert.equal(report.includes('deployState'), false)
  assert.equal(report.includes(invalidationId), false)
  rmSync(scenario.summaryFile, { force: true })
})

test('fails the run when CloudFront verification fails and does not write again', async () => {
  const scenario = await runScenario({
    responses: [live(Buffer.from('not-the-deployed-html'))],
  })
  const cause = 'verify: /index.html: content mismatch'
  assert.equal(scenario.result.exitCode, 2)
  const copied = expectedTrace(scenario.value)
  const pageAt = copied.indexOf('http /index.html')
  assert.deepEqual(scenario.trace, copied.slice(0, pageAt + 1))
  assert.equal(
    scenario.calls.filter((args) => args[1] === 'put-parameter').length,
    1,
  )
  assert.equal(
    scenario.calls.filter((args) => args[1] === 'copy-object').length,
    3,
  )
  assert.equal(
    scenario.calls.filter((args) => args[1] === 'create-invalidation').length,
    1,
  )
  assert.equal(scenario.requests.length, 1)
  assert.deepEqual(scenario.stdout, [])
  assertNoRelease(scenario.calls)
  const putAt = scenario.calls.findIndex((args) => args[1] === 'put-parameter')
  const invalidationAt = scenario.calls.findIndex(
    (args) => args[1] === 'create-invalidation',
  )
  assert.ok(putAt >= 0 && putAt < invalidationAt)
  assert.equal(
    scenario.calls.some(
      (args, index) => index > invalidationAt && args[1] === 'put-parameter',
    ),
    false,
  )
  assert.deepEqual(scenario.stderr, [`::error::${cause}`])
  const report = summaryText(scenario.summaryFile)
  assertFailureReport(report, 'verify', cause)
  assert.match(report, /`rollback\(\)` 반환 `deployState`: `closed`/)
  assert.match(
    report,
    /검증 실패 이후 SSM을 다시 조회하거나 변경하지 않았습니다/,
  )
  assert.equal(report.includes('검증이 성공해도'), false)
  assert.equal(report.includes(invalidationId), false)
  rmSync(scenario.summaryFile, { force: true })
})

test('keeps a successful rollback successful when the step summary cannot be written', async () => {
  const scenario = await runScenario({ summaryFile: tmpdir() })
  assert.equal(scenario.result.exitCode, 0)
  assert.equal(scenario.stdout.length, 1)
  assertSuccessReport(scenario.stdout[0], scenario.value)
  assert.equal(scenario.stderr.length, 1)
  assert.match(scenario.stderr[0], /^report: /)
  assert.equal(scenario.result.verified.invalidationId, invalidationId)
})

test('workflow calls the rollback entry point on main without a second preflight', () => {
  const text = readFileSync(workflowPath, 'utf8')
  assert.equal(text.includes('preflight.mjs'), false)
  assert.equal(text.includes('Read-only preflight'), false)
  assert.equal(text.includes('pull_request'), false)
  assert.equal(text.includes('\npush:'), false)
  assert.match(
    text,
    /node scripts\/deployment\/rollback-runner\.mjs "\$GIT_SHA" "\$RUN_ID" "\$RUN_ATTEMPT"/,
  )
  assert.equal(text.split('required: true').length - 1, 3)
  assert.equal(
    text.split('Rollback can only run from refs/heads/main').length - 1,
    2,
  )
  assert.match(text, /needs: guard/)
  assert.match(text, /environment: production/)
  assert.match(text, /contents: read/)
  assert.match(text, /id-token: write/)
  assert.match(text, /node-version: '24'/)
  assert.match(text, /aws-region: ap-northeast-2/)
  assert.match(text, /timeout-minutes: 5/)
  assert.match(text, /timeout-minutes: 15/)
  assert.match(
    text,
    /role-to-assume: arn:aws:iam::015454941458:role\/IEEE-github-actions-frontend-rollback-role/,
  )
  assert.match(text, /allowed-account-ids: '015454941458'/)
  assert.match(
    text,
    /aws-actions\/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd/,
  )
  assert.match(text, /actions\/checkout@v4/)
  assert.match(text, /persist-credentials: false/)
  assert.match(text, /actions\/setup-node@v4/)
  assert.match(text, /group: ieee-frontend-production-deploy/)
  assert.match(text, /cancel-in-progress: false/)
  assert.match(text, /queue: max/)
  assert.match(text, /workflow_dispatch:/)
  assert.match(text, /github\.ref == 'refs\/heads\/main'/)
  for (const input of ['git_sha', 'run_id', 'run_attempt']) {
    assert.match(text, new RegExp(`^ {6}${input}:`, 'm'))
    assert.match(text, new RegExp(`inputs\\.${input}`))
  }
  for (const line of text.split('\n')) {
    if (!line.includes('${{ inputs.')) continue
    assert.match(
      line,
      /^ {10}[A-Z0-9_]+: \$\{\{ inputs\.[A-Za-z0-9_]+ \}\}$/,
      line,
    )
  }
})
