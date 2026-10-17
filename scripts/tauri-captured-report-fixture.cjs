// Make a read-only-source QA copy of captured questions, not credentials or sessions.
// The real profile's statuses, answers and files are never changed.
const fs = require('node:fs'), path = require('node:path')
const Database = require('../tauri-app/runtime/node_modules/better-sqlite3')
const file = process.argv[2]
if (!file || !path.isAbsolute(file) || !fs.existsSync(file)) throw Error('Provide the captured profile data.db explicitly')
const source = new Database(file, { readonly: true })
const profile = fs.mkdtempSync('/private/tmp/wrong-answer-tauri-captured-')
const target = new Database(path.join(profile, 'data.db'))
try {
  const questions = source.prepare("SELECT * FROM questions WHERE import_source = 'fenbi' ORDER BY created_at LIMIT 100").all()
  if (!questions.length) throw Error('No captured Fenbi questions to verify')
  const tables = new Set(source.prepare('PRAGMA table_list').all().filter(row => row.type === 'table' && !row.name.startsWith('sqlite_')).map(row => row.name))
  for (const {name,sql} of source.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all()) if (tables.has(name)) target.exec(sql)
  for (const {tbl_name,sql} of source.prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all()) if (tables.has(tbl_name)) target.exec(sql)
  target.transaction(() => {
    for (const [table, rows] of [['question_groups', source.prepare('SELECT * FROM question_groups').all()], ['questions', questions]]) {
      for (const row of rows) {
        const columns = Object.keys(row)
        target.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]))
      }
    }
    target.prepare("UPDATE questions SET status='confirmed', confirmed_at=COALESCE(confirmed_at,created_at)").run()
    target.prepare('INSERT INTO config(key,value) VALUES(?,?)').run('local_data_dir', path.join(profile,'local'))
  })()
  console.log(JSON.stringify({profile,questions:questions.length,credentialsCopied:false,sourceUnchanged:true}))
} finally { source.close();target.close() }
