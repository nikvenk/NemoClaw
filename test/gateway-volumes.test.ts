// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { listGatewayDockerVolumes } from "../dist/lib/gateway-volumes";

describe("listGatewayDockerVolumes", () => {
  it("filters docker substring matches down to the real gateway prefix", () => {
    const volumes = listGatewayDockerVolumes("nemoclaw", () =>
      [
        "prefix-openshell-cluster-nemoclaw-nope",
        "openshell-cluster-nemoclaw",
        "openshell-cluster-nemoclaw-data",
        "other-volume",
      ].join("\n"),
    );

    expect(volumes).toEqual([
      "openshell-cluster-nemoclaw",
      "openshell-cluster-nemoclaw-data",
    ]);
  });
});
