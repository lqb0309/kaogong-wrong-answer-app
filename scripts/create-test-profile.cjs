// Create a read-only snapshot of production DB for a separate, non-automatic test app.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const original = '/Users/deca/Library/Application Support/wrong-answer-app/data.db'
const profile = fs.mkdtempSync('/private/tmp/wrong-answer-review-test-')
const target = path.join(profile, 'data.db')
// SQLite's online backup includes committed WAL data while the installed app runs.
execFileSync('/usr/bin/sqlite3', ['-readonly', original, `.backup '${target}'`], { timeout: 30000 })
const quote = value => "'" + value.replaceAll("'", "''") + "'"
const vault = path.join(profile, 'vault'), local = path.join(profile, 'local')
fs.mkdirSync(vault); fs.mkdirSync(local)
execFileSync('/usr/bin/sqlite3', [target, `DELETE FROM config WHERE key LIKE '%api_key%' OR key LIKE '%token%';
INSERT OR REPLACE INTO config(key,value) VALUES ('obsidian_vault',${quote(vault)}),('local_data_dir',${quote(local)});
PRAGMA quick_check;`], { encoding: 'utf8', timeout: 30000 })
console.log(JSON.stringify({ profile, copiedDatabase: target, automaticTasksDisabled: true, credentialsRemoved: true }))
