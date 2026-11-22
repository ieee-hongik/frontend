import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import schema from './manifest-v1.schema.json' with { type: 'json' }
import {
  classifyDist,
  manifestKey,
  readManifest,
  validateManifest,
} from './manifest.mjs'

const keys = ['index.html', 'favicon.svg', 'icons.svg']
const asset = 'assets/fonts/brand-Bv_Re-yv.woff2'
const manifest = () => ({
  schemaVersion: 1,
  gitSha: 'abcdef01'.repeat(5),
  runId: '9007199254740993',
  runAttempt: 2,
  completedAt: '2024-02-29T23:59:59.123456Z',
  repository: 'ieee-hongik/frontend',
  ref: 'refs/heads/main',
  originBucket: 'ieee-hongik-frontend-015454941458',
  awsRegion: 'ap-northeast-2',
  distributionId: 'E3FJUV685123A4',
  restore: keys.map((key) => ({
    key,
    versionId: 'opaque+/=id',
    contentType: key.endsWith('.svg')
      ? 'image/svg+xml'
      : 'text/html; charset=utf-8',
    cacheControl: 'no-cache, max-age=0',
    etag: '"opaque-tag-2"',
    size: 1,
  })),
  hashedAssets: [{ key: asset, etag: 'opaque-tag', size: 123 }],
})

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'frontend-manifest-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('accepts a complete manifest and derives its S3 key without losing run ID precision', () => {
  const value = manifest()
  value.restore.reverse()
  assert.equal(validateManifest(value), value)
  assert.equal(
    manifestKey(value),
    'manifests/' + value.gitSha + '/9007199254740993-2.json',
  )
})

test('requires all v1 fields and rejects unknown fields at every object level', () => {
  for (const select of [
    (m) => m,
    (m) => m.restore[0],
    (m) => m.hashedAssets[0],
  ]) {
    for (const field of Object.keys(select(manifest()))) {
      const m = manifest()
      delete select(m)[field]
      assert.throws(() => validateManifest(m), /missing field/)
    }
    const m = manifest()
    select(m).unexpected = true
    assert.throws(() => validateManifest(m), /unknown field/)
  }
})

for (const [field, values] of Object.entries({
  schemaVersion: ['1', 2],
  gitSha: ['f'.repeat(39), 'g'.repeat(40), 'a'.repeat(40) + '\n'],
  runId: [123, '01', '-1', '0', '1.1'],
  runAttempt: ['2', 0, 1.1, 2 ** 53],
  completedAt: [
    '2023-02-29T00:00:00Z',
    '2024-04-31T00:00:00Z',
    '2026-01-01T00:00:00+09:00',
    '2026-01-01T24:00:00Z',
  ],
  repository: ['ieee-hongik/backend'],
  ref: ['refs/heads/dev'],
  originBucket: ['other'],
  awsRegion: ['us-east-1'],
  distributionId: ['other'],
  restore: [null, [], {}],
  hashedAssets: [[], {}],
})) {
  test('rejects invalid ' + field, () => {
    for (const value of values)
      assert.throws(
        () => validateManifest({ ...manifest(), [field]: value }),
        new RegExp(field),
      )
  })
}

test('rejects invalid object metadata', () => {
  for (const [field, values] of Object.entries({
    versionId: [null, 'null', ' null ', '', ' ', 'two tokens', 1],
    contentType: ['', 'html', 'text/html; charset=', 1],
    cacheControl: ['no-cache\r\nextra', null],
    etag: ['', '""', '"broken', 'tag\n', 'two tags', 1],
    size: [-1, 1.5, '0', 2 ** 53],
  })) {
    for (const value of values) {
      const m = manifest()
      m.restore[0][field] = value
      assert.throws(() => validateManifest(m), new RegExp(field))
      if (['etag', 'size'].includes(field)) {
        const a = manifest()
        a.hashedAssets[0][field] = value
        assert.throws(() => validateManifest(a), new RegExp(field))
      }
    }
  }
})

test('size boundaries match the schema for each restore file and hashed assets', () => {
  const restoreSize = schema.properties.restore.items.properties.size
  assert.equal(restoreSize.minimum, 1)
  assert.equal(schema.$defs.size.minimum, 0)
  const value = manifest()
  value.hashedAssets[0].size = 0
  for (const [index, item] of value.restore.entries()) {
    item.size = 0
    assert.throws(() => validateManifest(value), {
      message:
        'manifest.restore[' + index + '].size: integer outside permitted range',
    })
    item.size = 1
    assert.doesNotThrow(() => validateManifest(value))
  }
})

test('allOf and contains agree with runtime for every three-key restore sequence', () => {
  const { allOf } = schema.properties.restore
  for (const first of keys) {
    for (const second of keys) {
      for (const third of keys) {
        const sequence = [first, second, third]
        const value = manifest()
        value.restore.forEach((item, index) => {
          item.key = sequence[index]
        })
        const matches = allOf.every(({ contains }) =>
          sequence.includes(contains.properties.key.const),
        )
        assert.equal(matches, new Set(sequence).size === keys.length)
        if (matches) assert.doesNotThrow(() => validateManifest(value))
        else
          assert.throws(
            () => validateManifest(value),
            /duplicate object key|missing restore file/,
          )
      }
    }
  }
})

