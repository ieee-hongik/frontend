import { appendFileSync } from 'node:fs'
import process from 'node:process'
import { rollback } from './rollback.mjs'
import { verifyRollback } from './rollback-verify.mjs'

const usage =
  'Usage: node scripts/deployment/rollback-runner.mjs <gitSha> <runId> <runAttempt>'

function stageError(stage, error) {
  const message = error instanceof Error ? error.message : 'rollback failed'
  const wrapped = new Error(`${stage}: ${message}`, { cause: error })
  wrapped.stage = stage
  return wrapped
}

function summaryTarget(options) {
  if (Object.hasOwn(options, 'summaryFile')) return options.summaryFile || ''
  return process.env.GITHUB_STEP_SUMMARY || ''
}

function writeSummary(markdown, target) {
  if (!target) return
  appendFileSync(target, markdown.endsWith('\n') ? markdown : `${markdown}\n`)
}

function publish(markdown, options) {
  try {
    writeSummary(markdown, summaryTarget(options))
  } catch (error) {
    const stderr = options.stderr ?? console.error
    const message = error instanceof Error ? error.message : 'summary failed'
    stderr(`report: ${message}`)
  }
}

function assertReported(input, restored, verified) {
  if (!restored || typeof restored !== 'object')
    throw stageError('report', new Error('rollback result is missing'))
  if (!verified || typeof verified !== 'object')
    throw stageError('report', new Error('verify result is missing'))
  if (restored.manifestKey !== verified.manifestKey)
    throw stageError('report', new Error('manifest key mismatch'))
  const manifest = verified.manifest
  if (!manifest || manifest.gitSha !== input.gitSha)
    throw stageError('report', new Error('gitSha mismatch'))
  if (manifest.runId !== input.runId)
    throw stageError('report', new Error('runId mismatch'))
  if (String(manifest.runAttempt) !== String(input.runAttempt))
    throw stageError('report', new Error('runAttempt mismatch'))
  if (restored.deployState !== 'closed' || verified.deployState !== 'closed')
    throw stageError('report', new Error('deploy-state is not closed'))
  if (!Array.isArray(restored.restored) || restored.restored.length === 0)
    throw stageError('report', new Error('restored keys are missing'))
  if (!Array.isArray(verified.verified) || verified.verified.length === 0)
    throw stageError('report', new Error('verified paths are missing'))
  if (
    typeof verified.invalidationId !== 'string' ||
    verified.invalidationId.length === 0
  )
    throw stageError('report', new Error('invalidation id is missing'))
}

function renderSuccess(input, restored, verified) {
  assertReported(input, restored, verified)
  const paths = verified.verified.map((path) => `\`${path}\``).join(', ')
  return [
    '## Frontend rollback 성공',
    '',
    `- 요청한 Git SHA: \`${input.gitSha}\``,
    `- Run ID: \`${input.runId}\``,
    `- Run Attempt: \`${input.runAttempt}\``,
    `- 매니페스트 키: \`${verified.manifestKey}\``,
    `- S3 복원: 성공 (\`${restored.restored.join('`, `')}\`)`,
    `- CloudFront invalidation ID: \`${verified.invalidationId}\``,
    `- 검증된 CloudFront 경로: ${paths}`,
    '',
    '### Freeze',
    '',
    `- \`rollback()\` 반환 \`deployState\`: \`${restored.deployState}\``,
    '  - 확인 시점: SSM에 `closed`를 기록한 뒤, `index.html` 복사 직전에 다시 읽었습니다.',
    '  - `index.html` 복사 이후의 SSM 재조회는 이 반환값에 포함되지 않습니다.',
    `- \`verifyRollback()\` 반환 \`deployState\`: \`${verified.deployState}\``,
    '  - 확인 시점: 복원된 객체 바이트 비교와 CloudFront invalidation 전에 SSM을 읽어 `closed`인지 확인했습니다.',
    '  - CloudFront 경로 검증 이후의 SSM 재조회는 하지 않았습니다.',
    '- 이번 실행은 Freeze를 해제하지 않습니다. 검증이 성공해도 `closed`를 유지합니다.',
    '',
  ].join('\n')
}

function oneLine(error) {
  const message = error instanceof Error ? error.message : 'rollback failed'
  return message.replace(/`/g, "'").replace(/\s+/g, ' ').trim()
}

function failureStage(error) {
  if (error?.stage === 'verify' || error?.stage === 'report') return error.stage
  return 'rollback'
}

function renderFailure(error) {
  const stage = failureStage(error)
  const lines = [
    '## Frontend rollback 실패',
    '',
    `- 단계: \`${stage}\``,
    `- 원인: \`${oneLine(error)}\``,
    '',
  ]
  if (stage === 'verify' && error.deployState === 'closed') {
    lines.push(
      '- `rollback()` 반환 `deployState`: `closed`',
      '  - 확인 시점: SSM에 `closed`를 기록한 뒤, `index.html` 복사 직전에 다시 읽었습니다.',
      '  - 검증 실패 이후 SSM을 다시 조회하거나 변경하지 않았습니다.',
    )
  } else if (stage === 'report') {
    lines.push(
      '- 결과 보고가 확인된 실행 결과와 일치하지 않아 성공으로 표시하지 않았습니다.',
      '- 이 보고를 위해 SSM을 다시 조회하거나 Freeze를 변경하지 않았습니다.',
    )
  } else {
    lines.push(
      '- `rollback()`이 성공 값을 반환하기 전에 중단되었습니다.',
      '- 이 실패 보고는 중단 이후의 SSM 조회 결과가 아닙니다.',
    )
  }
  lines.push('- Freeze를 해제하지 않습니다. 추가 복원과 재시도는 없습니다.', '')
  return lines.join('\n')
}

// rollback() runs preflight before it writes the freeze or copies objects.
// verifyRollback() then checks those objects and CloudFront. This runner does
// not call preflight again, and it never releases the freeze.
export async function executeRollback(input, options = {}) {
  const run = options.run
  const rollbackOptions = run ? { run } : {}
  const verifyOptions = {}
  if (run) verifyOptions.run = run
  if (options.fetch) verifyOptions.fetch = options.fetch
  if (options.timeoutMs !== undefined)
    verifyOptions.timeoutMs = options.timeoutMs

  let restored
  try {
    restored = await rollback(input, rollbackOptions)
  } catch (error) {
    throw stageError('rollback', error)
  }

  let verified
  try {
    verified = await verifyRollback(restored, verifyOptions)
  } catch (error) {
    const wrapped = stageError('verify', error)
    if (restored.deployState === 'closed') wrapped.deployState = 'closed'
    throw wrapped
  }

  const report = renderSuccess(input, restored, verified)
  publish(report, options)
  ;(options.log ?? console.log)(report)
  return { restored, verified, report }
}

export async function runCli(argv, options = {}) {
  const stderr = options.stderr ?? console.error
  try {
    if (!Array.isArray(argv) || argv.length !== 3) throw new Error(usage)
    const [gitSha, runId, runAttempt] = argv
    const outcome = await executeRollback(
      { gitSha, runId, runAttempt },
      options,
    )
    return { exitCode: 0, ...outcome }
  } catch (error) {
    stderr(`::error::${oneLine(error)}`)
    if (error?.stage) publish(renderFailure(error), options)
    return { exitCode: error?.stage ? 2 : 1, error }
  }
}

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2))
  process.exitCode = result.exitCode
}
