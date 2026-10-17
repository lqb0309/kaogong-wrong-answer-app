// One-shot local migration. Source is always read-only; credentials are never
// decrypted or printed. Existing Tauri credentials stay in their original format.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { fileURLToPath } = require('node:url')
const quote = name => '"' + name.replace(/"/g, '""') + '"'
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const secretKey = key => /(?:api_key|token|secret|password)$/i.test(key)
const scalar = value => Buffer.isBuffer(value) ? value.toString('hex') : value
const legacyDataRoot = () => path.join(require('node:os').homedir(),'考公错题')

function rewriteLocations(value, mappings) {
  if (typeof value !== 'string') return value
  const pairs = mappings.flatMap(([from, to]) => [
    [from, to], [pathToFileURL(from).href, pathToFileURL(to).href],
    [encodeURI(from), encodeURI(to)], [from.replace(/ /g, '%20'), to.replace(/ /g, '%20')]
  ]).sort((a, b) => b[0].length - a[0].length)
  // One pass, so a destination nested beneath a source is never rewritten twice.
  const seen = new Set(), unique = pairs.filter(([from]) => { if (seen.has(from)) return false; seen.add(from); return true })
  const pattern = new RegExp(unique.map(([from]) => from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  return unique.length ? value.replace(pattern, (match, offset) => {
    const next = value[offset + match.length]
    return !next || /[\/\s"'<>\])},]/.test(next) ? unique.find(([from]) => from === match)[1] : match
  }) : value
}

function copyVerifiedTree(from, to, onText = text => text) {
  const relative=path.relative(path.resolve(from),path.resolve(to))
  if(!relative || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative))) throw Error('复制目标不能位于源目录内部')
  if (fs.existsSync(to)) throw Error('复制目标已存在，拒绝覆盖')
  const root = fs.lstatSync(from)
  if (!root.isDirectory() || root.isSymbolicLink()) throw Error('数据目录必须为真实目录')
  const result = { files: 0, bytes: 0, markdown: 0, knowledgeCards: 0 }
  fs.mkdirSync(to, { recursive: true, mode: 0o700 })
  function walk(source, dest) {
    for (const item of fs.readdirSync(source, { withFileTypes: true })) {
      const src = path.join(source, item.name), dst = path.join(dest, item.name)
      if (item.isSymbolicLink()) throw Error('数据目录含符号链接，需先人工确认：' + src)
      if (item.isDirectory()) { fs.mkdirSync(dst, { mode: 0o700 }); walk(src, dst); continue }
      if (!item.isFile()) throw Error('数据目录含非普通文件：' + src)
      const before = fs.statSync(src), bytes = fs.readFileSync(src)
      if (digest(src) !== crypto.createHash('sha256').update(bytes).digest('hex')) throw Error('复制时源文件发生变化')
      const after = fs.statSync(src)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('复制时源文件发生变化')
      const isMarkdown = /\.md$/i.test(src)
      const output = isMarkdown ? Buffer.from(onText(bytes.toString('utf8'))) : bytes
      fs.writeFileSync(dst, output, { flag: 'wx', mode: before.mode & 0o777 })
      if (digest(dst) !== crypto.createHash('sha256').update(output).digest('hex')) throw Error('文件复制校验失败')
      result.files++; result.bytes += output.length
      if (isMarkdown) { result.markdown++; if (/^type:\s*["']?knowledge_card["']?\s*$/m.test(bytes.toString('utf8'))) result.knowledgeCards++ }
    }
  }
  walk(from, to)
  return result
}

function tables(db) { return db.prepare("SELECT name FROM pragma_table_list WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name) }
function columns(db, table) { return db.prepare(`PRAGMA table_info(${quote(table)})`).all() }
function counts(db) { return Object.fromEntries(tables(db).map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n])) }
function check(db) {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw Error('数据库完整性校验失败')
  if (db.pragma('foreign_key_check').length) throw Error('数据库存在断裂关联，已取消迁移')
}

function auditImages(source, stage, mappings) {
  const refs = new Set(), sourceLocal = source.prepare("SELECT value FROM config WHERE key='local_data_dir'").get()?.value || legacyDataRoot()
  const targetLocal = stage.prepare("SELECT value FROM config WHERE key='local_data_dir'").get()?.value
  const collect = value => { if (typeof value === 'string') refs.add(value); else if (Array.isArray(value)) value.forEach(collect); else if (value && typeof value==='object') Object.values(value).forEach(collect) }
  for (const table of ['questions','question_groups']) {
    if (!tables(source).includes(table)) continue
    for (const row of source.prepare(`SELECT * FROM ${quote(table)}`).all()) {
      for (const name of ['image_url','local_image_path','graphic_image_path','passage_image_url']) if(row[name])collect(row[name])
      for (const name of ['material_image_ids','question_images','option_images','material_images']) if(row[name]){try{collect(JSON.parse(row[name]))}catch{throw Error('图片关联字段损坏：'+name)}}
      if(row.original_analysis)for(const match of row.original_analysis.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)/g))collect(match[1]||match[2])
    }
  }
  const resolve = (value,root) => {
    if (/^(?:https?:|data:)/i.test(value)) return null
    let file=value
    if(file.startsWith('file://')){try{file=fileURLToPath(file)}catch{throw Error('无法解析本地图片地址')}}
    if(!path.isAbsolute(file)){if(!file.startsWith('images/'))return null;file=path.join(root,file)}
    if(!fs.existsSync(file)){try{const decoded=decodeURIComponent(file);if(fs.existsSync(decoded))file=decoded}catch{}}
    return file
  }
  let checked=0;const preexistingMissing=[]
  for(const ref of refs){const from=resolve(ref,sourceLocal);if(!from)continue
    if(!fs.existsSync(from)){preexistingMissing.push(from);continue}
    const to=resolve(rewriteLocations(ref,mappings),targetLocal)
    if(!to||!fs.existsSync(to)||digest(from)!==digest(to))throw Error('迁移后图片关联或文件校验失败：'+from)
    checked++
  }
  return {checked,preexistingMissing:[...new Set(preexistingMissing)]}
}

function mergeDatabases(source, target, stage, mappings) {
  const sourceConfig = new Map(source.prepare('SELECT key,value FROM config').all().map(r => [r.key, r.value]))
  const targetConfig = new Map(target.prepare('SELECT key,value FROM config').all().map(r => [r.key, r.value]))
  const report = { inserted: {}, conflictsKeptOriginal: {}, skippedLegacyCredentials: [] }
  const priority = ['question_groups', 'questions', 'review_batches', 'review_batch_items']
  stage.pragma('foreign_keys = ON')
  stage.transaction(() => {
    // Extend the old schema without dropping old columns (notes, wrong thoughts, etc.).
    for (const table of tables(target)) {
      if (!tables(stage).includes(table)) {
        stage.exec(target.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql)
      }
      const existing = new Set(columns(stage, table).map(c => c.name))
      for (const col of columns(target, table)) if (!existing.has(col.name)) {
        if (col.pk || (col.notnull && col.dflt_value === null)) throw Error('存在不能自动兼容的数据列：' + table + '.' + col.name)
        stage.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${quote(col.name)} ${col.type || 'TEXT'}${col.notnull ? ' NOT NULL' : ''}${col.dflt_value !== null ? ' DEFAULT ' + col.dflt_value : ''}`)
      }
    }
    // Rewrite only data fields; ciphertext is handled separately below.
    for (const table of tables(stage)) {
      if (table === 'config') continue
      const info = columns(stage, table), pk = info.filter(c => c.pk).sort((a,b) => a.pk-b.pk)
      if (!pk.length) { if (stage.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n) throw Error('无法安全定位数据行：' + table); continue }
      for (const row of stage.prepare(`SELECT * FROM ${quote(table)}`).all()) {
        const changed = info.filter(c => typeof row[c.name] === 'string' && rewriteLocations(row[c.name], mappings) !== row[c.name])
        if (changed.length) stage.prepare(`UPDATE ${quote(table)} SET ${changed.map(c => quote(c.name)+'=?').join(',')} WHERE ${pk.map(c => quote(c.name)+'=?').join(' AND ')}`)
          .run(...changed.map(c => rewriteLocations(row[c.name], mappings)), ...pk.map(c => row[c.name]))
      }
    }
    const ordered = tables(target).filter(t => !['config', 'tag_tree'].includes(t)).sort((a,b) => (priority.indexOf(a)<0 ? 100 : priority.indexOf(a)) - (priority.indexOf(b)<0 ? 100 : priority.indexOf(b)))
    for (const table of ordered) {
      const info = columns(target, table)
      const auto = /\bAUTOINCREMENT\b/i.test(target.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table).sql)
      const names = info.filter(c => !(auto && c.pk)).map(c => c.name)
      let inserted = 0, skipped = 0
      for (const row of target.prepare(`SELECT * FROM ${quote(table)}`).all()) {
        // Do not silently remap question IDs: dependent history would point to the wrong question.
        if (table === 'questions' && row.import_fingerprint) {
          const duplicate = stage.prepare('SELECT id FROM questions WHERE import_fingerprint=?').get(row.import_fingerprint)
          if (duplicate && duplicate.id !== row.id) throw Error('发现不同编号的重复题，需要明确处理关联后重试')
        }
        const result = stage.prepare(`INSERT INTO ${quote(table)} (${names.map(quote).join(',')}) VALUES (${names.map(()=>'?').join(',')}) ON CONFLICT DO NOTHING`)
          .run(...names.map(name => rewriteLocations(row[name],mappings)))
        result.changes ? inserted++ : skipped++
      }
      report.inserted[table] = inserted
      if (skipped) report.conflictsKeptOriginal[table] = skipped
    }
    const put = stage.prepare('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)')
    for (const [key, value] of sourceConfig) {
      if (secretKey(key)) { stage.prepare('DELETE FROM config WHERE key=?').run(key); if (value && !targetConfig.get(key)) report.skippedLegacyCredentials.push(key); continue }
      put.run(key, rewriteLocations(value, mappings))
    }
    for (const [key,value] of targetConfig) if (secretKey(key) || /^(?:ai_|vision_)/.test(key) || !sourceConfig.has(key)) put.run(key,value)
    for (const key of ['local_data_dir','obsidian_vault']) {
      const original = sourceConfig.get(key)
      if (original) put.run(key,rewriteLocations(original,mappings))
    }
    put.run('migration_electron_v1', new Date().toISOString())
  })()
  check(stage)
  // Every original field survives, except intentionally re-encrypted/retained configuration.
  for (const table of tables(source).filter(t => t !== 'config')) {
    const info = columns(source,table), pk = info.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk)
    if (!pk.length) continue
    for (const row of source.prepare(`SELECT * FROM ${quote(table)}`).all()) {
      const copy = stage.prepare(`SELECT * FROM ${quote(table)} WHERE ${pk.map(c=>quote(c.name)+'=?').join(' AND ')}`).get(...pk.map(c=>rewriteLocations(row[c.name],mappings)))
      if (!copy || info.some(c => scalar(copy[c.name]) !== scalar(rewriteLocations(row[c.name],mappings)))) throw Error('原始数据字段核对失败：' + table)
    }
  }
  report.counts = counts(stage)
  return report
}

async function migrate({ sourceFile, targetFile, extraRoots = [] }) {
  const Database = require('../tauri-app/runtime/node_modules/better-sqlite3')
  for (const file of [sourceFile,targetFile]) if (!path.isAbsolute(file) || !fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw Error('请提供两个独立的真实数据库文件')
  if (fs.realpathSync(sourceFile) === fs.realpathSync(targetFile)) throw Error('新旧数据库不能相同')
  // No live desktop process may still hold either database during the one-shot swap.
  const { spawnSync } = require('node:child_process')
  for (const file of [sourceFile,targetFile]) {
    const open = spawnSync('/usr/sbin/lsof',['-t',file],{encoding:'utf8'})
    if (open.status === 0 && open.stdout.trim()) throw Error('请先正常退出新旧两个版本，数据库仍被占用')
    if (open.error || (open.status !== 0 && open.status !== 1)) throw Error('无法验证数据库是否已关闭')
  }
  const backupRoot = path.join(path.dirname(targetFile),'migration-backups')
  fs.mkdirSync(backupRoot,{recursive:true,mode:0o700})
  const backup = fs.mkdtempSync(path.join(backupRoot,'electron-'))
  const liveAssets = path.join(path.dirname(targetFile),'migrated-data',path.basename(backup))
  let source, target, stage
  try {
    // A closed WAL-mode source may need a new -shm even for a read-only SQLite
    // connection. Recover only a private copy, never request write access to the old profile.
    const sourceSnapshot=path.join(backup,'source-snapshot.db')
    for(const suffix of ['', '-wal']) {
      const file=sourceFile+suffix
      if(!fs.existsSync(file))continue
      const before=digest(file);fs.copyFileSync(file,sourceSnapshot+suffix);fs.chmodSync(sourceSnapshot+suffix,0o600)
      if(before!==digest(file)||before!==digest(sourceSnapshot+suffix))throw Error('源数据库在快照时发生变化，已取消')
    }
    source = new Database(sourceSnapshot); target = new Database(targetFile)
    if (target.prepare("SELECT value FROM config WHERE key='migration_electron_v1'").get()) throw Error('此题库已经迁移过，不能重复覆盖；请使用增量迁移')
    check(source); check(target)
    await source.backup(path.join(backup,'electron-before.db'))
    await target.backup(path.join(backup,'tauri-before.db'))
    fs.chmodSync(path.join(backup,'electron-before.db'),0o600); fs.chmodSync(path.join(backup,'tauri-before.db'),0o600)
    const sourceConfig = Object.fromEntries(source.prepare('SELECT key,value FROM config').all().map(r=>[r.key,r.value]))
    const targetConfig = Object.fromEntries(target.prepare('SELECT key,value FROM config').all().map(r=>[r.key,r.value]))
    const roots = [...new Set([sourceConfig.local_data_dir || legacyDataRoot(),sourceConfig.obsidian_vault,...extraRoots].filter(Boolean))]
    const mappings = roots.map((root,index)=>[root,path.join(liveAssets,index===1?'Obsidian 考公错题':index===0?'local':'legacy-'+index)])
    const assetCounts = []
    for (let index=0;index<roots.length;index++) {
      const snapshot = path.join(backup,'assets-'+index)
      assetCounts.push(copyVerifiedTree(roots[index],snapshot))
    }
    if (targetConfig.local_data_dir && fs.existsSync(targetConfig.local_data_dir)) copyVerifiedTree(targetConfig.local_data_dir,path.join(backup,'tauri-local-before'))
    // Preserve linked review exports too; missing historical exports remain reported, not invented.
    const missingExports=[], copiedExports=[]
    if (tables(source).includes('review_batches')) for (const row of source.prepare('SELECT files_json FROM review_batches').all()) {
      let files=[];try{files=JSON.parse(row.files_json)}catch{throw Error('历史复习清单文件记录损坏')}
      for(const file of files){if(typeof file!=='string'||!path.isAbsolute(file))continue;if(mappings.some(([from])=>from===file))continue
        if(!fs.existsSync(file)){missingExports.push(file);continue}
        if(!fs.lstatSync(file).isFile())throw Error('导出文件不是普通文件')
        const filename=crypto.createHash('sha256').update(file).digest('hex').slice(0,12)+'-'+path.basename(file)
        const snapshot=path.join(backup,'exports',filename);fs.mkdirSync(path.dirname(snapshot),{recursive:true,mode:0o700});fs.copyFileSync(file,snapshot)
        if(digest(file)!==digest(snapshot))throw Error('历史导出文件校验失败')
        const dest=path.join(liveAssets,'exports',filename);mappings.push([file,dest]);copiedExports.push([snapshot,dest])
      }
    }
    for(let index=0;index<roots.length;index++)copyVerifiedTree(path.join(backup,'assets-'+index),mappings[index][1],text=>rewriteLocations(text,mappings))
    for(const [from,to] of copiedExports){fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o700});fs.copyFileSync(from,to)}
    const stageFile=path.join(backup,'merged-ready.db')
    fs.copyFileSync(path.join(backup,'electron-before.db'),stageFile);fs.chmodSync(stageFile,0o600)
    stage=new Database(stageFile)
    const report=mergeDatabases(source,target,stage,mappings)
    report.images=auditImages(source,stage,mappings)
    report.backup=backup;report.assetCounts=assetCounts;report.liveAssets=liveAssets;report.missingHistoricalExports=missingExports;report.exportFilesCopied=copiedExports.length
    report.sourceDatabaseUnchanged=true;report.originalAssetsUnchanged=true;report.sourceFile=sourceFile;report.targetFile=targetFile
    stage.pragma('wal_checkpoint(TRUNCATE)');stage.close();stage=null
    const checkpoint=target.pragma('wal_checkpoint(TRUNCATE)')[0];if(checkpoint?.busy)throw Error('新版数据库仍有未完成写入，未替换')
    source.close();source=null;target.close();target=null
    fs.writeFileSync(path.join(backup,'migration-report.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600})
    // The full pre-migration database and assets are already verified above.
    // rename is atomic on this filesystem; no partial database is exposed.
    fs.renameSync(stageFile,targetFile)
    return report
  } finally { stage?.close();target?.close();source?.close() }
}

module.exports={rewriteLocations,copyVerifiedTree,mergeDatabases,migrate,secretKey}
if(require.main===module) {
  if(process.argv.length<4)throw Error('Usage: node migrate-electron-data.cjs /absolute/old/data.db /absolute/new/data.db [extra-assets-root]')
  migrate({sourceFile:process.argv[2],targetFile:process.argv[3],extraRoots:process.argv.slice(4)}).then(report=>console.log(JSON.stringify(report))).catch(error=>{console.error(error.message);process.exitCode=1})
}
