import { spawnSync } from 'node:child_process'
import { preflight } from './preflight.mjs'
import schema from './manifest-v1.schema.json' with { type: 'json' }

const deployStateName = '/ieee/frontend/production/deploy-state'
const restoreOrder = ['favicon.svg', 'icons.svg', 'index.html']
const copyPathPattern = /^[A-Za-z0-9._~-]+$/u
const shaPattern = new RegExp(schema.properties.gitSha.pattern, 'u')

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

function knownState(value) {
  return (
    value === 'open' ||
    value === 'closed' ||
    (typeof value === 'string' &&
      value.startsWith('allow:') &&
      shaPattern.test(value.slice('allow:'.length)))
  )
}

function getParameterArgs(region) {
  return [
    'ssm',
    'get-parameter',
    '--name',
    deployStateName,
    '--region',
    region,
    '--output',
    'json',
  ]
}

function putClosedArgs(region) {
  return [
    'ssm',
    'put-parameter',
    '--name',
    deployStateName,
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

function readState(run, region, scope) {
  const result = run(getParameterArgs(region))
  if (result?.status !== 0) commandFailed(scope, 'get-parameter failed', result)
  const body = parsedObject(
    result.stdout,
    `${scope}: invalid get-parameter response`,
  )
  const parameter = body.Parameter
  if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter))
    fail(`${scope}: invalid get-parameter response`)
  if (parameter.Name !== deployStateName) fail(`${scope}: unexpected parameter`)
  if (parameter.Type !== 'String') fail(`${scope}: unexpected type`)
  if (!knownState(parameter.Value)) fail(`${scope}: unexpected state`)
  return parameter.Value
}

function writeClosed(run, region) {
  const result = run(putClosedArgs(region))
  if (result?.status !== 0)
    commandFailed('deploy-state', 'put-parameter failed', result)
  const body = parsedObject(
    result.stdout,
    'deploy-state: invalid put-parameter response',
  )
  if (!Number.isSafeInteger(body.Version) || body.Version < 1)
    fail('deploy-state: invalid put-parameter response')
}

function requireClosed(run, region, scope) {
  if (readState(run, region, scope) !== 'closed') fail(`${scope}: not closed`)
}

function orderRestore(manifest) {
  const seen = new Set()
  for (const item of manifest.restore) {
    if (seen.has(item.key) || !restoreOrder.includes(item.key))
      fail(`${item.key}: unexpected restore key`)
    seen.add(item.key)
  }
  if (seen.size !== restoreOrder.length) fail('restore: unexpected restore key')
  return restoreOrder.map((key) => {
    const item = manifest.restore.find((entry) => entry.key === key)
    if (!item || item.key !== key) fail(`${key}: unexpected restore key`)
    return item
  })
}

// Botocore preserves the version query suffix. Encode its value exactly once.
function copyArgs(bucket, region, item) {
  const key = item.key
  const versionId = item.versionId
  if (!restoreOrder.includes(key) || !copyPathPattern.test(key))
    fail(`${key}: unexpected restore key`)
  if (!copyPathPattern.test(bucket)) fail(`${key}: unexpected restore bucket`)
  if (
    typeof versionId !== 'string' ||
    versionId.length === 0 ||
    versionId === 'null' ||
    /\s/u.test(versionId)
  )
    fail(`${key}: unexpected version`)
  // One key is both the copy source and the destination. Nothing is deleted.
  return [
    's3api',
    'copy-object',
    '--bucket',
    bucket,
    '--key',
    key,
    '--copy-source',
    `${bucket}/${key}?versionId=${encodeURIComponent(versionId)}`,
    '--metadata-directive',
    'COPY',
    '--region',
    region,
    '--output',
    'json',
  ]
}

function copyVersion(run, bucket, region, item) {
  const result = run(copyArgs(bucket, region, item))
  if (result?.status !== 0)
    commandFailed(item.key, 'copy-object failed', result)
  const body = parsedObject(
    result.stdout,
    `${item.key}: invalid copy-object response`,
  )
  const copy = body.CopyObjectResult
  if (!copy || typeof copy !== 'object' || Array.isArray(copy))
    fail(`${item.key}: copy-object: invalid CopyObjectResult`)
  if (typeof copy.ETag !== 'string' || !copy.ETag.trim())
    fail(`${item.key}: copy-object: invalid ETag`)
  if (body.CopySourceVersionId !== item.versionId)
    fail(`${item.key}: copy-object: unexpected CopySourceVersionId`)
}

function runAws(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    fail('aws: expected string arguments')
  const result = spawnSync('aws', args, { encoding: 'utf8', shell: false })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

export async function rollback(input, { run = runAws } = {}) {
  const checked = await preflight(input, { run })
  const { manifest } = checked
  const targets = orderRestore(manifest)
  const region = manifest.awsRegion
  const bucket = manifest.originBucket
  // open, closed, and allow:<sha> are readable. closed is a retry after a
  // failed attempt: overwrite it with closed again and continue. This step
  // never writes open or allow:<sha>, including when a later copy fails.
  readState(run, region, 'deploy-state: read')
  writeClosed(run, region)
  requireClosed(run, region, 'deploy-state: confirm')
  for (const item of targets) {
    if (item.key === 'index.html')
      requireClosed(run, region, 'index.html: before-copy')
    copyVersion(run, bucket, region, item)
  }
  return {
    manifestKey: checked.manifestKey,
    manifest,
    deployState: 'closed',
    restored: targets.map((item) => item.key),
  }
}

// No CLI. frontend-rollback.yml must not invoke this module yet.
