/**
 * Rule-based planner implementation.
 * Selects recipes and generates plans based on conditions and input analysis.
 */

import { generateId } from '../utils/id';
import type {
  ConditionOperator,
  Plan,
  PlannedStep,
  Planner,
  PlanModification,
  PlanningContext,
  PlanValidationResult,
  Recipe,
  RecipeCondition,
  RecipeRegistry,
  RecipeSelectionResult,
  ResourceEstimate,
  StepHandlerRegistry,
  WorkflowKind,
} from './types';

// ============================================================================
// Condition Evaluation
// ============================================================================

/**
 * Get a nested value from an object using dot notation.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object' && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Evaluate a single condition against a value.
 */
function evaluateCondition(
  operator: ConditionOperator,
  fieldValue: unknown,
  conditionValue: unknown
): boolean {
  switch (operator) {
    case 'eq':
      return fieldValue === conditionValue;

    case 'neq':
      return fieldValue !== conditionValue;

    case 'gt':
      return typeof fieldValue === 'number' && typeof conditionValue === 'number'
        ? fieldValue > conditionValue
        : false;

    case 'gte':
      return typeof fieldValue === 'number' && typeof conditionValue === 'number'
        ? fieldValue >= conditionValue
        : false;

    case 'lt':
      return typeof fieldValue === 'number' && typeof conditionValue === 'number'
        ? fieldValue < conditionValue
        : false;

    case 'lte':
      return typeof fieldValue === 'number' && typeof conditionValue === 'number'
        ? fieldValue <= conditionValue
        : false;

    case 'contains':
      if (typeof fieldValue === 'string' && typeof conditionValue === 'string') {
        return fieldValue.includes(conditionValue);
      }
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(conditionValue);
      }
      return false;

    case 'matches':
      if (typeof fieldValue === 'string' && typeof conditionValue === 'string') {
        try {
          return new RegExp(conditionValue).test(fieldValue);
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

/**
 * Score a recipe's conditions against input.
 * Returns a score from 0-100 based on how well conditions match.
 */
function scoreConditions(
  conditions: RecipeCondition[] | undefined,
  input: Record<string, unknown>
): number {
  // No conditions = default match with low score
  if (!conditions || conditions.length === 0) {
    return 10;
  }

  let matched = 0;
  for (const condition of conditions) {
    const fieldValue = getNestedValue(input, condition.field);
    if (evaluateCondition(condition.operator, fieldValue, condition.value)) {
      matched++;
    }
  }

  // All conditions must match for any positive score
  if (matched < conditions.length) {
    return 0;
  }

  // Base score 50 ensures condition-matched recipes beat unconditional defaults (score 10).
  // Each additional condition adds 10 points, capped at 100 so forced recipes (100) still win.
  return Math.min(100, 50 + conditions.length * 10);
}

// ============================================================================
// Rule-Based Planner Implementation
// ============================================================================

/**
 * Configuration for the RuleBasedPlanner.
 */
export interface RuleBasedPlannerConfig {
  /** Recipe registry to use */
  recipeRegistry: RecipeRegistry;

  /** Step handler registry for validation */
  handlerRegistry?: StepHandlerRegistry;

  /** Whether to validate handler references during planning */
  validateHandlers?: boolean;

  /** Resource estimation defaults (used by estimateResources) */
  resourceEstimates?: {
    /** Estimated API calls per step (default: 1) */
    apiCallsPerStep?: number;
    /** Estimated tokens per step (default: 500) */
    tokensPerStep?: number;
    /** Estimated duration per step in ms (default: 2000) */
    durationPerStep?: number;
    /** Estimated API calls per child workflow (default: 5) */
    apiCallsPerChild?: number;
  };
}

/**
 * Rule-based planner that selects recipes based on condition matching.
 */
export class RuleBasedPlanner implements Planner {
  private recipeRegistry: RecipeRegistry;
  private handlerRegistry?: StepHandlerRegistry;
  private validateHandlers: boolean;
  private resourceEstimates: Required<NonNullable<RuleBasedPlannerConfig['resourceEstimates']>>;

  constructor(config: RuleBasedPlannerConfig) {
    this.recipeRegistry = config.recipeRegistry;
    this.handlerRegistry = config.handlerRegistry;
    this.validateHandlers = config.validateHandlers ?? false;
    this.resourceEstimates = {
      apiCallsPerStep: config.resourceEstimates?.apiCallsPerStep ?? 1,
      tokensPerStep: config.resourceEstimates?.tokensPerStep ?? 500,
      durationPerStep: config.resourceEstimates?.durationPerStep ?? 2000,
      apiCallsPerChild: config.resourceEstimates?.apiCallsPerChild ?? 5,
    };
  }

  /**
   * Select the best recipe for a workflow kind and input.
   */
  async selectRecipe(
    workflowKind: WorkflowKind,
    input: Record<string, unknown>,
    context?: PlanningContext
  ): Promise<RecipeSelectionResult> {
    // Check for forced recipe in hints
    if (context?.hints?.forceRecipeId) {
      const forced = this.recipeRegistry.get(context.hints.forceRecipeId);
      if (forced) {
        return {
          recipe: forced,
          score: 100,
          reason: `Forced recipe: ${context.hints.forceRecipeId}`,
        };
      }
    }

    // Check for preferred variant in hints
    if (context?.hints?.preferredVariant) {
      const preferred = this.recipeRegistry.getVariant(
        workflowKind,
        context.hints.preferredVariant
      );
      if (preferred) {
        return {
          recipe: preferred,
          score: 90,
          reason: `Preferred variant: ${context.hints.preferredVariant}`,
        };
      }
    }

    // Get all recipes for this workflow kind
    const recipes = this.recipeRegistry.getByKind(workflowKind);

    if (recipes.length === 0) {
      throw new Error(`No recipes found for workflow kind: ${workflowKind}`);
    }

    // Score each recipe
    const scored = recipes.map(recipe => ({
      recipe,
      conditionScore: scoreConditions(recipe.conditions, input),
      priorityScore: recipe.priority ?? 0,
    }));

    // Sort by condition score (desc), then priority (desc)
    scored.sort((a, b) => {
      if (b.conditionScore !== a.conditionScore) {
        return b.conditionScore - a.conditionScore;
      }
      return b.priorityScore - a.priorityScore;
    });

    // Find best matching recipe
    const best = scored.find(s => s.conditionScore > 0);

    if (best) {
      const reason = this.buildSelectionReason(best.recipe, input);
      return {
        recipe: best.recipe,
        score: best.conditionScore,
        reason,
      };
    }

    // Fall back to default recipe
    const defaultRecipe = this.recipeRegistry.getDefault(workflowKind);
    if (defaultRecipe) {
      return {
        recipe: defaultRecipe,
        score: 10,
        reason: `Fallback to default recipe: ${defaultRecipe.id}`,
      };
    }

    // Last resort: use first recipe
    return {
      recipe: recipes[0],
      score: 5,
      reason: `No matching recipe, using first available: ${recipes[0].id}`,
    };
  }

  /**
   * Generate a plan from a recipe and input.
   */
  async generatePlan(
    recipe: Recipe,
    input: Record<string, unknown>,
    context?: PlanningContext
  ): Promise<Plan> {
    const modifications: PlanModification[] = [];

    // Start with recipe steps
    let steps = recipe.steps.map(step => this.recipeStepToPlannedStep(step));

    // Apply hint-based modifications
    if (context?.hints) {
      const { skipSteps, includeSteps, additionalConfig } = context.hints;

      // Mark steps to skip
      if (skipSteps && skipSteps.length > 0) {
        for (const stepKey of skipSteps) {
          const stepIndex = steps.findIndex(s => s.key === stepKey);
          if (stepIndex >= 0) {
            steps = steps.filter(s => s.key !== stepKey);
            modifications.push({
              type: 'remove_step',
              stepKey,
              value: null,
              reason: `Skipped via planning hints`,
            });
          }
        }
      }

      // Apply additional config to all steps
      if (additionalConfig) {
        for (const step of steps) {
          step.config = { ...step.config, ...additionalConfig };
        }
        modifications.push({
          type: 'modify_step',
          value: additionalConfig,
          reason: 'Applied additional config from planning hints',
        });
      }
    }

    // Apply constraint-based modifications
    if (context?.constraints) {
      const constraintMods = this.applyConstraints(steps, context.constraints);
      modifications.push(...constraintMods.modifications);
      steps = constraintMods.steps;
    }

    // Build the plan
    const plan: Plan = {
      id: generateId(),
      recipeId: recipe.id,
      variant: recipe.variant,
      modifications,
      steps,
      defaults: recipe.defaults ?? {},
      reasoning: this.buildPlanReasoning(recipe, modifications, context),
      createdAt: new Date(),
    };

    // Estimate resources
    plan.resourceEstimate = this.estimateResources(plan);

    return plan;
  }

  /**
   * Combined operation: select recipe and generate plan.
   */
  async plan(
    workflowKind: WorkflowKind,
    input: Record<string, unknown>,
    context?: PlanningContext
  ): Promise<Plan> {
    const selection = await this.selectRecipe(workflowKind, input, context);
    const plan = await this.generatePlan(selection.recipe, input, context);

    // Add selection reasoning to plan
    plan.reasoning = `${selection.reason}. ${plan.reasoning ?? ''}`.trim();

    return plan;
  }

  /**
   * Validate a plan before execution.
   */
  validatePlan(plan: Plan): PlanValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check plan has steps
    if (!plan.steps || plan.steps.length === 0) {
      errors.push('Plan has no steps');
    }

    // Check for duplicate step keys
    const stepKeys = new Set<string>();
    for (const step of plan.steps) {
      if (stepKeys.has(step.key)) {
        errors.push(`Duplicate step key: ${step.key}`);
      }
      stepKeys.add(step.key);
    }

    // Validate each step
    for (const step of plan.steps) {
      if (!step.key) {
        errors.push('Step missing key');
      }
      if (!step.name) {
        warnings.push(`Step '${step.key}' missing name`);
      }
      if (!step.handlerRef) {
        errors.push(`Step '${step.key}' missing handlerRef`);
      }

      // Validate handler exists (if registry available)
      if (this.validateHandlers && this.handlerRegistry) {
        if (!this.handlerRegistry.has(step.handlerRef)) {
          errors.push(`Step '${step.key}' references unknown handler: ${step.handlerRef}`);
        }
      }
    }

    // Check child workflows
    if (plan.childWorkflows) {
      for (const child of plan.childWorkflows) {
        if (!child.kind) {
          errors.push('Child workflow missing kind');
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Estimate resources required for a plan.
   */
  estimateResources(plan: Plan): ResourceEstimate {
    const { apiCallsPerStep, tokensPerStep, durationPerStep, apiCallsPerChild } = this.resourceEstimates;

    const stepCount = plan.steps.length;
    const childCount = plan.childWorkflows?.length ?? 0;

    return {
      apiCalls: stepCount * apiCallsPerStep + childCount * apiCallsPerChild,
      tokens: stepCount * tokensPerStep,
      duration: stepCount * durationPerStep,
    };
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Convert a recipe step to a planned step.
   */
  private recipeStepToPlannedStep(step: Recipe['steps'][0]): PlannedStep {
    return {
      key: step.key,
      name: step.name,
      handlerRef: step.handlerRef,
      config: step.config ?? {},
      onError: step.onError,
      maxRetries: step.maxRetries,
      retryDelay: step.retryDelay,
      retryBackoff: step.retryBackoff,
      timeout: step.timeout,
      skipCondition: step.skipCondition,
    };
  }

  /**
   * Apply constraints to steps and generate modifications.
   */
  private applyConstraints(
    steps: PlannedStep[],
    constraints: NonNullable<PlanningContext['constraints']>
  ): { steps: PlannedStep[]; modifications: PlanModification[] } {
    const modifications: PlanModification[] = [];
    const perStepTimeout = constraints.maxDuration
      ? Math.floor(constraints.maxDuration / steps.length)
      : undefined;

    // Apply all constraint mutations in a single pass
    const modifiedSteps = steps.map(step => {
      const modified = { ...step };

      if (constraints.priority === 'speed') {
        modified.timeout = modified.timeout ? Math.min(modified.timeout, 30000) : 30000;
        modified.maxRetries = Math.min(modified.maxRetries ?? 3, 1);
      }

      if (constraints.priority === 'cost') {
        modified.maxRetries = 0;
      }

      if (perStepTimeout !== undefined) {
        modified.timeout = modified.timeout
          ? Math.min(modified.timeout, perStepTimeout)
          : perStepTimeout;
      }

      return modified;
    });

    // Record what was applied
    if (constraints.priority === 'speed') {
      modifications.push({
        type: 'set_default',
        value: { priority: 'speed' },
        reason: 'Optimized for speed: reduced timeouts and retries',
      });
    }
    if (constraints.priority === 'cost') {
      modifications.push({
        type: 'set_default',
        value: { priority: 'cost' },
        reason: 'Optimized for cost: disabled retries',
      });
    }
    if (constraints.maxDuration) {
      modifications.push({
        type: 'set_default',
        value: { maxDuration: constraints.maxDuration },
        reason: `Applied duration constraint: ${constraints.maxDuration}ms total`,
      });
    }

    return { steps: modifiedSteps, modifications };
  }

  /**
   * Build a human-readable selection reason.
   */
  private buildSelectionReason(
    recipe: Recipe,
    input: Record<string, unknown>
  ): string {
    const parts: string[] = [`Selected recipe: ${recipe.id}`];

    if (recipe.conditions && recipe.conditions.length > 0) {
      const conditionDescriptions = recipe.conditions.map(c => {
        const value = getNestedValue(input, c.field);
        return `${c.field} ${c.operator} ${JSON.stringify(c.value)} (actual: ${JSON.stringify(value)})`;
      });
      parts.push(`Matched conditions: ${conditionDescriptions.join(', ')}`);
    }

    if (recipe.priority !== undefined && recipe.priority > 0) {
      parts.push(`Priority: ${recipe.priority}`);
    }

    return parts.join('. ');
  }

  /**
   * Build reasoning text for a plan.
   */
  private buildPlanReasoning(
    recipe: Recipe,
    modifications: PlanModification[],
    context?: PlanningContext
  ): string {
    const parts: string[] = [];

    parts.push(`Using recipe '${recipe.name}' (${recipe.variant} variant)`);

    if (modifications.length > 0) {
      parts.push(`Applied ${modifications.length} modification(s)`);
    }

    if (context?.constraints) {
      const constraintList: string[] = [];
      if (context.constraints.priority) {
        constraintList.push(`priority=${context.constraints.priority}`);
      }
      if (context.constraints.maxDuration) {
        constraintList.push(`maxDuration=${context.constraints.maxDuration}ms`);
      }
      if (context.constraints.maxApiCalls) {
        constraintList.push(`maxApiCalls=${context.constraints.maxApiCalls}`);
      }
      if (constraintList.length > 0) {
        parts.push(`Constraints: ${constraintList.join(', ')}`);
      }
    }

    return parts.join('. ') + '.';
  }
}