test('uniqueItems rejects identical assets and runtime also rejects repeated keys with different metadata', () => {
  assert.equal(schema.properties.hashedAssets.uniqueItems, true)
  const value = manifest()
  const original = value.hashedAssets[0]
  value.hashedAssets.push({ ...original })
  assert.throws(() => validateManifest(value), /duplicate object key/)
  value.hashedAssets[1].etag = 'another-tag'
  assert.throws(() => validateManifest(value), /duplicate object key/)
  value.hashedAssets[1] = { ...original, key: 'assets/second-A1234567.js' }
  assert.doesNotThrow(() => validateManifest(value))
})

test('rejects missing, extra, overlapping and duplicate keys despite different metadata', () => {
  for (const change of [
    (m) => m.restore.pop(),
    (m) => m.restore.push(m.restore[0]),
    (m) => {
      m.restore[0].key = 'robots.txt'
    },
    (m) => {
      m.restore[0].key = 'icons.svg'
    },
    (m) => {
      m.hashedAssets[0].key = 'index.html'
    },
    (m) => {
      m.restore[0].key = asset
    },
    (m) => m.hashedAssets.push({ ...m.hashedAssets[0], size: 10 }),
  ]) {
    const m = manifest()
    change(m)
    assert.throws(() => validateManifest(m))
  }
})

test('schema parses, all regexes compile, and schema inventory constraints agree with runtime', () => {
  function inspect(node) {
    if (!node || typeof node !== 'object') return
    if (node.pattern) assert.doesNotThrow(() => new RegExp(node.pattern, 'u'))
    Object.values(node).forEach(inspect)
  }
  inspect(schema)
  const { restore, hashedAssets } = schema.properties
  assert.deepEqual(
    restore.items.properties.key.enum.toSorted(),
    keys.toSorted(),
  )
  assert.deepEqual(
    restore.allOf.map((rule) => rule.contains.properties.key.const).sort(),
    keys.toSorted(),
  )
  assert.equal(restore.minItems, keys.length)
  assert.equal(restore.maxItems, keys.length)
  assert.equal(hashedAssets.minItems, 1)
  assert.equal(hashedAssets.uniqueItems, true)
  assert.equal(schema.properties.completedAt.format, 'date-time')
  const pattern = new RegExp(schema.$defs.assetKey.pattern, 'u')
  for (const [key, valid] of [
    [asset, true],
    ['assets/index-aB01_-23.js', true],
    ['assets/index.js', false],
    ...['../', './', '/', '%2e%2e/', 'x\\', 'C:/'].map((prefix) => [
      'assets/' + prefix + 'a-12345678.js',
      false,
    ]),
    ['/assets/a-12345678.js', false],
    ['assets/a-12345678.js\n', false],
  ]) {
    const m = manifest()
    m.hashedAssets[0].key = key
    assert.equal(pattern.test(key), valid, key)
    if (valid) assert.doesNotThrow(() => validateManifest(m))
    else assert.throws(() => validateManifest(m))
  }
})

test('classifies a build recursively and fails closed on unexpected or incomplete output', async (t) => {
  const root = await temporaryDirectory(t)
  const path = (key) => join(root, key)
  await mkdir(dirname(path(asset)), { recursive: true })
  for (const key of keys) await writeFile(path(key), 'x')
  await writeFile(path(asset), '')
  assert.deepEqual(await classifyDist(root), {
    restore: keys.toSorted(),
    hashedAssets: [asset],
  })
  for (const key of ['robots.txt', 'assets/unhashed.js']) {
    await writeFile(path(key), '')
    await assert.rejects(classifyDist(root), /unexpected build artifact/)
    await rm(path(key))
  }
  for (const key of keys) {
    await writeFile(path(key), '')
    await assert.rejects(classifyDist(root), {
      message: key + '.size: integer outside permitted range',
    })
    await writeFile(path(key), 'x')
  }
  await mkdir(path('extra'))
  await assert.rejects(classifyDist(root), /unexpected directory/)
  await rm(path('extra'), { recursive: true })
  await rm(path(asset))
  await assert.rejects(classifyDist(root), /at least one asset/)
  await rm(path('index.html'))
  await assert.rejects(classifyDist(root), /missing restore file/)
})

test('reads local JSON and CLI reports success, invalid manifest, malformed JSON and missing input', async (t) => {
  const directory = await temporaryDirectory(t)
  const file = join(directory, 'download.json')
  const cli = fileURLToPath(new URL('./manifest.mjs', import.meta.url))
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
  const value = manifest()
  await writeFile(file, JSON.stringify(value))
  assert.deepEqual(await readManifest(file), value)
  const valid = run(file)
  assert.equal(valid.status, 0, valid.stderr)
  assert.equal(valid.stdout.trim(), manifestKey(value))
  for (const input of ['{}', '{']) {
    await writeFile(file, input)
    await assert.rejects(readManifest(file))
    const invalid = run(file)
    assert.equal(invalid.status, 1)
    assert.ok(invalid.stderr.trim())
  }
  assert.equal(run().status, 1)
  assert.equal(run(join(directory, 'absent')).status, 1)
})
