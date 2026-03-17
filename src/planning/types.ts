/**
 * Planning types for the workflow engine.
 * Enables dynamic workflow orchestration through recipes and plans.
 */

import type { WorkflowKind, StepErrorStrategy, WorkflowStep } from '../core/types';

// Re-export core types used in planning
export type { WorkflowKind, StepErrorStrategy } from '../core/types';

// ============================================================================
// Recipe Types
// ============================================================================

/**
 * Comparison operators for recipe conditions.
 */
export type ConditionOperator =
  | 'eq'       // equals
  | 'neq'      // not equals
  | 'gt'       // greater than
  | 'gte'      // greater than or equal
  | 'lt'       // less than
  | 'lte'      // less than or equal
  | 'contains' // string/array contains
  | 'matches'  // regex match
  | 'exists'   // field exists and is truthy
  | 'notExists'; // field does not exist or is falsy

/**
 * A condition that determines when a recipe should be selected.
 * Conditions are evaluated against the workflow input.
 */
export interface RecipeCondition {
  /** Input field to check (supports dot notation for nested fields) */
  field: string;

  /** Comparison operator */
  operator: ConditionOperator;

  /** Value to compare against (not required for exists/notExists) */
  value?: unknown;
}

/**
 * Default parameters for a recipe.
 */
export interface RecipeDefaults {
  /** Workflow-level timeout in ms */
  timeout?: number;

  /** Default max retries for steps */
  maxRetries?: number;

  /** Base retry delay in ms */
  retryDelay?: number;

  /** Retry backoff multiplier */
  retryBackoff?: number;

  /** Default error strategy for steps */
  onError?: StepErrorStrategy;
}

/**
 * Reference to a step handler function.
 * The actual handler is resolved at plan execution time.
 */
export interface StepHandlerRef {
  /** Unique handler identifier (e.g., 'handlers.loadDocument') */
  id: string;

  /** Human-readable description */
  description?: string;
}

/**
 * A step definition within a recipe.
 * Similar to WorkflowStep but uses handler references instead of functions.
 */
export interface RecipeStep {
  /** Unique step identifier within the recipe */
  key: string;

  /** Human-readable step name */
  name: string;

  /** Reference to the step handler function */
  handlerRef: string;

  /** Step-specific configuration passed to the handler */
  config?: Record<string, unknown>;

  /** Error handling strategy */
  onError?: StepErrorStrategy;

  /** Maximum retry attempts */
  maxRetries?: number;

  /** Retry delay in ms */
  retryDelay?: number;

  /** Retry backoff multiplier */
  retryBackoff?: number;

  /** Step timeout in ms */
  timeout?: number;

  /**
   * Expression to evaluate for skipping (simple field reference).
   * If the referenced field is truthy, the step is skipped.
   * Example: 'input.skipValidation' or 'results.load.alreadyExists'
   */
  skipCondition?: string;
}

/**
 * A recipe is a reusable workflow configuration template.
 * Recipes define the steps to execute and conditions for selection.
 */
export interface Recipe {
  /** Unique recipe identifier (e.g., 'summarize.comprehensive') */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description of what this recipe does */
  description?: string;

  /** Target workflow type */
  workflowKind: WorkflowKind;

  /** Variant name (e.g., 'default', 'fast', 'thorough') */
  variant: string;

  /** Ordered list of steps to execute */
  steps: RecipeStep[];

  /** Default parameters for this recipe */
  defaults?: RecipeDefaults;

  /** Conditions for auto-selecting this recipe */
  conditions?: RecipeCondition[];

  /**
   * Selection priority. Semantics differ by context:
   * - {@link MemoryRecipeRegistry.getDefault}: lower number = higher precedence
   *   (used as fallback when no 'default' variant exists).
   * - {@link RuleBasedPlanner.selectRecipe}: condition-based scoring (0-100) is
   *   the primary selection axis; this value is only a tiebreaker where higher
   *   numeric value wins.
   */
  priority?: number;

  /** Tags for categorization and filtering */
  tags?: string[];
}

// ============================================================================
// Plan Types
// ============================================================================

/**
 * Types of modifications that can be made to a plan.
 */
