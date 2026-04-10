import { describe, it, expect, beforeEach } from "vitest";
import {
  MemoryStepHandlerRegistry,
  MemoryRecipeRegistry,
  createRegistry,
} from "./registry";
import type { Recipe, RegisteredStepHandler } from "./types";

describe("MemoryStepHandlerRegistry", () => {
  let registry: MemoryStepHandlerRegistry;

  beforeEach(() => {
    registry = new MemoryStepHandlerRegistry();
  });

  it("should register and retrieve a handler", () => {
    const handler: RegisteredStepHandler = {
      id: "handler.a",
      description: "Handler A",
      handler: async () => "result",
    };

    registry.register(handler);

    expect(registry.get("handler.a")).toBeDefined();
    expect(registry.get("handler.a")?.id).toBe("handler.a");
    expect(registry.has("handler.a")).toBe(true);
  });

  it("should throw on duplicate registration", () => {
    registry.register({ id: "h1", handler: async () => {} });

    expect(() =>
      registry.register({ id: "h1", handler: async () => {} }),
    ).toThrow("Step handler 'h1' is already registered");
  });

  it("should return undefined for non-existent handler", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("should list all handlers", () => {
    registry.register({ id: "h1", handler: async () => {} });
    registry.register({ id: "h2", handler: async () => {} });

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((h) => h.id).sort()).toEqual(["h1", "h2"]);
  });

  it("should list handlers by tag", () => {
    registry.register({
      id: "h1",
      handler: async () => {},
      tags: ["ai", "text"],
    });
    registry.register({ id: "h2", handler: async () => {}, tags: ["ai"] });
    registry.register({ id: "h3", handler: async () => {}, tags: ["io"] });

    const aiHandlers = registry.listByTag("ai");
    expect(aiHandlers).toHaveLength(2);
    expect(aiHandlers.map((h) => h.id).sort()).toEqual(["h1", "h2"]);

    expect(registry.listByTag("nonexistent")).toEqual([]);
  });

  it("should resolve handler reference to handler function", () => {
    const fn = async () => "resolved";
    registry.register({ id: "h1", handler: fn });

    expect(registry.resolve("h1")).toBe(fn);
    expect(registry.resolve("nonexistent")).toBeUndefined();
  });

  it("should clear all handlers and tag indexes", () => {
    registry.register({ id: "h1", handler: async () => {}, tags: ["t1"] });
    registry.clear();

    expect(registry.list()).toHaveLength(0);
    expect(registry.listByTag("t1")).toEqual([]);
  });
});

