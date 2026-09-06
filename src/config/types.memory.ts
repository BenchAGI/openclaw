import type { MemoryExtraPath } from "../memory-host-sdk/host/types.js";
/**
 * Memory config types shared by core context-engine paths and memory host/plugin runtimes.
 * Builtin memory stays core-owned.
 */
import type { SecretInput } from "./types.secrets.js";

export type { MemoryExtraPath } from "../memory-host-sdk/host/types.js";

/** Citation rendering mode for memory-injected context. */
export type MemoryCitationsMode = "auto" | "on" | "off";

/** Top-level memory config block. */
export type MemoryConfig = {
  citations?: MemoryCitationsMode;
  /** Shared embedding/search defaults. Per-agent overrides live under agents.entries.*.memory.search. */
  search?: MemorySearchConfig;
};

export type MemorySearchConfig = {
  /** Enable vector memory search (default: true). */
  enabled?: boolean;
  /** Use relevant context from this agent's other private conversations. */
  rememberAcrossConversations?: boolean;
  /** Sources to index and search (default: ["memory"]). */
  sources?: Array<"memory" | "sessions">;
  /** Extra paths to include in memory search, optionally filtered by a glob. */
  extraPaths?: MemoryExtraPath[];
  /** Optional multimodal file indexing for selected extra paths. */
  multimodal?: {
    /** Enable image/audio embeddings from extraPaths. */
    enabled?: boolean;
    /** Which non-text file types to index. */
    modalities?: Array<"image" | "audio" | "all">;
    /** Max bytes allowed per multimodal file before it is skipped. */
    maxFileBytes?: number;
  };
  /** Experimental session transcript indexing. */
  experimental?: {
    sessionMemory?: boolean;
  };
  /** Memory embedding provider adapter id. */
  provider?: string;
  remote?: {
    baseUrl?: string;
    apiKey?: SecretInput;
    headers?: Record<string, string>;
    batch?: {
      /** Enable batch API for embedding indexing (OpenAI/Gemini; default: true). */
      enabled?: boolean;
    };
  };
  /** Fallback memory embedding provider adapter id when embeddings fail. */
  fallback?: string;
  /** Embedding model id (remote) or alias (local). */
  model?: string;
  /** Optional provider-specific embedding input_type for query and document requests. */
  inputType?: string;
  /** Optional provider-specific embedding input_type for query-time memory search. */
  queryInputType?: string;
  /** Optional provider-specific embedding input_type for document/index embeddings. */
  documentInputType?: string;
  /**
   * Provider-specific output vector dimensions. Gemini supports 128 to 3072.
   * Google recommends 768, 1536, or 3072 dimensions.
   */
  outputDimensionality?: number;
  /** Local embedding settings for the managed llama.cpp server. */
  local?: {
    /** GGUF model path or hf: URI. */
    modelPath?: string;
  };
  /** Index storage configuration. */
  store?: {
    fts?: {
      /** FTS5 tokenizer (default: "unicode61"). Use "trigram" for CJK text support. */
      tokenizer?: "unicode61" | "trigram";
    };
    vector?: {
      /** Enable the sqlite-vec semantic index (default: true). */
      enabled?: boolean;
      /** Optional override path to sqlite-vec extension (.dylib/.so/.dll). */
      extensionPath?: string;
    };
    cache?: {
      /** Enable embedding cache (default: true). */
      enabled?: boolean;
      /** Optional max cache entries per provider/model. */
      maxEntries?: number;
    };
  };
  /** Query behavior. */
  query?: {
    maxResults?: number;
    minScore?: number;
    /**
     * Tier-1 retrieval-at-start (Bench fork #63): on a cold session start, search
     * this agent's memory index for the opening topic and inject a small
     * retrieved-context slice ahead of MEMORY.md. Fail-open, bounded, default OFF.
     */
    tier1?: {
      /** Enable Tier-1 retrieval-at-start (default: false — ship dark). */
      enabled?: boolean;
      /** Top-K hits to inject (default: 4). */
      maxResults?: number;
      /** Minimum relevance score to inject a hit (0-1, default: 0.45). */
      minScore?: number;
      /** Hard byte cap on the injected slice (default: 1600). */
      maxBytes?: number;
      /** Search timeout budget in ms; on exceed, skip silently (default: 1200). */
      timeoutMs?: number;
    };
    /**
     * Optional LLM reranker for Tier-1 candidates: a judge model re-orders and
     * filters hits by "does this answer THIS question?". Fail-open, default OFF.
     */
    reranker?: {
      /** Enable the LLM reranker (default: false). */
      enabled?: boolean;
      /** OpenAI-compatible base URL of the judge endpoint. */
      baseUrl?: string;
      /** Optional API key for the judge endpoint. */
      apiKey?: SecretInput;
      /** Judge model id. */
      model?: string;
      /** Judge request timeout in ms (default: 6000). */
      timeoutMs?: number;
      /** Drop candidates the judge scores below this floor (0-1, default: 0.5). */
      minScore?: number;
      /** Max candidates sent to the judge (default: 8). */
      topK?: number;
    };
  };
  /** Index cache behavior. */
  cache?: {
    /** Cache chunk embeddings in SQLite (default: true). */
    enabled?: boolean;
  };
};
