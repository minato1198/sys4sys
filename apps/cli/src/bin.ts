#!/usr/bin/env node
import { run } from "./index.js";

const code = await run(process.argv.slice(2));
if (code !== 0) process.exitCode = code;
