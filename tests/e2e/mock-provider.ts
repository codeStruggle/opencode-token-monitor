/**
 * OpenAI-compatible mock provider for end-to-end runs. Prompts containing a keyword drive behaviour:
 *   SPAWN → task tool call (subagent), READ → read tool call, SLOW → delays the reply (for abort tests).
 * Every completion reports usage with cached and reasoning tokens so all counters are exercised.
 */
export function startMockProvider(port = 0, readPath = "package.json") {
  let n = 0
  const sse = (chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "mock-model", object: "model" }] })
      const body = (await req.json()) as { model: string; tools?: unknown[]; messages?: { role: string; content: unknown }[] }
      n++
      const msgs = body.messages ?? []
      const last = msgs[msgs.length - 1]
      const lastText = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "")
      const base = { id: `chatcmpl-${n}`, object: "chat.completion.chunk", created: 1, model: body.model }
      const usage = {
        prompt_tokens: 1000 + n,
        completion_tokens: 50,
        total_tokens: 1050 + n,
        prompt_tokens_details: { cached_tokens: 200 },
        completion_tokens_details: { reasoning_tokens: 10 },
      }
      const isTitle = !body.tools && JSON.stringify(msgs).includes("title")
      const toolCall = (name: string, args: unknown) =>
        sse([
          { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          { ...base, choices: [], usage },
        ])
      if (!isTitle && last?.role !== "tool" && body.tools) {
        if (lastText.includes("SPAWN")) return toolCall("task", { description: "sub work", prompt: "do sub work", subagent_type: "general" })
        if (lastText.includes("READ")) return toolCall("read", { filePath: readPath })
      }
      if (!isTitle && lastText.includes("SLOW")) await Bun.sleep(15_000)
      return sse([
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: isTitle ? "Mock title" : `Mock reply ${n}` }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { ...base, choices: [], usage },
      ])
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true), requests: () => n }
}
