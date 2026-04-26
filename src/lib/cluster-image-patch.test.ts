// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildPatchDockerfile,
  ClusterImagePatchError,
  computePatchedTag,
  ensurePatchedClusterImage,
  extractUpstreamVersion,
} from "../../dist/lib/cluster-image-patch";

const UPSTREAM = "ghcr.io/nvidia/openshell/cluster:0.0.36";

describe("buildPatchDockerfile", () => {
  it("includes fuse-overlayfs install and snapshotter CMD override", () => {
    const dockerfile = buildPatchDockerfile("fuse-overlayfs");
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends fuse-overlayfs");
    expect(dockerfile).toContain('CMD ["server", "--snapshotter=fuse-overlayfs"]');
  });

  it("threads through the native snapshotter when requested", () => {
    expect(buildPatchDockerfile("native")).toContain('CMD ["server", "--snapshotter=native"]');
  });
});

describe("extractUpstreamVersion", () => {
  it("extracts the tag portion from a registry-qualified image reference", () => {
    expect(extractUpstreamVersion("ghcr.io/nvidia/openshell/cluster:0.0.36")).toBe("0.0.36");
  });

  it("strips an appended digest", () => {
    expect(
      extractUpstreamVersion(
        "ghcr.io/nvidia/openshell/cluster:0.0.36@sha256:abc123def456",
      ),
    ).toBe("0.0.36");
  });

  it("falls back to 'unknown' for an untagged reference", () => {
    expect(extractUpstreamVersion("ghcr.io/nvidia/openshell/cluster")).toBe("unknown");
  });
});

describe("computePatchedTag", () => {
  it("is deterministic for matching inputs", () => {
    const dockerfile = buildPatchDockerfile("fuse-overlayfs");
    const a = computePatchedTag({
      upstreamImage: UPSTREAM,
      snapshotter: "fuse-overlayfs",
      dockerfile,
    });
    const b = computePatchedTag({
      upstreamImage: UPSTREAM,
      snapshotter: "fuse-overlayfs",
      dockerfile,
    });
    expect(a).toBe(b);
    expect(a.startsWith("nemoclaw-cluster:0.0.36-fuse-overlayfs-")).toBe(true);
  });

  it("differs when the snapshotter changes", () => {
    const fuse = computePatchedTag({
      upstreamImage: UPSTREAM,
      snapshotter: "fuse-overlayfs",
      dockerfile: buildPatchDockerfile("fuse-overlayfs"),
    });
    const native = computePatchedTag({
      upstreamImage: UPSTREAM,
      snapshotter: "native",
      dockerfile: buildPatchDockerfile("native"),
    });
    expect(fuse).not.toBe(native);
  });

  it("differs when the upstream image version changes", () => {
    const dockerfile = buildPatchDockerfile("fuse-overlayfs");
    const a = computePatchedTag({
      upstreamImage: "ghcr.io/nvidia/openshell/cluster:0.0.36",
      snapshotter: "fuse-overlayfs",
      dockerfile,
    });
    const b = computePatchedTag({
      upstreamImage: "ghcr.io/nvidia/openshell/cluster:0.0.37",
      snapshotter: "fuse-overlayfs",
      dockerfile,
    });
    expect(a).not.toBe(b);
  });
});

interface MockFs {
  mkdtempSync: (prefix: string) => string;
  writeFileSync: (filePath: string, data: string, encoding: BufferEncoding) => void;
  rmSync: (filePath: string, opts?: { recursive?: boolean; force?: boolean }) => void;
  written: Map<string, string>;
}

function createMockFs(): MockFs {
  const written = new Map<string, string>();
  return {
    mkdtempSync: (prefix: string) => `${prefix}mock`,
    writeFileSync: (filePath: string, data: string, _encoding: BufferEncoding) => {
      written.set(filePath, String(data));
    },
    rmSync: (_filePath: string) => {
      // no-op
    },
    written,
  };
}

