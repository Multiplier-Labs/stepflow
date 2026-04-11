/**
 * Recipe and Step Handler registries.
 * Provides storage and retrieval of recipes and handlers.
 */

import RE2 from 're2';
import type { WorkflowStep } from '../core/types';
import type {
  Recipe,
  RecipeCondition,
  RecipeRegistry,
  RecipeQueryOptions,
  RegisteredStepHandler,
  StepHandlerRegistry,
  WorkflowKind,
} from './types';

// ============================================================================
// Step Handler Registry Implementation
// ============================================================================

/**
 * In-memory implementation of the step handler registry.
 */
export class MemoryStepHandlerRegistry implements StepHandlerRegistry {
  private handlers = new Map<string, RegisteredStepHandler>();
  private tagIndex = new Map<string, Set<string>>();

  /** Register a step handler. Throws if a handler with the same ID is already registered. */
  register<TInput = Record<string, unknown>>(
    handler: RegisteredStepHandler<TInput>
  ): void {
    if (this.handlers.has(handler.id)) {
      throw new Error(`Step handler '${handler.id}' is already registered`);
    }

    this.handlers.set(handler.id, handler as RegisteredStepHandler);

    // Index by tags
    if (handler.tags) {
      for (const tag of handler.tags) {
        if (!this.tagIndex.has(tag)) {
          this.tagIndex.set(tag, new Set());
        }
        this.tagIndex.get(tag)!.add(handler.id);
      }
    }
  }

  /** Get a handler by its unique ID, or undefined if not registered. */
  get(id: string): RegisteredStepHandler | undefined {
    return this.handlers.get(id);
  }

  /** Check whether a handler with the given ID is registered. */
  has(id: string): boolean {
    return this.handlers.has(id);
  }

  /** List all registered step handlers. */
  list(): RegisteredStepHandler[] {
    return Array.from(this.handlers.values());
  }

  /** List all handlers tagged with the given tag. */
  listByTag(tag: string): RegisteredStepHandler[] {
    const ids = this.tagIndex.get(tag);
    if (!ids) return [];

    return Array.from(ids)
      .map(id => this.handlers.get(id))
      .filter((h): h is RegisteredStepHandler => h !== undefined);
  }

  /**
   * Resolve a handler reference to a WorkflowStep handler function.
   * Returns undefined if the handler is not found.
   */
  resolve(handlerRef: string): WorkflowStep['handler'] | undefined {
    const registered = this.handlers.get(handlerRef);
    return registered?.handler;
  }

  /**
   * Clear all registered handlers (useful for testing).
   */
  clear(): void {
    this.handlers.clear();
    this.tagIndex.clear();
  }
}

// ============================================================================
// Recipe Registry Implementation
// ============================================================================

/**
 * In-memory implementation of the recipe registry.
 */
export class MemoryRecipeRegistry implements RecipeRegistry {
  private recipes = new Map<string, Recipe>();
  private kindIndex = new Map<WorkflowKind, Set<string>>();
  private variantIndex = new Map<string, string>(); // "kind:variant" -> recipeId
  private tagIndex = new Map<string, Set<string>>();

  /** Register a single recipe. Throws if a recipe with the same ID or kind:variant pair is already registered. */
  register(recipe: Recipe): void {
    if (this.recipes.has(recipe.id)) {
      throw new Error(`Recipe '${recipe.id}' is already registered`);
    }

    this.recipes.set(recipe.id, recipe);

    // Index by workflow kind
    if (!this.kindIndex.has(recipe.workflowKind)) {
      this.kindIndex.set(recipe.workflowKind, new Set());
    }
    this.kindIndex.get(recipe.workflowKind)!.add(recipe.id);

    // Index by kind:variant
    const variantKey = `${recipe.workflowKind}:${recipe.variant}`;
    if (this.variantIndex.has(variantKey)) {
      throw new Error(
        `Recipe variant '${recipe.variant}' for '${recipe.workflowKind}' is already registered`
      );
    }
    this.variantIndex.set(variantKey, recipe.id);

    // Index by tags
    if (recipe.tags) {
      for (const tag of recipe.tags) {
        if (!this.tagIndex.has(tag)) {
          this.tagIndex.set(tag, new Set());
        }
        this.tagIndex.get(tag)!.add(recipe.id);
      }
    }
  }

  /** Register multiple recipes at once. */
  registerAll(recipes: Recipe[]): void {
    for (const recipe of recipes) {
      this.register(recipe);
    }
  }

  /** Get a recipe by its unique ID, or undefined if not registered. */
  get(recipeId: string): Recipe | undefined {
    return this.recipes.get(recipeId);
  }

  /** Check whether a recipe with the given ID is registered. */
  has(recipeId: string): boolean {
    return this.recipes.has(recipeId);
  }

  /** Get all recipes registered for a given workflow kind. */
  getByKind(workflowKind: WorkflowKind): Recipe[] {
    const ids = this.kindIndex.get(workflowKind);
    if (!ids) return [];

    return Array.from(ids)
      .map(id => this.recipes.get(id))
      .filter((r): r is Recipe => r !== undefined);
  }

