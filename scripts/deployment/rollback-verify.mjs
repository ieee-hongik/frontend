import { createHash, randomUUID } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { runAws, runCommand, runObjectCommand } from './aws-cli.mjs'
import { manifestKey, validateManifest } from './manifest.mjs'
import { requireClosed } from './deploy-state.mjs'
import { restoreOrder } from './rollback.mjs'

const originBucket = 'ieee-hongik-frontend-015454941458'
const region = 'ap-northeast-2'
const distributionId = 'E3FJUV685123A4'
const cloudfrontDomain = 'dm3mb697l7lxs.cloudfront.net'
// The distribution's default root object is index.html.
const entryPages = [
  ['/index.html', 'index.html'],
  ['/', 'index.html'],
  ['/favicon.svg', 'favicon.svg'],
  ['/icons.svg', 'icons.svg'],
]
const requestTimeoutMs = 30_000
const hashChunkBytes = 64 * 1024
const invalidationIdPattern = /^I[A-Z0-9]{8,128}$/u

function fail(message) {
  throw new Error(message)
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

function getArgs(key, versionId) {
  const args = ['s3api', 'get-object', '--bucket', originBucket, '--key', key]
  if (versionId !== undefined) args.push('--version-id', versionId)
  args.push('--region', region, '--output', 'json')
  return args
}

function createInvalidationArgs() {
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

function waitInvalidationArgs(id) {
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

function assertRestored(restored) {
  if (!Array.isArray(restored)) fail('restore: unexpected restore key')
  for (const [index, key] of restored.entries()) {
    if (restoreOrder[index] !== key)
      fail(`${String(key)}: unexpected restore key`)
  }
  if (restored.length !== restoreOrder.length)
    fail('restore: unexpected restore key')
}

function acceptedManifest(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result))
    fail('rollback: expected an object')
  const manifest = validateManifest(result.manifest)
  if (result.manifestKey !== manifestKey(manifest))
    fail('manifest: object key mismatch')
  if (manifest.originBucket !== originBucket)
    fail('originBucket: manifest mismatch')
  if (manifest.awsRegion !== region) fail('awsRegion: manifest mismatch')
  if (manifest.distributionId !== distributionId)
    fail('distributionId: manifest mismatch')
  if (result.deployState !== 'closed') fail('deploy-state: not closed')
  assertRestored(result.restored)
  return manifest
}

function restoreItem(manifest, key) {
  const item = manifest.restore.find((entry) => entry.key === key)
  if (!item || item.key !== key) fail(`${key}: unexpected restore key`)
  return item
}

function headObject(run, key) {
  return runObjectCommand(run, headArgs(key), key, 'head-object')
}

// CopyObject can change the version id and does not have to keep an MD5 ETag.
function compareRestoredMeta(item, meta) {
  if (meta.ContentType !== item.contentType)
    fail(`${item.key}.ContentType: mismatch`)
  if (meta.CacheControl !== item.cacheControl)
    fail(`${item.key}.CacheControl: mismatch`)
  if (
    !Number.isSafeInteger(meta.ContentLength) ||
    meta.ContentLength !== item.size
  )
    fail(`${item.key}.ContentLength: mismatch`)
}

function compareAssetMeta(item, meta) {
  if (meta.ETag !== item.etag) fail(`${item.key}.ETag: mismatch`)
  if (
    !Number.isSafeInteger(meta.ContentLength) ||
    meta.ContentLength !== item.size
  )
    fail(`${item.key}.ContentLength: mismatch`)
}

async function hashHandle(handle, limit) {
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(hashChunkBytes)
  let size = 0
  while (true) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, size)
    if (bytesRead === 0) break
    size += bytesRead
    // Stop once the object is larger than the manifest. The extra bytes cannot match.
    if (Number.isSafeInteger(limit) && size > limit)
      return { sha256: '', size, overflow: true }
    hash.update(chunk.subarray(0, bytesRead))
  }
  return { sha256: hash.digest('hex'), size, overflow: false }
}

async function hashFile(file, scope, limit) {
  let handle
  try {
    handle = await open(file, 'r')
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'failed'
    fail(`${scope}: unreadable object: ${detail}`)
  }
  try {
    return await hashHandle(handle, limit)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'failed'
    fail(`${scope}: unreadable object: ${detail}`)
  } finally {
    await handle.close()
  }
}

async function readObject(run, args, scope, limit) {
  const file = join(tmpdir(), `frontend-verify-${randomUUID()}`)
  try {
    const body = runObjectCommand(run, [...args, file], scope, 'get-object')
    const bytes = await hashFile(file, scope, limit)
    return { body, bytes }
  } finally {
    await rm(file, { force: true })
  }
}

function assertStoredSize(item, downloaded, stage) {
  if (
    !Number.isSafeInteger(downloaded.body.ContentLength) ||
    downloaded.body.ContentLength !== item.size
  )
    fail(`${item.key}.ContentLength: mismatch`)
  if (downloaded.bytes.overflow || downloaded.bytes.size !== item.size)
    fail(`${item.key}: ${stage}: content mismatch`)
}

async function readVersion(run, item) {
  const downloaded = await readObject(
    run,
    getArgs(item.key, item.versionId),
    `${item.key}: version`,
    item.size,
  )
  if (downloaded.body.VersionId !== item.versionId)
    fail(`${item.key}: unexpected version`)
  assertStoredSize(item, downloaded, 'version')
  return downloaded.bytes
}

async function readCurrent(run, item, scope, compare) {
  const downloaded = await readObject(run, getArgs(item.key), scope, item.size)
  // HEAD can describe an older object than the bytes this GET returned.
  compare(item, downloaded.body)
  assertStoredSize(item, downloaded, 'current')
  return downloaded.bytes
}

