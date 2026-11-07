/** Native PWA regression suite. Uses key taps, and asserts the real agents' transcripts. */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const [host, udid, runDir, claudeLog, codexLog, outputDir = 'test-results/native-autocorrect'] = process.argv.slice(2)
if (!host || !udid || !runDir || !claudeLog || !codexLog) throw new Error('Usage: bun check-native.ts SSH_HOST UDID RUN_DIR CLAUDE_JSONL CODEX_JSONL [OUTPUT_DIR]')
const output = resolve(outputDir)
mkdirSync(output, {recursive:true})
const temp = mkdtempSync('/tmp/ac-native-')
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
async function command(args: string[]) {
  const child = Bun.spawn(args, {env:{...process.env, TMUX:undefined}, stdout:'pipe', stderr:'pipe'})
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${stdout}\n${stderr}`)
  return stdout
}
function messages(agent: 'claude' | 'codex') {
  const rows = readFileSync(agent === 'claude' ? claudeLog : codexLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  if (agent === 'claude') return rows.filter(row => row.type === 'user' && row.promptSource === 'typed').map(row => row.message.content.trim())
  return rows.filter(row => row.type === 'event_msg' && row.payload?.type === 'item_completed' && row.payload.item?.type === 'UserMessage')
    .map(row => row.payload.item.content.filter((part: {type:string}) => part.type === 'text').map((part:{text:string}) => part.text).join('').trim())
}
async function waitForSubmission(agent: 'claude' | 'codex', before: number, expected: string) {
  const end = Date.now() + 25000
  while (Date.now() < end && messages(agent).length === before) await Bun.sleep(250)
  // Allow any accidental duplicate Enter to reach the agent, too.
  await Bun.sleep(1500)
  assert.deepEqual(messages(agent).slice(before), [expected], `${agent}: exactly one corrected prompt must be submitted`)
}
const logs = readFileSync(join(runDir, 'app.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const proof = logs.filter(row => row.event === 'client_ios_autocorrect_prototype').at(-1)
assert.equal(proof?.standalone, true, 'Install and launch the real Home Screen PWA first')
assert.equal(proof?.protocol, 'explicit-replacement', 'PWA must load the current candidate')
const results: unknown[] = [{test:'installed PWA', standalone:proof.standalone, protocol:proof.protocol}]
writeFileSync(join(output,'results.json'), JSON.stringify(results,null,2))
const tap = (text: string) => `- tapOn: ${JSON.stringify(text)}\n`
const key = (id: string) => `- tapOn:\n    id: ${id}\n`
for (const agent of ['claude','codex'] as const) {
  for (const variant of ['return', 'length-change', 'resume'] as const) {
    const name = `${agent}-${variant}`
    const before = messages(agent).length
    let flow = 'appId: com.apple.webapp\n---\n'
    if (variant === 'resume') flow += '- pressKey: Home\n- runFlow:\n    when:\n      notVisible: Agentboard\n    commands:\n      - swipe:\n          direction: LEFT\n- tapOn: Agentboard\n'
    flow += `- tapOn:\n    point: "${agent === 'claude' ? '7' : '20'}%,16%"\n- tapOn:\n    point: "40%,45%"\n`
    for (const letter of variant === 'length-change' ? 'dont' : 'teh') flow += tap(letter)
    if (variant === 'length-change') flow += key('space') + key('delete')
    if (variant === 'resume') flow += key('space')
    flow += key('Return')
    const local = join(temp, `${name}.yaml`)
    const remote = `/tmp/ac-native-${udid}-${name}.yaml`
    writeFileSync(local, flow)
    writeFileSync(join(output, `${name}.yaml`), flow)
    await command(['scp', local, `${host}:${remote}`])
    const maestro = `JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ~/.maestro/bin/maestro --udid ${quote(udid)} test ${quote(remote)}`
    const runLog = await command(['ssh', host, maestro])
    writeFileSync(join(output, `${name}.log`), runLog)
    const expected = variant === 'length-change' ? 'don’t' : 'the'
    await waitForSubmission(agent, before, expected)
    const shot = `/tmp/ac-native-${udid}-${name}.png`
    await command(['ssh', host, `xcrun simctl io ${quote(udid)} screenshot ${quote(shot)}`])
    await command(['scp', `${host}:${shot}`, join(output, `${name}.png`)])
    results.push({test:name, expected, submitted:messages(agent).slice(before), passed:true})
    writeFileSync(join(output,'results.json'), JSON.stringify(results,null,2))
    console.log(`PASS ${name}: one submitted ${JSON.stringify(expected)}`)
  }
}
console.log(`Evidence: ${output}`)
