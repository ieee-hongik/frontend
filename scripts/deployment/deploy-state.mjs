import { runObjectCommand } from './aws-cli.mjs'
import schema from './manifest-v1.schema.json' with { type: 'json' }

export const deployStateName = '/ieee/frontend/production/deploy-state'
const shaPattern = new RegExp(schema.properties.gitSha.pattern, 'u')

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

export function readState(run, region, scope) {
  const body = runObjectCommand(
    run,
    getParameterArgs(region),
    scope,
    'get-parameter',
  )
  const parameter = body.Parameter
  if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter))
    throw new Error(`${scope}: invalid get-parameter response`)
  if (parameter.Name !== deployStateName)
    throw new Error(`${scope}: unexpected parameter`)
  if (parameter.Type !== 'String') throw new Error(`${scope}: unexpected type`)
  if (!knownState(parameter.Value))
    throw new Error(`${scope}: unexpected state`)
  return parameter.Value
}

export function requireClosed(run, region, scope) {
  if (readState(run, region, scope) !== 'closed')
    throw new Error(`${scope}: not closed`)
}
