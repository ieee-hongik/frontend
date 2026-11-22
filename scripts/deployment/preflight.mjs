import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { manifestKey, validateManifest } from './manifest.mjs'
import schema from './manifest-v1.schema.json' with { type: 'json' }

const manifestBucket =
  'ieee-hongik-frontend-deployments-015454941458-ap-northeast-2-an'
const originBucket = 'ieee-hongik-frontend-015454941458'
const region = 'ap-northeast-2'
const decimalPattern = new RegExp(schema.properties.runId.pattern, 'u')
const shaPattern = new RegExp(schema.properties.gitSha.pattern, 'u')
const { minimum: attemptMin, maximum: attemptMax } =
  schema.properties.runAttempt

function fail(message) {
  throw new Error(message)
}

function commandFailed(scope, action, result) {
  const detail = typeof result?.stderr === 'string' ? result.stderr.trim() : ''
  fail(detail ? `${scope}: ${action}: ${detail}` : `${scope}: ${action}`)
}

function parsedJson(text, message) {
  try {
    return JSON.parse(text)
  } catch {
    fail(message)
  }
}

function parsedObject(text, message) {
  const value = parsedJson(text, message)
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(message)
  return value
}

function s3args(command, pairs, positional = []) {
  return [
    's3api',
    command,
    ...pairs.flat(),
    '--region',
    region,
    '--output',
    'json',
    ...positional,
  ]
}

function parseRollbackInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('input: expected an object')
  const { gitSha, runId, runAttempt } = input
  if (typeof gitSha !== 'string' || !shaPattern.test(gitSha))
    fail('gitSha: invalid string')
  if (typeof runId !== 'string' || !decimalPattern.test(runId))
    fail('runId: invalid string')
  if (typeof runAttempt !== 'string' || !decimalPattern.test(runAttempt))
    fail('runAttempt: invalid string')
  const attempt = Number(runAttempt)
  if (
    !Number.isSafeInteger(attempt) ||
    attempt < attemptMin ||
    attempt > attemptMax
  )
    fail('runAttempt: integer outside permitted range')
  return {
    gitSha,
    runId,
    runAttempt: attempt,
    key: `manifests/${gitSha}/${runId}-${attempt}.json`,
  }
}

function assertManifestAgrees(request, manifest) {
  if (manifest.gitSha !== request.gitSha) fail('gitSha: manifest mismatch')
  if (manifest.runId !== request.runId) fail('runId: manifest mismatch')
  if (manifest.runAttempt !== request.runAttempt)
    fail('runAttempt: manifest mismatch')
  if (manifestKey(manifest) !== request.key)
    fail('manifest: object key mismatch')
  if (manifest.originBucket !== originBucket)
    fail('originBucket: manifest mismatch')
  if (manifest.awsRegion !== region) fail('awsRegion: manifest mismatch')
}

function mismatch(path) {
  fail(`${path}: mismatch`)
}

function compareRestore(expected, head) {
  if (head.VersionId === 'null' || head.VersionId !== expected.versionId)
    mismatch(`${expected.key}.VersionId`)
  if (head.ETag !== expected.etag) mismatch(`${expected.key}.ETag`)
  if (
    !Number.isSafeInteger(head.ContentLength) ||
    head.ContentLength < 1 ||
    head.ContentLength !== expected.size
  )
    mismatch(`${expected.key}.ContentLength`)
  if (head.ContentType !== expected.contentType)
    mismatch(`${expected.key}.ContentType`)
  if (head.CacheControl !== expected.cacheControl)
    mismatch(`${expected.key}.CacheControl`)
}

function compareAsset(expected, head) {
  if (head.ETag !== expected.etag) mismatch(`${expected.key}.ETag`)
  if (
    !Number.isSafeInteger(head.ContentLength) ||
    head.ContentLength < 0 ||
    head.ContentLength !== expected.size
  )
    mismatch(`${expected.key}.ContentLength`)
}

function headArgs(key, versionId) {
  const pairs = [
    ['--bucket', originBucket],
    ['--key', key],
  ]
  if (versionId !== undefined) pairs.push(['--version-id', versionId])
  return s3args('head-object', pairs)
}

function fetchHead(run, args, key) {
  const result = run(args)
  if (result?.status !== 0) commandFailed(key, 'head-object failed', result)
  return parsedObject(result.stdout, `${key}: invalid head-object response`)
}

// Exact key only: the rollback role cannot list the manifest bucket.
async function fetchManifest(run, key) {
  const file = join(tmpdir(), `frontend-preflight-${randomUUID()}.json`)
  try {
    const result = run(
      s3args(
        'get-object',
        [
          ['--bucket', manifestBucket],
          ['--key', key],
        ],
        [file],
      ),
    )
    if (result?.status !== 0)
      commandFailed('manifest', 'get-object failed', result)
    parsedObject(result.stdout, 'manifest: invalid get-object response')
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      fail('manifest: invalid manifest JSON')
    }
    return parsedJson(text, 'manifest: invalid manifest JSON')
  } finally {
    await rm(file, { force: true })
  }
}

function runAws(args) {
  const result = spawnSync('aws', args, { encoding: 'utf8' })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

export async function preflight(input, { run = runAws } = {}) {
  const request = parseRollbackInput(input)
  const manifest = validateManifest(await fetchManifest(run, request.key))
  assertManifestAgrees(request, manifest)
  for (const item of manifest.restore) {
    compareRestore(
      item,
      fetchHead(run, headArgs(item.key, item.versionId), item.key),
    )
  }
  for (const item of manifest.hashedAssets)
    compareAsset(item, fetchHead(run, headArgs(item.key), item.key))
  return { manifestKey: request.key, manifest }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  try {
    if (args.length !== 3)
      throw new Error(
        'Usage: node scripts/deployment/preflight.mjs <gitSha> <runId> <runAttempt>',
      )
    const [gitSha, runId, runAttempt] = args
    const { manifestKey: key } = await preflight({ gitSha, runId, runAttempt })
    console.log(key)
  } catch (error) {
    console.error(error.message)
    process.exitCode = args.length === 0 ? 1 : 2
  }
}
