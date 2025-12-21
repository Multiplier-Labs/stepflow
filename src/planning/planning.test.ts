import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryRecipeRegistry, MemoryStepHandlerRegistry, createRegistry } from './registry';
import { RuleBasedPlanner } from './planner';
import type { Recipe, RecipeCondition, PlanningContext } from './types';

describe('MemoryRecipeRegistry', () => {
  let registry: MemoryRecipeRegistry;

  beforeEach(() => {
    registry = new MemoryRecipeRegistry();
  });

  const createTestRecipe = (overrides: Partial<Recipe> = {}): Recipe => ({
    id: 'test.recipe',
    name: 'Test Recipe',
    workflowKind: 'test.workflow',
    variant: 'default',
    steps: [
      { key: 'step1', name: 'Step 1', handlerRef: 'handlers.step1' },
    ],
    ...overrides,
  });

  describe('register', () => {
    it('should register a recipe', () => {
      const recipe = createTestRecipe();
      registry.register(recipe);

      expect(registry.has('test.recipe')).toBe(true);
      expect(registry.get('test.recipe')).toEqual(recipe);
    });

    it('should throw if recipe already registered', () => {
      const recipe = createTestRecipe();
      registry.register(recipe);

      expect(() => registry.register(recipe)).toThrow(
        "Recipe 'test.recipe' is already registered"
      );
    });

    it('should throw if variant already exists for workflow kind', () => {
      const recipe1 = createTestRecipe({ id: 'recipe1' });
      const recipe2 = createTestRecipe({ id: 'recipe2' });

      registry.register(recipe1);

      expect(() => registry.register(recipe2)).toThrow(
        "Recipe variant 'default' for 'test.workflow' is already registered"
      );
    });
  });

  describe('getByKind', () => {
    it('should return all recipes for a workflow kind', () => {
      registry.register(createTestRecipe({ id: 'recipe1', variant: 'default' }));
      registry.register(createTestRecipe({ id: 'recipe2', variant: 'fast' }));
      registry.register(createTestRecipe({
        id: 'recipe3',
        workflowKind: 'other.workflow',
        variant: 'default',
      }));

      const recipes = registry.getByKind('test.workflow');
      expect(recipes).toHaveLength(2);
      expect(recipes.map(r => r.id)).toContain('recipe1');
      expect(recipes.map(r => r.id)).toContain('recipe2');
    });

    it('should return empty array if no recipes found', () => {
      expect(registry.getByKind('nonexistent')).toEqual([]);
    });
  });

  describe('getVariant', () => {
    it('should return specific variant', () => {
      registry.register(createTestRecipe({ id: 'recipe1', variant: 'default' }));
      registry.register(createTestRecipe({ id: 'recipe2', variant: 'fast' }));

      const recipe = registry.getVariant('test.workflow', 'fast');
      expect(recipe?.id).toBe('recipe2');
    });

    it('should return undefined if variant not found', () => {
      registry.register(createTestRecipe());

      expect(registry.getVariant('test.workflow', 'nonexistent')).toBeUndefined();
    });
  });

  describe('getDefault', () => {
    it('should return default variant if exists', () => {
      registry.register(createTestRecipe({ id: 'recipe1', variant: 'default' }));
      registry.register(createTestRecipe({ id: 'recipe2', variant: 'fast' }));

      const recipe = registry.getDefault('test.workflow');
      expect(recipe?.variant).toBe('default');
    });

    it('should return lowest priority recipe if no default variant', () => {
      registry.register(createTestRecipe({ id: 'recipe1', variant: 'fast', priority: 10 }));
      registry.register(createTestRecipe({ id: 'recipe2', variant: 'slow', priority: 5 }));

      const recipe = registry.getDefault('test.workflow');
      expect(recipe?.id).toBe('recipe2');
    });
  });

  describe('listVariants', () => {
    it('should list all variants for a workflow kind', () => {
      registry.register(createTestRecipe({ id: 'recipe1', variant: 'default' }));
      registry.register(createTestRecipe({ id: 'recipe2', variant: 'fast' }));
      registry.register(createTestRecipe({ id: 'recipe3', variant: 'thorough' }));

      const variants = registry.listVariants('test.workflow');
      expect(variants).toHaveLength(3);
      expect(variants).toContain('default');
      expect(variants).toContain('fast');
      expect(variants).toContain('thorough');
    });
  });

  describe('query', () => {
    it('should filter by workflow kind', () => {
      registry.register(createTestRecipe({ id: 'recipe1', variant: 'v1' }));
      registry.register(createTestRecipe({
        id: 'recipe2',
        workflowKind: 'other',
        variant: 'v1',
      }));

      const results = registry.query({ workflowKind: 'test.workflow' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('recipe1');
    });

    it('should filter by tags', () => {
      registry.register(createTestRecipe({ id: 'recipe1', variant: 'v1', tags: ['fast', 'simple'] }));
      registry.register(createTestRecipe({ id: 'recipe2', variant: 'v2', tags: ['slow', 'complex'] }));

      const results = registry.query({ tags: ['fast'] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('recipe1');
    });
  });
});

describe('MemoryStepHandlerRegistry', () => {
  let registry: MemoryStepHandlerRegistry;

  beforeEach(() => {
    registry = new MemoryStepHandlerRegistry();
  });

  it('should register and retrieve handlers', () => {
    const handler = {
      id: 'test.handler',
      description: 'Test handler',
      handler: async () => ({ result: 'test' }),
    };

    registry.register(handler);

    expect(registry.has('test.handler')).toBe(true);
    expect(registry.get('test.handler')).toEqual(handler);
  });

  it('should throw if handler already registered', () => {
    const handler = {
      id: 'test.handler',
      handler: async () => ({}),
    };

    registry.register(handler);

    expect(() => registry.register(handler)).toThrow(
      "Step handler 'test.handler' is already registered"
    );
  });

  it('should list handlers by tag', () => {
    registry.register({
      id: 'handler1',
      handler: async () => ({}),
      tags: ['llm', 'text'],
    });
    registry.register({
      id: 'handler2',
      handler: async () => ({}),
      tags: ['data', 'text'],
    });

    const llmHandlers = registry.listByTag('llm');
    expect(llmHandlers).toHaveLength(1);
    expect(llmHandlers[0].id).toBe('handler1');

    const textHandlers = registry.listByTag('text');
    expect(textHandlers).toHaveLength(2);
  });
});

describe('RuleBasedPlanner', () => {
  let registry: MemoryRecipeRegistry;
  let planner: RuleBasedPlanner;

  beforeEach(() => {
    registry = new MemoryRecipeRegistry();
    planner = new RuleBasedPlanner({ recipeRegistry: registry });
  });

  const createTestRecipe = (overrides: Partial<Recipe> = {}): Recipe => ({
    id: 'test.recipe',
    name: 'Test Recipe',
    workflowKind: 'test.workflow',
    variant: 'default',
    steps: [
      { key: 'step1', name: 'Step 1', handlerRef: 'handlers.step1' },
      { key: 'step2', name: 'Step 2', handlerRef: 'handlers.step2' },
    ],
    ...overrides,
  });

  describe('selectRecipe', () => {
    it('should select recipe with matching conditions', async () => {
      const conditions: RecipeCondition[] = [
        { field: 'priority', operator: 'eq', value: 'speed' },
      ];

      registry.register(createTestRecipe({ id: 'default', variant: 'default' }));
      registry.register(createTestRecipe({
        id: 'fast',
        variant: 'fast',
        conditions,
        priority: 10,
      }));

      const result = await planner.selectRecipe('test.workflow', { priority: 'speed' });

      expect(result.recipe.id).toBe('fast');
      expect(result.score).toBeGreaterThan(0);
    });

    it('should fall back to default if no conditions match', async () => {
      registry.register(createTestRecipe({ id: 'default', variant: 'default' }));
      registry.register(createTestRecipe({
        id: 'fast',
        variant: 'fast',
        conditions: [{ field: 'priority', operator: 'eq', value: 'speed' }],
      }));

      const result = await planner.selectRecipe('test.workflow', { priority: 'quality' });

      expect(result.recipe.id).toBe('default');
    });

    it('should use forced recipe from hints', async () => {
      registry.register(createTestRecipe({ id: 'default', variant: 'default' }));
      registry.register(createTestRecipe({ id: 'specific', variant: 'specific' }));

      const context: PlanningContext = {
        hints: { forceRecipeId: 'specific' },
      };

      const result = await planner.selectRecipe('test.workflow', {}, context);

      expect(result.recipe.id).toBe('specific');
      expect(result.score).toBe(100);
    });

    it('should use preferred variant from hints', async () => {
      registry.register(createTestRecipe({ id: 'default', variant: 'default' }));
      registry.register(createTestRecipe({ id: 'fast', variant: 'fast' }));

      const context: PlanningContext = {
        hints: { preferredVariant: 'fast' },
      };

      const result = await planner.selectRecipe('test.workflow', {}, context);

      expect(result.recipe.id).toBe('fast');
    });

    it('should throw if no recipes found', async () => {
      await expect(
        planner.selectRecipe('nonexistent', {})
      ).rejects.toThrow('No recipes found for workflow kind: nonexistent');
    });
  });

  describe('generatePlan', () => {
    it('should generate a plan from a recipe', async () => {
      const recipe = createTestRecipe();

      const plan = await planner.generatePlan(recipe, {});

      expect(plan.recipeId).toBe('test.recipe');
      expect(plan.variant).toBe('default');
      expect(plan.steps).toHaveLength(2);
      expect(plan.steps[0].key).toBe('step1');
      expect(plan.steps[1].key).toBe('step2');
    });

    it('should apply skip hints', async () => {
      const recipe = createTestRecipe();
      const context: PlanningContext = {
        hints: { skipSteps: ['step1'] },
      };

      const plan = await planner.generatePlan(recipe, {}, context);

      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].key).toBe('step2');
      expect(plan.modifications).toContainEqual(
        expect.objectContaining({ type: 'remove_step', stepKey: 'step1' })
      );
    });

    it('should apply additional config from hints', async () => {
      const recipe = createTestRecipe();
      const context: PlanningContext = {
        hints: { additionalConfig: { depth: 'comprehensive' } },
      };

      const plan = await planner.generatePlan(recipe, {}, context);

      expect(plan.steps[0].config).toEqual({ depth: 'comprehensive' });
      expect(plan.steps[1].config).toEqual({ depth: 'comprehensive' });
    });

    it('should apply speed constraints', async () => {
      const recipe = createTestRecipe({
        steps: [
          { key: 'step1', name: 'Step 1', handlerRef: 'h1', timeout: 60000, maxRetries: 5 },
        ],
      });
      const context: PlanningContext = {
        constraints: { priority: 'speed' },
      };

      const plan = await planner.generatePlan(recipe, {}, context);

      expect(plan.steps[0].timeout).toBeLessThanOrEqual(30000);
      expect(plan.steps[0].maxRetries).toBeLessThanOrEqual(1);
    });

    it('should apply duration constraints', async () => {
      const recipe = createTestRecipe();
      const context: PlanningContext = {
        constraints: { maxDuration: 10000 },
      };

      const plan = await planner.generatePlan(recipe, {}, context);

      // With 2 steps and 10s total, each step should get ~5s
      expect(plan.steps[0].timeout).toBeLessThanOrEqual(5000);
      expect(plan.steps[1].timeout).toBeLessThanOrEqual(5000);
    });
  });

  describe('plan', () => {
    it('should select recipe and generate plan in one call', async () => {
      registry.register(createTestRecipe());

      const plan = await planner.plan('test.workflow', {});

      expect(plan.recipeId).toBe('test.recipe');
      expect(plan.steps).toHaveLength(2);
      expect(plan.reasoning).toContain('test.recipe');
    });
  });

  describe('validatePlan', () => {
    it('should validate a correct plan', async () => {
      registry.register(createTestRecipe());
      const plan = await planner.plan('test.workflow', {});

      const result = planner.validatePlan(plan);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing steps', () => {
      const result = planner.validatePlan({
        id: 'plan-1',
        recipeId: 'test',
        variant: 'default',
        modifications: [],
        steps: [],
        defaults: {},
        createdAt: new Date(),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Plan has no steps');
    });

    it('should detect duplicate step keys', () => {
      const result = planner.validatePlan({
        id: 'plan-1',
        recipeId: 'test',
        variant: 'default',
        modifications: [],
        steps: [
          { key: 'step1', name: 'Step 1', handlerRef: 'h1', config: {} },
          { key: 'step1', name: 'Step 1 Duplicate', handlerRef: 'h2', config: {} },
        ],
        defaults: {},
        createdAt: new Date(),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate step key: step1');
    });
  });

  describe('estimateResources', () => {
    it('should estimate resources for a plan', async () => {
      registry.register(createTestRecipe());
      const plan = await planner.plan('test.workflow', {});

      const estimate = planner.estimateResources(plan);

      expect(estimate.apiCalls).toBeGreaterThan(0);
      expect(estimate.tokens).toBeGreaterThan(0);
      expect(estimate.duration).toBeGreaterThan(0);
    });
  });
});

describe('createRegistry', () => {
  it('should create a combined registry', () => {
    const { recipes, handlers } = createRegistry();

    expect(recipes).toBeInstanceOf(MemoryRecipeRegistry);
    expect(handlers).toBeInstanceOf(MemoryStepHandlerRegistry);
  });
});

describe('Condition Evaluation', () => {
  let registry: MemoryRecipeRegistry;
  let planner: RuleBasedPlanner;

  beforeEach(() => {
    registry = new MemoryRecipeRegistry();
    planner = new RuleBasedPlanner({ recipeRegistry: registry });
  });

  const testConditions = async (
    conditions: RecipeCondition[],
    input: Record<string, unknown>,
    shouldMatch: boolean
  ) => {
    registry.clear();
    registry.register({
      id: 'conditional',
      name: 'Conditional Recipe',
      workflowKind: 'test.workflow',
      variant: 'conditional',
      steps: [{ key: 's1', name: 'S1', handlerRef: 'h1' }],
      conditions,
      priority: 10,
    });
    registry.register({
      id: 'default',
      name: 'Default Recipe',
      workflowKind: 'test.workflow',
      variant: 'default',
      steps: [{ key: 's1', name: 'S1', handlerRef: 'h1' }],
    });

    const result = await planner.selectRecipe('test.workflow', input);
    if (shouldMatch) {
      expect(result.recipe.id).toBe('conditional');
    } else {
      expect(result.recipe.id).toBe('default');
    }
  };

  it('should evaluate eq operator', async () => {
    await testConditions(
      [{ field: 'type', operator: 'eq', value: 'fast' }],
      { type: 'fast' },
      true
    );
    await testConditions(
      [{ field: 'type', operator: 'eq', value: 'fast' }],
      { type: 'slow' },
      false
    );
  });

  it('should evaluate neq operator', async () => {
    await testConditions(
      [{ field: 'type', operator: 'neq', value: 'slow' }],
      { type: 'fast' },
      true
    );
    await testConditions(
      [{ field: 'type', operator: 'neq', value: 'slow' }],
      { type: 'slow' },
      false
    );
  });

  it('should evaluate gt operator', async () => {
    await testConditions(
      [{ field: 'count', operator: 'gt', value: 10 }],
      { count: 15 },
      true
    );
    await testConditions(
      [{ field: 'count', operator: 'gt', value: 10 }],
      { count: 5 },
      false
    );
  });

  it('should evaluate gte operator', async () => {
    await testConditions(
      [{ field: 'count', operator: 'gte', value: 10 }],
      { count: 10 },
      true
    );
    await testConditions(
      [{ field: 'count', operator: 'gte', value: 10 }],
      { count: 9 },
      false
    );
  });

  it('should evaluate lt operator', async () => {
    await testConditions(
      [{ field: 'count', operator: 'lt', value: 10 }],
      { count: 5 },
      true
    );
    await testConditions(
      [{ field: 'count', operator: 'lt', value: 10 }],
      { count: 15 },
      false
    );
  });

  it('should evaluate lte operator', async () => {
    await testConditions(
      [{ field: 'count', operator: 'lte', value: 10 }],
      { count: 10 },
      true
    );
    await testConditions(
      [{ field: 'count', operator: 'lte', value: 10 }],
      { count: 11 },
      false
    );
  });

  it('should evaluate contains operator for strings', async () => {
    await testConditions(
      [{ field: 'name', operator: 'contains', value: 'test' }],
      { name: 'my-test-file' },
      true
    );
    await testConditions(
      [{ field: 'name', operator: 'contains', value: 'test' }],
      { name: 'my-file' },
      false
    );
  });

  it('should evaluate contains operator for arrays', async () => {
    await testConditions(
      [{ field: 'tags', operator: 'contains', value: 'urgent' }],
      { tags: ['urgent', 'review'] },
      true
    );
    await testConditions(
      [{ field: 'tags', operator: 'contains', value: 'urgent' }],
      { tags: ['normal'] },
      false
    );
  });

  it('should evaluate matches operator', async () => {
    await testConditions(
      [{ field: 'email', operator: 'matches', value: '^test@' }],
      { email: 'test@example.com' },
      true
    );
    await testConditions(
      [{ field: 'email', operator: 'matches', value: '^test@' }],
      { email: 'user@example.com' },
      false
    );
  });

  it('should evaluate exists operator', async () => {
    await testConditions(
      [{ field: 'optional', operator: 'exists' }],
      { optional: 'value' },
      true
    );
    await testConditions(
      [{ field: 'optional', operator: 'exists' }],
      { other: 'value' },
      false
    );
    await testConditions(
      [{ field: 'optional', operator: 'exists' }],
      { optional: '' },
      false
    );
  });

  it('should evaluate notExists operator', async () => {
    await testConditions(
      [{ field: 'optional', operator: 'notExists' }],
      { other: 'value' },
      true
    );
    await testConditions(
      [{ field: 'optional', operator: 'notExists' }],
      { optional: 'value' },
      false
    );
  });

  it('should evaluate nested fields', async () => {
    await testConditions(
      [{ field: 'config.settings.enabled', operator: 'eq', value: true }],
      { config: { settings: { enabled: true } } },
      true
    );
    await testConditions(
      [{ field: 'config.settings.enabled', operator: 'eq', value: true }],
      { config: { settings: { enabled: false } } },
      false
    );
  });

  it('should require all conditions to match', async () => {
    await testConditions(
      [
        { field: 'type', operator: 'eq', value: 'fast' },
        { field: 'count', operator: 'gt', value: 5 },
      ],
      { type: 'fast', count: 10 },
      true
    );
    await testConditions(
      [
        { field: 'type', operator: 'eq', value: 'fast' },
        { field: 'count', operator: 'gt', value: 5 },
      ],
      { type: 'fast', count: 3 },
      false
    );
  });
});
