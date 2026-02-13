import * as fs from 'node:fs/promises'
import path from 'node:path'
import * as ts from 'typescript'

const ROOT_DIR = process.cwd()
const SRC_DIR = path.join(ROOT_DIR, 'src')
const COVERAGE_FILE = path.join(ROOT_DIR, 'coverage', 'lcov.info')
const INCLUDED_EXTENSIONS = new Set(['.ts', '.tsx'])
const EXCLUDED_DIRS = new Set(['__tests__', '__mocks__'])
const EXCLUDED_FILE_PATTERN = /\.(test|spec)\.(ts|tsx)$/

type Range = [number, number]

async function main() {
  const lcovText = await readCoverageFile()
  const coveredFiles = extractCoveredFiles(lcovText)
  const sourceFiles = await listSourceFiles(SRC_DIR)
  const missingFiles = sourceFiles.filter(
    (file) => !coveredFiles.has(toPosix(path.relative(ROOT_DIR, file)))
  )

  const addedRecords: string[] = []
  let skippedTypeOnly = 0

  for (const file of missingFiles) {
    const record = await buildEmptyRecord(file)
    if (record) {
      addedRecords.push(record)
    } else {
      skippedTypeOnly += 1
    }
  }

  const output = buildOutput(lcovText, addedRecords)
  await fs.mkdir(path.dirname(COVERAGE_FILE), { recursive: true })
  await fs.writeFile(COVERAGE_FILE, `${output}\n`)

  const totals = extractLineTotals(output)
  const percent = totals.total === 0 ? 100 : (totals.hit / totals.total) * 100

  console.log(
    `Full-project line coverage: ${percent.toFixed(2)}% (${totals.hit}/${totals.total})`
  )
  console.log(`Added ${addedRecords.length} files with 0 line coverage`)
  if (skippedTypeOnly > 0) {
    console.log(`Skipped ${skippedTypeOnly} type-only files with no executable lines`)
  }
  await writeSummary({
    percent,
    totals,
    addedFileCount: addedRecords.length,
    skippedTypeOnly,
  })
}

async function readCoverageFile() {
  try {
    return await fs.readFile(COVERAGE_FILE, 'utf8')
  } catch {
    throw new Error(
      `Coverage file not found at ${COVERAGE_FILE}. Run bun test --coverage first.`
    )
  }
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      files.push(...(await listSourceFiles(path.join(dir, entry.name))))
      continue
    }

    if (!entry.isFile()) continue

    const fullPath = path.join(dir, entry.name)
    const ext = path.extname(entry.name)
    if (!INCLUDED_EXTENSIONS.has(ext)) continue
    if (entry.name.endsWith('.d.ts')) continue
    if (EXCLUDED_FILE_PATTERN.test(entry.name)) continue
    files.push(fullPath)
  }

  return files
}

function extractCoveredFiles(lcovText: string): Set<string> {
  const covered = new Set<string>()
  for (const line of lcovText.split('\n')) {
    if (!line.startsWith('SF:')) continue
    const rawPath = line.slice(3).trim()
    if (!rawPath) continue
    const absolute = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(ROOT_DIR, rawPath)
    covered.add(toPosix(path.relative(ROOT_DIR, absolute)))
  }
  return covered
}

async function buildEmptyRecord(filePath: string): Promise<string | null> {
  const sourceText = await fs.readFile(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true
  )
  const coverableLines = collectCoverableLines(sourceFile, sourceText)
  if (coverableLines.length === 0) {
    return null
  }

  const relativePath = toPosix(path.relative(ROOT_DIR, filePath))
  const daLines = coverableLines.map((line) => `DA:${line},0`)

  return [
    'TN:',
    `SF:${relativePath}`,
    ...daLines,
    `LF:${coverableLines.length}`,
    'LH:0',
    'end_of_record',
  ].join('\n')
}

function collectCoverableLines(
  sourceFile: ts.SourceFile,
  sourceText: string
): number[] {
  const excludedRanges = collectExcludedRanges(sourceFile)
  const mergedRanges = mergeRanges(excludedRanges)
  const lines = new Set<number>()
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    sourceFile.languageVariant,
    sourceText
  )

  let rangeIndex = 0
  let token = scanner.scan()
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    const pos = scanner.getTokenPos()
    while (
      rangeIndex < mergedRanges.length &&
      pos >= mergedRanges[rangeIndex][1]
    ) {
      rangeIndex += 1
    }

    const isExcluded =
      rangeIndex < mergedRanges.length &&
      pos >= mergedRanges[rangeIndex][0] &&
      pos < mergedRanges[rangeIndex][1]

    if (!isExcluded && isSignificantToken(token)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(pos)
      lines.add(line + 1)
    }

    token = scanner.scan()
  }

  return Array.from(lines).toSorted((a, b) => a - b)
}

function collectExcludedRanges(sourceFile: ts.SourceFile): Range[] {
  const ranges: Range[] = []

  const hasDeclareModifier = (node: ts.Node) => {
    if (!ts.canHaveModifiers(node)) return false
    const modifiers = ts.getModifiers(node)
    return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
  }

  const mark = (node: ts.Node) => {
    ranges.push([node.getStart(sourceFile, false), node.getEnd()])
  }

  const visit = (node: ts.Node) => {
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      mark(node)
      return
    }

    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) {
      mark(node)
      return
    }

    if (ts.isImportEqualsDeclaration(node) && node.isTypeOnly) {
      mark(node)
      return
    }

    if (ts.isExportDeclaration(node) && node.isTypeOnly) {
      mark(node)
      return
    }

    if (
      hasDeclareModifier(node) &&
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isVariableStatement(node))
    ) {
      mark(node)
      return
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return ranges
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.toSorted((a, b) => a[0] - b[0])
  const merged: Range[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (!last || range[0] > last[1]) {
      merged.push([...range])
    } else {
      last[1] = Math.max(last[1], range[1])
    }
  }
  return merged
}

function isSignificantToken(kind: ts.SyntaxKind) {
  if (kind === ts.SyntaxKind.Identifier) return true
  if (kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword) {
    return true
  }
  if (
    kind >= ts.SyntaxKind.FirstLiteralToken &&
    kind <= ts.SyntaxKind.LastLiteralToken
  ) {
    return true
  }
  if (kind === ts.SyntaxKind.JsxText) return true
  return false
}

function extractLineTotals(lcovText: string) {
  let total = 0
  let hit = 0

  for (const line of lcovText.split('\n')) {
    if (line.startsWith('LF:')) {
      total += Number(line.slice(3))
    } else if (line.startsWith('LH:')) {
      hit += Number(line.slice(3))
    }
  }

  return { total, hit }
}

function buildOutput(existing: string, records: string[]) {
  const chunks: string[] = []
  const trimmed = existing.trim()
  if (trimmed) {
    chunks.push(existing.trimEnd())
  }
  chunks.push(...records)
  return chunks.join('\n')
}

function toPosix(value: string) {
  return value.split(path.sep).join('/')
}

async function writeSummary({
  percent,
  totals,
  addedFileCount,
  skippedTypeOnly,
}: {
  percent: number
  totals: { total: number; hit: number }
  addedFileCount: number
  skippedTypeOnly: number
}) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return

  const lines = [
    '## Coverage',
    '',
    `- Full-project line coverage: ${percent.toFixed(2)}% (${totals.hit}/${totals.total})`,
    `- Added files with 0 line coverage: ${addedFileCount}`,
  ]
  if (skippedTypeOnly > 0) {
    lines.push(`- Skipped type-only files: ${skippedTypeOnly}`)
  }

  await fs.appendFile(summaryPath, `${lines.join('\n')}\n`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