  /** Get the recipe for a specific workflow kind and variant combination. */
  getVariant(workflowKind: WorkflowKind, variant: string): Recipe | undefined {
    const variantKey = `${workflowKind}:${variant}`;
    const recipeId = this.variantIndex.get(variantKey);
    if (!recipeId) return undefined;
    return this.recipes.get(recipeId);
  }

  /**
   * Get the default recipe for a workflow kind.
   * Returns the 'default' variant if one exists, otherwise falls back to the
   * recipe with the lowest numeric priority value (lower number = higher precedence).
   */
  getDefault(workflowKind: WorkflowKind): Recipe | undefined {
    // First try to find a 'default' variant
    const defaultRecipe = this.getVariant(workflowKind, 'default');
    if (defaultRecipe) return defaultRecipe;

    // Fall back to the recipe with the lowest numeric priority (highest precedence).
    // Note: this ascending order is the inverse of RuleBasedPlanner.selectRecipe,
    // which uses descending priority as a tiebreaker in condition-based scoring.
    const recipes = this.getByKind(workflowKind);
    if (recipes.length === 0) return undefined;

    return recipes.reduce((lowest, current) => {
      const currentPriority = current.priority ?? 0;
      const lowestPriority = lowest.priority ?? 0;
      return currentPriority < lowestPriority ? current : lowest;
    });
  }

  /** List all variant names registered for a workflow kind. */
  listVariants(workflowKind: WorkflowKind): string[] {
    const recipes = this.getByKind(workflowKind);
    return recipes.map(r => r.variant);
  }

  /** Query recipes with optional filters for kind, variant, tags, and input conditions. */
  query(options: RecipeQueryOptions): Recipe[] {
    let results = this.list();

    if (options.workflowKind) {
      results = results.filter(r => r.workflowKind === options.workflowKind);
    }

    if (options.variant) {
      results = results.filter(r => r.variant === options.variant);
    }

    if (options.tags && options.tags.length > 0) {
      results = results.filter(r =>
        options.tags!.some(tag => r.tags?.includes(tag))
      );
    }

    if (options.matchConditions) {
      results = results.filter(r => {
        if (!r.conditions || r.conditions.length === 0) return true;
        return this.evaluateConditions(r.conditions, options.matchConditions!);
      });
    }

    return results;
  }

  /** List all registered recipes. */
  list(): Recipe[] {
    return Array.from(this.recipes.values());
  }

  /**
   * Clear all registered recipes (useful for testing).
   */
  clear(): void {
    this.recipes.clear();
    this.kindIndex.clear();
    this.variantIndex.clear();
    this.tagIndex.clear();
  }

  /**
   * Evaluate recipe conditions against an input.
   * Returns true if all conditions match.
   *
   * Note: This intentionally mirrors the condition evaluation in planner.ts
   * to keep registry queries independent of the planner implementation.
   */
  private evaluateConditions(
    conditions: Recipe['conditions'],
    input: Record<string, unknown>
  ): boolean {
    if (!conditions || conditions.length === 0) return true;

    return conditions.every(condition => {
      const fieldValue = this.getNestedValue(input, condition.field);
      return this.evaluateCondition(condition, fieldValue);
    });
  }

  /**
   * Get a nested value from an object using dot notation.
   */
  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((current, key) => {
      if (current && typeof current === 'object' && key in current) {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
  }

  /**
   * Evaluate a single condition.
   */
  private evaluateCondition(
    condition: RecipeCondition,
    fieldValue: unknown
  ): boolean {
    const { operator, value } = condition;

    switch (operator) {
      case 'eq':
        return fieldValue === value;

      case 'neq':
        return fieldValue !== value;

      case 'gt':
        return typeof fieldValue === 'number' && typeof value === 'number'
          ? fieldValue > value
          : false;

      case 'gte':
        return typeof fieldValue === 'number' && typeof value === 'number'
          ? fieldValue >= value
          : false;

      case 'lt':
        return typeof fieldValue === 'number' && typeof value === 'number'
          ? fieldValue < value
          : false;

      case 'lte':
        return typeof fieldValue === 'number' && typeof value === 'number'
          ? fieldValue <= value
          : false;

      case 'contains':
        if (typeof fieldValue === 'string' && typeof value === 'string') {
          return fieldValue.includes(value);
        }
        if (Array.isArray(fieldValue)) {
          return fieldValue.includes(value);
        }
        return false;

      case 'matches':
        if (typeof fieldValue === 'string' && typeof value === 'string') {
          try {
            return new RE2(value).test(fieldValue);
          } catch {
            return false;
          }
        }
        return false;

      case 'exists':
        return fieldValue !== undefined && fieldValue !== null && fieldValue !== '';

      case 'notExists':
        return fieldValue === undefined || fieldValue === null || fieldValue === '';

      default:
        return false;
    }
  }
}

// ============================================================================
// Default Instances
// ============================================================================

/**
 * Create a combined registry that holds both recipes and step handlers.
 */
export interface CombinedRegistry {
  recipes: MemoryRecipeRegistry;
  handlers: MemoryStepHandlerRegistry;
}

/**
 * Create a new combined registry instance.
 */
export function createRegistry(): CombinedRegistry {
  return {
    recipes: new MemoryRecipeRegistry(),
    handlers: new MemoryStepHandlerRegistry(),
  };
}
