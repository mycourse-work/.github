import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflowPath = join(repoRoot, '.github', 'workflows', 'sync-to-r2.yml')

const PLATFORM_DB_ID = '7f5cc97d-9745-471c-bc3d-b2f208b42ae8'
const TENANT_DB_ID = '11111111-2222-3333-4444-555555555555'
const DUMMY_ENV = { TENANT_ID: 'dronetrust', CLOUDFLARE_ACCOUNT_ID: 'fixture-account', CLOUDFLARE_API_TOKEN: 'fixture-token' }

const PLATFORM_SCHEMA = `
CREATE TABLE tenant_registry (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain_primary TEXT NOT NULL UNIQUE,
  database_name TEXT NOT NULL,
  database_id TEXT NOT NULL,
  branding TEXT NOT NULL DEFAULT '{}',
  auth TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active'
);
`

const TENANT_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  r2_base_path TEXT NOT NULL,
  r2_manifest_path TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  total_modules INTEGER DEFAULT 0,
  total_lessons INTEGER DEFAULT 0,
  total_quizzes INTEGER DEFAULT 0,
  cover_image TEXT,
  access_type TEXT NOT NULL DEFAULT 'public',
  access_sku TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  manifest_format TEXT DEFAULT 'monolithic',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE modules (
  id TEXT PRIMARY KEY,
  r2_base_path TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  estimated_duration TEXT,
  tags TEXT,
  total_lessons INTEGER DEFAULT 0,
  total_quizzes INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE course_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  slot_type TEXT DEFAULT 'core',
  elective_group_id TEXT,
  slot_order INTEGER DEFAULT 0,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
  UNIQUE(course_id, slot_id)
);
CREATE TABLE widgets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  r2_path TEXT,
  github_path TEXT,
  tags TEXT,
  status TEXT DEFAULT 'active',
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`

function extractRegisterScript(yamlText) {
  const match = yamlText.match(/node << 'REGISTER_SCRIPT'\n([\s\S]*?)\n[ \t]*REGISTER_SCRIPT/)
  assert.ok(match, 'Could not find REGISTER_SCRIPT heredoc in sync-to-r2.yml')
  const lines = match[1].split('\n')
  const indent = lines.reduce((min, line) => {
    if (!line.trim()) return min
    const spaces = line.match(/^[ ]*/)[0].length
    return Math.min(min, spaces)
  }, Infinity)
  return lines.map(line => line.slice(Math.min(indent, line.length))).join('\n')
}

function createMockD1Server({ platformDb, tenantDb, fault } = {}) {
  const calls = []
  const dbs = new Map([
    [PLATFORM_DB_ID, platformDb],
    [TENANT_DB_ID, tenantDb],
  ])

  function runStatement(db, stmt) {
    assert.equal(typeof stmt.sql, 'string', 'sql must be a string')
    assert.ok(Buffer.byteLength(stmt.sql) <= 100_000, `SQL exceeded 100 KB D1 limit: ${Buffer.byteLength(stmt.sql)}`)
    const params = Array.isArray(stmt.params) ? stmt.params : []
    assert.ok(params.length <= 100, `Statement bound ${params.length} params (D1 limit is 100)`)
    const prepared = db.prepare(stmt.sql)
    if (/^\s*SELECT\b/i.test(stmt.sql)) {
      return { success: true, results: prepared.all(...params) }
    }
    prepared.run(...params)
    return { success: true, results: [] }
  }

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url, 'http://127.0.0.1')
    const match = url.pathname.match(/^\/client\/v4\/accounts\/([^/]+)\/d1\/database\/([^/]+)\/query$/)
    if (!match || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: false, errors: [{ message: 'Not found' }] }))
      return
    }
    const dbId = match[2]
    const body = JSON.parse(rawBody)
    const callIndex = calls.length
    const isBatch = Array.isArray(body.batch)
    calls.push({
      dbId,
      isBatch,
      statementCount: isBatch ? body.batch.length : 1,
      maxParams: isBatch
        ? Math.max(0, ...body.batch.map(s => (s.params || []).length))
        : (body.params || []).length,
      bodyBytes: Buffer.byteLength(rawBody),
      body,
    })

    if (fault) {
      const override = fault({ callIndex, dbId, body })
      if (override) {
        res.writeHead(override.status ?? 200, { 'content-type': override.contentType ?? 'application/json' })
        res.end(typeof override.body === 'string' ? override.body : JSON.stringify(override.body))
        return
      }
    }

    const db = dbs.get(dbId)
    if (!db) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: false, errors: [{ message: `Unknown DB ${dbId}` }] }))
      return
    }

    try {
      assert.ok(calls[callIndex].statementCount <= 50, 'D1 request exceeded 50 statements')
      assert.ok(calls[callIndex].bodyBytes <= 512 * 1024, 'D1 request exceeded 512 KiB')
      if (isBatch) assert.equal(body.sql, undefined, 'D1 request cannot combine sql and batch')
      // Each statement commits independently to exercise failures without batch rollback.
      const results = (isBatch ? body.batch : [body]).map(stmt => runStatement(db, stmt))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, result: results }))
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: false, errors: [{ code: 7500, message: err.message }] }))
    }
  })

  return {
    calls,
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      return `http://127.0.0.1:${server.address().port}`
    },
    async close() {
      await new Promise(resolve => server.close(resolve))
    },
  }
}

