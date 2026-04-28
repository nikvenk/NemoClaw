// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ROOT } from "../runner";
import { dockerRun, type DockerRunOptions } from "./run";

export function dockerBuild(
  dockerfilePath: string,
  tag: string,
  contextDir: string = ROOT,
  opts: DockerRunOptions = {},
) {
  return dockerRun(["build", "-f", dockerfilePath, "-t", tag, contextDir], opts);
}

export function dockerRmi(imageRef: string, opts: DockerRunOptions = {}) {
  return dockerRun(["rmi", imageRef], opts);
}
