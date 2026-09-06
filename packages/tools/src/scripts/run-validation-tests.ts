import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  createValidationPlan,
  parseValidationProfile,
  resolveWorkerBudget,
  runValidationPlan,
  type ValidationTask,
} from '#tools/lib/validation-runner.ts';

function readProfileArgument(args: string[]): string | undefined {
  const argument = args.find((value) => value.startsWith('--profile='));
  return argument?.slice('--profile='.length);
}

function runPnpm(args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `${label} failed (${signal ? `signal ${signal}` : `exit ${code}`})`,
        ),
      );
    });
  });
}

const profile = parseValidationProfile(
  readProfileArgument(process.argv.slice(2)),
);
const configuredWorkerBudget = process.env['ISSUARY_TEST_WORKERS'];
const { workerBudget, source: workerBudgetSource } = resolveWorkerBudget(
  configuredWorkerBudget,
  profile,
  process.env['CI'] !== undefined,
);
process.env['ISSUARY_TEST_WORKERS'] = String(workerBudget);
process.stdout.write(
  `[validation] profile: ${profile}; global worker budget: ${workerBudget} (${workerBudgetSource})\n`,
);

await runValidationPlan(
  createValidationPlan(profile),
  workerBudget,
  async (task: ValidationTask, workers: number) => {
    const startedAt = performance.now();
    process.stdout.write(
      `[validation] ${task.name}: started with ${workers} worker${workers === 1 ? '' : 's'}\n`,
    );
    try {
      await runPnpm(task.args(workers), task.name);
      process.stdout.write(
        `[validation] ${task.name}: completed in ${((performance.now() - startedAt) / 1000).toFixed(1)}s\n`,
      );
    } catch (error) {
      process.stderr.write(
        `[validation] ${task.name}: failed after ${((performance.now() - startedAt) / 1000).toFixed(1)}s\n`,
      );
      throw error;
    }
  },
);
