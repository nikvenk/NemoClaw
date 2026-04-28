// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { parseOllamaArgs, OllamaArgParseError } from "../../src/lib/ollama-cmd.js";

describe("parseOllamaArgs", () => {
  // -------------------------------------------------------------------------
  // Named subcommands
  // -------------------------------------------------------------------------

  describe("named subcommands", () => {
    it("parses 'status'", () => {
      const result = parseOllamaArgs(["status"]);
      expect(result.subcommand).toBe("status");
    });

    it("parses 'optimize'", () => {
      const result = parseOllamaArgs(["optimize"]);
      expect(result.subcommand).toBe("optimize");
    });

    it("parses 'apply'", () => {
      const result = parseOllamaArgs(["apply"]);
      expect(result.subcommand).toBe("apply");
    });

    it("parses 'reset'", () => {
      const result = parseOllamaArgs(["reset"]);
      expect(result.subcommand).toBe("reset");
    });
  });

  // -------------------------------------------------------------------------
  // vram=N%
  // -------------------------------------------------------------------------

  describe("vram= assignment", () => {
    it("parses vram=80%", () => {
      const result = parseOllamaArgs(["vram=80%"]);
      expect(result.vramPercent).toBe(80);
    });

    it("parses vram=1%", () => {
      const result = parseOllamaArgs(["vram=1%"]);
      expect(result.vramPercent).toBe(1);
    });

    it("parses vram=100%", () => {
      const result = parseOllamaArgs(["vram=100%"]);
      expect(result.vramPercent).toBe(100);
    });

    it("parses vram=off as null", () => {
      const result = parseOllamaArgs(["vram=off"]);
      expect(result.vramPercent).toBeNull();
    });

    it("rejects vram=0%", () => {
      expect(() => parseOllamaArgs(["vram=0%"])).toThrow(OllamaArgParseError);
    });

    it("rejects vram=101%", () => {
      expect(() => parseOllamaArgs(["vram=101%"])).toThrow(OllamaArgParseError);
    });

    it("rejects vram=abc", () => {
      expect(() => parseOllamaArgs(["vram=abc"])).toThrow(OllamaArgParseError);
    });
  });

  // -------------------------------------------------------------------------
  // ctx=N
  // -------------------------------------------------------------------------

  describe("ctx= assignment", () => {
    it("parses ctx=32768", () => {
      const result = parseOllamaArgs(["ctx=32768"]);
      expect(result.numCtx).toBe(32768);
    });

    it("parses ctx=off as null", () => {
      const result = parseOllamaArgs(["ctx=off"]);
      expect(result.numCtx).toBeNull();
    });

    it("rejects ctx=0", () => {
      expect(() => parseOllamaArgs(["ctx=0"])).toThrow(OllamaArgParseError);
    });

    it("rejects ctx=-1", () => {
      expect(() => parseOllamaArgs(["ctx=-1"])).toThrow(OllamaArgParseError);
    });

    it("rejects ctx=abc", () => {
      expect(() => parseOllamaArgs(["ctx=abc"])).toThrow(OllamaArgParseError);
    });
  });

  // -------------------------------------------------------------------------
  // batch=N
  // -------------------------------------------------------------------------

  describe("batch= assignment", () => {
    it("parses batch=512", () => {
      const result = parseOllamaArgs(["batch=512"]);
      expect(result.numBatch).toBe(512);
    });

    it("parses batch=off as null", () => {
      const result = parseOllamaArgs(["batch=off"]);
      expect(result.numBatch).toBeNull();
    });

    it("rejects batch=0", () => {
      expect(() => parseOllamaArgs(["batch=0"])).toThrow(OllamaArgParseError);
    });
  });

  // -------------------------------------------------------------------------
  // flash=on|off
  // -------------------------------------------------------------------------

  describe("flash= assignment", () => {
    it("parses flash=on as true", () => {
      const result = parseOllamaArgs(["flash=on"]);
      expect(result.flashAttention).toBe(true);
    });

    it("parses flash=off as false", () => {
      const result = parseOllamaArgs(["flash=off"]);
      expect(result.flashAttention).toBe(false);
    });

    it("rejects flash=maybe", () => {
      expect(() => parseOllamaArgs(["flash=maybe"])).toThrow(OllamaArgParseError);
    });
  });

  // -------------------------------------------------------------------------
  // kv-cache=...
  // -------------------------------------------------------------------------

  describe("kv-cache= assignment", () => {
    it("parses kv-cache=f16", () => {
      const result = parseOllamaArgs(["kv-cache=f16"]);
      expect(result.kvCacheType).toBe("f16");
    });

    it("parses kv-cache=q8_0", () => {
      const result = parseOllamaArgs(["kv-cache=q8_0"]);
      expect(result.kvCacheType).toBe("q8_0");
    });

    it("parses kv-cache=q4_0", () => {
      const result = parseOllamaArgs(["kv-cache=q4_0"]);
      expect(result.kvCacheType).toBe("q4_0");
    });

    it("parses kv-cache=off as null", () => {
      const result = parseOllamaArgs(["kv-cache=off"]);
      expect(result.kvCacheType).toBeNull();
    });

    it("rejects kv-cache=garbage", () => {
      expect(() => parseOllamaArgs(["kv-cache=garbage"])).toThrow(OllamaArgParseError);
    });
  });

  // -------------------------------------------------------------------------
  // Combined form
  // -------------------------------------------------------------------------

  describe("combined form", () => {
    it("parses vram=80% ctx=32768 kv-cache=q8_0 flash=on", () => {
      const result = parseOllamaArgs(["vram=80%", "ctx=32768", "kv-cache=q8_0", "flash=on"]);
      expect(result.vramPercent).toBe(80);
      expect(result.numCtx).toBe(32768);
      expect(result.kvCacheType).toBe("q8_0");
      expect(result.flashAttention).toBe(true);
    });

    it("parses vram=80% ctx=32768", () => {
      const result = parseOllamaArgs(["vram=80%", "ctx=32768"]);
      expect(result.vramPercent).toBe(80);
      expect(result.numCtx).toBe(32768);
    });

    it("parses optimize --apply --ctx 8192 --vram 70%", () => {
      const result = parseOllamaArgs(["optimize", "--apply", "--ctx", "8192", "--vram", "70%"]);
      expect(result.subcommand).toBe("optimize");
      expect(result.optimizeApply).toBe(true);
      expect(result.optimizeCtx).toBe(8192);
      expect(result.optimizeVram).toBe(70);
    });

    it("parses apply --sudo --yes", () => {
      const result = parseOllamaArgs(["apply", "--sudo", "--yes"]);
      expect(result.subcommand).toBe("apply");
      expect(result.sudo).toBe(true);
      expect(result.yes).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Flags
  // -------------------------------------------------------------------------

  describe("flags", () => {
    it("parses --help", () => {
      const result = parseOllamaArgs(["--help"]);
      expect(result.help).toBe(true);
    });

    it("parses -h", () => {
      const result = parseOllamaArgs(["-h"]);
      expect(result.help).toBe(true);
    });

    it("parses --sudo", () => {
      const result = parseOllamaArgs(["status", "--sudo"]);
      expect(result.sudo).toBe(true);
    });

    it("parses --yes", () => {
      const result = parseOllamaArgs(["apply", "--yes"]);
      expect(result.yes).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Malformed input
  // -------------------------------------------------------------------------

  describe("malformed input", () => {
    it("rejects unknown bare argument", () => {
      expect(() => parseOllamaArgs(["unknown-arg"])).toThrow(OllamaArgParseError);
    });

    it("rejects unknown key=value", () => {
      expect(() => parseOllamaArgs(["mode=fast"])).toThrow(OllamaArgParseError);
    });

    it("returns empty result for no args", () => {
      const result = parseOllamaArgs([]);
      expect(result.subcommand).toBeUndefined();
      expect(result.vramPercent).toBeUndefined();
      expect(result.numCtx).toBeUndefined();
      expect(result.help).toBe(false);
    });
  });
});
