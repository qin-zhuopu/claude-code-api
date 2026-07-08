/**
 * Sprint 串行工作流
 *
 * args 格式:
 * {
 *   tasks: [
 *     { name: "task-1", devPrompt: "...", testCmd: "npm test -- task-1" },
 *     { name: "task-2", devPrompt: "...", testCmd: "npm test -- task-2" },
 *   ],
 *   maxRetries: 3  (可选，默认 3)
 * }
 *
 * 执行规则：
 * - 任务严格按顺序串行执行
 * - 每个任务：dev agent → test agent → 失败则重新 dev → 循环直到全绿
 * - 一个任务完成后才进入下一个
 */
export const meta = {
  name: 'sprint-serial',
  description: 'Sprint 迭代：串行任务，每个任务 dev→test 循环直到测试全绿',
  phases: [{ title: 'Sprint', detail: 'serial dev-test loop' }],
}

// Handle args that might be a JSON string
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : (args || {})
const { tasks = [], maxRetries = 3 } = parsedArgs
const results = {}

for (const task of tasks) {
  phase(`[Task: ${task.name}]`)
  let passed = false
  let attempt = 0

  while (!passed && attempt < maxRetries) {
    attempt++
    log(`  ⏳ ${task.name} attempt ${attempt}/${maxRetries}`)

    // 开发 agent
    const devPrompt = attempt === 1
      ? task.devPrompt
      : `${task.devPrompt}\n\nPrevious test failures:\n${results[task.name]?.lastError || 'N/A'}\nFix the failing tests.`

    const devResult = await agent(devPrompt, {
      label: `dev:${task.name}-a${attempt}`,
    })

    // 测试 agent
    const testResult = await agent(`Run the following test command and report pass/fail:\n${task.testCmd}\n\nReturn JSON: { passed: boolean, output: string, error: string | null }`, {
      label: `test:${task.name}-a${attempt}`,
      schema: {
        type: 'object',
        required: ['passed', 'output'],
        properties: {
          passed: { type: 'boolean' },
          output: { type: 'string' },
          error: { type: ['string', 'null'] },
        },
      },
    })

    if (testResult && testResult.passed) {
      passed = true
      results[task.name] = { passed: true, attempts: attempt }
      log(`  ✅ ${task.name} passed after ${attempt} attempt(s)`)
    } else {
      results[task.name] = {
        passed: false,
        attempt,
        lastError: testResult?.output || testResult?.error || 'Unknown failure',
      }
      log(`  ❌ ${task.name} failed attempt ${attempt}: ${(testResult?.output || '').substring(0, 200)}`)
    }
  }

  if (!passed) {
    log(`  ⚠️ ${task.name} exhausted ${maxRetries} attempts`)
    results[task.name] = { ...results[task.name], passed: false }
  }
}

return { sprint: 'sprint-serial', tasks: results, allPassed: Object.values(results).every(r => r.passed) }