export type PlanModificationType =
  | 'add_step'      // Add a new step
  | 'remove_step'   // Remove an existing step
  | 'modify_step'   // Modify step configuration
  | 'reorder_steps' // Change step order
  | 'set_default';  // Override a default parameter

/**
 * A modification to apply to a recipe when generating a plan.
 */
export interface PlanModification {
  /** Type of modification */
  type: PlanModificationType;

  /** Target step key (for step modifications) */
  stepKey?: string;

  /** New value or configuration */
  value: unknown;

  /** Human-readable reason for this modification */
  reason: string;
}

/**
 * A resolved step in a plan, ready for execution.
 */
export interface PlannedStep {
  /** Unique step identifier */
  key: string;

  /** Human-readable step name */
  name: string;

  /** Reference to the step handler */
  handlerRef: string;

  /** Resolved configuration for this step */
  config: Record<string, unknown>;

  /** Error handling strategy */
  onError?: StepErrorStrategy;

  /** Maximum retry attempts */
  maxRetries?: number;

  /** Retry delay in ms */
  retryDelay?: number;

  /** Retry backoff multiplier */
  retryBackoff?: number;

  /** Step timeout in ms */
  timeout?: number;

  /** Skip condition expression */
  skipCondition?: string;
}

/**
 * A planned child workflow to spawn during execution.
 */
export interface ChildWorkflowPlan {
  /** Workflow type to spawn */
  kind: WorkflowKind;

  /** Input for the child workflow */
  input: Record<string, unknown>;

  /** Whether to wait for the child to complete */
  waitFor?: boolean;

  /** Step key after which to spawn this workflow */
  afterStep?: string;

  /** Optional metadata for the child workflow */
  metadata?: Record<string, unknown>;
}

/**
 * Resource requirements estimated for a plan.
 */
export interface ResourceEstimate {
  /** Estimated API calls */
  apiCalls?: number;

  /** Estimated LLM tokens */
  tokens?: number;

  /** Estimated duration in ms */
  duration?: number;

  /** Estimated memory usage in bytes */
  memory?: number;
}

/**
 * A plan is the output of planning - a concrete execution strategy.
 */
export interface Plan {
  /** Unique plan identifier */
  id: string;

  /** Recipe this plan is based on */
  recipeId: string;

  /** Recipe variant used */
  variant: string;

  /** Modifications applied to the base recipe */
  modifications: PlanModification[];

  /** Final step sequence after modifications */
  steps: PlannedStep[];

  /** Child workflows to spawn */
  childWorkflows?: ChildWorkflowPlan[];

  /** Resolved default parameters */
  defaults: RecipeDefaults;

  /** Human-readable reasoning for plan decisions */
  reasoning?: string;

  /** Estimated resource requirements */
  resourceEstimate?: ResourceEstimate;

  /** When this plan was generated */
  createdAt: Date;
}

// ============================================================================
// Planning Context Types
// ============================================================================

/**
 * Priority modes for planning.
 */
export type PlanningPriority = 'speed' | 'quality' | 'cost' | 'balanced';

/**
 * Constraints that limit planning and execution.
 */
export interface PlanningConstraints {
  /** Maximum allowed duration in ms */
  maxDuration?: number;

  /** Maximum API calls allowed */
  maxApiCalls?: number;

  /** Maximum LLM tokens allowed */
  maxTokens?: number;

  /** Optimization priority */
  priority?: PlanningPriority;
}

/**
 * User-provided hints to guide planning.
 */
export interface PlanningHints {
  /** Preferred recipe variant */
  preferredVariant?: string;

  /** Specific recipe to use (bypasses selection) */
  forceRecipeId?: string;

  /** Steps to skip */
  skipSteps?: string[];

  /** Steps to include (even if normally skipped) */
  includeSteps?: string[];

  /** Focus areas (domain-specific) */
  focusAreas?: string[];

  /** Additional configuration to merge */
  additionalConfig?: Record<string, unknown>;
}

/**
 * Context provided to the planner for decision-making.
 */
export interface PlanningContext {
  /** Parent workflow run ID (if spawned as child) */
  parentRunId?: string;

  /** Domain-specific metadata */
  metadata?: Record<string, unknown>;

  /** Resource constraints */
  constraints?: PlanningConstraints;

  /** User-provided hints */
  hints?: PlanningHints;
}

