-- schema.sql
-- Create tables for workflows, nodes, edges, and executions

DROP TABLE IF EXISTS edges;
DROP TABLE IF EXISTS nodes;
DROP TABLE IF EXISTS executions;
DROP TABLE IF EXISTS workflows;

CREATE TABLE workflows (
    id TEXT PRIMARY KEY, -- workflow ID/name
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE nodes (
    id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    type TEXT NOT NULL,
    position_x REAL NOT NULL,
    position_y REAL NOT NULL,
    config TEXT NOT NULL, -- JSON string
    inputs TEXT,          -- JSON string (optional inputs)
    outputs TEXT,         -- JSON string (optional outputs)
    PRIMARY KEY (workflow_id, id),
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE TABLE edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    source_handle TEXT, -- 'success', 'failure', 'always'
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
    FOREIGN KEY (workflow_id, source) REFERENCES nodes(workflow_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workflow_id, target) REFERENCES nodes(workflow_id, id) ON DELETE CASCADE
);

CREATE TABLE executions (
    id TEXT PRIMARY KEY, -- execution UUID
    workflow_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'running', 'success', 'failed', 'partial_failure'
    started_at TEXT,
    finished_at TEXT,
    log TEXT, -- JSON string containing full step log
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);
