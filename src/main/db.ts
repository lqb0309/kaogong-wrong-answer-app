import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import fs from 'fs-extra'
import { localDateKey } from './date-utils'

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
  db.pragma('busy_timeout = 5000')

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
    try { db.exec(`ALTER TABLE questions ADD COLUMN sync_status TEXT DEFAULT 'pending'`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN sync_error TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN last_synced_at TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN deleted_at TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN question_number TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN material_image_ids TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN import_source TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN import_fingerprint TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN original_analysis TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN original_answer TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN question_images TEXT`) } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE questions ADD COLUMN option_images TEXT`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE questions ADD COLUMN source_snapshot TEXT`) } catch { /* already exists */ }
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
    CREATE INDEX IF NOT EXISTS idx_questions_level1 ON questions(level1);
    CREATE INDEX IF NOT EXISTS idx_questions_level2 ON questions(level2);
    CREATE INDEX IF NOT EXISTS idx_questions_created ON questions(created_at);
    CREATE INDEX IF NOT EXISTS idx_questions_file_hash ON questions(file_hash);
    CREATE INDEX IF NOT EXISTS idx_questions_sync_status ON questions(sync_status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_import_fingerprint ON questions(import_fingerprint) WHERE import_fingerprint IS NOT NULL;

    CREATE VIRTUAL TABLE IF NOT EXISTS question_fts_v2 USING fts5(
      question_id UNINDEXED, ocr_text, reflection, source, error_type, level1, level2, level3,
      tokenize = 'trigram'
    );
    CREATE TRIGGER IF NOT EXISTS questions_fts_v2_insert AFTER INSERT ON questions BEGIN
      INSERT INTO question_fts_v2(question_id, ocr_text, reflection, source, error_type, level1, level2, level3)
      VALUES (new.id, new.ocr_text, new.reflection, new.source, new.error_type, new.level1, new.level2, new.level3);
    END;
    CREATE TRIGGER IF NOT EXISTS questions_fts_v2_update AFTER UPDATE ON questions BEGIN
      DELETE FROM question_fts_v2 WHERE question_id = old.id;
      INSERT INTO question_fts_v2(question_id, ocr_text, reflection, source, error_type, level1, level2, level3)
      VALUES (new.id, new.ocr_text, new.reflection, new.source, new.error_type, new.level1, new.level2, new.level3);
    END;
    CREATE TRIGGER IF NOT EXISTS questions_fts_v2_delete AFTER DELETE ON questions BEGIN
      DELETE FROM question_fts_v2 WHERE question_id = old.id;
    END;

    CREATE TABLE IF NOT EXISTS tag_tree (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS speed_training_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id TEXT NOT NULL,
      selected_answer TEXT,
      correct_answer TEXT,
      elapsed_seconds INTEGER NOT NULL,
      target_seconds INTEGER NOT NULL,
      is_correct INTEGER NOT NULL DEFAULT 0,
      is_on_time INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_speed_attempt_question ON speed_training_attempts(question_id, created_at);
    CREATE TABLE IF NOT EXISTS speed_training_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_count INTEGER NOT NULL,
      correct_count INTEGER NOT NULL,
      elapsed_seconds INTEGER NOT NULL,
      limit_seconds INTEGER NOT NULL,
      accuracy REAL NOT NULL,
      is_on_time INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'pdf',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fenbi_daily_sessions (
      exercise_id TEXT PRIMARY KEY,
      practice_date TEXT NOT NULL,
      title TEXT NOT NULL,
      question_count INTEGER NOT NULL,
      correct_count INTEGER NOT NULL,
      total_seconds INTEGER NOT NULL DEFAULT 0,
      wrong_count INTEGER NOT NULL DEFAULT 0,
      overtime_count INTEGER NOT NULL DEFAULT 0,
      modules_json TEXT NOT NULL DEFAULT '{}',
      points_json TEXT NOT NULL DEFAULT '[]',
      source_url TEXT,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fenbi_daily_date ON fenbi_daily_sessions(practice_date);

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

    -- 知识卡片复习日志（加权复习队列）
    CREATE TABLE IF NOT EXISTS review_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_path TEXT NOT NULL,
      date TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_card ON review_log(card_path, date);
    CREATE TABLE IF NOT EXISTS review_state (
      card_path TEXT PRIMARY KEY,
      interval_days INTEGER NOT NULL DEFAULT 0,
      repetitions INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      last_rating TEXT,
      last_reviewed_at TEXT,
      due_date TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_state_due ON review_state(due_date);

    CREATE TABLE IF NOT EXISTS test_attempts (
      id TEXT PRIMARY KEY,
      question_ids TEXT NOT NULL,
      wrong_ids TEXT NOT NULL,
      total_count INTEGER NOT NULL,
      wrong_count INTEGER NOT NULL,
      accuracy REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_test_attempts_created ON test_attempts(created_at);
    CREATE TABLE IF NOT EXISTS review_batches (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      question_ids TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      files_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS review_batch_items (
      batch_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY(batch_id, question_id),
      FOREIGN KEY(batch_id) REFERENCES review_batches(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_review_items_question ON review_batch_items(question_id, completed_at);
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);

    -- 每日备考计划（含 AI 动态调整）
    CREATE TABLE IF NOT EXISTS daily_plans (
      date TEXT PRIMARY KEY,
      tasks_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      ai_adjusted INTEGER NOT NULL DEFAULT 0,
      adjustment_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  try { db.exec(`ALTER TABLE review_state ADD COLUMN fsrs_json TEXT`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE review_log ADD COLUMN scheduler_log TEXT`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE questions ADD COLUMN analysis_error TEXT`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE questions ADD COLUMN analysis_status TEXT`) } catch { /* already exists */ }
  db.exec("UPDATE questions SET status = 'pending', analysis_status = 'failed', analysis_error = '上次导入在保存元数据前中断，请重新导入或手动处理' WHERE status = 'capturing'")
  try { db.exec(`ALTER TABLE speed_training_attempts ADD COLUMN training_mode TEXT NOT NULL DEFAULT 'online'`) } catch { /* already exists */ }
  // Legacy PDF attempts used a synthetic 0/1 timing pair. Exclude these from per-question timing metrics.
  db.exec("UPDATE speed_training_attempts SET training_mode = 'pdf' WHERE elapsed_seconds = 0 AND target_seconds = 1")
  try { db.exec(`ALTER TABLE question_groups ADD COLUMN material_images TEXT`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE question_groups ADD COLUMN practice_summary TEXT`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE ai_usage ADD COLUMN cost_source TEXT DEFAULT 'unpriced'`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE ai_usage ADD COLUMN price_input REAL DEFAULT 0`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE ai_usage ADD COLUMN price_output REAL DEFAULT 0`) } catch { /* already exists */ }

  db.exec(`
    INSERT INTO question_fts_v2(question_id, ocr_text, reflection, source, error_type, level1, level2, level3)
    SELECT q.id, q.ocr_text, q.reflection, q.source, q.error_type, q.level1, q.level2, q.level3
    FROM questions q WHERE NOT EXISTS (SELECT 1 FROM question_fts_v2 f WHERE f.question_id = q.id)
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
    updated: localDateKey(),
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
