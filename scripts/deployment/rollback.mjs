import { runAws, runObjectCommand } from './aws-cli.mjs'
import { preflight } from './preflight.mjs'
import { deployStateName, readState, requireClosed } from './deploy-state.mjs'

export const restoreOrder = Object.freeze([
  'favicon.svg',
  'icons.svg',
  'index.html',
])
const copyPathPattern = /^[A-Za-z0-9._~-]+$/u

function fail(message) {
  throw new Error(message)
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

function writeClosed(run, region) {
  const body = runObjectCommand(
    run,
    putClosedArgs(region),
    'deploy-state',
    'put-parameter',
  )
  if (!Number.isSafeInteger(body.Version) || body.Version < 1)
    fail('deploy-state: invalid put-parameter response')
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
  const body = runObjectCommand(
    run,
    copyArgs(bucket, region, item),
    item.key,
    'copy-object',
  )
  const copy = body.CopyObjectResult
  if (!copy || typeof copy !== 'object' || Array.isArray(copy))
    fail(`${item.key}: copy-object: invalid CopyObjectResult`)
  if (typeof copy.ETag !== 'string' || !copy.ETag.trim())
    fail(`${item.key}: copy-object: invalid ETag`)
  if (body.CopySourceVersionId !== item.versionId)
    fail(`${item.key}: copy-object: unexpected CopySourceVersionId`)
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

// No CLI. scripts/deployment/rollback-runner.mjs is the workflow entry point.