// ============================================================================
// Planner Interface
// ============================================================================

/**
 * Result of recipe selection.
 */
export interface RecipeSelectionResult {
  /** Selected recipe */
  recipe: Recipe;

  /** Score indicating confidence (0-100) */
  score: number;

  /** Why this recipe was selected */
  reason: string;
}

/**
 * Validation result for a plan.
 */
export interface PlanValidationResult {
  /** Whether the plan is valid */
  valid: boolean;

  /** Validation errors (if any) */
  errors: string[];

  /** Validation warnings */
  warnings: string[];
}

/**
 * Planner interface for generating execution plans.
 */
export interface Planner {
  /**
   * Select the best recipe for a workflow and input.
   */
  selectRecipe(
    workflowKind: WorkflowKind,
    input: Record<string, unknown>,
    context?: PlanningContext
  ): Promise<RecipeSelectionResult>;

  /**
   * Generate a plan from a recipe and input.
   */
  generatePlan(
    recipe: Recipe,
    input: Record<string, unknown>,
    context?: PlanningContext
  ): Promise<Plan>;

  /**
   * Combined operation: select recipe and generate plan.
   */
  plan(
    workflowKind: WorkflowKind,
    input: Record<string, unknown>,
    context?: PlanningContext
  ): Promise<Plan>;

  /**
   * Validate a plan before execution.
   */
  validatePlan(plan: Plan): PlanValidationResult;

  /**
   * Estimate resources required for a plan.
   */
  estimateResources(plan: Plan): ResourceEstimate;
}

// ============================================================================
// Step Handler Registry Types
// ============================================================================

/**
 * A registered step handler function.
 */
export interface RegisteredStepHandler<TInput = Record<string, unknown>> {
  /** Unique handler identifier */
  id: string;

  /** Human-readable description */
  description?: string;

  /** The handler function */
  handler: WorkflowStep<TInput>['handler'];

  /** Tags for categorization */
  tags?: string[];
}

/**
 * Registry for step handlers.
 * Allows recipes to reference handlers by ID.
 */
export interface StepHandlerRegistry {
  /**
   * Register a step handler.
   */
  register<TInput = Record<string, unknown>>(
    handler: RegisteredStepHandler<TInput>
  ): void;

  /**
   * Get a handler by ID.
   */
  get(id: string): RegisteredStepHandler | undefined;

  /**
   * Check if a handler exists.
   */
  has(id: string): boolean;

  /**
   * List all registered handlers.
   */
  list(): RegisteredStepHandler[];

  /**
   * List handlers by tag.
   */
  listByTag(tag: string): RegisteredStepHandler[];
}

// ============================================================================
// Recipe Registry Types
// ============================================================================

/**
 * Options for querying recipes.
 */
export interface RecipeQueryOptions {
  /** Filter by workflow kind */
  workflowKind?: WorkflowKind;

  /** Filter by variant */
  variant?: string;

  /** Filter by tags (any match) */
  tags?: string[];

  /** Only include recipes matching conditions */
  matchConditions?: Record<string, unknown>;
}

/**
 * Registry for recipes.
 */
export interface RecipeRegistry {
  /**
   * Register a recipe.
   */
  register(recipe: Recipe): void;

  /**
   * Register multiple recipes.
   */
  registerAll(recipes: Recipe[]): void;

  /**
   * Get a recipe by ID.
   */
  get(recipeId: string): Recipe | undefined;

  /**
   * Check if a recipe exists.
   */
  has(recipeId: string): boolean;

  /**
   * Get all recipes for a workflow kind.
   */
  getByKind(workflowKind: WorkflowKind): Recipe[];

  /**
   * Get a specific variant for a workflow kind.
   */
  getVariant(workflowKind: WorkflowKind, variant: string): Recipe | undefined;

  /**
   * Get the default recipe for a workflow kind.
   */
  getDefault(workflowKind: WorkflowKind): Recipe | undefined;

  /**
   * List all available variants for a workflow kind.
   */
  listVariants(workflowKind: WorkflowKind): string[];

  /**
   * Query recipes with filters.
   */
  query(options: RecipeQueryOptions): Recipe[];

  /**
   * List all registered recipes.
   */
  list(): Recipe[];
}
