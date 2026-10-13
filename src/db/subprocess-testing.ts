import { isRecord } from "./access";

export function createSubprocessBridge(child: Bun.Subprocess<"pipe", "pipe", "pipe">, dispatch: (request: Request) => Promise<Response>, prefix = "") {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const stderr = new Response(child.stderr).text();
  let pending = "";
  let ended = false;
  let disposed = false;

  return {
    async read(): Promise<unknown> {
      if (disposed) throw new Error("Synthetic request bridge is disposed");
      for (;;) {
        while (!pending.includes("\n")) {
          const next = await reader.read();
          if (next.done) throw new Error("Subprocess exited before completing its synthetic request");
          pending += decoder.decode(next.value, { stream: true });
        }
        const end = pending.indexOf("\n");
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.startsWith(prefix)) {
          try { return JSON.parse(line.slice(prefix.length)); }
          catch { throw new Error("Invalid synthetic subprocess frame"); }
        }
      }
    },
    async forward(message: unknown) {
      if (disposed || ended) throw new Error("Synthetic request bridge input is closed");
      if (!isRecord(message) || typeof message.url !== "string" || typeof message.method !== "string" || typeof message.body !== "string" || !isRecord(message.headers)) throw new Error("Invalid synthetic subprocess request");
      const headers = new Headers();
      for (const [key, value] of Object.entries(message.headers)) {
        if (typeof value !== "string") throw new Error("Invalid synthetic subprocess header");
        headers.set(key, value);
      }
      const response = await dispatch(new Request(message.url, { method: message.method, headers, body: message.body }));
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });
      child.stdin.write(JSON.stringify({ status: response.status, headers: responseHeaders, body: await response.text() }) + "\n");
    },
    end() {
      if (ended) return;
      ended = true;
      child.stdin.end();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (child.exitCode === null) child.kill();
      await child.exited;
      try { await reader.cancel(); } finally { reader.releaseLock(); }
      await stderr;
    },
  };
}
