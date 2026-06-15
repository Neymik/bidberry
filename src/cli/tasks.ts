/**
 * Dev task board CLI — low-friction access for developers and Claude Code.
 *
 * Run inside the app container (has DB env):
 *   docker exec wb-analytics-app bun run src/cli/tasks.ts <command> [...]
 *
 * Commands:
 *   list [status]                 List tasks (optionally filter by status)
 *   show <id>                     Show one task + its activity log
 *   add "<title>" [opts]          Create a task
 *       --desc "..."  --priority low|medium|high|urgent
 *       --assignee X  --tags "a,b" --branch feat/x --status backlog|todo|...
 *   status <id> <status> [who]    Change status (optionally set assignee)
 *   claim <id> <who>              Assign to <who> and mark in_progress
 *   assign <id> <who>             Set assignee
 *   comment <id> "<text>" [who]   Add a comment to the activity log
 *   done <id> [who]               Mark done
 *   rm <id>                       Delete a task
 *
 * The board UI is at http://localhost:${APP_PORT:-3000}/admin/tasks
 */
import * as t from '../db/dev-tasks-repository';
import { closePool } from '../db/connection';

function parseOpts(args: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg && arg.startsWith('--')) {
      opts[arg.slice(2)] = args[i + 1] ?? '';
      i++;
    }
  }
  return opts;
}

const PRI_MARK: Record<string, string> = { urgent: '🔴', high: '🟠', medium: '⚪', low: '·' };

function fmt(task: t.DevTask): string {
  const pri = PRI_MARK[task.priority] || '';
  const who = task.assignee ? ` @${task.assignee}` : '';
  const br = task.branch ? ` ⎇${task.branch}` : '';
  const tags = task.tags ? ` [${task.tags}]` : '';
  return `#${task.id} ${pri} ${task.status.padEnd(11)} ${task.title}${who}${br}${tags}`;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  try {
    await t.ensureDevTasksSchema();

    switch (cmd) {
      case 'list': {
        const status = rest[0] as t.DevTaskStatus | undefined;
        const list = await t.listTasks({ status: status && t.DEV_TASK_STATUSES.includes(status) ? status : undefined });
        if (list.length === 0) { console.log('(no tasks)'); break; }
        for (const task of list) console.log(fmt(task));
        const stats = await t.getStats();
        console.log('\n' + Object.entries(stats).map(([s, n]) => `${s}:${n}`).join('  '));
        break;
      }
      case 'show': {
        const id = parseInt(rest[0], 10);
        const task = await t.getTask(id);
        if (!task) { console.error(`Task #${id} not found`); process.exit(1); }
        console.log(fmt(task));
        if (task.description) console.log('\n' + task.description);
        const events = await t.getTaskEvents(id);
        if (events.length) {
          console.log('\nActivity:');
          for (const e of events) {
            console.log(`  ${e.created_at}  ${e.author || '?'}  ${e.kind}: ${e.body || ''}`);
          }
        }
        break;
      }
      case 'add': {
        const title = rest[0];
        if (!title) { console.error('Usage: add "<title>" [--desc ... --priority ... --assignee ... --tags ... --branch ... --status ...]'); process.exit(1); }
        const o = parseOpts(rest.slice(1));
        const task = await t.createTask({
          title,
          description: o.desc,
          priority: o.priority as t.DevTaskPriority,
          assignee: o.assignee,
          tags: o.tags,
          branch: o.branch,
          status: o.status as t.DevTaskStatus,
          author: o.author || o.assignee,
        });
        console.log('Created ' + fmt(task));
        break;
      }
      case 'status': {
        const id = parseInt(rest[0], 10);
        const status = rest[1] as t.DevTaskStatus;
        const who = rest[2];
        if (!t.DEV_TASK_STATUSES.includes(status)) { console.error(`Invalid status. One of: ${t.DEV_TASK_STATUSES.join(', ')}`); process.exit(1); }
        const task = await t.updateTask(id, { status, assignee: who, author: who });
        if (!task) { console.error(`Task #${id} not found`); process.exit(1); }
        console.log('Updated ' + fmt(task));
        break;
      }
      case 'claim': {
        const id = parseInt(rest[0], 10);
        const who = rest[1];
        if (!who) { console.error('Usage: claim <id> <who>'); process.exit(1); }
        const task = await t.updateTask(id, { assignee: who, status: 'in_progress', author: who });
        if (!task) { console.error(`Task #${id} not found`); process.exit(1); }
        console.log('Claimed ' + fmt(task));
        break;
      }
      case 'assign': {
        const id = parseInt(rest[0], 10);
        const who = rest[1];
        const task = await t.updateTask(id, { assignee: who, author: who });
        if (!task) { console.error(`Task #${id} not found`); process.exit(1); }
        console.log('Assigned ' + fmt(task));
        break;
      }
      case 'comment': {
        const id = parseInt(rest[0], 10);
        const body = rest[1];
        const who = rest[2];
        if (!body) { console.error('Usage: comment <id> "<text>" [who]'); process.exit(1); }
        const ev = await t.addComment(id, body, who);
        if (!ev) { console.error(`Task #${id} not found`); process.exit(1); }
        console.log('Comment added to #' + id);
        break;
      }
      case 'done': {
        const id = parseInt(rest[0], 10);
        const who = rest[1];
        const task = await t.updateTask(id, { status: 'done', author: who });
        if (!task) { console.error(`Task #${id} not found`); process.exit(1); }
        console.log('Done ' + fmt(task));
        break;
      }
      case 'rm': {
        const id = parseInt(rest[0], 10);
        const ok = await t.deleteTask(id);
        console.log(ok ? `Deleted #${id}` : `Task #${id} not found`);
        break;
      }
      default:
        console.log('Commands: list [status] | show <id> | add "<title>" [opts] | status <id> <status> [who] | claim <id> <who> | assign <id> <who> | comment <id> "<text>" [who] | done <id> [who] | rm <id>');
        console.log('Board UI: /admin/tasks');
    }
    await closePool();
    process.exit(0);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    await closePool().catch(() => {});
    process.exit(2);
  }
}

main();
