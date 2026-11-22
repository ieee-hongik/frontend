import { spawnSync } from 'node:child_process'

export function runAws(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    throw new Error('aws: expected string arguments')
  const result = spawnSync('aws', args, { encoding: 'utf8', shell: false })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

export function runCommand(run, args, scope, action) {
  const result = run(args)
  if (result?.status !== 0) {
    const detail =
      typeof result?.stderr === 'string' ? result.stderr.trim() : ''
    const message = `${scope}: ${action} failed`
    throw new Error(detail ? `${message}: ${detail}` : message)
  }
  return result.stdout
}

export function runObjectCommand(run, args, scope, action) {
  const stdout = runCommand(run, args, scope, action)
  const message = `${scope}: invalid ${action} response`
  let value
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error(message)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(message)
  return value
}
