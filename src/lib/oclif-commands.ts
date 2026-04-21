// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createListCommand, type ListCommandClass } from "./list-command";
import { buildListCommandDeps } from "./list-command-deps";

const commands: Record<string, ListCommandClass> = {
  list: createListCommand(buildListCommandDeps),
};

export default commands;
