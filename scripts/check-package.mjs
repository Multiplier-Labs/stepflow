import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { WorkflowEngine, SilentLogger, verifyWebhookSignature } from '@multiplier-labs/stepflow';
import { SQLiteStorageAdapter } from '@multiplier-labs/stepflow/storage';
import { signWebhookPayload } from '@multiplier-labs/stepflow/events';

// Receivers verify Stepflow webhooks with these public helpers.
const signature = signWebhookPayload('{"ok":true}', 'secret');
assert.equal(verifyWebhookSignature('{"ok":true}', signature, 'secret'), true);
assert.equal(verifyWebhookSignature('{"ok":false}', signature, 'secret'), false);

// Exercise the actual package exports, including the migration Git installs use.
const db = new Database(':memory:');
db.exec(`CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
  parent_run_id TEXT, input_json TEXT NOT NULL, metadata_json TEXT NOT NULL,
  context_json TEXT NOT NULL, error_json TEXT, created_at TEXT NOT NULL,
  started_at TEXT, finished_at TEXT
)`);
const storage = new SQLiteStorageAdapter({ db });
const engine = new WorkflowEngine({ storage, logger: new SilentLogger() });
try {
  assert(db.prepare('PRAGMA table_info(workflow_runs)').all()
    .some(column => column.name === 'completed_steps_json'));
  engine.registerWorkflow({ kind: 'package.smoke', name: 'Package smoke', steps: [
    { key: 'result', name: 'Result', handler: async () => 'ok' },
  ] });
  const id = await engine.startRun({ kind: 'package.smoke' });
  const run = await engine.waitForRun(id);
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.completedSteps, ['result']);
} finally {
  await engine.shutdown();
}
console.log('Package exports and legacy SQLite migration passed');
