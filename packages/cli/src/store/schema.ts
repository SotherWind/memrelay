/**
 * 0.1.0 是首个对外版本：所有结构（含偏好整理）都在 v1。
 * 未发版期间给 v1 增表时直接并入下方 SQL，启动时用 IF NOT EXISTS 幂等补齐；
 * 发版后再改结构需追加 MIGRATIONS 并递增 SCHEMA_VERSION。
 */
export const SCHEMA_VERSION = 1;

/** 每个迁移按顺序执行；数组下标 + 1 = user_version。 */
export const MIGRATIONS: string[] = [
  // v1：0.1.0 首个正式版完整结构（原开发期 v1-v6 压缩）。
  `
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ms INTEGER NOT NULL DEFAULT 0,
    hash TEXT,
    last_offset INTEGER NOT NULL DEFAULT 0,
    adapter_version INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    source_path TEXT,
    project_root TEXT,
    cwd TEXT,
    git_branch TEXT,
    title TEXT,
    first_user_message TEXT,
    started_at TEXT,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    status_source TEXT NOT NULL DEFAULT 'auto',
    parent_session_id TEXT,
    deleted_at TEXT,
    raw_records INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT -1,
    file_count INTEGER NOT NULL DEFAULT -1,
    sig_pending INTEGER NOT NULL DEFAULT 0,
    sig_quota INTEGER NOT NULL DEFAULT 0,
    sig_error INTEGER NOT NULL DEFAULT 0,
    sig_unanswered INTEGER NOT NULL DEFAULT 0,
    sig_todos_open INTEGER NOT NULL DEFAULT 0,
    sig_last_real TEXT,
    sig_reply_len INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_root);
  CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    native_id TEXT,
    native_parent_id TEXT,
    role TEXT NOT NULL,
    created_at TEXT,
    is_sidechain INTEGER NOT NULL DEFAULT 0,
    is_compact_boundary INTEGER NOT NULL DEFAULT 0,
    on_current_branch INTEGER NOT NULL DEFAULT 1,
    UNIQUE(session_id, ordinal)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ordinal);

  CREATE TABLE IF NOT EXISTS parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT,
    json TEXT,
    tool_name TEXT,
    tool_category TEXT,
    tool_call_id TEXT,
    status TEXT,
    blob_sha256 TEXT,
    truncated INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_parts_message ON parts(message_id);

  CREATE TABLE IF NOT EXISTS blobs (
    sha256 TEXT PRIMARY KEY,
    content BLOB NOT NULL,
    raw_size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5(text);
  CREATE VIRTUAL TABLE IF NOT EXISTS parts_cjk_fts USING fts5(text);

  CREATE TABLE IF NOT EXISTS secret_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    part_id INTEGER NOT NULL,
    rule_id TEXT NOT NULL,
    rules_version INTEGER NOT NULL,
    preview TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_findings_session ON secret_findings(session_id);

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    project_root TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_sessions (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    link_source TEXT NOT NULL DEFAULT 'auto',
    PRIMARY KEY (task_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_sessions_session ON task_sessions(session_id);

  CREATE TABLE IF NOT EXISTS tombstones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT,
    native_id TEXT,
    content_hash TEXT,
    deleted_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS embeddings (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    chunk_ix INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    dims INTEGER NOT NULL,
    host TEXT NOT NULL,
    vec BLOB NOT NULL,
    norm REAL NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(session_id, ordinal, chunk_ix)
  );
  CREATE INDEX IF NOT EXISTS idx_embeddings_fp ON embeddings(model, dims, host);
  CREATE INDEX IF NOT EXISTS idx_embeddings_session ON embeddings(session_id);

  CREATE TABLE IF NOT EXISTS embed_queue (
    session_id TEXT PRIMARY KEY,
    enqueued_at TEXT NOT NULL,
    claimed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS summaries (
    session_id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    host TEXT NOT NULL,
    text TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_summaries_fp ON summaries(model, host);

  CREATE TABLE IF NOT EXISTS summary_queue (
    session_id TEXT PRIMARY KEY,
    enqueued_at TEXT NOT NULL,
    claimed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS session_names (
    session_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    objective TEXT,
    model TEXT NOT NULL,
    host TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS name_queue (
    session_id TEXT PRIMARY KEY,
    enqueued_at TEXT NOT NULL,
    claimed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS memory_sources (
    path TEXT PRIMARY KEY,
    tool TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    fingerprint TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL DEFAULT 0,
    imported_at TEXT NOT NULL,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS memory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL REFERENCES memory_sources(path) ON DELETE CASCADE,
    heading TEXT,
    text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    UNIQUE(path, content_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_items_path ON memory_items(path);

  CREATE TABLE IF NOT EXISTS memory_plan (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    conflicts TEXT NOT NULL DEFAULT '[]',
    inputs TEXT NOT NULL DEFAULT '{}',
    model TEXT,
    host TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_exports (
    path TEXT PRIMARY KEY,
    tool TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'block',
    block_hash TEXT NOT NULL,
    written_at TEXT NOT NULL,
    backup_path TEXT,
    created INTEGER NOT NULL DEFAULT 0
  );
  `,
];
