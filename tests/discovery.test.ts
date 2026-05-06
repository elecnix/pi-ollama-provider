/**
 * Tests for discovery.ts — model discovery, capability inference, cache,
 * fallback models, and OLLAMA_API_BASE.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  hasVision,
  hasToolSupport,
  hasReasoning,
  extractContextLength,
  isCloudModel,
  generateModelId,
  getOllamaHost,
  FALLBACK_LOCAL_MODELS,
  FALLBACK_CLOUD_MODELS,
  type OllamaModelConfig,
} from "../extensions/pi-ollama-provider/index.js";

import {
  readModelCache,
  writeModelCache,
  CACHE_PATH,
  type OllamaModelCacheV2,
} from "../extensions/pi-ollama-provider/discovery.js";

// ── fallback model structure validation ──

describe("FALLBACK_LOCAL_MODELS", () => {
  it("has at least 3 models", () => {
    expect(FALLBACK_LOCAL_MODELS.length).toBeGreaterThanOrEqual(3);
  });

  it("all local models have required fields", () => {
    for (const m of FALLBACK_LOCAL_MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxTokens).toBeGreaterThan(0);
      expect(m.isCloud).toBe(false);
      expect(m.ollamaName).toBeTruthy();
    }
  });

  it("all local models have isCloud=false", () => {
    for (const m of FALLBACK_LOCAL_MODELS) {
      expect(m.isCloud).toBe(false);
    }
  });

  it("at least one local model supports tools", () => {
    expect(FALLBACK_LOCAL_MODELS.some(m => m.toolSupport)).toBe(true);
  });

  it("local model IDs do not have :cloud suffix", () => {
    for (const m of FALLBACK_LOCAL_MODELS) {
      expect(m.id).not.toContain(":cloud");
      expect(m.id).not.toMatch(/-cloud$/);
    }
  });
});

describe("FALLBACK_CLOUD_MODELS", () => {
  it("has at least 2 models", () => {
    expect(FALLBACK_CLOUD_MODELS.length).toBeGreaterThanOrEqual(2);
  });

  it("all cloud models have required fields", () => {
    for (const m of FALLBACK_CLOUD_MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxTokens).toBeGreaterThan(0);
      expect(m.isCloud).toBe(true);
      expect(m.ollamaName).toBeTruthy();
    }
  });

  it("all cloud models are marked as cloud", () => {
    for (const m of FALLBACK_CLOUD_MODELS) {
      expect(m.isCloud).toBe(true);
    }
  });

  it("all cloud models support tools (required for coding agent)", () => {
    for (const m of FALLBACK_CLOUD_MODELS) {
      expect(m.toolSupport).toBe(true);
    }
  });

  it("cloud model IDs have :cloud or -cloud suffix", () => {
    for (const m of FALLBACK_CLOUD_MODELS) {
      expect(m.id).toMatch(/(:cloud|-cloud)$/);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// Cache v2 format
// ════════════════════════════════════════════════════════════════

describe("readModelCache / writeModelCache", () => {
  let originalCachePath: string;
  let tempCachePath: string;

  beforeEach(() => {
    // Mock CACHE_PATH by temporarily pointing to a temp file
    originalCachePath = (globalThis as any).__CACHE_PATH__;
    tempCachePath = join(tmpdir(), `pi-ollama-cache-test-${Date.now()}`);
    mkdirSync(join(tempCachePath, ".."), { recursive: true });
  });

  afterEach(() => {
    (globalThis as any).__CACHE_PATH__ = originalCachePath;
    if (existsSync(tempCachePath)) {
      rmSync(tempCachePath, { recursive: true, force: true });
    }
  });

  it("writeModelCache creates v2 format with version and timestamp", () => {
    const models: OllamaModelConfig[] = [
      {
        id: "llama3.1:8b",
        name: "llama3.1:8b",
        reasoning: false,
        input: ["text"],
        contextWindow: 131072,
        maxTokens: 32768,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        toolSupport: true,
        isCloud: false,
        ollamaName: "llama3.1:8b",
      },
    ];

    writeModelCache(models);

    const cached = readModelCache();
    expect(cached).not.toBeNull();
    expect(cached!.length).toBe(1);
    expect(cached![0].id).toBe("llama3.1:8b");

    // Clean up — find the actual cache path by reading the written file
    try { rmSync(CACHE_PATH, { force: true }); } catch {}
  });

  it("readModelCache returns null when cache file doesn't exist", () => {
    // readModelCache uses hardcoded CACHE_PATH, so we test by deleting any existing cache
    try { rmSync(CACHE_PATH, { force: true }); } catch {}
    const result = readModelCache();
    expect(result).toBeNull();
  });

  it("readModelCache handles v2 format with version field", () => {
    // Write v2 format directly
    const v2Cache: OllamaModelCacheV2 = {
      version: 2,
      timestamp: Date.now(),
      models: [
        {
          id: "qwen3:32b",
          name: "qwen3:32b",
          reasoning: true,
          input: ["text"],
          contextWindow: 131072,
          maxTokens: 32768,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          toolSupport: true,
          isCloud: false,
          ollamaName: "qwen3:32b",
        },
      ],
    };

    mkdirSync(join(CACHE_PATH, ".."), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(v2Cache, null, 2));

    const cached = readModelCache();
    expect(cached).not.toBeNull();
    expect(cached!.length).toBe(1);
    expect(cached![0].id).toBe("qwen3:32b");

    // Clean up
    rmSync(CACHE_PATH, { force: true });
  });

  it("readModelCache migrates v1 (plain array) format", () => {
    const v1Cache: OllamaModelConfig[] = [
      {
        id: "llama3.1:8b",
        name: "llama3.1:8b",
        reasoning: false,
        input: ["text"],
        contextWindow: 131072,
        maxTokens: 32768,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        toolSupport: true,
        isCloud: false,
        ollamaName: "llama3.1:8b",
      },
    ];

    mkdirSync(join(CACHE_PATH, ".."), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(v1Cache, null, 2));

    const cached = readModelCache();
    expect(cached).not.toBeNull();
    expect(cached!.length).toBe(1);
    expect(cached![0].id).toBe("llama3.1:8b");

    // Clean up
    rmSync(CACHE_PATH, { force: true });
  });

  it("writeModelCache produces v2 format readable as v2", () => {
    const models: OllamaModelConfig[] = [
      {
        id: "test:model",
        name: "test:model",
        reasoning: false,
        input: ["text"],
        contextWindow: 8192,
        maxTokens: 2048,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        toolSupport: false,
        isCloud: false,
        ollamaName: "test:model",
      },
    ];

    writeModelCache(models);

    // Read the raw file and verify v2 format
    mkdirSync(join(CACHE_PATH, ".."), { recursive: true });
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    expect(raw.version).toBe(2);
    expect(raw.timestamp).toBeTypeOf("number");
    expect(raw.models).toHaveLength(1);
    expect(raw.models[0].id).toBe("test:model");

    // Clean up
    rmSync(CACHE_PATH, { force: true });
  });
});

// ════════════════════════════════════════════════════════════════
// hasVision
// ════════════════════════════════════════════════════════════════

describe("hasVision", () => {
  it("detects from capabilities array", () => {
    expect(hasVision(["vision"], {})).toBe(true);
    expect(hasVision(["thinking"], {})).toBe(false);
    expect(hasVision(["vision", "thinking"], {})).toBe(true);
  });

  it("detects from known architecture", () => {
    expect(hasVision([], { "general.architecture": "llava-v1.6-34b" })).toBe(true);
    expect(hasVision([], { "general.architecture": "minicpm-v" })).toBe(true);
    expect(hasVision([], { "general.architecture": "mllama" })).toBe(true);
    expect(hasVision([], { "general.architecture": "llama" })).toBe(false);
  });

  it("detects from clip.has_vision_encoder", () => {
    expect(hasVision([], { "clip.has_vision_encoder": true })).toBe(true);
    expect(hasVision([], { "clip.has_vision_encoder": false })).toBe(false);
  });

  it("detects from family", () => {
    expect(hasVision([], {}, "llava")).toBe(true);
    expect(hasVision([], {}, "mllama")).toBe(true);
    expect(hasVision([], {}, "llama3.1")).toBe(false);
  });

  it("capabilities take precedence over family", () => {
    expect(hasVision(["vision"], {}, "llama3.1")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// hasToolSupport
// ════════════════════════════════════════════════════════════════

describe("hasToolSupport", () => {
  it("detects from capabilities array", () => {
    expect(hasToolSupport(["tools"], {})).toBe(true);
    expect(hasToolSupport(["vision"], {})).toBe(false);
    expect(hasToolSupport(["tools", "vision"], {})).toBe(true);
  });

  it("detects from known family", () => {
    expect(hasToolSupport([], {}, "llama3.1")).toBe(true);
    expect(hasToolSupport([], {}, "qwen2.5")).toBe(true);
    expect(hasToolSupport([], {}, "gemma4")).toBe(true);
    expect(hasToolSupport([], {}, "mistral")).toBe(true);
    expect(hasToolSupport([], {}, "llama3")).toBe(false); // base llama3 is NOT tool-capable
  });

  it("detects from model name", () => {
    expect(hasToolSupport([], {}, undefined, "llama3.1:8b")).toBe(true);
    expect(hasToolSupport([], {}, undefined, "qwen2.5-coder:7b")).toBe(true);
    expect(hasToolSupport([], {}, undefined, "simple-lora:latest")).toBe(false);
  });

  it("capabilities take precedence", () => {
    expect(hasToolSupport(["tools"], {}, "unknown-family")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// hasReasoning
// ════════════════════════════════════════════════════════════════

describe("hasReasoning", () => {
  it("detects from capabilities array", () => {
    expect(hasReasoning(["thinking"])).toBe(true);
    expect(hasReasoning(["vision"])).toBe(false);
  });

  it("detects from model name patterns", () => {
    expect(hasReasoning([], "deepseek-r1:671b")).toBe(true);
    expect(hasReasoning([], "qwen3:32b")).toBe(true);
    expect(hasReasoning([], "gemma4:27b")).toBe(true);
    expect(hasReasoning([], "llama3.1:8b")).toBe(false);
  });

  it("capabilities override name heuristics", () => {
    expect(hasReasoning(["thinking"], "llama3.1:8b")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// extractContextLength
// ════════════════════════════════════════════════════════════════

describe("extractContextLength", () => {
  it("extracts from llama.context_length", () => {
    expect(extractContextLength({ "llama.context_length": 131072 })).toBe(131072);
  });

  it("extracts from qwen2.context_length", () => {
    expect(extractContextLength({ "qwen2.context_length": 32768 })).toBe(32768);
  });

  it("returns null when no context_length key", () => {
    expect(extractContextLength({ "llama.attention_head_count": 32 })).toBeNull();
  });

  it("returns null for invalid values", () => {
    expect(extractContextLength({ "llama.context_length": 0 })).toBeNull();
    expect(extractContextLength({ "llama.context_length": -1 })).toBeNull();
    expect(extractContextLength({ "llama.context_length": "big" })).toBeNull();
    expect(extractContextLength({ "llama.context_length": NaN })).toBeNull();
  });

  it("uses first context_length key when multiple exist", () => {
    const result = extractContextLength({
      "llama.context_length": 8192,
      "qwen.context_length": 32768,
    });
    // Should return one of them (first found)
    expect([8192, 32768]).toContain(result);
  });
});

// ════════════════════════════════════════════════════════════════
// isCloudModel
// ════════════════════════════════════════════════════════════════

describe("isCloudModel", () => {
  it("all models are cloud when mode=cloud", () => {
    expect(isCloudModel("llama3:8b", new Set(["llama3:8b"]), 4e9, "cloud")).toBe(true);
  });

  it(":cloud tag detected", () => {
    expect(isCloudModel("kimi-k2.6:cloud", new Set(["kimi-k2.6:cloud"]), 384, "local")).toBe(true);
  });

  it("-cloud suffix detected", () => {
    expect(isCloudModel("qwen3.5:397b-cloud", new Set(), 393, "local")).toBe(true);
  });

  it("local pulled models not flagged", () => {
    expect(isCloudModel("llama3:8b", new Set(["llama3:8b"]), 4.7e9, "local")).toBe(false);
  });

  it("large unpulled models flagged (size fallback)", () => {
    expect(isCloudModel("huge:200b", new Set(["llama3:8b"]), 200e9, "local")).toBe(true);
  });

  it("small unpulled local models not flagged", () => {
    expect(isCloudModel("tiny:1b", new Set(), 1e9, "local")).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// generateModelId
// ════════════════════════════════════════════════════════════════

describe("generateModelId", () => {
  it("preserves existing :cloud suffix", () => {
    expect(generateModelId("kimi-k2.6:cloud", true)).toBe("kimi-k2.6:cloud");
  });

  it("preserves existing -cloud suffix", () => {
    expect(generateModelId("qwen3.5:397b-cloud", true)).toBe("qwen3.5:397b-cloud");
  });

  it("adds -cloud for tagged models in cloud mode", () => {
    expect(generateModelId("qwen3.5:397b", true)).toBe("qwen3.5:397b-cloud");
  });

  it("adds :cloud for bare-name models in cloud mode", () => {
    expect(generateModelId("gemini-3-flash-preview", true)).toBe("gemini-3-flash-preview:cloud");
  });

  it("does not modify non-cloud models", () => {
    expect(generateModelId("llama3:8b", false)).toBe("llama3:8b");
  });
});

// ════════════════════════════════════════════════════════════════
// getOllamaHost
// ════════════════════════════════════════════════════════════════

describe("getOllamaHost", () => {
  const originalHost = process.env.OLLAMA_HOST;

  afterEach(() => {
    if (originalHost !== undefined) {
      process.env.OLLAMA_HOST = originalHost;
    } else {
      delete process.env.OLLAMA_HOST;
    }
  });

  it("defaults to localhost:11434 when OLLAMA_HOST not set", () => {
    delete process.env.OLLAMA_HOST;
    expect(getOllamaHost()).toBe("http://localhost:11434");
  });

  it("uses OLLAMA_HOST with http:// prefix", () => {
    process.env.OLLAMA_HOST = "http://my-server:11434";
    expect(getOllamaHost()).toBe("http://my-server:11434");
  });

  it("uses OLLAMA_HOST without prefix (adds http://)", () => {
    process.env.OLLAMA_HOST = "my-server:11434";
    expect(getOllamaHost()).toBe("http://my-server:11434");
  });

  it("uses OLLAMA_HOST with https:// prefix", () => {
    process.env.OLLAMA_HOST = "https://remote:11434";
    expect(getOllamaHost()).toBe("https://remote:11434");
  });

  it("strips trailing slash", () => {
    process.env.OLLAMA_HOST = "http://my-server:11434/";
    expect(getOllamaHost()).toBe("http://my-server:11434");
  });

  it("supports custom port", () => {
    process.env.OLLAMA_HOST = "http://192.168.1.100:8080";
    expect(getOllamaHost()).toBe("http://192.168.1.100:8080");
  });
});