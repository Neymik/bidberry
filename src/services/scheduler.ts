import type { SchedulerStatus } from '../types';

interface ScheduledTask {
  name: string;
  interval: number; // ms
  callback: () => Promise<void>;
  timer: ReturnType<typeof setInterval> | null;
  lastRun: Date | null;
  status: 'idle' | 'running' | 'error';
  lastError?: string;
}

const tasks: Map<string, ScheduledTask> = new Map();
let isRunning = false;

export function registerTask(name: string, intervalMs: number, callback: () => Promise<void>): void {
  tasks.set(name, {
    name,
    interval: intervalMs,
    callback,
    timer: null,
    lastRun: null,
    status: 'idle',
  });
}

export function start(): void {
  if (isRunning) return;
  isRunning = true;

  for (const [, task] of tasks) {
    task.timer = setInterval(async () => {
      if (task.status === 'running') return; // Skip if already running
      task.status = 'running';
      try {
        await task.callback();
        task.lastRun = new Date();
        task.status = 'idle';
        task.lastError = undefined;
      } catch (error: any) {
        task.status = 'error';
        task.lastError = error.message;
        console.error(`Scheduler task "${task.name}" failed:`, error.message);
      }
    }, task.interval);
  }

  console.log(`Scheduler started with ${tasks.size} tasks`);
}

export function stop(): void {
  if (!isRunning) return;
  isRunning = false;

  for (const [, task] of tasks) {
    if (task.timer) {
      clearInterval(task.timer);
      task.timer = null;
    }
  }

  console.log('Scheduler stopped');
}

export function getStatus(): SchedulerStatus {
  const taskList = [...tasks.values()].map(t => ({
    name: t.name,
    interval: formatInterval(t.interval),
    lastRun: t.lastRun?.toISOString() || null,
    nextRun: t.lastRun
      ? new Date(t.lastRun.getTime() + t.interval).toISOString()
      : null,
    status: t.status,
    lastError: t.lastError,
  }));

  return { running: isRunning, tasks: taskList };
}

function formatInterval(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

export function initDefaultTasks(): void {
  // These will be imported and registered in src/index.ts
  // Just providing the structure here
}
