import { describe, expect, it } from "vitest";

import {
  formatValueForViewer,
  isStructuredText,
} from "./valueView";

describe("isStructuredText", () => {
  it("recognizes top-level JSON objects and arrays", () => {
    expect(isStructuredText('{"a":1}')).toBe(true);
    expect(isStructuredText("[1, 2, 3]")).toBe(true);
    expect(isStructuredText('  {"a":1}  ')).toBe(true);
  });

  it("rejects scalars, malformed JSON, and plain text", () => {
    expect(isStructuredText("123")).toBe(false);
    expect(isStructuredText('"a string"')).toBe(false);
    expect(isStructuredText("{not json}")).toBe(false);
    expect(isStructuredText("plain text")).toBe(false);
  });
});

describe("formatValueForViewer", () => {
  it("shows nulls distinctly", () => {
    expect(formatValueForViewer({ type: "null" })).toEqual({
      text: "NULL",
      structured: false,
    });
  });

  it("preserves the full text of a multi-line value", () => {
    const text = "line one\nline two\tend";
    const content = formatValueForViewer({ type: "text", value: text });

    expect(content.text).toBe(text);
    expect(content.structured).toBe(false);
  });

  it("pretty-prints structured text", () => {
    const content = formatValueForViewer({
      type: "text",
      value: '{"b":2,"a":[1,2]}',
    });

    expect(content.structured).toBe(true);
    expect(content.text).toContain("\n");
    expect(content.text).toContain('"a"');
  });

  it("keeps a scalar decimal text as-is", () => {
    expect(
      formatValueForViewer({ type: "decimal", value: "12345678901234567890.12" }),
    ).toEqual({ text: "12345678901234567890.12", structured: false });
  });

  it("renders bytes as spaced hex with a byte count", () => {
    expect(formatValueForViewer({ type: "bytes", value: [0x00, 0xff] })).toEqual({
      text: "00 ff",
      structured: false,
      byteLength: 2,
    });
  });
});