describe("MemoryRecipeRegistry", () => {
  let registry: MemoryRecipeRegistry;

  const makeRecipe = (overrides: Partial<Recipe> = {}): Recipe => ({
    id: "recipe-1",
    name: "Recipe 1",
    workflowKind: "test.workflow",
    variant: "default",
    steps: [{ key: "s1", name: "S1", handlerRef: "h1" }],
    ...overrides,
  });

  beforeEach(() => {
    registry = new MemoryRecipeRegistry();
  });

  describe("register / get / has", () => {
    it("should register and retrieve a recipe", () => {
      const recipe = makeRecipe();
      registry.register(recipe);

      expect(registry.get("recipe-1")).toEqual(recipe);
      expect(registry.has("recipe-1")).toBe(true);
    });

    it("should throw on duplicate recipe id", () => {
      registry.register(makeRecipe());

      expect(() => registry.register(makeRecipe())).toThrow(
        "Recipe 'recipe-1' is already registered",
      );
    });

    it("should throw on duplicate kind:variant", () => {
      registry.register(makeRecipe({ id: "r1" }));

      expect(() => registry.register(makeRecipe({ id: "r2" }))).toThrow(
        "Recipe variant 'default' for 'test.workflow' is already registered",
      );
    });

    it("should return undefined for non-existent recipe", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
      expect(registry.has("nonexistent")).toBe(false);
    });
  });

  describe("registerAll", () => {
    it("should register multiple recipes", () => {
      registry.registerAll([
        makeRecipe({ id: "r1", variant: "fast" }),
        makeRecipe({ id: "r2", variant: "slow" }),
      ]);

      expect(registry.list()).toHaveLength(2);
    });
  });

  describe("getByKind", () => {
    it("should return recipes matching a workflow kind", () => {
      registry.register(makeRecipe({ id: "r1", variant: "v1" }));
      registry.register(makeRecipe({ id: "r2", variant: "v2" }));
      registry.register(
        makeRecipe({ id: "r3", workflowKind: "other", variant: "default" }),
      );

      const results = registry.getByKind("test.workflow");
      expect(results).toHaveLength(2);
    });

    it("should return empty array for unknown kind", () => {
      expect(registry.getByKind("unknown")).toEqual([]);
    });
  });

  describe("getVariant", () => {
    it("should return recipe by kind and variant", () => {
      registry.register(makeRecipe({ id: "r1", variant: "fast" }));
      registry.register(
        makeRecipe({ id: "r2", workflowKind: "other", variant: "default" }),
      );

      expect(registry.getVariant("test.workflow", "fast")?.id).toBe("r1");
      expect(
        registry.getVariant("test.workflow", "nonexistent"),
      ).toBeUndefined();
    });
  });

  describe("getDefault", () => {
    it('should return the "default" variant', () => {
      registry.register(makeRecipe({ id: "r1", variant: "default" }));
      registry.register(makeRecipe({ id: "r2", variant: "fast" }));

      expect(registry.getDefault("test.workflow")?.id).toBe("r1");
    });

    it("should fall back to lowest priority recipe", () => {
      registry.register(
        makeRecipe({ id: "r1", variant: "fast", priority: 10 }),
      );
      registry.register(makeRecipe({ id: "r2", variant: "slow", priority: 1 }));

      expect(registry.getDefault("test.workflow")?.id).toBe("r2");
    });

    it("should return undefined for unknown kind", () => {
      expect(registry.getDefault("unknown")).toBeUndefined();
    });

    it("should handle recipes without explicit priority", () => {
      registry.register(makeRecipe({ id: "r1", variant: "v1" }));

      expect(registry.getDefault("test.workflow")?.id).toBe("r1");
    });
  });

  describe("listVariants", () => {
    it("should list all variants for a kind", () => {
      registry.register(makeRecipe({ id: "r1", variant: "fast" }));
      registry.register(makeRecipe({ id: "r2", variant: "slow" }));

      expect(registry.listVariants("test.workflow").sort()).toEqual([
        "fast",
        "slow",
      ]);
    });
  });

  describe("query", () => {
    beforeEach(() => {
      registry.register(
        makeRecipe({ id: "r1", variant: "fast", tags: ["ai"] }),
      );
      registry.register(
        makeRecipe({
          id: "r2",
          variant: "slow",
          tags: ["legacy"],
          workflowKind: "other",
        }),
      );
      registry.register(
        makeRecipe({
          id: "r3",
          variant: "conditional",
          workflowKind: "other",
          conditions: [{ field: "size", operator: "gt", value: 100 }],
        }),
      );
    });

    it("should filter by workflowKind", () => {
      const results = registry.query({ workflowKind: "other" });
      expect(results).toHaveLength(2);
    });

    it("should filter by variant", () => {
      const results = registry.query({ variant: "fast" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("r1");
    });

    it("should filter by tags", () => {
      const results = registry.query({ tags: ["ai"] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("r1");
    });

    it("should filter by matchConditions", () => {
      const results = registry.query({ matchConditions: { size: 200 } });
      // r1 has no conditions (passes), r2 has no conditions (passes), r3 has size > 100 (passes)
      expect(results).toHaveLength(3);
    });

    it("should exclude recipes where conditions fail", () => {
      const results = registry.query({ matchConditions: { size: 50 } });
      // r3 has size > 100 which fails for 50
      expect(results).toHaveLength(2);
      expect(results.find((r) => r.id === "r3")).toBeUndefined();
    });
  });

  describe("condition evaluation", () => {
    const registerConditional = (
      field: string,
      operator: string,
      value?: unknown,
    ) => {
      const id = `cond-${Math.random()}`;
      registry.register(
        makeRecipe({
          id,
          variant: id,
          conditions: [{ field, operator: operator as any, value }],
        }),
      );
      return id;
    };

    it("should evaluate eq/neq", () => {
      const eqId = registerConditional("x", "eq", 5);
      const neqId = registerConditional("x", "neq", 5);

      let results = registry.query({ matchConditions: { x: 5 } });
      expect(results.find((r) => r.id === eqId)).toBeDefined();

      results = registry.query({ matchConditions: { x: 3 } });
      expect(results.find((r) => r.id === eqId)).toBeUndefined();
      expect(results.find((r) => r.id === neqId)).toBeDefined();
    });

    it("should evaluate gt/gte/lt/lte", () => {
      const gtId = registerConditional("n", "gt", 10);
      const gteId = registerConditional("n", "gte", 10);
      const ltId = registerConditional("n", "lt", 10);
      const lteId = registerConditional("n", "lte", 10);

      let results = registry.query({ matchConditions: { n: 15 } });
      expect(results.find((r) => r.id === gtId)).toBeDefined();
      expect(results.find((r) => r.id === gteId)).toBeDefined();
      expect(results.find((r) => r.id === ltId)).toBeUndefined();

      results = registry.query({ matchConditions: { n: 10 } });
      expect(results.find((r) => r.id === gtId)).toBeUndefined();
      expect(results.find((r) => r.id === gteId)).toBeDefined();
      expect(results.find((r) => r.id === lteId)).toBeDefined();

      results = registry.query({ matchConditions: { n: 5 } });
      expect(results.find((r) => r.id === ltId)).toBeDefined();
      expect(results.find((r) => r.id === lteId)).toBeDefined();
    });

    it("should return false for gt/lt with non-number values", () => {
      const gtId = registerConditional("x", "gt", 10);

      const results = registry.query({
        matchConditions: { x: "not a number" },
      });
      expect(results.find((r) => r.id === gtId)).toBeUndefined();
    });

    it("should evaluate contains for strings", () => {
      const id = registerConditional("text", "contains", "hello");

      let results = registry.query({
        matchConditions: { text: "say hello world" },
      });
      expect(results.find((r) => r.id === id)).toBeDefined();

      results = registry.query({ matchConditions: { text: "no match" } });
      expect(results.find((r) => r.id === id)).toBeUndefined();
    });

    it("should evaluate contains for arrays", () => {
      const id = registerConditional("tags", "contains", "important");

      const results = registry.query({
        matchConditions: { tags: ["important", "other"] },
      });
      expect(results.find((r) => r.id === id)).toBeDefined();
    });

    it("should return false for contains with non-string/non-array", () => {
      const id = registerConditional("x", "contains", "test");

      const results = registry.query({ matchConditions: { x: 42 } });
      expect(results.find((r) => r.id === id)).toBeUndefined();
    });

    it("should evaluate matches (regex)", () => {
      const id = registerConditional("name", "matches", "^test-\\d+$");

      let results = registry.query({ matchConditions: { name: "test-123" } });
      expect(results.find((r) => r.id === id)).toBeDefined();

      results = registry.query({ matchConditions: { name: "not-matching" } });
      expect(results.find((r) => r.id === id)).toBeUndefined();
    });

    it("should return false for matches with invalid regex", () => {
      const id = registerConditional("x", "matches", "[invalid");

      const results = registry.query({ matchConditions: { x: "anything" } });
      expect(results.find((r) => r.id === id)).toBeUndefined();
    });

    it("should return false for matches with non-string field", () => {
      const id = registerConditional("x", "matches", ".*");

      const results = registry.query({ matchConditions: { x: 42 } });
      expect(results.find((r) => r.id === id)).toBeUndefined();
    });

    it("should evaluate exists/notExists", () => {
      const existsId = registerConditional("field", "exists");
      const notExistsId = registerConditional("field", "notExists");

      let results = registry.query({ matchConditions: { field: "present" } });
      expect(results.find((r) => r.id === existsId)).toBeDefined();
      expect(results.find((r) => r.id === notExistsId)).toBeUndefined();

      results = registry.query({ matchConditions: { field: "" } });
      expect(results.find((r) => r.id === existsId)).toBeUndefined();
      expect(results.find((r) => r.id === notExistsId)).toBeDefined();

      results = registry.query({ matchConditions: { field: null } });
      expect(results.find((r) => r.id === existsId)).toBeUndefined();
      expect(results.find((r) => r.id === notExistsId)).toBeDefined();

      results = registry.query({ matchConditions: {} });
      expect(results.find((r) => r.id === existsId)).toBeUndefined();
      expect(results.find((r) => r.id === notExistsId)).toBeDefined();
    });

    it("should handle nested field paths", () => {
      const id = registerConditional("a.b.c", "eq", 42);

      let results = registry.query({
        matchConditions: { a: { b: { c: 42 } } },
      });
      expect(results.find((r) => r.id === id)).toBeDefined();

      results = registry.query({ matchConditions: { a: { b: { c: 99 } } } });
      expect(results.find((r) => r.id === id)).toBeUndefined();
    });

    it("should return undefined for missing nested path segments", () => {
      const id = registerConditional("a.b.c", "exists");

      const results = registry.query({ matchConditions: { a: "not-object" } });
      expect(results.find((r) => r.id === id)).toBeUndefined();
    });

    it("should return false for unknown operator", () => {
      const id = registerConditional("x", "unknownOp" as any, 1);

      const results = registry.query({ matchConditions: { x: 1 } });
      expect(results.find((r) => r.id === id)).toBeUndefined();
    });
  });

  describe("clear", () => {
    it("should clear all registries", () => {
      registry.register(makeRecipe({ id: "r1", variant: "v1", tags: ["t1"] }));
      registry.clear();

      expect(registry.list()).toHaveLength(0);
      expect(registry.getByKind("test.workflow")).toEqual([]);
      expect(registry.listVariants("test.workflow")).toEqual([]);
    });
  });
});

describe("createRegistry", () => {
  it("should return a combined registry", () => {
    const reg = createRegistry();
    expect(reg.recipes).toBeInstanceOf(MemoryRecipeRegistry);
    expect(reg.handlers).toBeInstanceOf(MemoryStepHandlerRegistry);
  });
});
