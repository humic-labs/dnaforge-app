import type Database from 'better-sqlite3';

export function createWorkReminderTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scientific_work_dispatch (
      workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      installation_id TEXT NOT NULL, state TEXT NOT NULL, epoch INTEGER NOT NULL, fence_json TEXT
    );
    CREATE TABLE IF NOT EXISTS scientific_work_consent (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, principal TEXT NOT NULL,
      inbox INTEGER NOT NULL, desktop INTEGER NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(workspace_id,principal)
    );
    CREATE TABLE IF NOT EXISTS scientific_work_rules (
      id TEXT PRIMARY KEY,workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,principal TEXT NOT NULL,
      task_id TEXT NOT NULL,role TEXT NOT NULL,offset_ms INTEGER NOT NULL,day_time TEXT,day_fold TEXT NOT NULL,
      desktop_enabled INTEGER NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,scanned_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scientific_work_active_rules ON scientific_work_rules(workspace_id,state);
    CREATE TABLE IF NOT EXISTS scientific_work_effects (
      id TEXT PRIMARY KEY,effect_key TEXT NOT NULL UNIQUE,workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      principal TEXT NOT NULL,task_id TEXT NOT NULL,rule_id TEXT NOT NULL,rule_generation INTEGER NOT NULL,
      slot TEXT NOT NULL,due_at INTEGER NOT NULL,task_revision TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,
      wake_at INTEGER,created_at INTEGER NOT NULL,channel TEXT NOT NULL,admitted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS scientific_work_effect_recipient ON scientific_work_effects(workspace_id,principal);
    CREATE TABLE IF NOT EXISTS scientific_work_reminder_receipts (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,principal TEXT NOT NULL,
      request_id TEXT NOT NULL,command_json TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(workspace_id,principal,request_id)
    );
    CREATE INDEX IF NOT EXISTS scientific_work_reminder_request ON scientific_work_reminder_receipts(request_id);
    CREATE INDEX IF NOT EXISTS scientific_work_effect_channel ON scientific_work_effects(channel,admitted_at);
    CREATE TRIGGER IF NOT EXISTS scientific_work_dispatch_bound AFTER INSERT ON workspace_sync_bindings
    BEGIN
      UPDATE scientific_work_dispatch SET state='fenced',epoch=epoch+1 WHERE workspace_id=NEW.workspace_id AND state IN ('local','suspended');
    END;
    CREATE TRIGGER IF NOT EXISTS scientific_work_suspended_deliveries AFTER UPDATE OF state ON scientific_work_dispatch
    WHEN (OLD.state='local' AND NEW.state='suspended') OR (OLD.state='suspended' AND NEW.state='local') BEGIN
      UPDATE scientific_work_effects SET channel='suppressed'
      WHERE workspace_id=NEW.workspace_id AND principal='local:' || NEW.installation_id AND channel='queued';
    END;
    CREATE TRIGGER IF NOT EXISTS scientific_work_project_suspended AFTER UPDATE OF archived_at,trashed_at,access_mode ON workspaces
    WHEN NEW.archived_at IS NOT NULL OR NEW.trashed_at IS NOT NULL OR NEW.access_mode <> 'writable' BEGIN
      UPDATE scientific_work_dispatch SET state='suspended',epoch=epoch+1 WHERE workspace_id=NEW.id AND state='local';
    END;
  `);
}
