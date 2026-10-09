import { defineModelAgent } from "tubeless/agent";
import { connectMcpServers } from "tubeless/agent/mcp";
import { openaiModel } from "tubeless/agent/openai";

/**
 * Connect MCP servers for one batch of work. Tools are discovered before the agent
 * is defined, so its capability inventory is fixed; `await using` closes the
 * servers (and stops stdio processes) when the block exits.
 */
export async function answerWithMcp(task: string, signal?: AbortSignal) {
  await using mcp = await connectMcpServers(
    {
      docs: {
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: `Bearer ${process.env.DOCS_MCP_TOKEN}` },
      },
      files: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
        tools: ["read_text_file", "list_directory"],
      },
    },
    { signal }
  );
  const agent = defineModelAgent({
    id: "mcp-agent",
    model: openaiModel(),
    // Named docs__<tool> and files__<tool>; spread alongside your own tools.
    tools: mcp.tools,
  });
  const { answer } = await agent.runOrThrow({ task }, undefined, { signal });
  return answer;
}
