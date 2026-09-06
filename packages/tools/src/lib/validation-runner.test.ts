import { describe, expect, test, vi } from 'vitest';
import {
  allocateWorkers,
  createValidationPlan,
  parseValidationProfile,
  resolveWorkerBudget,
  runValidationPlan,
  type ValidationProfileName,
  type ValidationTaskExecutor,
} from './validation-runner.ts';

describe('validation runner', () => {
  test.each([
    [1, 1],
    [4, 2],
    [24, 12],
  ])(
    'uses 50%% of detected parallelism %i for the local full worker budget',
    (detectedParallelism, expectedWorkerBudget) => {
      expect(
        resolveWorkerBudget(undefined, 'full', false, detectedParallelism),
      ).toEqual({
        workerBudget: expectedWorkerBudget,
        source: 'local full default (50%)',
      });
    },
  );

  test('uses all detected parallelism for local quick validation', () => {
    expect(resolveWorkerBudget(undefined, 'quick', false, 24)).toEqual({
      workerBudget: 24,
      source: 'local quick default (100%)',
    });
  });

  test.each<ValidationProfileName>(['quick', 'full'])(
    'uses all detected parallelism for the %s profile in CI',
    (profile) => {
      expect(resolveWorkerBudget(undefined, profile, true, 24)).toEqual({
        workerBudget: 24,
        source: 'CI default (100%)',
      });
    },
  );

  test('prefers a configured worker budget in every context', () => {
    const contexts: Array<{
      profile: ValidationProfileName;
      isCi: boolean;
    }> = [
      { profile: 'quick', isCi: false },
      { profile: 'quick', isCi: true },
      { profile: 'full', isCi: false },
      { profile: 'full', isCi: true },
    ];

    for (const { profile, isCi } of contexts) {
      expect(resolveWorkerBudget('2', profile, isCi, 24)).toEqual({
        workerBudget: 2,
        source: 'ISSUARY_TEST_WORKERS',
      });
    }
  });

  test.each(['0', '-1', '1.5', 'invalid'])(
    'rejects invalid configured worker budget %s',
    (configuredWorkerBudget) => {
      expect(() =>
        resolveWorkerBudget(configuredWorkerBudget, 'full', false),
      ).toThrow('ISSUARY_TEST_WORKERS must be a positive integer');
    },
  );

  test.each([1, 4, 24])(
    'uses detected parallelism %i as the CI default worker budget',
    (detectedParallelism) => {
      expect(
        resolveWorkerBudget(undefined, 'full', true, detectedParallelism)
          .workerBudget,
      ).toBe(detectedParallelism);
    },
  );

  test('parses supported validation profiles', () => {
    expect(parseValidationProfile(undefined)).toBe('quick');
    expect(parseValidationProfile('quick')).toBe('quick');
    expect(parseValidationProfile('full')).toBe('full');
    expect(() => parseValidationProfile('local')).toThrow(
      'Unknown validation profile: local',
    );
  });

  test('keeps concurrent allocations within the worker budget', () => {
    const tasks = createValidationPlan('quick').concurrent.slice(0, 4);
    const allocations = allocateWorkers(tasks, 4);
    expect(allocations.reduce((sum, workers) => sum + workers, 0)).toBe(4);
    expect(allocations.every((workers) => workers >= 1)).toBe(true);
  });

  test('allocates all available workers across the full concurrent group', () => {
    const tasks = createValidationPlan('full').concurrent;
    const allocations = allocateWorkers(tasks, 24);

    expect(allocations).toHaveLength(tasks.length);
    expect(allocations.reduce((sum, workers) => sum + workers, 0)).toBe(24);
    expect(allocations.every((workers) => workers >= 1)).toBe(true);
  });

  test('creates a focused quick plan', () => {
    const plan = createValidationPlan('quick');
    expect(plan.before.map((task) => task.name)).toEqual([
      'design system',
      'biome',
      'typecheck',
    ]);
    expect(plan.concurrent.map((task) => task.name)).toEqual([
      'frontend unit',
      'server',
      'standalone',
      'tools',
      'homepage',
    ]);
    expect(plan.after).toEqual([]);
    expect(plan.concurrentTaskLimit).toBe(2);
    expect(plan.concurrent[0]?.args(1)).toContain('test:unit:chromium');
    expect(plan.concurrent[4]?.args(1)).toContain('test:quick');
    expect(plan.before[0]?.args(1)).toEqual(['check:ui']);
  });

  test('preserves complete validation in the full plan', () => {
    const plan = createValidationPlan('full');
    expect(
      [...plan.before, ...plan.concurrent, ...plan.after].map(
        (task) => task.name,
      ),
    ).toEqual([
      'design system',
      'build',
      'server',
      'frontend unit',
      'standalone',
      'tools',
      'homepage',
      'example smoke',
      'standalone dist',
      'frontend e2e',
    ]);
  });

  test('propagates concurrent failures and skips later batches', async () => {
    const executed: string[] = [];
    const execute: ValidationTaskExecutor = vi.fn(async (task) => {
      executed.push(task.name);
      if (task.name === 'server') throw new Error('server failed');
    });
    await expect(
      runValidationPlan(createValidationPlan('quick'), 4, execute),
    ).rejects.toThrow('Validation test group failed');
    expect(executed).not.toContain('standalone');
    expect(executed).not.toContain('homepage');
  });
});