describe("ensurePatchedClusterImage", () => {
  it("returns the cached tag without invoking docker build when the image already exists", () => {
    const calls: string[][] = [];
    const tag = ensurePatchedClusterImage({
      upstreamImage: UPSTREAM,
      runCaptureImpl: (cmd) => {
        calls.push(["capture", ...cmd]);
        return "sha256:abcd";
      },
      runImpl: (cmd) => {
        calls.push(["run", ...cmd]);
        return { status: 0 };
      },
      logger: () => {},
      fsImpl: createMockFs(),
      tmpdirImpl: () => "/tmp",
    });

    expect(tag.startsWith("nemoclaw-cluster:0.0.36-fuse-overlayfs-")).toBe(true);
    const runCalls = calls.filter((entry) => entry[0] === "run");
    expect(runCalls).toHaveLength(0);
  });

  it("pulls upstream and builds the patched image on cache miss", () => {
    const fsImpl = createMockFs();
    const runCalls: string[][] = [];
    const tag = ensurePatchedClusterImage({
      upstreamImage: UPSTREAM,
      runCaptureImpl: () => "",
      runImpl: (cmd) => {
        runCalls.push([...cmd]);
        return { status: 0 };
      },
      logger: () => {},
      fsImpl,
      tmpdirImpl: () => "/tmp",
    });

    expect(tag.startsWith("nemoclaw-cluster:0.0.36-fuse-overlayfs-")).toBe(true);
    expect(runCalls[0]).toEqual(["docker", "pull", UPSTREAM]);
    const buildCall = runCalls.find((entry) => entry[0] === "docker" && entry[1] === "build");
    expect(buildCall).toBeDefined();
    expect(buildCall).toContain("--build-arg");
    expect(buildCall).toContain(`UPSTREAM=${UPSTREAM}`);
    expect(buildCall).toContain("-t");
    expect(buildCall).toContain(tag);

    const [dockerfilePath] = Array.from(fsImpl.written.keys());
    expect(dockerfilePath).toBeDefined();
    expect(fsImpl.written.get(dockerfilePath)).toContain(
      'CMD ["server", "--snapshotter=fuse-overlayfs"]',
    );
  });

  it("threads the native snapshotter through the build", () => {
    const fsImpl = createMockFs();
    ensurePatchedClusterImage({
      upstreamImage: UPSTREAM,
      snapshotter: "native",
      runCaptureImpl: () => "",
      runImpl: () => ({ status: 0 }),
      logger: () => {},
      fsImpl,
      tmpdirImpl: () => "/tmp",
    });
    const [dockerfilePath] = Array.from(fsImpl.written.keys());
    expect(fsImpl.written.get(dockerfilePath)).toContain(
      'CMD ["server", "--snapshotter=native"]',
    );
    expect(fsImpl.written.get(dockerfilePath)).not.toContain('"--snapshotter=fuse-overlayfs"');
  });

  it("throws ClusterImagePatchError on docker pull failure", () => {
    expect(() =>
      ensurePatchedClusterImage({
        upstreamImage: UPSTREAM,
        runCaptureImpl: () => "",
        runImpl: (cmd) => (cmd[1] === "pull" ? { status: 1 } : { status: 0 }),
        logger: () => {},
        fsImpl: createMockFs(),
        tmpdirImpl: () => "/tmp",
      }),
    ).toThrow(ClusterImagePatchError);
  });

  it("throws ClusterImagePatchError on docker build failure", () => {
    expect(() =>
      ensurePatchedClusterImage({
        upstreamImage: UPSTREAM,
        runCaptureImpl: () => "",
        runImpl: (cmd) => (cmd[1] === "build" ? { status: 2 } : { status: 0 }),
        logger: () => {},
        fsImpl: createMockFs(),
        tmpdirImpl: () => "/tmp",
      }),
    ).toThrow(ClusterImagePatchError);
  });
});
