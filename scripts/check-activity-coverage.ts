// Keep the feature threshold separate: the repository runner invokes several
// Bun processes, each of which replaces the default LCOV report.
const reportPath = process.argv[2] ?? 'coverage/activity/lcov.info'
const required = ['activityReducer.ts', 'sessionActivity.ts', 'sessionActivityClient.ts', 'sessionActivityProtocol.ts']
const records = (await Bun.file(reportPath).text()).split('end_of_record')
const files = required.map(name => {
  const record = records.find(record => record.includes(`SF:src/server/${name}\n`))
  if (!record) throw new Error(`Missing activity coverage: ${name}`)
  const lines = [...record.matchAll(/^DA:(\d+),(\d+)/gm)]
  const missed = lines.filter(([, , count]) => Number(count) === 0).map(([, line]) => Number(line))
  if (!lines.length || missed.length) throw new Error(`${name}: uncovered lines ${missed.join(', ') || '(empty report)'}`)
  return { file: `src/server/${name}`, lines: lines.length, covered: lines.length, percent: 100 }
})
const summary = { scope: 'Core activity backend line coverage; browser and worker entrypoint behavior is verified separately by E2E', files }
await Bun.write(new URL('./summary.json', Bun.pathToFileURL(reportPath)), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