async function verifyRestoredObject(run, item) {
  compareRestoredMeta(item, headObject(run, item.key))
  const version = await readVersion(run, item)
  const current = await readCurrent(
    run,
    item,
    `${item.key}: current`,
    compareRestoredMeta,
  )
  if (current.sha256 !== version.sha256) fail(`${item.key}: content mismatch`)
  return { sha256: current.sha256, size: current.size }
}

function invalidationIdFrom(body) {
  const invalidation = body.Invalidation
  if (
    !invalidation ||
    typeof invalidation !== 'object' ||
    Array.isArray(invalidation)
  )
    fail('cloudfront: invalid create-invalidation response')
  const batch = invalidation.InvalidationBatch
  const paths = batch && typeof batch === 'object' ? batch.Paths : undefined
  const items = paths && Array.isArray(paths.Items) ? paths.Items : []
  if (!paths || paths.Quantity !== 1 || items.length !== 1 || items[0] !== '/*')
    fail('cloudfront: unexpected invalidation path')
  if (
    typeof invalidation.Id !== 'string' ||
    !invalidationIdPattern.test(invalidation.Id)
  )
    fail('cloudfront: invalid invalidation id')
  return invalidation.Id
}

function invalidate(run) {
  const body = runObjectCommand(
    run,
    createInvalidationArgs(),
    'cloudfront',
    'create-invalidation',
  )
  const id = invalidationIdFrom(body)
  runCommand(
    run,
    waitInvalidationArgs(id),
    'cloudfront',
    'invalidation-completed',
  )
  return id
}

// Node's fetch can decode gzip, deflate, or brotli and still leave
// Content-Encoding set. Hash the body as returned; decoding it again fails
// a valid rollback. Accept-Encoding: identity does not make this impossible.
async function hashBody(response, pathname, limit) {
  const hash = createHash('sha256')
  let size = 0
  let overflow = false
  try {
    const source = response.body
      ? Readable.fromWeb(response.body)
      : Readable.from([])
    await pipeline(source, async function (upstream) {
      for await (const chunk of upstream) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        if (Number.isSafeInteger(limit) && size + bytes.length > limit) {
          overflow = true
          upstream.destroy()
          return
        }
        size += bytes.length
        hash.update(bytes)
      }
    })
  } catch (error) {
    if (overflow) return { sha256: '', size, overflow: true }
    if (error instanceof Error && error.message.startsWith(`${pathname}:`))
      throw error
    const detail = error instanceof Error ? error.message : 'failed'
    fail(`${pathname}: unreadable response: ${detail}`)
  }
  if (overflow) return { sha256: '', size, overflow: true }
  return { sha256: hash.digest('hex'), size, overflow: false }
}

function timeoutSignal(timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    )
  }, timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer)
    },
  }
}

function errorText(error) {
  if (!(error instanceof Error)) return 'failed'
  if (error.name && error.name !== 'Error')
    return `${error.name}: ${error.message}`
  return error.message
}

async function requestBytes(request, pathname, limit, timeoutMs) {
  const url = `https://${cloudfrontDomain}${pathname}`
  const timeout = timeoutSignal(timeoutMs)
  try {
    let response
    try {
      response = await request(url, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        headers: { 'accept-encoding': 'identity' },
        signal: timeout.signal,
      })
    } catch (error) {
      fail(`${pathname}: request failed: ${errorText(error)}`)
    }
    if (!response || typeof response.status !== 'number')
      fail(`${pathname}: request failed`)
    if (response.type === 'opaqueredirect' || response.redirected)
      fail(`${pathname}: redirect`)
    if (response.status !== 200) fail(`${pathname}: HTTP ${response.status}`)
    return await hashBody(response, pathname, limit)
  } finally {
    timeout.cancel()
  }
}

async function assertRemote(request, pathname, expected, timeoutMs) {
  const actual = await requestBytes(request, pathname, expected.size, timeoutMs)
  if (
    actual.overflow ||
    actual.size !== expected.size ||
    actual.sha256 !== expected.sha256
  )
    fail(`${pathname}: content mismatch`)
}

async function verifyHashedAsset(run, item) {
  compareAssetMeta(item, headObject(run, item.key))
  return readCurrent(run, item, item.key, compareAssetMeta)
}

// Runs only after rollback() has restored every object and left the freeze
// closed. Reads that state, compares restored bytes, invalidates CloudFront,
// then checks the live responses. Never writes SSM or copies, deletes, or uploads.
export async function verifyRollback(
  result,
  {
    run = runAws,
    fetch: request = globalThis.fetch,
    timeoutMs = requestTimeoutMs,
  } = {},
) {
  const manifest = acceptedManifest(result)
  requireClosed(run, region, 'deploy-state: confirm')
  const restored = new Map()
  for (const key of restoreOrder) {
    const bytes = await verifyRestoredObject(run, restoreItem(manifest, key))
    restored.set(key, bytes)
  }
  const id = invalidate(run)
  const verified = []
  for (const [pathname, key] of entryPages) {
    await assertRemote(request, pathname, restored.get(key), timeoutMs)
    verified.push(pathname)
  }
  for (const item of manifest.hashedAssets) {
    const bytes = await verifyHashedAsset(run, item)
    const pathname = `/${item.key}`
    await assertRemote(request, pathname, bytes, timeoutMs)
    verified.push(pathname)
  }
  return {
    manifestKey: result.manifestKey,
    manifest,
    deployState: 'closed',
    distributionId,
    invalidationId: id,
    verified,
  }
}
