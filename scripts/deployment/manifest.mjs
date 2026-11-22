import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import schema from './manifest-v1.schema.json' with { type: 'json' }

const restoreFields = schema.properties.restore.items.properties
const restoreKeys = restoreFields.key.enum
const assetPattern = new RegExp(schema.$defs.assetKey.pattern, 'u')

function invalid(path, reason) {
  throw new Error(`${path}: ${reason}`)
}

// Read scalar and object constraints from the published v1 contract.
function checkFields(value, rule, path) {
  if (rule.$ref) {
    return checkFields(value, schema.$defs[rule.$ref.split('/').at(-1)], path)
  }
  if ('const' in rule && value !== rule.const) invalid(path, 'unexpected value')
  if (rule.enum && !rule.enum.includes(value)) invalid(path, 'unknown key')
  if (rule.not && value === rule.not.const) invalid(path, 'invalid value')

  switch (rule.type) {
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        invalid(path, 'expected an object')
      }
      for (const name of rule.required) {
        if (!Object.hasOwn(value, name))
          invalid(`${path}.${name}`, 'missing field')
      }
      for (const [name, field] of Object.entries(value)) {
        if (!Object.hasOwn(rule.properties, name))
          invalid(`${path}.${name}`, 'unknown field')
        checkFields(field, rule.properties[name], `${path}.${name}`)
      }
      break
    case 'array':
      if (
        !Array.isArray(value) ||
        value.length < rule.minItems ||
        value.length > (rule.maxItems ?? Infinity)
      ) {
        invalid(path, 'invalid list or item count')
      }
      for (const [index, item] of value.entries())
        checkFields(item, rule.items, `${path}[${index}]`)
      break
    case 'integer':
      if (
        !Number.isSafeInteger(value) ||
        value < rule.minimum ||
        value > rule.maximum
      ) {
        invalid(path, 'integer outside permitted range')
      }
      break
    case 'string':
      if (
        typeof value !== 'string' ||
        !new RegExp(rule.pattern, 'u').test(value)
      ) {
        invalid(path, 'invalid string')
      }
      if (rule.format === 'date-time') {
        const day = value.slice(0, 10)
        const date = new Date(day)
        if (
          !Number.isFinite(date.valueOf()) ||
          !date.toISOString().startsWith(day + 'T')
        ) {
          invalid(path, 'invalid calendar date')
        }
      }
      break
  }
}

function checkInventory(restoreList, assetList) {
  const seen = new Set()
  for (const list of [restoreList, assetList]) {
    for (const key of list) {
      if (seen.has(key)) invalid(key, 'duplicate object key')
      seen.add(key)
    }
  }
  for (const key of restoreKeys) {
    if (!seen.has(key)) invalid(key, 'missing restore file')
  }
  if (!assetList.length) invalid('hashedAssets', 'expected at least one asset')
}

export function validateManifest(manifest) {
  checkFields(manifest, schema, 'manifest')
  checkInventory(
    manifest.restore.map(({ key }) => key),
    manifest.hashedAssets.map(({ key }) => key),
  )
  return manifest
}

export async function readManifest(file) {
  return validateManifest(JSON.parse(await readFile(file, 'utf8')))
}

export function manifestKey(manifest) {
  const { gitSha, runId, runAttempt } = validateManifest(manifest)
  return `manifests/${gitSha}/${runId}-${runAttempt}.json`
}

export async function classifyDist(directory) {
  const restore = []
  const hashedAssets = []
  async function walk(prefix) {
    for (const entry of await readdir(join(directory, prefix), {
      withFileTypes: true,
    })) {
      const key = prefix + entry.name
      if (entry.isDirectory()) {
        // A directory must be a valid prefix for an asset, including empty directories.
        if (!assetPattern.test(key + '/file-abcdefgh.js'))
          invalid(key, 'unexpected directory')
        await walk(key + '/')
      } else if (!entry.isFile()) {
        invalid(key, 'expected a regular file')
      } else if (restoreKeys.includes(key)) {
        const file = await lstat(join(directory, key))
        if (!file.isFile()) invalid(key, 'expected a regular file')
        checkFields(file.size, restoreFields.size, key + '.size')
        restore.push(key)
      } else if (assetPattern.test(key)) {
        hashedAssets.push(key)
      } else {
        invalid(key, 'unexpected build artifact')
      }
    }
  }
  if (!(await lstat(directory)).isDirectory())
    invalid(directory, 'expected a directory')
  await walk('')
  checkInventory(restore, hashedAssets)
  return { restore: restore.sort(), hashedAssets: hashedAssets.sort() }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3)
      throw new Error(
        'Usage: node scripts/deployment/manifest.mjs <manifest.json>',
      )
    const manifest = await readManifest(process.argv[2])
    console.log(manifestKey(manifest))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
