import { describe, test, expect } from "bun:test"
import { mapTool } from "../../src/tool-mapping.js"

describe("mapTool", () => {
  test("skips internal tools (returns skip: true)", () => {
    for (const name of ["ToolSearch", "Agent", "AskFollowupQuestion"]) {
      const result = mapTool(name)
      expect(result.skip).toBe(true)
    }
  })

  test("strips MCP prefix (mcp__server__tool -> server_tool)", () => {
    const result = mapTool("mcp__myserver__my_tool", { key: "value" })
    expect(result.name).toBe("myserver_my_tool")
    expect(result.executed).toBe(false)
    expect(result.input).toEqual({ key: "value" })
  })

  test("converts snake_case to camelCase for handled tools", () => {
    const editResult = mapTool("Edit", {
      file_path: "/tmp/test.ts",
      old_string: "foo",
      new_string: "bar",
    })
    expect(editResult.name).toBe("edit")
    expect(editResult.input.filePath).toBe("/tmp/test.ts")
    expect(editResult.input.oldString).toBe("foo")
    expect(editResult.input.newString).toBe("bar")
    expect(editResult.executed).toBe(true)

    const writeResult = mapTool("Write", {
      file_path: "/tmp/out.ts",
      content: "hello",
    })
    expect(writeResult.name).toBe("write")
    expect(writeResult.input.filePath).toBe("/tmp/out.ts")

    const readResult = mapTool("Read", {
      file_path: "/tmp/in.ts",
      offset: 10,
      limit: 50,
    })
    expect(readResult.name).toBe("read")
    expect(readResult.input.filePath).toBe("/tmp/in.ts")
    expect(readResult.input.offset).toBe(10)
  })

  test("passes through unknown tools as-is", () => {
    const result = mapTool("SomeUnknownTool", { data: 123 })
    expect(result.name).toBe("SomeUnknownTool")
    expect(result.input).toEqual({ data: 123 })
    expect(result.executed).toBe(true)
  })

  test("handles undefined input", () => {
    const result = mapTool("Edit")
    expect(result.name).toBe("edit")
    expect(result.executed).toBe(true)
    // mapToolInput returns undefined input as-is when !input
  })

  test("maps WebSearch correctly", () => {
    const result = mapTool("WebSearch", { query: "test query" })
    expect(result.name).toBe("websearch_web_search_exa")
    expect(result.input).toEqual({ query: "test query" })
    expect(result.executed).toBe(false)

    // Also test web_search alias
    const result2 = mapTool("web_search", { query: "another" })
    expect(result2.name).toBe("websearch_web_search_exa")
  })
})
