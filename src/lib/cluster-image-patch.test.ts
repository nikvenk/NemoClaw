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
  it("uses a multi-stage ubuntu:24.04 builder to install fuse-overlayfs from apt", () => {
    const dockerfile = buildPatchDockerfile("fuse-overlayfs");
    expect(dockerfile).toContain("FROM ubuntu:24.04 AS bin-fetcher");
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends fuse-overlayfs");
    expect(dockerfile).toContain(
      "COPY --from=bin-fetcher /export/fuse-overlayfs /usr/local/bin/fuse-overlayfs",
    );
    expect(dockerfile).toContain(
      "COPY --from=bin-fetcher /export/lib/libfuse3.so.3 /usr/local/lib/libfuse3.so.3",
    );
    expect(dockerfile).toContain('CMD ["server", "--snapshotter=fuse-overlayfs"]');
  });

  it("does not link to a third-party code repository in the Dockerfile", () => {
    // Repo policy (CONTRIBUTING.md "No External Project Links") prohibits
    // pointing at third-party GitHub repos in source. The previous static-
    // binary approach pulled from `containers/fuse-overlayfs` releases —
    // this assertion guards against regressing back to that.
    const dockerfile = buildPatchDockerfile("fuse-overlayfs");
    expect(dockerfile).not.toContain("github.com");
  });

  it("does not RUN apt-get or curl in the final cluster stage", () => {
    // The upstream cluster image's base ships BusyBox tar (so dpkg-deb
    // cannot extract .debs) AND does not ship curl (RUN curl exits 127).
    // The fix is structural: install in a clean ubuntu:24.04 builder,
    // COPY --from into the cluster stage.
    const dockerfile = buildPatchDockerfile("fuse-overlayfs");
    const finalStage = dockerfile.split(/^FROM \$\{UPSTREAM\}/m)[1] ?? "";
    expect(finalStage).not.toMatch(/RUN[^\n]*apt-get/);
    expect(finalStage).not.toMatch(/RUN[^\n]*curl/);
  });

  it("threads through the native snapshotter without installing fuse-overlayfs", () => {
    // K3s `native` snapshotter does not need the userspace fuse helper.
    // Anyone selecting it (NEMOCLAW_OVERLAY_SNAPSHOTTER=native) should get
    // a minimal patch image that only overrides CMD.
    const dockerfile = buildPatchDockerfile("native");
    expect(dockerfile).toContain('CMD ["server", "--snapshotter=native"]');
    expect(dockerfile).not.toContain("fuse-overlayfs");
    expect(dockerfile).not.toContain("apt-get");
    expect(dockerfile).not.toContain("ubuntu:24.04");
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

  it("does not mistake a registry port for a tag", () => {
    // `registry.example.com:5000/openshell/cluster` is a registry on port 5000
    // with no explicit tag; a naive split-on-':' parser would return "5000/openshell/cluster".
    expect(extractUpstreamVersion("registry.example.com:5000/openshell/cluster")).toBe("unknown");
  });

  it("extracts the tag when both a registry port and a tag are present", () => {
    expect(extractUpstreamVersion("registry.example.com:5000/openshell/cluster:0.0.36")).toBe(
      "0.0.36",
    );
  });

  it("falls back to 'unknown' when the tag separator has no value after it", () => {
    expect(extractUpstreamVersion("ghcr.io/nvidia/openshell/cluster:")).toBe("unknown");
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
