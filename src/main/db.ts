import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import fs from 'fs-extra'

let db: Database.Database

export function getDb(): Database.Database {
  return db
}

export function initDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'data.db')
  fs.ensureDirSync(app.getPath('userData'))

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS error_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      module TEXT NOT NULL,
      event TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT,
      trace_id TEXT,
      resolved INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_logs_level ON error_logs(level);
    CREATE INDEX IF NOT EXISTS idx_logs_module ON error_logs(module);
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON error_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_trace_id ON error_logs(trace_id);
    CREATE INDEX IF NOT EXISTS idx_logs_resolved ON error_logs(resolved);

    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      image_url TEXT NOT NULL,
      level1 TEXT NOT NULL,
      level2 TEXT NOT NULL,
      level3 TEXT,
      confidence REAL NOT NULL,
      ocr_text TEXT,
      reasoning TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_count INTEGER DEFAULT 1,
      source TEXT,
      obsidian_path TEXT,
      local_image_path TEXT,
      trace_id TEXT,
      created_at TEXT NOT NULL,
      confirmed_at TEXT
    );

    -- Add column if upgrading from old schema (ignore error if already exists)
    `);
    try { db.exec(`ALTER TABLE questions ADD COLUMN local_image_path TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN reflection TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN error_type TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN group_id TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN has_graphics INTEGER DEFAULT 0`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN graphic_image_path TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN match_type TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN ai_raw_level1 TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN ai_raw_level2 TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN ai_raw_level3 TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN file_hash TEXT`) } catch { /* already exists */ }
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
    CREATE INDEX IF NOT EXISTS idx_questions_level1 ON questions(level1);
    CREATE INDEX IF NOT EXISTS idx_questions_level2 ON questions(level2);
    CREATE INDEX IF NOT EXISTS idx_questions_created ON questions(created_at);

    CREATE TABLE IF NOT EXISTS tag_tree (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_days (
      date TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS question_groups (
      id TEXT PRIMARY KEY,
      title TEXT,
      passage_image_url TEXT,
      passage_text TEXT,
      group_type TEXT DEFAULT 'default',
      created_at TEXT NOT NULL
    );
  `)

  // Insert default tag tree if table is empty
  const count = db.prepare('SELECT COUNT(*) as cnt FROM tag_tree').get() as { cnt: number }
  if (count.cnt === 0) {
    db.prepare(
      'INSERT INTO tag_tree (data, updated_at) VALUES (?, ?)'
    ).run(JSON.stringify(getDefaultTagTree()), new Date().toISOString())
  }
}

function getDefaultTagTree() {
  return {
    version: '1.0',
    updated: new Date().toISOString().slice(0, 10),
    tree: [
      {
        id: 'verbal',
        name: '言语理解',
        level: 1,
        children: [
          { id: 'verbal-main', name: '主旨概括', level: 2, children: [] },
          { id: 'verbal-intent', name: '意图判断', level: 2, children: [] },
          { id: 'verbal-detail', name: '细节判断', level: 2, children: [] },
          { id: 'verbal-fill', name: '逻辑填空', level: 2, children: [] },
          { id: 'verbal-order', name: '语句排列', level: 2, children: [] }
        ]
      },
      {
        id: 'math',
        name: '数量关系',
        level: 1,
        children: [
          {
            id: 'math-num-reason',
            name: '数字推理',
            level: 2,
            children: [
              { id: 'math-num-seq', name: '等差/等比数列', level: 3, children: [] },
              { id: 'math-num-recur', name: '递推数列', level: 3, children: [] }
            ]
          },
          {
            id: 'math-op',
            name: '数学运算',
            level: 2,
            children: [
              { id: 'math-op-travel', name: '行程问题', level: 3, children: [] },
              { id: 'math-op-project', name: '工程问题', level: 3, children: [] },
              { id: 'math-op-combo', name: '排列组合', level: 3, children: [] },
              { id: 'math-op-prob', name: '概率问题', level: 3, children: [] },
              { id: 'math-op-geo', name: '几何问题', level: 3, children: [] }
            ]
          }
        ]
      },
      {
        id: 'reasoning',
        name: '判断推理',
        level: 1,
        children: [
          {
            id: 'reasoning-figure',
            name: '图形推理',
            level: 2,
            children: [
              { id: 'reasoning-figure-rule', name: '规律类', level: 3, children: [] },
              {
                id: 'reasoning-figure-count',
                name: '数量类',
                level: 3,
                children: [
                  { id: 'reasoning-figure-count-part', name: '部分数', level: 4, children: [] },
                  { id: 'reasoning-figure-count-line', name: '线条数', level: 4, children: [] },
                  { id: 'reasoning-figure-count-angle', name: '角数', level: 4, children: [] }
                ]
              },
              { id: 'reasoning-figure-overlay', name: '叠加类', level: 3, children: [] },
              { id: 'reasoning-figure-fold', name: '空间折叠类', level: 3, children: [] }
            ]
          },
          { id: 'reasoning-def', name: '定义判断', level: 2, children: [] },
          { id: 'reasoning-analogy', name: '类比推理', level: 2, children: [] },
          {
            id: 'reasoning-logic',
            name: '逻辑判断',
            level: 2,
            children: [
              { id: 'reasoning-logic-tf', name: '真假推理', level: 3, children: [] },
              { id: 'reasoning-logic-strengthen', name: '加强型', level: 3, children: [] },
              { id: 'reasoning-logic-weaken', name: '削弱型', level: 3, children: [] },
              { id: 'reasoning-logic-premise', name: '前提型', level: 3, children: [] }
            ]
          }
        ]
      },
      {
        id: 'data',
        name: '资料分析',
        level: 1,
        children: [
          { id: 'data-growth', name: '增长率计算', level: 2, children: [] },
          { id: 'data-ratio', name: '比重计算', level: 2, children: [] },
          { id: 'data-multiple', name: '倍数关系', level: 2, children: [] },
          { id: 'data-comprehensive', name: '综合判断', level: 2, children: [] }
        ]
      },
      {
        id: 'common-sense',
        name: '常识判断',
        level: 1,
        children: [
          { id: 'cs-politics', name: '政治/法律', level: 2, children: [] },
          { id: 'cs-economy', name: '经济', level: 2, children: [] },
          { id: 'cs-history', name: '人文/历史', level: 2, children: [] },
          { id: 'cs-science', name: '科技/地理/生物', level: 2, children: [] }
        ]
      }
    ]
  }
}