function createFixtureDatabases(tenantId = 'dronetrust', {
  platformSchema = PLATFORM_SCHEMA, tenantSchema = TENANT_SCHEMA,
} = {}) {
  const platformDb = new DatabaseSync(':memory:')
  platformDb.exec(platformSchema)
  platformDb.prepare(
    "INSERT INTO tenant_registry (id, name, domain_primary, database_name, database_id, branding, auth) VALUES (?, ?, ?, ?, ?, '{}', '{}')"
  ).run(tenantId, tenantId, `${tenantId}.example`, `cv-tenant-${tenantId}`, TENANT_DB_ID)

  const tenantDb = new DatabaseSync(':memory:')
  tenantDb.function('datetime', (_value) => '2026-11-25 00:00:00')
  tenantDb.exec(tenantSchema)
  assert.equal(tenantDb.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  return { platformDb, tenantDb }
}

async function runScript(scriptSource, { cwd, env, mockOrigin }) {
  const work = mkdtempSync(join(repoRoot, 'd1-register-run-'))
  try {
    const scriptFile = join(work, 'register.cjs')
    writeFileSync(scriptFile, scriptSource)
    const preloadFile = join(work, 'mock-fetch.mjs')
    writeFileSync(preloadFile, `
      const origFetch = globalThis.fetch;
      const target = ${JSON.stringify(mockOrigin || '')};
      globalThis.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (target && url.startsWith('https://api.cloudflare.com/')) {
          return origFetch(target + url.slice('https://api.cloudflare.com'.length), init);
        }
        throw new Error('Blocked unexpected network request: ' + url);
      };
    `)
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, ['--import', preloadFile, scriptFile], {
        cwd,
        env: { PATH: process.env.PATH, ...env },
        encoding: 'utf8',
      })
      return { exitCode: 0, stdout, stderr }
    } catch (err) {
      return {
        exitCode: typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout?.toString('utf8') ?? '',
        stderr: err.stderr?.toString('utf8') ?? '',
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function writeDroneTrustSizedRepo(dir, { modules = 33, courses = 6, widgets = 85 } = {}) {
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'courses'), { recursive: true })
  if (widgets > 0) mkdirSync(join(dir, 'widgets'), { recursive: true })

  const moduleIds = []
  for (let i = 0; i < modules; i++) {
    const id = `mod-${String(i + 1).padStart(2, '0')}`
    moduleIds.push(id)
    mkdirSync(join(dir, 'modules', id), { recursive: true })
    const lessons = [
      { id: 'l1', title: 'Lesson 1', type: 'content', markdownPath: '01.md' },
      { id: 'l2', title: 'Lesson 2', type: 'content', markdownPath: '02.md' },
      ...(i % 2 === 0 ? [{ id: 'q1', title: 'Quiz', type: 'quiz', quizPath: 'quiz.json' }] : []),
    ]
    writeFileSync(join(dir, 'modules', id, 'manifest.json'), JSON.stringify({
      id,
      title: `Module ${i + 1}`,
      description: i % 3 === 0 ? undefined : `Description for ${id}`,
      lessons,
    }))
  }

  for (let c = 0; c < courses; c++) {
    const id = `course-${c + 1}`
    mkdirSync(join(dir, 'courses', id), { recursive: true })
    const start = Math.floor((c * modules) / courses)
    const end = Math.floor(((c + 1) * modules) / courses)
    const assigned = moduleIds.slice(start, end)
    writeFileSync(join(dir, 'courses', id, 'course.json'), JSON.stringify({
      id,
      title: `Course ${c + 1}`,
      description: `Desc ${c + 1}`,
      ...(c === 0 ? { coverImage: 'assets/cover.webp' } : {}),
      modules: assigned,
    }))
  }

  for (let w = 0; w < widgets; w++) {
    writeFileSync(join(dir, 'widgets', `widget-item-${String(w + 1).padStart(2, '0')}.html`), '<p>ok</p>')
  }
}

const scriptSource = extractRegisterScript(readFileSync(workflowPath, 'utf8'))

test('registers a DroneTrust-sized repo in 3 HTTP calls and preserves upsert/delete semantics', async () => {
  const repoDir = mkdtempSync(join(repoRoot, 'd1-dt-fixture-'))
  const { platformDb, tenantDb } = createFixtureDatabases('dronetrust')

  // Seed pre-existing rows to verify ON CONFLICT DO UPDATE preserves status/access_type and deletes stale junctions.
  tenantDb.prepare(
    "INSERT INTO modules (id, r2_base_path, title, description, total_lessons, total_quizzes, status) VALUES ('mod-01', 'old', 'Old Title', 'Old', 99, 99, 'active')"
  ).run()
  tenantDb.prepare(
    "INSERT INTO courses (id, r2_base_path, r2_manifest_path, title, description, total_modules, total_lessons, total_quizzes, access_type, status, manifest_format) VALUES ('course-1', 'old', 'old', 'Old Course', 'Old', 1, 1, 0, 'paid', 'published', 'blueprint')"
  ).run()
  tenantDb.prepare(
    "INSERT INTO course_modules (course_id, module_id, slot_id, slot_type, slot_order) VALUES ('course-1', 'mod-01', 'stale-slot', 'core', 99)"
  ).run()
  tenantDb.prepare(
    "INSERT INTO widgets (id, title, r2_path, github_path, status) VALUES ('widget-item-01', 'Custom Kept Title', 'old', 'old', 'active')"
  ).run()

  const mock = createMockD1Server({ platformDb, tenantDb })
  const origin = await mock.start()
  try {
    writeDroneTrustSizedRepo(repoDir, { modules: 33, courses: 6, widgets: 85 })
    const result = await runScript(scriptSource, {
      cwd: repoDir,
      mockOrigin: origin,
      env: { TENANT_ID: 'dronetrust', CLOUDFLARE_ACCOUNT_ID: 'acct-1', CLOUDFLARE_API_TOKEN: 'tok-1' },
    })
    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
    assert.equal(mock.calls.length, 3, 'Expected lookup, upserts and cleanup')
    assert.equal(mock.calls[0].dbId, PLATFORM_DB_ID)
    assert.equal(mock.calls[0].isBatch, false)
    assert.equal(mock.calls[1].dbId, TENANT_DB_ID)
    assert.equal(mock.calls[1].isBatch, true)
    assert.ok(mock.calls[1].maxParams <= 96)

    assert.equal(tenantDb.prepare('SELECT COUNT(*) AS n FROM modules').get().n, 33)
    assert.equal(tenantDb.prepare('SELECT COUNT(*) AS n FROM courses').get().n, 6)
    assert.equal(tenantDb.prepare('SELECT COUNT(*) AS n FROM course_modules').get().n, 33)
    assert.equal(tenantDb.prepare('SELECT COUNT(*) AS n FROM widgets').get().n, 85)

    // Pre-existing course keeps its access_type/status and gets updated counts & rebuilt junctions.
    const c1 = tenantDb.prepare("SELECT * FROM courses WHERE id = 'course-1'").get()
    assert.equal(c1.title, 'Course 1')
    assert.equal(c1.access_type, 'paid')
    assert.equal(c1.status, 'published')
    assert.equal(c1.cover_image, 'assets/cover.webp')
    const stale = tenantDb.prepare("SELECT * FROM course_modules WHERE slot_id = 'stale-slot'").all()
    assert.equal(stale.length, 0)

    // Pre-existing widget keeps its title and updates r2_path/github_path (matching original ON CONFLICT clause).
    const w1 = tenantDb.prepare("SELECT * FROM widgets WHERE id = 'widget-item-01'").get()
    assert.equal(w1.title, 'Custom Kept Title')
    assert.equal(w1.r2_path, 'tenants/dronetrust/widgets/widget-item-01.html')
  } finally {
    await mock.close()
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('skips registration with exit 0 and zero HTTP calls when Cloudflare credentials are missing', async () => {
  const repoDir = mkdtempSync(join(repoRoot, 'd1-skip-'))
  const { platformDb, tenantDb } = createFixtureDatabases('dronetrust')
  const mock = createMockD1Server({ platformDb, tenantDb })
  const origin = await mock.start()
  try {
    for (const env of [
      { TENANT_ID: 'dronetrust', CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: 'tok' },
      { TENANT_ID: 'dronetrust', CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: '' },
      { TENANT_ID: '', CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' },
    ]) {
      const result = await runScript(scriptSource, { cwd: repoDir, mockOrigin: origin, env })
      assert.equal(result.exitCode, 0, result.stderr)
      assert.match(result.stdout, /Cloudflare credentials not configured, skipping D1 registration/)
    }
    assert.equal(mock.calls.length, 0)
  } finally {
    await mock.close()
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('handles missing widgets dir, empty repo, and large tenants across multiple batches', async () => {
  // Empty repo: only 1 platform lookup call, 0 tenant batch calls.
  const emptyDir = mkdtempSync(join(repoRoot, 'd1-empty-'))
  const { platformDb: p1, tenantDb: t1 } = createFixtureDatabases('empty-tenant')
  const m1 = createMockD1Server({ platformDb: p1, tenantDb: t1 })
  const o1 = await m1.start()
  try {
    const res = await runScript(scriptSource, {
      cwd: emptyDir,
      mockOrigin: o1,
      env: { TENANT_ID: 'empty-tenant', CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' },
    })
    assert.equal(res.exitCode, 0, res.stderr)
    assert.equal(m1.calls.length, 1)
  } finally {
    await m1.close()
    rmSync(emptyDir, { recursive: true, force: true })
  }

  // Large tenant uses separate upsert and cleanup requests.
  const largeDir = mkdtempSync(join(repoRoot, 'd1-large-'))
  const { platformDb: p2, tenantDb: t2 } = createFixtureDatabases('big-tenant')
  const m2 = createMockD1Server({ platformDb: p2, tenantDb: t2 })
  const o2 = await m2.start()
  try {
    writeDroneTrustSizedRepo(largeDir, { modules: 120, courses: 30, widgets: 200 })
    const res = await runScript(scriptSource, {
      cwd: largeDir,
      mockOrigin: o2,
      env: { TENANT_ID: 'big-tenant', CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' },
    })
    assert.equal(res.exitCode, 0, res.stderr)
    assert.ok(m2.calls.length >= 3, `Expected multiple batch calls for large tenant, got ${m2.calls.length}`)
    assert.ok(m2.calls.every(c => c.maxParams <= 96))
    assert.equal(t2.prepare('SELECT COUNT(*) AS n FROM modules').get().n, 120)
    assert.equal(t2.prepare('SELECT COUNT(*) AS n FROM courses').get().n, 30)
    assert.equal(t2.prepare('SELECT COUNT(*) AS n FROM course_modules').get().n, 120)
    assert.equal(t2.prepare('SELECT COUNT(*) AS n FROM widgets').get().n, 200)
  } finally {
    await m2.close()
    rmSync(largeDir, { recursive: true, force: true })
  }
})

test('fails the step with non-zero exit when any batch statement or API response fails', async () => {
  const repoDir = mkdtempSync(join(repoRoot, 'd1-fail-'))
  writeDroneTrustSizedRepo(repoDir, { modules: 2, courses: 1, widgets: 2 })

  const faultCases = [
    {
      name: 'HTTP 502 with non-JSON body',
      fault: ({ callIndex }) => callIndex === 1 && { status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' },
    },
    {
      name: 'top-level success: false',
      fault: ({ callIndex }) => callIndex === 1 && { status: 200, body: { success: false, errors: [{ message: 'D1 overloaded' }] } },
    },
    {
      name: 'individual statement success: false inside batch',
      fault: ({ callIndex, body }) => callIndex === 1 && {
        status: 200,
        body: {
          success: true,
          result: body.batch.map((_, idx) => ({ success: idx !== 1, results: [], ...(idx === 1 ? { error: 'constraint failed' } : {}) })),
        },
      },
    },
    {
      name: 'result length shorter than batch',
      fault: ({ callIndex }) => callIndex === 1 && {
        status: 200,
        body: { success: true, result: [{ success: true, results: [] }] },
      },
    },
  ]

  try {
    for (const tc of faultCases) {
      const { platformDb, tenantDb } = createFixtureDatabases('dronetrust')
      const mock = createMockD1Server({ platformDb, tenantDb, fault: tc.fault })
      const origin = await mock.start()
      try {
        const res = await runScript(scriptSource, {
          cwd: repoDir,
          mockOrigin: origin,
          env: { TENANT_ID: 'dronetrust', CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' },
        })
        assert.notEqual(res.exitCode, 0, `${tc.name} must fail the step`)
        assert.match(res.stderr, /D1 registration failed:/)
      } finally {
        await mock.close()
      }
    }
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('splits inserts by serialized UTF-8 bytes and rejects an oversized single row before tenant writes', async () => {
  const repoDir = mkdtempSync(join(repoRoot, 'd1-byte-limit-'))
  const { platformDb, tenantDb } = createFixtureDatabases()
  const mock = createMockD1Server({ platformDb, tenantDb })
  const mockOrigin = await mock.start()
  const description = '🚀'.repeat(10_000)
  try {
    writeDroneTrustSizedRepo(repoDir, { modules: 16, courses: 1, widgets: 0 })
    for (let i = 1; i <= 16; i++) {
      const id = `mod-${String(i).padStart(2, '0')}`
      writeFileSync(join(repoDir, 'modules', id, 'manifest.json'), JSON.stringify({ id, description }))
    }
    const run = () => runScript(scriptSource, { cwd: repoDir, mockOrigin, env: DUMMY_ENV })
    const result = await run()
    assert.equal(result.exitCode, 0, result.stderr)
    assert.ok(mock.calls.filter(call => call.dbId === TENANT_DB_ID && call.bodyBytes > 40_000).length >= 2)
    const descriptions = tenantDb.prepare('SELECT description FROM modules').all()
    assert.equal(descriptions.length, 16)
    assert.ok(descriptions.every(row => row.description === description))

    writeFileSync(join(repoDir, 'modules', 'mod-16', 'manifest.json'), JSON.stringify({ description: description.repeat(14) }))
    mock.calls.length = 0
    const oversized = await run()
    assert.equal(oversized.exitCode, 1)
    assert.match(oversized.stderr, /D1 insert row exceeds statement or request limits/)
    assert.deepEqual(mock.calls.map(call => call.dbId), [PLATFORM_DB_ID])
  } finally {
    await mock.close()
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('keeps every request within 50 statements for a single course with 1,177 junctions', async () => {
  const repoDir = mkdtempSync(join(repoRoot, 'd1-statement-limit-'))
  const { platformDb, tenantDb } = createFixtureDatabases()
  const mock = createMockD1Server({ platformDb, tenantDb })
  const mockOrigin = await mock.start()
  try {
    writeDroneTrustSizedRepo(repoDir, { modules: 2, courses: 1, widgets: 0 })
    const modules = Array.from({ length: 1_177 }, (_, i) => i % 2 ? 'mod-02' : 'mod-01')
    writeFileSync(join(repoDir, 'courses', 'course-1', 'course.json'), JSON.stringify({ modules }))
    const result = await runScript(scriptSource, { cwd: repoDir, mockOrigin, env: DUMMY_ENV })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.ok(mock.calls.some(call => call.statementCount === 50))
    const junctions = tenantDb.prepare('SELECT module_id, slot_id, slot_order FROM course_modules ORDER BY slot_order').all()
    assert.deepEqual(junctions.map(row => [row.module_id, row.slot_id, row.slot_order]),
      modules.map((id, i) => [id, `core-${i}`, i]))
  } finally {
    await mock.close()
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('keeps existing junctions through a partial install and retains the new set through a failure after pruning', async () => {
  const repoDir = mkdtempSync(join(repoRoot, 'd1-junction-fail-'))
  const { platformDb, tenantDb } = createFixtureDatabases()
  const mock = createMockD1Server({ platformDb, tenantDb })
  const mockOrigin = await mock.start()
  try {
    writeDroneTrustSizedRepo(repoDir, { modules: 30, courses: 1, widgets: 1 })
    tenantDb.exec(`
      INSERT INTO courses (id, title, r2_base_path, r2_manifest_path) VALUES ('course-1', 'Old', 'old', 'old');
      INSERT INTO modules (id, title, r2_base_path) VALUES ('mod-01', 'Old', 'old');
      INSERT INTO course_modules (course_id, module_id, slot_id, slot_order)
        VALUES ('course-1', 'mod-01', 'core-26', 26), ('course-1', 'mod-01', 'stale', 99);
      CREATE TRIGGER fail_install BEFORE INSERT ON course_modules
        WHEN NEW.slot_id = 'core-24' BEGIN SELECT RAISE(ABORT, 'fixture install failure'); END;
    `)
    const existing = tenantDb.prepare("SELECT * FROM course_modules WHERE slot_id IN ('core-26', 'stale') ORDER BY id")
    const before = existing.all()
    const run = () => runScript(scriptSource, { cwd: repoDir, mockOrigin, env: DUMMY_ENV })

    const failedInstall = await run()
    assert.equal(failedInstall.exitCode, 1)
    assert.match(failedInstall.stderr, /fixture install failure/)
    assert.deepEqual(existing.all(), before)
    assert.equal(tenantDb.prepare('SELECT count(*) AS n FROM course_modules').get().n, 26)
    assert.ok(mock.calls.every(call => !call.body.batch?.some(stmt => /^DELETE /i.test(stmt.sql))))

    tenantDb.exec(`
      DROP TRIGGER fail_install;
      CREATE TRIGGER fail_widget BEFORE INSERT ON widgets
        BEGIN SELECT RAISE(ABORT, 'fixture widget failure'); END;
    `)
    const failedAfterDelete = await run()
    assert.equal(failedAfterDelete.exitCode, 1)
    assert.match(failedAfterDelete.stderr, /fixture widget failure/)
    assert.equal(tenantDb.prepare("SELECT module_id FROM course_modules WHERE slot_id = 'core-26'").get().module_id, 'mod-27')
    assert.equal(tenantDb.prepare("SELECT count(*) AS n FROM course_modules WHERE slot_id = 'stale'").get().n, 0)
    assert.equal(tenantDb.prepare('SELECT count(*) AS n FROM course_modules').get().n, 30)
  } finally {
    await mock.close()
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('registers modules, courses and earlier widgets when a widget has an empty title segment', async () => {
  const repoDir = mkdtempSync(join(repoRoot, 'd1-widget-name-'))
  const { platformDb, tenantDb } = createFixtureDatabases()
  const mock = createMockD1Server({ platformDb, tenantDb })
  const mockOrigin = await mock.start()
  try {
    writeDroneTrustSizedRepo(repoDir, { modules: 1, courses: 1, widgets: 0 })
    mkdirSync(join(repoDir, 'widgets'))
    for (const name of ['air-check.html', 'flight--check.html', 'weather-check.html']) {
      writeFileSync(join(repoDir, 'widgets', name), '<p>ok</p>')
    }
    const result = await runScript(scriptSource, { cwd: repoDir, mockOrigin, env: DUMMY_ENV })
    assert.equal(result.exitCode, 0, result.stderr)
    for (const table of ['modules', 'courses', 'course_modules']) {
      assert.equal(tenantDb.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 1, table)
    }
    assert.deepEqual(tenantDb.prepare('SELECT title FROM widgets').all().map(row => row.title), ['Air Check'])
  } finally {
    await mock.close()
    rmSync(repoDir, { recursive: true, force: true })
  }
})

// Fetch these revisions in the two source repos before running the differential offline:
// D1_PLATFORM_REPO=/path/to/course.platform D1_CONTENT_REPO=/path/to/dronetrust \
//   node --test --test-reporter=dot --test-name-pattern='pinned-base' tests/register-d1.test.mjs
const BASE_SHA = '4367ef784203fd10f9717d681619011f33fee7d3'
const PLATFORM_SHA = '850db6c364290b8b33b3ba7c95ab2aee511b0960'
const CONTENT_SHA = 'ad2622ace95bd34ebf3502b4c70716085663440b'
const platformRepo = process.env.D1_PLATFORM_REPO
const contentRepo = process.env.D1_CONTENT_REPO

function gitRead(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GIT_NO_LAZY_FETCH: '1' },
  })
}

test('pinned-base differential matches every catalog column on the DroneTrust fixture', {
  skip: !(platformRepo || contentRepo) && 'Set D1_PLATFORM_REPO and D1_CONTENT_REPO to enable',
}, async () => {
  assert.ok(platformRepo && contentRepo, 'Set both D1_PLATFORM_REPO and D1_CONTENT_REPO')
  const baseScript = extractRegisterScript(gitRead(repoRoot, 'show', `${BASE_SHA}:.github/workflows/sync-to-r2.yml`))
  const migration = file => gitRead(platformRepo, 'show', `${PLATFORM_SHA}:workers/edge-router/migrations/${file}`)
  const platformSchema = migration('platform/001_catalog.sql')
  const tenantSchema = ['001_tenant_schema.sql', '006_modules_and_electives.sql', '007_widgets.sql']
    .map(file => migration(`tenant/${file}`)).join('\n')

  const files = gitRead(contentRepo, 'ls-tree', '-r', '--name-only', CONTENT_SHA, '--', 'courses', 'modules', 'widgets')
    .trimEnd().split('\n')
    .filter(file => /^(courses\/[^/]+\/course\.json|modules\/[^/]+\/manifest\.json|widgets\/[^/]+\.html)$/.test(file))
  const firstCourse = files.find(file => file.startsWith('courses/'))
  const course = JSON.parse(gitRead(contentRepo, 'show', `${CONTENT_SHA}:${firstCourse}`))
  const courseId = course.id || firstCourse.split('/')[1]
  const moduleId = course.modules[0]
  const firstWidgetId = files.find(file => file.startsWith('widgets/')).slice('widgets/'.length, -'.html'.length)
  const repoDir = mkdtempSync(join(repoRoot, 'd1-differential-'))
  try {
    for (const file of files) {
      const target = join(repoDir, file)
      mkdirSync(dirname(target), { recursive: true })
      // The workflow only reads widget filenames.
      writeFileSync(target, file.startsWith('widgets/') ? '' : gitRead(contentRepo, 'show', `${CONTENT_SHA}:${file}`))
    }

    async function snapshot(source, expectedCalls) {
      const { platformDb, tenantDb } = createFixtureDatabases('dronetrust', { platformSchema, tenantSchema })
      const mock = createMockD1Server({ platformDb, tenantDb })
      const mockOrigin = await mock.start()
      try {
        const moduleInsert = tenantDb.prepare("INSERT INTO modules (id, title, r2_base_path, status) VALUES (?, 'Old', 'old', 'draft')")
        moduleInsert.run(moduleId)
        moduleInsert.run('removed-module')
        const courseInsert = tenantDb.prepare(
          "INSERT INTO courses (id, title, r2_base_path, r2_manifest_path, access_type, status) VALUES (?, 'Old', 'old', 'old', 'paid', 'published')")
        courseInsert.run(courseId)
        courseInsert.run('removed-course')
        const slotInsert = tenantDb.prepare(
          "INSERT INTO course_modules (course_id, module_id, slot_id, slot_type, elective_group_id, slot_order) VALUES (?, ?, ?, 'elective', 'group', 99)")
        slotInsert.run(courseId, 'removed-module', 'core-0')
        slotInsert.run(courseId, 'removed-module', 'stale')
        slotInsert.run('removed-course', 'removed-module', 'core-0')
        const widgetInsert = tenantDb.prepare("INSERT INTO widgets (id, title, status) VALUES (?, 'Custom title', 'draft')")
        widgetInsert.run(firstWidgetId)
        widgetInsert.run('removed-widget')

        const result = await runScript(source, { cwd: repoDir, mockOrigin, env: DUMMY_ENV })
        assert.equal(result.exitCode, 0, result.stderr)
        assert.equal(mock.calls.length, expectedCalls)
        return Object.fromEntries(['modules', 'courses', 'course_modules', 'widgets'].map(table =>
          [table, tenantDb.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]))
      } finally {
        await mock.close()
        tenantDb.close()
        platformDb.close()
      }
    }

    const base = await snapshot(baseScript, 164)
    const head = await snapshot(scriptSource, 3)
    for (const [table, count] of Object.entries({ modules: 34, courses: 7, course_modules: 34, widgets: 86 })) {
      assert.equal(head[table].length, count, table)
      assert.deepEqual(head[table], base[table], table)
    }
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})
