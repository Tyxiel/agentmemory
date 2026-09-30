import type { Plugin } from "@opencode-ai/plugin";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

/**
 * agentmemory-capture for OpenCode — V1 and V2 in one file.
 *
 * OpenCode V2 no longer runs the V1 `Hooks`-object plugin shape: the default
 * export must carry an `id` plus a `setup(ctx)`, and hooks are registered on
 * the domain that owns the operation. This file default-exports both, so it
 * keeps working across the V1 -> V2 transition:
 *
 *   - V1 calls `server()` and uses the returned hooks.
 *   - V2 reads `id` and `setup()` and ignores `server()`.
 *
 * The two implementations are deliberately kept separate. Sharing an export
 * does not translate V1 hooks into V2 hooks, and the hook payloads differ
 * enough (see README.md) that a shared core would be a lie about coverage.
 *
 * The V1 body below is unchanged and remains the full 22-hook implementation,
 * including `config` and `chat.params`. The V2 body carries only the hooks
 * that have a faithful V2 equivalent.
 *
 * `@opencode/plugin` is deliberately not imported: the loader only requires
 * `id` plus `setup`, so this file needs no V2 SDK dependency to be installed.
 */

const API = process.env.AGENTMEMORY_URL || "http://localhost:3111";
// OpenCode reports tool names in lowercase ("read", "edit", ...); matching is
// case-insensitive at the call site so a future casing change cannot silently
// kill file enrichment again.
const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep"]);
const FILE_KEYS = ["filePath", "file_path", "path", "file", "pattern"];
const MAX_STASHED_FILES = 20;

const DEBUG = process.env.OPENCODE_AGENTMEMORY_DEBUG === "1";
const SECRET = process.env.AGENTMEMORY_SECRET || "";

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) headers["Authorization"] = `Bearer ${SECRET}`;
  return headers;
}

async function post(path: string, body: Record<string, unknown>, timeoutMs = 5000): Promise<void> {
  try {
    await fetch(`${API}/agentmemory${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (DEBUG) console.error(`[agentmemory] POST ${path} failed:`, (e as Error).message);
  }
}

async function postJson(path: string, body: Record<string, unknown>): Promise<unknown | null> {
  try {
    const res = await fetch(`${API}/agentmemory${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? await res.json() : null;
  } catch (e) {
    if (DEBUG) console.error(`[agentmemory] POST ${path} failed:`, (e as Error).message);
    return null;
  }
}

async function observe(
  sessionId: string,
  hookType: string,
  data: Record<string, unknown>,
): Promise<void> {
  const proj = projectFor(sessionId);
  await post("/observe", {
    hookType,
    sessionId,
    project: proj.name,
    cwd: proj.cwd,
    timestamp: new Date().toISOString(),
    data,
  });
}

let activeSessionId: string | null = null;
let pendingConfig: Record<string, unknown> | null = null;
// Default scope resolved at plugin init (same resolution order as the hooks'
// resolveProject: env override, git toplevel basename, cwd basename). In a
// long-lived OpenCode process serving multiple directories these defaults are
// only a fallback — attribution is per-session via sessionProjects, resolved
// from each session's own directory at session.created. Module-level-only
// state recorded home-directory sessions under whatever repo loaded first.
let defaultProjectName: string | null = null;
let defaultProjectCwd: string | null = null;
const sessionProjects = new Map<string, { name: string; cwd: string }>();

function projectFor(sessionId: string): { name: string | null; cwd: string | null } {
  const p = sessionProjects.get(sessionId);
  return p ?? { name: defaultProjectName, cwd: defaultProjectCwd };
}

const projectNameCache = new Map<string, string>();

function resolveProjectName(dir: string): string {
  const explicit = process.env.AGENTMEMORY_PROJECT_NAME?.trim();
  if (explicit) return explicit;
  const cached = projectNameCache.get(dir);
  if (cached !== undefined) return cached;
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (top) {
      const name = basename(top);
      projectNameCache.set(dir, name);
      return name;
    }
  } catch {
    // not a git repo, fall through
  }
  const fallback = basename(dir) || dir;
  projectNameCache.set(dir, fallback);
  return fallback;
}
const stashedFiles = new Map<string, Set<string>>();
const seenSubtaskIds = new Map<string, Set<string>>();
const seenToolCallIds = new Map<string, Set<string>>();
const contextInjectedSessions = new Set<string>();
// cache the context returned by POST /session/start so the chat
// system-transform hook can inject it without a second /context fetch.
// Auto-injection now happens at session.created (immediately) AND at
// the first prompt_submit (fallback for older OpenCode builds that
// don't implement experimental.chat.system.transform).
const startContextCache = new Map<string, string>();

function stashFor(sid: string): Set<string> {
  let s = stashedFiles.get(sid);
  if (!s) { s = new Set<string>(); stashedFiles.set(sid, s); }
  return s;
}

function subtaskSetFor(sid: string): Set<string> {
  let s = seenSubtaskIds.get(sid);
  if (!s) { s = new Set<string>(); seenSubtaskIds.set(sid, s); }
  return s;
}

function toolCallSetFor(sid: string): Set<string> {
  let s = seenToolCallIds.get(sid);
  if (!s) { s = new Set<string>(); seenToolCallIds.set(sid, s); }
  return s;
}

function pruneSessionMaps(sid: string): void {
  stashedFiles.delete(sid);
  seenSubtaskIds.delete(sid);
  seenToolCallIds.delete(sid);
  sessionProjects.delete(sid);
}

function safeSlice(v: unknown, max: number): string {
  if (typeof v === "string") return v.slice(0, max);
  if (v == null) return "";
  try { return JSON.stringify(v).slice(0, max); } catch { return ""; }
}

const AGENTMEMORY_INSTRUCTIONS = `<agentmemory-instructions>
You have access to agentmemory for persistent cross-session memory. Use these tools proactively.

CORE TOOLS:

memory_save — Save an insight, decision, or fact to long-term memory.
  Required: content (text), concepts (2-5 comma-separated keywords), type (pattern/preference/architecture/bug/workflow/fact)
  Optional: files (comma-separated paths)
  Use when: user says "remember this", after discovering a bug, after making an architectural decision, after learning a project convention.

memory_recall — Search past observations by keywords.
  Use when: user says "recall", "what did we do", "do you remember", or needs context from past sessions.

memory_smart_search — Hybrid semantic+keyword search with progressive disclosure.
  Use when: you need the most relevant past context, fuzzy/conceptual searches, or recall doesn't find what you need.

memory_sessions — List recent sessions with status and observation counts.
  Use when: user asks about session/past history, "what did we work on".

memory_file_history — Get past observations about specific files (across all sessions).
  Use when: you're about to edit a file and want to know its history, common pitfalls, or past edits.

memory_lesson_save — Save a lesson learned (what worked, what to avoid).
  Use when: you discover a pattern that could help future sessions avoid mistakes.

memory_lesson_recall — Search lessons by query. Returns lessons sorted by confidence.
  Use when: before making a decision, check if past lessons apply.

memory_governance_delete — Delete specific memories. Requires explicit user confirmation.
  Use when: user says "forget this", "delete that memory".

memory_patterns — Detect recurring patterns across sessions.
  Use when: you want to understand project-level trends over time.

memory_consolidate — Run the 4-tier memory consolidation pipeline.
  Use when: you want to compress and organize accumulated session observations.

All memory tools start with \`agentmemory_memory_\`. Use the exact names as they appear in your tool list. Tool results are JSON. Always check what was returned before presenting to the user.
</agentmemory-instructions>`;

function extractFilePaths(args: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const key of FILE_KEYS) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) {
      files.push(val);
    }
  }
  return files;
}

function extractErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (e.data && typeof e.data === "object") {
      const d = e.data as Record<string, unknown>;
      if (typeof d.message === "string") return d.message;
    }
    if (typeof e.name === "string") return e.name;
    try { return JSON.stringify(err); } catch { return ""; }
  }
  return String(err ?? "");
}

// ═══════════════════════════════════════════════════════════════════════════
// V1 implementation — unchanged from the original plugin
// ═══════════════════════════════════════════════════════════════════════════

const v1Hooks: Plugin = async (ctx) => {
  defaultProjectCwd = ctx.worktree || ctx.project?.id || process.cwd();
  defaultProjectName = resolveProjectName(defaultProjectCwd);

  return {
    event: async ({ event }) => {
      const type = event.type;
      const props = (event as any).properties || {};

      // ── session.created ──
      if (type === "session.created") {
        const info = props.info as Record<string, unknown> | undefined;
        activeSessionId = (info?.id as string) || props.sessionID || null;
        if (!activeSessionId) return;
        stashedFiles.set(activeSessionId, new Set());
        seenSubtaskIds.delete(activeSessionId);
        seenToolCallIds.delete(activeSessionId);
        contextInjectedSessions.delete(activeSessionId);
        // Snapshot the session id locally — `activeSessionId` is mutable
        // and another `session.created` event during the await could
        // rebind it, causing context to be cached against the wrong key.
        const sessionId = activeSessionId;
        // Attribute this session to its own directory when the event
        // carries one; a multi-directory OpenCode process otherwise
        // records every session under whichever repo loaded the plugin.
        const sessionDir =
          typeof info?.directory === "string" && info.directory
            ? info.directory
            : defaultProjectCwd;
        let proj: { name: string | null; cwd: string | null };
        if (sessionDir) {
          const entry = { cwd: sessionDir, name: resolveProjectName(sessionDir) };
          sessionProjects.set(sessionId, entry);
          proj = entry;
        } else {
          proj = projectFor(sessionId);
        }
        const startResult = await postJson("/session/start", {
          sessionId,
          title: info?.title ?? null,
          parentID: info?.parentID ?? null,
          version: info?.version ?? null,
          project: proj.name,
          cwd: proj.cwd,
        });
        // cache the context returned at session/start so the
        // chat.system.transform hook injects it without a second fetch.
        const startCtx = (startResult as any)?.context;
        if (typeof startCtx === "string" && startCtx.length > 0) {
          startContextCache.set(sessionId, startCtx);
        }
        if (pendingConfig) {
          await observe(sessionId, "config_loaded", pendingConfig);
          pendingConfig = null;
        }
      }

      // ── session.idle ── (summarize handled in session.status idle branch)

      // ── session.status ──
      if (type === "session.status") {
        const status = props.status as Record<string, unknown> | undefined;
        const sid = props.sessionID || activeSessionId;
        if (!sid || !status) return;
        if (status.type === "idle") {
          await post("/summarize", { sessionId: sid });
        }
        await observe(sid, "session_status", {
          status_type: status.type,
          attempt: status.attempt ?? null,
          message: safeSlice(status.message, 2000),
        });
      }

      // ── session.compacted ──
      if (type === "session.compacted") {
        const sid = props.sessionID || activeSessionId;
        if (sid) {
          await post("/summarize", { sessionId: sid });
          await observe(sid, "session_compacted", {});
        }
      }

      // ── session.updated ──
      if (type === "session.updated") {
        const info = props.info as Record<string, unknown> | undefined;
        const sid = (info?.id as string) || props.sessionID || activeSessionId;
        if (!sid) return;
        await observe(sid, "session_updated", {
          title: info?.title ?? null,
          parentID: info?.parentID ?? null,
          additions: (info?.summary as any)?.additions ?? null,
          deletions: (info?.summary as any)?.deletions ?? null,
          files: (info?.summary as any)?.files ?? null,
        });
      }

      // ── session.diff ──
      if (type === "session.diff") {
        const sid = props.sessionID || activeSessionId;
        if (!sid || !Array.isArray(props.diff)) return;
        const diffs = props.diff as Array<Record<string, unknown>>;
        await observe(sid, "session_diff", {
          files: diffs.map(d => d.file),
          additions: diffs.reduce((s, d) => s + ((d.additions as number) || 0), 0),
          deletions: diffs.reduce((s, d) => s + ((d.deletions as number) || 0), 0),
          diffs: diffs.slice(0, 50),
        });
      }

      // ── session.deleted ──
      if (type === "session.deleted") {
        const sid = props.info?.id || props.sessionID || activeSessionId;
        if (!sid) {
          if (DEBUG) console.error("[agentmemory] session.deleted with no session ID");
          return;
        }
        await post("/session/end", { sessionId: sid });
        post("/crystals/auto", { olderThanDays: 7 }, 30000);
        post("/consolidate-pipeline", { tier: "all", force: true }, 30000);
        if (sid === activeSessionId) activeSessionId = null;
        pruneSessionMaps(sid);
        startContextCache.delete(sid);
        contextInjectedSessions.delete(sid);
      }

      // ── session.error ──
      if (type === "session.error") {
        const sid = props.sessionID || activeSessionId;
        if (sid) {
          await observe(sid, "post_tool_failure", {
            tool_name: "session.error",
            tool_input: "",
            tool_output: safeSlice(props.error, 8000),
          });
        }
      }

      // ── message.updated ──
      if (type === "message.updated") {
        const info = props.info as Record<string, unknown> | undefined;
        if (!info) return;

        if (info.role === "assistant") {
          const sid = props.sessionID || (info.sessionID as string) || activeSessionId;
          if (!sid) return;
          const tokens = info.tokens as Record<string, unknown> | undefined;
          const error = info.error ? extractErrorMessage(info.error) : null;
          await observe(sid, "assistant_message", {
            messageID: info.id,
            parentID: info.parentID,
            modelID: info.modelID,
            providerID: info.providerID,
            mode: info.mode,
            cost: info.cost ?? 0,
            tokens: {
              input: tokens?.input ?? 0,
              output: tokens?.output ?? 0,
              reasoning: tokens?.reasoning ?? 0,
              cache_read: (tokens?.cache as any)?.read ?? 0,
              cache_write: (tokens?.cache as any)?.write ?? 0,
            },
            finish: info.finish ?? null,
            error,
            duration_ms: (info.time && typeof (info.time as any).completed === "number")
              ? (info.time as any).completed - ((info.time as any).created || 0)
              : null,
          });
        }
      }

      // ── message.removed ──
      if (type === "message.removed") {
        const sid = props.sessionID || activeSessionId;
        if (sid) {
          await observe(sid, "message_removed", {
            messageID: props.messageID,
          });
        }
      }

      // ── message.part.updated ──
      if (type === "message.part.updated") {
        const part = props.part as Record<string, unknown> | undefined;
        if (!part) return;
        const sid = (part.sessionID as string) || props.sessionID || activeSessionId;
        if (!sid) return;

        if (part.type === "subtask") {
          const subtaskId = part.id as string;
          if (!subtaskId) return;
          const subtaskSet = subtaskSetFor(sid);
          if (subtaskSet.has(subtaskId)) return;
          subtaskSet.add(subtaskId);
          await observe(sid, "subagent_start", {
            subtask_id: part.id,
            agent: part.agent,
            prompt: safeSlice(part.prompt, 4000),
            description: safeSlice(part.description, 2000),
          });
          return;
        }

        if (part.type === "tool") {
          const state = part.state as Record<string, unknown> | undefined;
          if (!state) return;
          const callId = part.callID as string;
          if (!callId) return;
          const toolName = part.tool as string;

          if (state.status === "completed") {
            const callSet = toolCallSetFor(sid);
            if (callSet.has(callId)) return;
            callSet.add(callId);
            const st = state as Record<string, unknown>;
            const rawTime = (st.time as any) || {};
            const startTime = typeof rawTime.start === "number" ? rawTime.start : null;
            const endTime = typeof rawTime.end === "number" ? rawTime.end : null;
            await observe(sid, "post_tool_use", {
              tool_name: toolName,
              call_id: callId,
              tool_input: safeSlice(st.input, 4000),
              tool_output: safeSlice(st.output, 8000),
              title: st.title ?? null,
              metadata: st.metadata || {},
              duration_ms: (startTime != null && endTime != null) ? endTime - startTime : null,
              attachments: Array.isArray(st.attachments)
                ? (st.attachments as Array<Record<string, unknown>>).map(a => a.filename || a.url)
                : [],
            });
          } else if (state.status === "error") {
            const callSet = toolCallSetFor(sid);
            if (callSet.has(callId)) return;
            callSet.add(callId);
            const st = state as Record<string, unknown>;
            const rawTime = (st.time as any) || {};
            const startTime = typeof rawTime.start === "number" ? rawTime.start : null;
            const endTime = typeof rawTime.end === "number" ? rawTime.end : null;
            await observe(sid, "post_tool_failure", {
              tool_name: toolName,
              call_id: callId,
              tool_input: safeSlice(st.input, 4000),
              tool_output: safeSlice(st.error, 8000),
              duration_ms: (startTime != null && endTime != null) ? endTime - startTime : null,
            });
          }
          return;
        }

        if (part.type === "step-finish") {
          await observe(sid, "step_finish", {
            messageID: part.messageID,
            reason: part.reason ?? null,
            cost: (part as any).cost ?? 0,
            input_tokens: ((part as any).tokens?.input as number) ?? 0,
            output_tokens: ((part as any).tokens?.output as number) ?? 0,
            reasoning_tokens: ((part as any).tokens?.reasoning as number) ?? 0,
          });
          return;
        }

        if (part.type === "reasoning") {
          await observe(sid, "reasoning", {
            messageID: part.messageID,
            text: safeSlice((part as any).text, 4000),
          });
          return;
        }

        if (part.type === "file") {
          const filename = (part as any).filename || (part as any).url || null;
          if (filename) stashFor(sid).add(filename);
          return;
        }

        if (part.type === "patch") {
          await observe(sid, "patch_applied", {
            messageID: part.messageID,
            hash: (part as any).hash,
            files: (part as any).files || [],
          });
          return;
        }

        if (part.type === "compaction") {
          await observe(sid, "compaction_event", {
            messageID: part.messageID,
            auto: (part as any).auto ?? false,
          });
          return;
        }

        if (part.type === "agent") {
          await observe(sid, "agent_selected", {
            messageID: part.messageID,
            name: (part as any).name,
          });
          return;
        }

        if (part.type === "retry") {
          await observe(sid, "retry_attempt", {
            messageID: part.messageID,
            attempt: (part as any).attempt,
            error: safeSlice((part as any).error, 2000),
          });
          return;
        }
      }

      // ── file.edited ──
      if (type === "file.edited") {
        const sid = props.sessionID || activeSessionId;
        if (sid && typeof props.file === "string" && props.file.length > 0) {
          const stash = stashFor(sid);
          stash.add(props.file);
          if (stash.size > MAX_STASHED_FILES) {
            const keep = [...stash].slice(-MAX_STASHED_FILES);
            stash.clear();
            for (const f of keep) stash.add(f);
          }
        }
      }

      // ── permission.updated ──
      if (type === "permission.updated") {
        const sid = props.sessionID || activeSessionId;
        if (!sid) return;
        await observe(sid, "notification", {
          notification_type: "permission_prompt",
          permission: props.type || "unknown",
          pattern: Array.isArray(props.pattern)
            ? props.pattern.join(", ")
            : (props.pattern || ""),
          tool_call_id: props.callID || null,
          title: props.title || props.type || "",
          metadata: props.metadata || {},
        });
      }

      // ── permission.replied ──
      if (type === "permission.replied") {
        const sid = props.sessionID || activeSessionId;
        if (!sid) return;
        await observe(sid, "permission_replied", {
          permission_id: props.permissionID || props.requestID || "",
          response: props.response || props.reply || "",
        });
      }

      // ── todo.updated ──
      if (type === "todo.updated") {
        const sid = props.sessionID || activeSessionId;
        const todos = Array.isArray(props.todos) ? props.todos.slice(0, 100) : [];
        if (!sid || todos.length === 0) return;
        const completed = todos.filter((t: any) => t.status === "completed");
        const active = todos.filter((t: any) => t.status !== "completed");
        await observe(sid, "task_completed", {
          completed: completed.map((t: any) => ({ content: t.content, priority: t.priority })),
          in_progress: active.map((t: any) => ({ content: t.content, priority: t.priority })),
          total: todos.length,
        });
      }

      // ── command.executed ──
      if (type === "command.executed") {
        const sid = props.sessionID || activeSessionId;
        if (sid) {
          await observe(sid, "command_executed", {
            name: props.name,
            arguments: props.arguments || "",
          });
        }
      }
    },

    // ── chat.message ──
    "chat.message": async (input, output) => {
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;
      const parts = output.parts || [];
      const files = parts
        .filter((p: any) => p.type === "file")
        .map((p: any) => p.filename || p.url)
        .filter(Boolean);
      for (const f of files) {
        const stash = stashFor(sid);
        stash.add(f);
        if (stash.size > MAX_STASHED_FILES) {
          const keep = [...stash].slice(-MAX_STASHED_FILES);
          stash.clear();
          for (const k of keep) stash.add(k);
        }
      }

      const textParts = parts.filter((p: any) => p.type === "text" && !p.synthetic && !p.ignored);
      const userText = textParts.map((p: any) => p.text || "").join("\n");

      await observe(sid, "prompt_submit", {
        agent: input.agent ?? null,
        model: input.model ?? null,
        variant: input.variant ?? null,
        prompt: userText.slice(0, 8000),
        files: files.slice(0, 20),
        parts_summary: parts.map((p: any) => p.type).filter(Boolean),
      });
    },

    // ── chat.params ──
    "chat.params": async (input, output) => {
      if (!input.model || !output) return;
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;
      await observe(sid, "llm_params", {
        agent: input.agent,
        model: `${input.model.providerID}/${input.model.id}`,
        provider_url: input.model.api?.url ?? null,
        temperature: output.temperature,
        topP: output.topP,
        max_output_tokens: input.model.limit?.output ?? null,
        context_limit: input.model.limit?.context ?? null,
        cost_1k_input: input.model.cost?.input ?? 0,
        cost_1k_output: input.model.cost?.output ?? 0,
      });
    },

    // ── tool.execute.before ──
    "tool.execute.before": async (input, output) => {
      if (!FILE_TOOLS.has(String(input.tool ?? "").toLowerCase())) return;
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;
      const args = output.args as Record<string, unknown> | undefined;
      if (!args) return;
      const stash = stashFor(sid);
      for (const fp of extractFilePaths(args)) {
        stash.add(fp);
      }
      if (stash.size > MAX_STASHED_FILES) {
        const keep = [...stash].slice(-MAX_STASHED_FILES);
        stash.clear();
        for (const f of keep) stash.add(f);
      }
    },

    // ── experimental.chat.system.transform ──
    "experimental.chat.system.transform": async (input, output) => {
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;

      if (!contextInjectedSessions.has(sid)) {
        if (!Array.isArray(output.system)) return;
        output.system.push(AGENTMEMORY_INSTRUCTIONS);
        // prefer the context already fetched at session.created;
        // fall back to a fresh /context call if the cache missed (e.g.
        // session resumed across plugin reloads).
        let ctx = startContextCache.get(sid);
        if (typeof ctx !== "string" || ctx.length === 0) {
          const result = await postJson("/context", {
            sessionId: sid,
            project: projectFor(sid).name,
          });
          ctx = (result as any)?.context;
        } else {
          startContextCache.delete(sid);
        }
        if (typeof ctx === "string" && ctx.length > 0) {
          output.system.push(ctx);
        }
        contextInjectedSessions.add(sid);
      }

      const stash = stashFor(sid);
      if (stash.size === 0) return;
      const files = [...stash].slice(0, 10);

      const enrichResult = await postJson("/enrich", {
        sessionId: sid,
        files,
        toolName: "enrich_inject",
      });

      const enrichCtx = (enrichResult as any)?.context;
      if (typeof enrichCtx === "string" && enrichCtx.length > 0) {
        if (Array.isArray(output.system)) {
          output.system.push(enrichCtx);
        }
        for (const f of files) stash.delete(f);
      }
    },

    // ── experimental.session.compacting (WIP) ──
    "experimental.session.compacting": async (input, output) => {
      const sid = input.sessionID || activeSessionId;
      if (!sid) return;

      const result = await postJson("/context", {
        sessionId: sid,
        project: projectFor(sid).name,
      });
      const ctx = (result as any)?.context;
      if (typeof ctx === "string" && ctx.length > 0) {
        if (Array.isArray(output.context)) {
          output.context.push(ctx);
        }
      }
    },

    // ── config ──
    config: async (input) => {
      const payload: Record<string, unknown> = {
        theme: input.theme ?? null,
        model: input.model ?? null,
        autoupdate: input.autoupdate ?? null,
        agents: typeof input.agent === "object" && input.agent !== null && !Array.isArray(input.agent)
          ? Object.keys(input.agent as Record<string, unknown>)
          : Array.isArray(input.agent) ? input.agent : [],
        mcp_servers: typeof input.mcp === "object" && input.mcp !== null && !Array.isArray(input.mcp)
          ? Object.keys(input.mcp as Record<string, unknown>)
          : Array.isArray(input.mcp) ? input.mcp : [],
        providers: typeof input.provider === "object" && input.provider !== null && !Array.isArray(input.provider)
          ? Object.keys(input.provider as Record<string, unknown>)
          : Array.isArray(input.provider) ? input.provider : [],
        permission: input.permission ?? null,
      };
      if (activeSessionId) {
        await observe(activeSessionId, "config_loaded", payload);
      } else {
        pendingConfig = payload;
      }
    },
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// V2 implementation — OpenCode 2.x
//
// Registered on the domain that owns each operation. Callbacks receive one
// mutable event instead of V1's separate `input` / `output` objects.
//
// Three V1 hooks are intentionally absent here, and README.md explains why:
//   config                        — V2 exposes no mutable global config object
//                                   and no hook that observes it.
//   chat.params                   — V2 `context` starts with empty `options`
//                                   rather than resolved model settings.
//   experimental.session.compacting — V2 `compaction` can only set `result`,
//                                   which skips the model call entirely, so
//                                   memory cannot be added to the prompt.
// ═══════════════════════════════════════════════════════════════════════════

async function v2Setup(ctx: any) {
  const location = ctx.location;
  defaultProjectCwd = location?.directory ?? location?.project?.directory ?? process.cwd();
  defaultProjectName = resolveProjectName(defaultProjectCwd);

  // V1 keeps its state at module scope; the two implementations share it here
  // because only one of them ever runs in a given OpenCode version.
  async function observeV2(sessionId: string, hookType: string, data: Record<string, unknown>): Promise<void> {
    await observe(sessionId, hookType, data);
  }

  // ── config snapshot ───────────────────────────────────────────────────────
  // V1's `config` hook observed the global config on every load. V2 has no
  // equivalent, so this is a one-shot snapshot at setup. Config edited while
  // OpenCode is running is NOT captured.

  void (async () => {
    try {
      const [agents, providers, mcp] = await Promise.all([
        ctx.agent?.list?.().catch(() => []),
        ctx.provider?.list?.().catch(() => []),
        ctx.mcp?.list?.().catch(() => []),
      ]);
      const names = (v: unknown): string[] =>
        Array.isArray(v)
          ? v.map((x: any) => (typeof x === "string" ? x : x?.id ?? x?.name)).filter(Boolean)
          : Object.keys((v as object) ?? {});
      const payload = {
        agents: names(agents),
        providers: names(providers),
        mcp_servers: names(mcp),
        model: ctx.model?.default?.() ?? null,
        location: defaultProjectCwd,
      };
      // `setup` runs before any session.created, so `activeSessionId` is
      // normally null here. Park the payload and let the session.created
      // handler flush it, the same way V1's `config` hook does.
      if (activeSessionId) await observeV2(activeSessionId, "config_loaded", payload);
      else pendingConfig = payload;
    } catch (e) {
      if (DEBUG) console.error("[agentmemory] config snapshot failed:", (e as Error).message);
    }
  })();

  // ── tool.execute.before -> ctx.tool.hook("execute.before") ────────────────
  // V1 read `output.args`; V2 exposes the same values as `event.input`.

  await ctx.tool.hook("execute.before", (event: any) => {
    if (!FILE_TOOLS.has(String(event?.tool ?? "").toLowerCase())) return;
    const sid = event?.sessionID || activeSessionId;
    if (!sid) return;
    const args = event?.input as Record<string, unknown> | undefined;
    if (!args) return;
    const stash = stashFor(sid);
    for (const fp of extractFilePaths(args)) stash.add(fp);
    if (stash.size > MAX_STASHED_FILES) {
      const keep = [...stash].slice(-MAX_STASHED_FILES);
      stash.clear();
      for (const f of keep) stash.add(f);
    }
  });

  // ── chat.message -> ctx.session.hook("prompt") ───────────────────────────
  // V2 runs this once during admission, before attachment resolution.

  await ctx.session.hook("prompt", async (event: any) => {
    const sid = event?.sessionID || activeSessionId;
    if (!sid) return;
    const files = (event?.prompt?.files ?? [])
      .map((f: any) => (typeof f === "string" ? f : f?.uri ?? f?.filename ?? f?.url))
      .filter(Boolean) as string[];
    const stash = stashFor(sid);
    for (const f of files) stash.add(f);
    if (stash.size > MAX_STASHED_FILES) {
      const keep = [...stash].slice(-MAX_STASHED_FILES);
      stash.clear();
      for (const k of keep) stash.add(k);
    }
    await observeV2(sid, "prompt_submit", {
      prompt: (event?.prompt?.text ?? "").slice(0, 8000),
      files: files.slice(0, 20),
      agents: event?.prompt?.agents ?? [],
      skills: event?.prompt?.skills ?? [],
      delivery: event?.delivery ?? null,
    });
  });

  // ── experimental.chat.system.transform -> ctx.session.hook("context") ─────
  // `output.system` (string[]) became `event.system` (SystemPart[]), so every
  // push is now a part object. Injects the tool instructions plus recalled
  // memory once per session, then per-file history for stashed files.

  await ctx.session.hook("context", async (event: any) => {
    const sid = event?.sessionID || activeSessionId;
    if (!sid) return;

    if (!contextInjectedSessions.has(sid)) {
      if (!Array.isArray(event.system)) return;
      event.system.push({ type: "text", text: AGENTMEMORY_INSTRUCTIONS });
      // Prefer the context already fetched at session.created; fall back to a
      // fresh /context call if the cache missed (e.g. session resumed across a
      // plugin reload).
      let ctxText = startContextCache.get(sid);
      if (typeof ctxText !== "string" || ctxText.length === 0) {
        const result = await postJson("/context", { sessionId: sid, project: projectFor(sid).name });
        ctxText = (result as any)?.context;
      } else {
        startContextCache.delete(sid);
      }
      if (typeof ctxText === "string" && ctxText.length > 0) {
        event.system.push({ type: "text", text: ctxText });
      }
      contextInjectedSessions.add(sid);
    }

    const stash = stashFor(sid);
    if (stash.size === 0) return;
    const files = [...stash].slice(0, 10);

    const enrichResult = await postJson("/enrich", { sessionId: sid, files, toolName: "enrich_inject" });
    const enrichCtx = (enrichResult as any)?.context;
    if (typeof enrichCtx === "string" && enrichCtx.length > 0) {
      if (Array.isArray(event.system)) event.system.push({ type: "text", text: enrichCtx });
      for (const f of files) stash.delete(f);
    }
  });

  // ── event -> ctx.event.subscribe() ───────────────────────────────────────
  // All lifecycle and message activity arrives on the public server event
  // stream, aborted on unload.

  const controller = new AbortController();

  // The switch below is wrapped in a function so its `return` statements only
  // skip the current event. Inline in the loop, they would exit the IIFE and
  // permanently end the subscription. This mirrors V1, where `return` exits
  // only the current event callback.
  const handleEvent = async (event: any): Promise<void> => {
    {
      const type = event.type;
        const props: any = (event as any).properties || {};
        const sid0 = props.sessionID || (props.info?.id as string) || activeSessionId;

        switch (type) {
          case "session.created": {
            const info = props.info as any;
            // Snapshot locally: `activeSessionId` is mutable and another
            // session.created during the await could rebind it.
            const sessionId = (info?.id as string) || props.sessionID;
            if (!sessionId) return;
            activeSessionId = sessionId;
            stashedFiles.set(sessionId, new Set());
            seenSubtaskIds.delete(sessionId);
            seenToolCallIds.delete(sessionId);
            contextInjectedSessions.delete(sessionId);
            const sessionDir = typeof info?.directory === "string" && info.directory ? info.directory : null;
            if (sessionDir) {
              sessionProjects.set(sessionId, { cwd: sessionDir, name: resolveProjectName(sessionDir) });
            }
            const proj = projectFor(sessionId);
            const startResult = await postJson("/session/start", {
              sessionId,
              title: info?.title ?? null,
              parentID: info?.parentID ?? null,
              version: info?.version ?? null,
              project: proj.name,
              cwd: proj.cwd,
            });
            const startCtx = (startResult as any)?.context;
            if (typeof startCtx === "string" && startCtx.length > 0) startContextCache.set(sessionId, startCtx);
            // Flush the setup-time config snapshot parked before any session
            // existed. Sent after /session/start so the session is registered.
            if (pendingConfig) {
              await observeV2(sessionId, "config_loaded", pendingConfig);
              pendingConfig = null;
            }
            break;
          }

          case "session.status": {
            const status = props.status;
            if (!sid0 || !status) return;
            if (status.type === "idle") await post("/summarize", { sessionId: sid0 });
            await observeV2(sid0, "session_status", {
              status_type: status.type,
              attempt: status.attempt ?? null,
              message: safeSlice(status.message, 2000),
            });
            break;
          }

          case "session.idle": {
            // Summarize is driven by session.status; nothing extra here.
            break;
          }

          case "session.compacted": {
            if (sid0) {
              await post("/summarize", { sessionId: sid0 });
              await observeV2(sid0, "session_compacted", {});
            }
            break;
          }

          case "session.updated": {
            const info = props.info as any;
            if (!sid0) return;
            await observeV2(sid0, "session_updated", {
              title: info?.title ?? null,
              parentID: info?.parentID ?? null,
              additions: info?.summary?.additions ?? null,
              deletions: info?.summary?.deletions ?? null,
              files: info?.summary?.files ?? null,
            });
            break;
          }

          case "session.diff": {
            if (!sid0 || !Array.isArray(props.diff)) return;
            const diffs = props.diff as Array<Record<string, any>>;
            await observeV2(sid0, "session_diff", {
              files: diffs.map((d) => d.file),
              additions: diffs.reduce((s, d) => s + (d.additions || 0), 0),
              deletions: diffs.reduce((s, d) => s + (d.deletions || 0), 0),
              diffs: diffs.slice(0, 50),
            });
            break;
          }

          case "session.deleted": {
            const sid = (props.info?.id as string) || props.sessionID || activeSessionId;
            if (!sid) {
              if (DEBUG) console.error("[agentmemory] session.deleted with no session ID");
              return;
            }
            await post("/session/end", { sessionId: sid });
            // Background consolidation: deliberately not awaited.
            void post("/crystals/auto", { olderThanDays: 7 }, 30000);
            void post("/consolidate-pipeline", { tier: "all", force: true }, 30000);
            if (sid === activeSessionId) activeSessionId = null;
            pruneSessionMaps(sid);
            startContextCache.delete(sid);
            contextInjectedSessions.delete(sid);
            break;
          }

          case "session.error": {
            if (sid0) {
              await observeV2(sid0, "post_tool_failure", {
                tool_name: "session.error",
                tool_input: "",
                tool_output: extractErrorMessage(props.error).slice(0, 8000),
              });
            }
            break;
          }

          case "message.updated": {
            const info = props.info as any;
            if (!info || info.role !== "assistant") return;
            if (!sid0) return;
            const tokens = info.tokens;
            await observeV2(sid0, "assistant_message", {
              messageID: info.id,
              parentID: info.parentID,
              modelID: info.modelID,
              providerID: info.providerID,
              mode: info.mode,
              agent: info.agent ?? null,
              cost: info.cost ?? 0,
              tokens: {
                input: tokens?.input ?? 0,
                output: tokens?.output ?? 0,
                reasoning: tokens?.reasoning ?? 0,
                cache_read: tokens?.cache?.read ?? 0,
                cache_write: tokens?.cache?.write ?? 0,
              },
              finish: info.finish ?? null,
              error: info.error ? extractErrorMessage(info.error) : null,
              duration_ms:
                typeof info.time?.completed === "number" ? info.time.completed - (info.time?.created || 0) : null,
            });
            break;
          }

          case "message.removed": {
            if (sid0) await observeV2(sid0, "message_removed", { messageID: props.messageID });
            break;
          }

          case "message.part.updated": {
            const part = props.part as any;
            if (!part) return;
            const sid = part.sessionID || sid0;
            if (!sid) return;

            switch (part.type) {
              case "subtask": {
                const subtaskId = part.id;
                if (!subtaskId) return;
                const set = subtaskSetFor(sid);
                if (set.has(subtaskId)) return;
                set.add(subtaskId);
                await observeV2(sid, "subagent_start", {
                  subtask_id: part.id,
                  agent: part.agent,
                  prompt: safeSlice(part.prompt, 4000),
                  description: safeSlice(part.description, 2000),
                });
                return;
              }

              case "tool": {
                const state = part.state;
                if (!state) return;
                const callId = part.callID;
                if (!callId) return;
                const start = typeof state.time?.start === "number" ? state.time.start : null;
                const end = typeof state.time?.end === "number" ? state.time.end : null;
                const duration = start != null && end != null ? end - start : null;

                // Dedup on terminal states only, matching V1. Marking the ID on
                // the first pending/running update would make the completed
                // update look like a duplicate and drop the observation.
                if (state.status === "completed") {
                  const set = toolCallSetFor(sid);
                  if (set.has(callId)) return;
                  set.add(callId);
                  await observeV2(sid, "post_tool_use", {
                    tool_name: part.tool,
                    call_id: callId,
                    tool_input: safeSlice(state.input, 4000),
                    tool_output: safeSlice(state.output, 8000),
                    title: state.title ?? null,
                    metadata: state.metadata || {},
                    duration_ms: duration,
                    attachments: Array.isArray(state.attachments)
                      ? state.attachments.map((a: any) => a.filename || a.url)
                      : [],
                  });
                } else if (state.status === "error") {
                  const set = toolCallSetFor(sid);
                  if (set.has(callId)) return;
                  set.add(callId);
                  await observeV2(sid, "post_tool_failure", {
                    tool_name: part.tool,
                    call_id: callId,
                    tool_input: safeSlice(state.input, 4000),
                    tool_output: safeSlice(state.error, 8000),
                    duration_ms: duration,
                  });
                }
                return;
              }

              case "step-finish": {
                await observeV2(sid, "step_finish", {
                  messageID: part.messageID,
                  reason: part.reason ?? null,
                  cost: part.cost ?? 0,
                  input_tokens: part.tokens?.input ?? 0,
                  output_tokens: part.tokens?.output ?? 0,
                  reasoning_tokens: part.tokens?.reasoning ?? 0,
                });
                return;
              }

              case "reasoning": {
                await observeV2(sid, "reasoning", {
                  messageID: part.messageID,
                  text: safeSlice(part.text, 4000),
                });
                return;
              }

              case "file": {
                const filename = part.filename || part.url || null;
                if (filename) stashFor(sid).add(filename);
                return;
              }

              case "patch": {
                await observeV2(sid, "patch_applied", {
                  messageID: part.messageID,
                  hash: part.hash,
                  files: part.files || [],
                });
                return;
              }

              case "compaction": {
                await observeV2(sid, "compaction_event", {
                  messageID: part.messageID,
                  auto: part.auto ?? false,
                  overflow: part.overflow ?? false,
                });
                return;
              }

              case "agent": {
                await observeV2(sid, "agent_selected", { messageID: part.messageID, name: part.name });
                return;
              }

              case "retry": {
                await observeV2(sid, "retry_attempt", {
                  messageID: part.messageID,
                  attempt: part.attempt,
                  error: extractErrorMessage(part.error).slice(0, 2000),
                });
                return;
              }
            }
            return;
          }

          case "file.edited": {
            if (typeof props.file === "string" && props.file.length > 0 && (sid0 || activeSessionId)) {
              const stash = stashFor(sid0 || activeSessionId!);
              stash.add(props.file);
              if (stash.size > MAX_STASHED_FILES) {
                const keep = [...stash].slice(-MAX_STASHED_FILES);
                stash.clear();
                for (const f of keep) stash.add(f);
              }
            }
            break;
          }

          // V1 listened to "permission.updated"; V2 renamed it to
          // "permission.asked" and reshaped the payload into PermissionRequest.
          case "permission.asked": {
            if (!sid0) return;
            await observeV2(sid0, "notification", {
              notification_type: "permission_prompt",
              permission: props.permission || "unknown",
              pattern: Array.isArray(props.patterns) ? props.patterns.join(", ") : (props.patterns || ""),
              tool_call_id: props.tool?.callID || null,
              title: props.permission || "",
              metadata: props.metadata || {},
            });
            break;
          }

          case "permission.replied": {
            if (!sid0) return;
            await observeV2(sid0, "permission_replied", {
              permission_id: props.requestID || props.permissionID || "",
              response: props.reply || props.response || "",
            });
            break;
          }

          case "todo.updated": {
            const todos = Array.isArray(props.todos) ? props.todos.slice(0, 100) : [];
            if (!sid0 || todos.length === 0) return;
            const completed = todos.filter((t: any) => t.status === "completed");
            const active = todos.filter((t: any) => t.status !== "completed");
            await observeV2(sid0, "task_completed", {
              completed: completed.map((t: any) => ({ content: t.content, priority: t.priority })),
              in_progress: active.map((t: any) => ({ content: t.content, priority: t.priority })),
              total: todos.length,
            });
            break;
          }

          case "command.executed": {
            if (sid0) {
              await observeV2(sid0, "command_executed", { name: props.name, arguments: props.arguments || "" });
            }
            break;
          }
        }
    }
  };

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        // A throw from one event must not end the subscription.
        try {
          await handleEvent(event);
        } catch (e) {
          if (DEBUG) console.error("[agentmemory] event handler failed:", (e as Error).message);
        }
      }
    } catch (e) {
      if (DEBUG) console.error("[agentmemory] event stream failed:", (e as Error).message);
    }
  })();

  return () => {
    controller.abort();
    startContextCache.clear();
    contextInjectedSessions.clear();
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Dual export
//
// V1 calls `server()` and uses the returned hooks. V2 reads `id` and
// `setup()` and ignores `server()`. The V1 object form is supported in
// OpenCode 1.18.29 and newer; older V1 releases expect a function export, so
// the named export below is kept for direct imports.
// ═══════════════════════════════════════════════════════════════════════════

export default {
  id: "agentmemory-capture",
  setup: v2Setup,
  server: v1Hooks,
};

export const AgentmemoryCapturePlugin: Plugin = v1Hooks;
